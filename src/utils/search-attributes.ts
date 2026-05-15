/**
 * Reusable helpers for extracting Temporal search attributes from
 * `WorkflowExecutionInfo` (from `client.workflow.list()` iteration) and
 * `WorkflowExecutionDescription` (from `handle.describe()`).
 *
 * Extracted per issue #203 to eliminate the inline
 * `arr = wf.searchAttributes?.<Attr>; first = Array.isArray(arr) ? arr[0] : undefined`
 * pattern previously duplicated across 9 call sites.
 *
 * Kept free of `@temporalio/client` imports — the `SearchAttributeCarrier`
 * type is structural. That keeps this util reusable from tests and future
 * call sites without dragging the Temporal client dependency in.
 */
import { AttachmentPhase } from '../types';

/**
 * Structural shape of objects carrying Temporal search attributes.
 *
 * Matches both `WorkflowExecutionInfo` and `WorkflowExecutionDescription`
 * without depending on Temporal SDK types. The underlying JSON shape is a
 * `Record<string, ReadonlyArray<unknown> | undefined>` — the SDK preserves
 * the list shape even for single-value attributes like ensemble name or
 * phase, and exposes it with `readonly` arrays (so this type uses
 * `ReadonlyArray` to stay assignable from the Temporal SDK's
 * `SearchAttributes` type).
 */
export interface SearchAttributeCarrier {
  searchAttributes?: Record<string, ReadonlyArray<unknown> | undefined>;
}

/**
 * Read the first element of a search-attribute array as a string.
 *
 * Returns `undefined` when any of these holds:
 * - The carrier has no `searchAttributes` object.
 * - The named attribute is absent.
 * - The attribute value is not an array.
 * - The array is empty.
 *
 * Non-string values are coerced via `String(v)` — matches the legacy
 * inline pattern (`String(vals[0])`) at the migrated call sites.
 */
export function getSearchAttrString(
  carrier: SearchAttributeCarrier,
  name: string,
): string | undefined {
  const arr = carrier.searchAttributes?.[name];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const v = arr[0];
  return typeof v === 'string' ? v : String(v);
}

/**
 * Read the first element of a search-attribute array as a boolean.
 *
 * Returns `undefined` when the attribute is missing or non-boolean-shaped.
 * Tolerates string representations (`"true"` / `"false"`) that some
 * Temporal client versions have been known to surface instead of native
 * booleans — same forgiveness policy as the legacy inline pattern.
 */
export function getSearchAttrBool(
  carrier: SearchAttributeCarrier,
  name: string,
): boolean | undefined {
  const arr = carrier.searchAttributes?.[name];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const v = arr[0];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

// ── Typed wrappers for claude-tempo's custom search attributes ──
//
// Keeping one wrapper per attribute gives callers a readable, typed API
// without re-stating the attribute name at every site. Adding a fourth
// attribute (e.g. `AgentTempoHost`) later follows the same pattern.

/**
 * Read the attachment phase from `AgentTempoAttachmentState`.
 *
 * Post-#175 this is the canonical lifecycle state (replaced the v0.25
 * `AgentTempoStatus` heuristic). Returns `undefined` when the attribute is
 * missing — typically during the brief post-start window before the
 * workflow has written its first phase transition, or for workflows that
 * predate the attachment-lifecycle rework.
 */
export function getAttachmentPhase(
  carrier: SearchAttributeCarrier,
): AttachmentPhase | undefined {
  return getSearchAttrString(carrier, 'AgentTempoAttachmentState') as
    | AttachmentPhase
    | undefined;
}

/**
 * Read the ensemble name from `AgentTempoEnsemble`.
 *
 * Returns `undefined` when the attribute is absent — callers typically
 * treat that as "skip this session" since every session workflow should
 * set the attribute on start.
 */
export function getEnsembleName(
  carrier: SearchAttributeCarrier,
): string | undefined {
  return getSearchAttrString(carrier, 'AgentTempoEnsemble');
}

/**
 * Read the conductor flag from `AgentTempoIsConductor`.
 *
 * Returns `undefined` when absent (e.g. transiently un-indexed after a
 * conductor spawn). Callers wanting the pre-#178 workflow-id-suffix
 * fallback (`endsWith('-conductor')`) should apply it on `undefined`.
 */
export function getIsConductor(
  carrier: SearchAttributeCarrier,
): boolean | undefined {
  return getSearchAttrBool(carrier, 'AgentTempoIsConductor');
}
