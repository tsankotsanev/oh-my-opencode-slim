/**
 * Single source of truth for this package's NPM/repository identity.
 *
 * TWO DISTINCT NAMESPACES live in this codebase and MUST NOT be conflated:
 *
 * 1. `PACKAGE_NAME` — the npm package identity. Everything that talks to a
 *    registry, resolves `node_modules`, matches an `opencode.json` plugin
 *    entry, or prints an install command must use this. On the fork channel
 *    it is scoped, so an auto-update can never pull the upstream package
 *    over this one.
 *
 * 2. `STORAGE_NAMESPACE` — the on-disk namespace: `oh-my-opencode-slim.json[c]`
 *    config files, the `~/.config/opencode/oh-my-opencode-slim/` prompt-override
 *    directory, `opencode/storage/oh-my-opencode-slim/**` XDG data (including the
 *    background-jobs lane mirror), log file prefixes, the skills registry entry,
 *    cmux/TUI state, `.opencode/oh-my-opencode-slim.json` project overrides, and
 *    the plugin `id`/`name` reported to the OpenCode host. This value is
 *    DELIBERATELY unchanged from upstream: an existing install's config,
 *    prompt overrides, skills and lane mirror must keep working after
 *    switching to the fork channel. NEVER derive it from `PACKAGE_NAME`.
 *
 * This module must stay dependency-free (it is imported by the plugin bundle,
 * the TUI bundle and the CLI) — do not add imports.
 */

/** The npm package this build is published as. Kept in sync with package.json by a test. */
export const PACKAGE_NAME = '@whitez/oh-my-opencode-slim';

/** The upstream package this fork descends from. Accepted as an alias when DETECTING an install. */
export const UPSTREAM_PACKAGE_NAME = 'oh-my-opencode-slim';

/**
 * Names that identify "this plugin" when inspecting an existing install.
 *
 * Used for duplicate detection and for replacing a previous entry, so that
 * `omos install` over an upstream install upgrades in place instead of leaving
 * two copies of the plugin registered. WRITE paths always use `PACKAGE_NAME`.
 */
export const PACKAGE_NAME_ALIASES: readonly string[] = [
  PACKAGE_NAME,
  UPSTREAM_PACKAGE_NAME,
];

/**
 * On-disk namespace for config, prompt overrides, storage, logs and the plugin id.
 * Intentionally NOT the package name — see the module header.
 */
export const STORAGE_NAMESPACE = 'oh-my-opencode-slim';

/** Short product name used in the TUI sidebar and update notifications. */
export const DISPLAY_NAME = 'OMO-Slim';

/** `owner/repo` for this fork channel. */
export const GITHUB_REPO = 'tsankotsanev/oh-my-opencode-slim';

export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

/**
 * `$schema` URL written into generated user configs. Must point at THIS package:
 * the upstream schema does not describe the fork-only keys (silenceDetection,
 * staleAfterMs, laneControl, reviveOnCascade).
 */
export const CONFIG_SCHEMA_URL = `https://unpkg.com/${PACKAGE_NAME}@latest/${STORAGE_NAMESPACE}.schema.json`;

/** Number of path segments in the package name (2 when scoped). */
const PACKAGE_NAME_SEGMENTS = PACKAGE_NAME.split('/').length;

/**
 * Extracts the leading directory of a bunx cache path that names this package.
 *
 * A scoped package name contains a `/`, so bun's `bunx-<uid>-<name>@<tag>`
 * directory can span two path segments. Callers pass the path already
 * normalized to forward slashes and already sliced past the `bunx-` marker.
 */
export function takePackageNameSegments(relativePath: string): string {
  return relativePath.split('/').slice(0, PACKAGE_NAME_SEGMENTS).join('/');
}

/**
 * True when a plugin specifier from an `opencode.json` `plugin` array refers to
 * this plugin — either the fork name or the upstream name it replaces, bare or
 * with an `@version`/`@tag` suffix.
 */
export function matchesPluginSpecifier(spec: string): boolean {
  return PACKAGE_NAME_ALIASES.some(
    (name) => spec === name || spec.startsWith(`${name}@`),
  );
}

/**
 * Strips a matching `<name>@` prefix and returns the version/tag suffix,
 * or `undefined` when the specifier does not name this plugin (or is bare).
 */
export function pluginSpecifierVersion(spec: string): string | undefined {
  for (const name of PACKAGE_NAME_ALIASES) {
    if (spec.startsWith(`${name}@`)) {
      return spec.slice(name.length + 1) || undefined;
    }
  }
  return undefined;
}
