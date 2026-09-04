import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_SCHEMA_URL,
  DISPLAY_NAME,
  GITHUB_REPO,
  matchesPluginSpecifier,
  PACKAGE_NAME,
  PACKAGE_NAME_ALIASES,
  pluginSpecifierVersion,
  STORAGE_NAMESPACE,
  takePackageNameSegments,
  UPSTREAM_PACKAGE_NAME,
} from './package-identity';

const packageJson = JSON.parse(
  readFileSync(path.join(import.meta.dir, '..', '..', 'package.json'), 'utf8'),
) as { name: string };

describe('package-identity', () => {
  test('PACKAGE_NAME matches the published package.json name', () => {
    expect(PACKAGE_NAME).toBe(packageJson.name);
  });

  test('STORAGE_NAMESPACE stays on the upstream name so existing installs keep their config, prompt overrides, skills and lane mirror', () => {
    expect(STORAGE_NAMESPACE).toBe('oh-my-opencode-slim');
    expect(STORAGE_NAMESPACE).toBe(UPSTREAM_PACKAGE_NAME);
  });

  test('the storage namespace is independent of the package name', () => {
    // Guards against a future refactor deriving on-disk paths from the npm
    // name, which would orphan every existing config file and override dir.
    expect(STORAGE_NAMESPACE).not.toContain('/');
    expect(STORAGE_NAMESPACE.startsWith('@')).toBe(false);
  });

  test('aliases cover the fork and the upstream package it replaces', () => {
    expect(PACKAGE_NAME_ALIASES).toContain(PACKAGE_NAME);
    expect(PACKAGE_NAME_ALIASES).toContain(UPSTREAM_PACKAGE_NAME);
  });

  test('matchesPluginSpecifier accepts bare and versioned forms of both names', () => {
    expect(matchesPluginSpecifier(PACKAGE_NAME)).toBe(true);
    expect(matchesPluginSpecifier(`${PACKAGE_NAME}@latest`)).toBe(true);
    expect(matchesPluginSpecifier(`${PACKAGE_NAME}@2.3.0`)).toBe(true);
    expect(matchesPluginSpecifier(UPSTREAM_PACKAGE_NAME)).toBe(true);
    expect(matchesPluginSpecifier(`${UPSTREAM_PACKAGE_NAME}@2.2.18`)).toBe(
      true,
    );
    expect(matchesPluginSpecifier(`${UPSTREAM_PACKAGE_NAME}@latest`)).toBe(
      true,
    );
  });

  test('matchesPluginSpecifier rejects unrelated plugins', () => {
    expect(matchesPluginSpecifier('some-other-plugin')).toBe(false);
    expect(matchesPluginSpecifier('oh-my-opencode')).toBe(false);
    expect(matchesPluginSpecifier('@someone-else/oh-my-opencode-slim')).toBe(
      false,
    );
  });

  test('pluginSpecifierVersion extracts the suffix for both names', () => {
    expect(pluginSpecifierVersion(`${PACKAGE_NAME}@2.3.0`)).toBe('2.3.0');
    expect(pluginSpecifierVersion(`${UPSTREAM_PACKAGE_NAME}@beta`)).toBe(
      'beta',
    );
    expect(pluginSpecifierVersion(PACKAGE_NAME)).toBeUndefined();
    expect(pluginSpecifierVersion('unrelated@1.0.0')).toBeUndefined();
  });

  test('takePackageNameSegments spans the scope directory of a bunx path', () => {
    const segments = PACKAGE_NAME.split('/').length;
    const relative = `501-${PACKAGE_NAME}@latest/node_modules/${PACKAGE_NAME}`;
    expect(takePackageNameSegments(relative)).toBe(
      relative.split('/').slice(0, segments).join('/'),
    );
    expect(takePackageNameSegments(relative)).toContain(`${PACKAGE_NAME}@`);
  });

  test('the generated $schema URL resolves inside this package', () => {
    expect(CONFIG_SCHEMA_URL).toContain(`${PACKAGE_NAME}@latest`);
    expect(CONFIG_SCHEMA_URL.endsWith('.schema.json')).toBe(true);
  });

  test('display and repository identity are set', () => {
    expect(DISPLAY_NAME.length).toBeGreaterThan(0);
    expect(GITHUB_REPO).toContain('/');
  });
});
