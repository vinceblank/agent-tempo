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
 * Structural shape of objects carrying a workflow memo alongside search
 * attributes — matches `WorkflowExecutionInfo` (from `client.workflow.list()`)
 * and `WorkflowExecutionDescription` (from `handle.describe()`), whose `memo`
 * is the decoded `Record<string, unknown>`.
 *
 * T0.5 (#747): the read-only metadata fields (`gitRoot`, `playerType`,
 * `isConductor`, plus `part`) migrated from search attributes to the workflow
 * memo. The dual-read helpers below prefer the memo (new runs) and fall back
 * to the legacy search attribute (runs started before the v1.8-sa-diet patch)
 * — this file is the single choke point for that migration window.
 */
export interface WorkflowMetaCarrier extends SearchAttributeCarrier {
  memo?: Record<string, unknown>;
}

/**
 * Canonical memo key names (T0.5, #747) — single registry shared by every
 * write site (session workflow, the five `client.workflow.start({ memo })`
 * seeds) and the dual-read helpers below, so a key can never silently
 * drift between writer and reader. Wire-stable: renaming a key is a
 * breaking change (docs/WIRE-PROTOCOL.md §Workflow memo).
 *
 * This module is intentionally dependency-free (only a type import), so
 * the workflow bundle can import these constants safely.
 */
export const MEMO_KEYS = {
  gitRoot: 'AgentTempoGitRoot',
  playerType: 'AgentTempoPlayerType',
  isConductor: 'AgentTempoIsConductor',
  part: 'AgentTempoPart',
} as const;

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

// ── T0.5 (#747) — memo readers + dual-read (memo preferred, SA fallback) ──

/** Read a memo value as a string. `undefined` when absent or non-string. */
export function getMemoString(
  carrier: WorkflowMetaCarrier,
  name: string,
): string | undefined {
  const v = carrier.memo?.[name];
  return typeof v === 'string' ? v : undefined;
}

/** Read a memo value as a boolean. `undefined` when absent or non-boolean. */
export function getMemoBool(
  carrier: WorkflowMetaCarrier,
  name: string,
): boolean | undefined {
  const v = carrier.memo?.[name];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Dual-read a string field: memo first (runs started on or after the
 * v1.8-sa-diet patch), legacy search attribute as fallback (older runs).
 *
 * TODO(next major): remove the SA fallback chain here and in
 * {@link getWorkflowMetaBool}, and drop `LEGACY_SEARCH_ATTRIBUTES` in
 * `src/cli/sa-preflight.ts` — see #747 and docs/ops/sa-diet-migration.md.
 */
export function getWorkflowMetaString(
  carrier: WorkflowMetaCarrier,
  name: string,
): string | undefined {
  return getMemoString(carrier, name) ?? getSearchAttrString(carrier, name);
}

/** Dual-read a boolean field — memo preferred, SA fallback. */
export function getWorkflowMetaBool(
  carrier: WorkflowMetaCarrier,
  name: string,
): boolean | undefined {
  return getMemoBool(carrier, name) ?? getSearchAttrBool(carrier, name);
}

// ── Typed wrappers for agent-tempo's custom search attributes ──
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
 * Read the conductor flag — memo `AgentTempoIsConductor` preferred (T0.5),
 * legacy search attribute as fallback for pre-v1.8 runs.
 *
 * Returns `undefined` when absent in both (e.g. transiently un-indexed after
 * a conductor spawn). Callers wanting the pre-#178 workflow-id-suffix
 * fallback (`endsWith('-conductor')`) should apply it on `undefined`.
 */
export function getIsConductor(
  carrier: WorkflowMetaCarrier,
): boolean | undefined {
  return getWorkflowMetaBool(carrier, MEMO_KEYS.isConductor);
}

/**
 * Read the player type — memo `AgentTempoPlayerType` preferred (T0.5),
 * legacy search attribute as fallback for pre-v1.8 runs. Callers keep their
 * existing workflow-id-suffix fallback (`endsWith('-maestro')`) on
 * `undefined`.
 */
export function getPlayerType(
  carrier: WorkflowMetaCarrier,
): string | undefined {
  return getWorkflowMetaString(carrier, MEMO_KEYS.playerType);
}

/**
 * Read the player's part from the memo (`AgentTempoPart`). Memo-only —
 * part was never a search attribute, so there is no SA fallback; returns
 * `undefined` for runs started before the v1.8-sa-diet patch (callers fall
 * back to the `getPart` workflow query). Added for T0.1's observation-path
 * read (#748).
 */
export function getPart(
  carrier: WorkflowMetaCarrier,
): string | undefined {
  return getMemoString(carrier, MEMO_KEYS.part);
}
