/**
 * How the plugin learns the URL of the OpenCode server it is running inside.
 *
 * There is no dedicated API for this. The multiplexer already had to solve it
 * to spawn `opencode attach <serverUrl> --session <id>` panes; this module is
 * that logic, extracted so the pane spawner, the lane-control server sidecar
 * (`src/utils/lane-control.ts`) and the `omo lanes` CLI can never disagree
 * about which server they are talking to.
 *
 * Resolution order:
 *   1. `ctx.serverUrl` — present on modern runtimes; may be a getter that is
 *      populated late (the multiplexer re-reads it on every spawn, so this is
 *      a function, never a cached string).
 *   2. the SDK client's own `baseUrl` — the client was constructed against the
 *      live server, so its config is authoritative even when `ctx.serverUrl`
 *      is missing.
 *   3. {@link SERVER_URL_ENV} — last-resort escape hatch, readable by BOTH the
 *      plugin and the CLI, for hosts that expose neither of the above. Only
 *      {@link createLaneServerUrlResolver} consults it; see that function for
 *      why the multiplexer deliberately does not.
 *
 * Every step is individually try/caught: `ctx.serverUrl` is a property access
 * on a host object we do not own, and a throwing getter must not take the
 * plugin down.
 */

/**
 * Escape hatch for hosts that expose no server URL in-process.
 *
 * Set it on the OpenCode server AND read it from the second terminal:
 *   OMO_OPENCODE_SERVER_URL=http://127.0.0.1:4096 opencode
 * The `omo lanes` CLI honours the same variable, so it works without a
 * sidecar file or an explicit `--server`.
 */
export const SERVER_URL_ENV = 'OMO_OPENCODE_SERVER_URL';

/**
 * Accept only absolute http(s) URLs, normalized through `URL`.
 *
 * Returns `null` rather than throwing: every caller treats "no URL" as a
 * skip-this-feature condition, never as an error.
 */
export function validServerUrl(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  try {
    const url = new URL(value.toString());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Dig the `baseUrl` out of an `@opencode-ai/sdk` client.
 *
 * The client keeps its transport on a private `_client` with a `getConfig()`
 * accessor; none of that is in the published types, hence the unknown-shaped
 * reads and the blanket catch. Hostile/proxied clients must not throw out of
 * here — the multiplexer has a regression test for exactly that.
 */
export function clientBaseUrl(client: unknown): string | null {
  try {
    if (!client || typeof client !== 'object' || !('_client' in client)) {
      return null;
    }
    const internal = (client as { _client?: unknown })._client;
    if (
      !internal ||
      typeof internal !== 'object' ||
      !('getConfig' in internal)
    ) {
      return null;
    }
    const getConfig = (internal as { getConfig?: unknown }).getConfig;
    if (typeof getConfig !== 'function') return null;
    const config: unknown = getConfig.call(internal);
    if (!config || typeof config !== 'object' || !('baseUrl' in config)) {
      return null;
    }
    return validServerUrl((config as { baseUrl?: unknown }).baseUrl);
  } catch {
    return null;
  }
}

/** The environment override, validated. */
export function serverUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return validServerUrl(env[SERVER_URL_ENV]?.trim() || undefined);
}

/**
 * Build a resolver for a plugin context (host URL, then SDK client baseUrl).
 *
 * Deliberately returns a FUNCTION: `ctx.serverUrl` can be a getter that only
 * becomes valid after the host finishes binding its listener, so callers must
 * re-resolve at use time instead of capturing a value at construction.
 *
 * This is the multiplexer's resolver and stays env-free on purpose: a wrong
 * {@link SERVER_URL_ENV} would make it attach panes to another project's
 * server, and "no URL" already has a safe meaning there (skip the spawn).
 */
export function createServerUrlResolver(ctx: {
  serverUrl?: unknown;
  client?: unknown;
}): () => string | null {
  return () => {
    try {
      const fromCtx = validServerUrl(ctx.serverUrl);
      if (fromCtx) return fromCtx;
    } catch {
      // A throwing host getter is not a reason to give up on the next source.
    }
    return clientBaseUrl(ctx.client);
  };
}

/**
 * Resolver for lane control: the context sources, then {@link SERVER_URL_ENV}.
 *
 * The env fallback exists for the sidecar because the alternative is not "a
 * slightly wrong URL" but "no `omo lanes` at all": with no in-process URL the
 * plugin cannot publish where it lives, and the user's only recourse is to
 * pass `--server` on every single command. The variable is read from the same
 * name on both sides, so a user who sets it has stated the URL explicitly.
 */
export function createLaneServerUrlResolver(
  ctx: { serverUrl?: unknown; client?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): () => string | null {
  const fromContext = createServerUrlResolver(ctx);
  return () => fromContext() ?? serverUrlFromEnv(env);
}
