import * as os from 'node:os';
import * as path from 'node:path';
import { getOpenCodeConfigPaths } from '../../cli/config-manager';
import { PACKAGE_NAME } from '../../config/package-identity';

export { INSTALLER_MANAGED_PLUGIN_OPTION } from '../../plugin-entry';

/**
 * The auto-update checker resolves, queries and INSTALLS this exact package.
 * It deliberately does not accept the upstream name as an alias: an upstream
 * entry must never be matched here, or a fork install could be silently
 * replaced by an upstream release.
 */
export { PACKAGE_NAME };

// registry.npmjs.org serves scoped names with a literal '/' on both of these
// endpoints (verified against a scoped package), so no percent-encoding here.
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
export const NPM_PACKAGE_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
export const NPM_FETCH_TIMEOUT = 5000;

function getCacheDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'opencode');
  }
  return path.join(os.homedir(), '.cache', 'opencode');
}

/** The directory used by OpenCode to cache node_modules for plugins. */
export const CACHE_DIR = getCacheDir();

/** Path to this plugin's package.json within the OpenCode cache. */
export const INSTALLED_PACKAGE_JSON = path.join(
  CACHE_DIR,
  'node_modules',
  PACKAGE_NAME,
  'package.json',
);

const configPaths = getOpenCodeConfigPaths();

/** Primary OpenCode configuration file path (standard JSON). */
export const USER_OPENCODE_CONFIG = configPaths[0];

/** Alternative OpenCode configuration file path (JSON with Comments). */
export const USER_OPENCODE_CONFIG_JSONC = configPaths[1];
