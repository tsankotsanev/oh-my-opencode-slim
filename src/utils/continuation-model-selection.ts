import { isRecord as isObjectRecord } from './guards';

/**
 * Shared by the plugin (idle continuation, orchestrator wake, `task_message`)
 * and by the `omos lanes` CLI, which must pin a lane's model before prompting
 * it. It lives in `src/utils/` precisely so both can reach it: `src/cli/` must
 * not import from `src/hooks/`, and a second copy of this normalizer would
 * drift the moment a host changed its model shape.
 */
export type ContinuationModelSelection = {
  model: {
    providerID: string;
    modelID: string;
  };
  variant?: string;
};

/**
 * Normalize the two runtime model shapes used across supported OpenCode
 * versions:
 * - chat.message / promptAsync: { providerID, modelID }
 * - current Session.model:      { providerID, id }
 */
export function parseContinuationModelSelection(
  value: unknown,
  variantOverride?: unknown,
): ContinuationModelSelection | undefined {
  if (!isObjectRecord(value)) return undefined;

  const providerID =
    typeof value.providerID === 'string' && value.providerID.length > 0
      ? value.providerID
      : undefined;
  const modelID =
    typeof value.modelID === 'string' && value.modelID.length > 0
      ? value.modelID
      : typeof value.id === 'string' && value.id.length > 0
        ? value.id
        : undefined;
  if (!providerID || !modelID) return undefined;

  const variant =
    typeof variantOverride === 'string' && variantOverride.length > 0
      ? variantOverride
      : typeof value.variant === 'string' && value.variant.length > 0
        ? value.variant
        : undefined;

  return {
    model: { providerID, modelID },
    ...(variant ? { variant } : {}),
  };
}
