import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../../utils/logger';
import { getCurrentRuntimePackageJsonPath } from './checker';
import { CACHE_DIR, PACKAGE_NAME } from './constants';

interface AutoUpdateInstallContext {
  installDir: string;
  packageJsonPath: string;
}

interface PreparedPackageUpdate {
  stagingDir: string;
  targetDir: string;
}

/**
 * Path segments in the package name: 1 for a bare name, 2 for a scoped one.
 *
 * OpenCode nests the plugin cache for a scoped package
 * (`packages/@scope/name@version/node_modules/@scope/name`), so every walk
 * between an install root and the package directory spans this many levels.
 */
const PACKAGE_NAME_PARTS = PACKAGE_NAME.split('/');

/** Last segment of the package name — usable as a single path segment. */
const PACKAGE_DIR_NAME = PACKAGE_NAME_PARTS[PACKAGE_NAME_PARTS.length - 1];

/** Walks `levels` directories upward from `from`. */
function ascend(from: string, levels: number): string {
  let dir = from;
  for (let index = 0; index < levels; index++) dir = path.dirname(dir);
  return dir;
}

function getTargetInstallContext(
  installContext: AutoUpdateInstallContext,
  version: string,
): AutoUpdateInstallContext {
  // `packages` sits directly above the install root for a bare name and one
  // level higher for a scoped one.
  const packagesDir = ascend(
    installContext.installDir,
    PACKAGE_NAME_PARTS.length,
  );
  const parentDir =
    path.basename(packagesDir) === 'packages'
      ? packagesDir
      : path.join(CACHE_DIR, 'packages');
  const installDir = path.join(parentDir, `${PACKAGE_NAME}@${version}`);
  return { installDir, packageJsonPath: path.join(installDir, 'package.json') };
}

export function resolveInstallContext(
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
  if (runtimePackageJsonPath) {
    const packageDir = path.dirname(runtimePackageJsonPath);

    // Collect as many trailing segments as the package name has, so a scoped
    // package's `@scope/name` directory pair is matched as a whole.
    const observedParts: string[] = [];
    let cursor = packageDir;
    for (let index = 0; index < PACKAGE_NAME_PARTS.length; index++) {
      observedParts.unshift(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
    const nodeModulesDir = cursor;

    if (
      observedParts.join('/') === PACKAGE_NAME &&
      path.basename(nodeModulesDir) === 'node_modules'
    ) {
      const installDir = path.dirname(nodeModulesDir);
      const packageJsonPath = path.join(installDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        return { installDir, packageJsonPath };
      }
    }

    return null;
  }

  const legacyPackageJsonPath = path.join(CACHE_DIR, 'package.json');
  if (fs.existsSync(legacyPackageJsonPath)) {
    return { installDir: CACHE_DIR, packageJsonPath: legacyPackageJsonPath };
  }

  return null;
}

/**
 * Prepares the current install root for a clean re-install of the target version.
 * Returns the install directory to run `bun install` in.
 */
export function preparePackageUpdate(
  version: string,
  packageName: string = PACKAGE_NAME,
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
  cacheIdentity: string = version,
): PreparedPackageUpdate | null {
  let stagingDir: string | null = null;
  try {
    const installContext = resolveInstallContext(runtimePackageJsonPath);
    if (!installContext) {
      log('[auto-update-checker] No install context found for auto-update');
      return null;
    }

    const targetContext = getTargetInstallContext(
      installContext,
      cacheIdentity,
    );
    const targetParent = path.dirname(targetContext.installDir);
    fs.mkdirSync(targetParent, { recursive: true });
    // The staging prefix must be a single path segment: a scoped package name
    // would otherwise ask mkdtemp for a nested directory that does not exist.
    stagingDir = fs.mkdtempSync(
      path.join(targetParent, `.${PACKAGE_DIR_NAME}@${cacheIdentity}.staging-`),
    );
    fs.writeFileSync(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: { [packageName]: version },
      }),
    );

    return { stagingDir, targetDir: targetContext.installDir };
  } catch (err) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    log('[auto-update-checker] Failed to prepare package update:', err);
    return null;
  }
}

export function discardPreparedPackageUpdate(
  prepared: PreparedPackageUpdate,
): void {
  fs.rmSync(prepared.stagingDir, { recursive: true, force: true });
}

export function publishPackageUpdate(
  prepared: PreparedPackageUpdate,
  version: string,
): string | null {
  try {
    if (fs.existsSync(prepared.targetDir)) {
      if (verifyInstalledPackage(prepared.targetDir, version)) {
        discardPreparedPackageUpdate(prepared);
        return prepared.targetDir;
      }
      const quarantineDir = `${prepared.targetDir}.invalid-${process.pid}-${Date.now()}`;
      fs.renameSync(prepared.targetDir, quarantineDir);
      try {
        fs.renameSync(prepared.stagingDir, prepared.targetDir);
        if (verifyInstalledPackage(prepared.targetDir, version)) {
          fs.rmSync(quarantineDir, { recursive: true, force: true });
          return prepared.targetDir;
        }
        fs.rmSync(prepared.targetDir, { recursive: true, force: true });
        fs.renameSync(quarantineDir, prepared.targetDir);
        return null;
      } catch {
        if (fs.existsSync(prepared.targetDir)) {
          if (verifyInstalledPackage(prepared.targetDir, version)) {
            discardPreparedPackageUpdate(prepared);
            fs.rmSync(quarantineDir, { recursive: true, force: true });
            return prepared.targetDir;
          }
        }
      }
      if (!fs.existsSync(prepared.targetDir)) {
        fs.renameSync(quarantineDir, prepared.targetDir);
      }
      discardPreparedPackageUpdate(prepared);
      return null;
    }
    // A scoped package name adds a scope directory above the target; it may be
    // absent if the cache was pruned between prepare and publish, and rename
    // does not create parents.
    fs.mkdirSync(path.dirname(prepared.targetDir), { recursive: true });
    fs.renameSync(prepared.stagingDir, prepared.targetDir);
    if (verifyInstalledPackage(prepared.targetDir, version)) {
      return prepared.targetDir;
    }
    fs.rmSync(prepared.targetDir, { recursive: true, force: true });
    return null;
  } catch {
    discardPreparedPackageUpdate(prepared);
    return null;
  }
}

export function verifyInstalledPackage(
  installDir: string,
  version: string,
  packageName: string = PACKAGE_NAME,
): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(installDir, 'node_modules', packageName, 'package.json'),
        'utf-8',
      ),
    ) as { name?: string; version?: string };
    return packageJson.name === packageName && packageJson.version === version;
  } catch {
    return false;
  }
}
