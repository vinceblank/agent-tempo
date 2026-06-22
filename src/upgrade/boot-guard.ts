/**
 * #786 — the 2.0 cutover BOOT GUARD (the keystone's centerpiece).
 *
 * A 2.0 Temporal worker can never deterministically replay a 1.x-recorded
 * workflow history — the bundle's command stream has diverged, so a replay
 * faults (or, worse, silently corrupts) deep inside a workflow task. The
 * `upgrade-to-2` cutover (#785) exists to destroy every 1.x run before a 2.0
 * daemon ever polls. This guard is the enforcement: a 2.0 daemon REFUSES to
 * register workers if visibility still shows ANY Running agent-tempo workflow
 * that lacks the protocol-2 stamp.
 *
 * **Stamp source of truth:** every 2.0 workflow upserts the
 * `AgentTempoProtocol` memo = {@link PROTOCOL_VERSION} early + unconditionally
 * on every run (incl. continueAsNew successors) — see `src/workflows/*` and
 * `src/constants.ts`. The memo rides the visibility list result directly
 * ({@link getWorkflowProtocol} reads it off the row), so the scan needs NO
 * per-workflow query. A 1.x run never executes that upsert, so its memo is
 * `undefined` → un-stamped → the guard refuses.
 *
 * **FAIL-CLOSED (the #845 partial-scan lesson):** the scan is bounded by the
 * `protocolGuardBoot` visibility budget. A timeout or any scan error is NOT a
 * best-effort partial — it means "couldn't prove the cutover is clean," and an
 * unverified scan must NEVER be read as clean. Both refuse with
 * {@link ProtocolGuardResult.reason} = `'scan-incomplete'`; the daemon retries
 * on the next boot. The cost of a false-refuse (one retry) is trivial next to
 * the cost of a false-proceed (deterministic history corruption).
 *
 * This module is daemon-side (it holds a Temporal client), distinct from the
 * deliberately SDK-free `snapshot-v1.ts` cross-release contract.
 */
import type { Client, WorkflowExecutionInfo } from '@temporalio/client';
import { PROTOCOL_VERSION } from '../constants';
import { getWorkflowProtocol } from '../utils/search-attributes';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VISIBILITY_DEADLINES_MS,
} from '../utils/visibility-deadline';

/**
 * The four agent-tempo workflow types. A Running workflow of any of these is
 * an agent-tempo coordination workflow that a 2.0 worker would have to replay
 * — so all four must be protocol-2 stamped before boot.
 */
export const AGENT_TEMPO_WORKFLOW_TYPES = [
  'agentSessionWorkflow',
  'agentMaestroWorkflow',
  'agentSchedulerWorkflow',
  'agentGlobalMaestroWorkflow',
] as const;

/** A Running workflow that failed the protocol-2 stamp check. */
export interface ProtocolOffender {
  workflowId: string;
  /** Workflow type name from the visibility row (best-effort). */
  workflowType?: string;
  /** The stamp read from the row's memo — `undefined` for an un-stamped 1.x run. */
  protocol: number | undefined;
}

/** Outcome of {@link checkProtocolGuard}. */
export interface ProtocolGuardResult {
  /** `true` → every Running agent-tempo workflow is protocol-2 stamped (or none exist). */
  ok: boolean;
  /**
   * Why boot was refused. Only set when `ok` is `false`.
   *   - `'unstamped'` — at least one Running workflow lacks the protocol-2 stamp
   *     (a 1.x run survived the cutover). See {@link offenders}.
   *   - `'scan-incomplete'` — the visibility scan timed out or errored before
   *     completing, so cleanliness could not be PROVEN (fail-closed).
   */
  reason?: 'unstamped' | 'scan-incomplete';
  /** Number of Running agent-tempo workflows examined before the result. */
  scanned: number;
  /** Un-stamped offenders (only when `reason === 'unstamped'`). */
  offenders: ProtocolOffender[];
  /** Operator-facing explanation (always set on refusal). */
  message?: string;
}

/** Injectable seams for {@link checkProtocolGuard} — production callers omit. */
export interface ProtocolGuardDeps {
  /**
   * Returns the visibility iterable for the guard query. Defaults to
   * `client.workflow.list({ query })`. Tests inject a crafted async iterable
   * of `WorkflowExecutionInfo`-shaped rows (only `workflowId`, `type`, `memo`
   * are read) without a live Temporal connection.
   */
  listWorkflows?: (query: string) => AsyncIterable<WorkflowExecutionInfo>;
  /** Scan deadline. Default {@link VISIBILITY_DEADLINES_MS.protocolGuardBoot}. */
  deadlineMs?: number;
  /** Injectable clock — forwarded to {@link iterateWithDeadline}. Default `Date.now`. */
  now?: () => number;
  /** Log sink. Default no-op (the daemon caller logs the structured result). */
  log?: (...args: unknown[]) => void;
}

/**
 * Build the namespace-scoped visibility query for the guard. The client is
 * already namespace-scoped, so no namespace clause is needed. Exposed for
 * test introspection.
 */
export function buildProtocolGuardQuery(): string {
  const types = AGENT_TEMPO_WORKFLOW_TYPES.map((t) => `"${t}"`).join(', ');
  return `WorkflowType IN (${types}) AND ExecutionStatus = "Running"`;
}

/**
 * Scan every Running agent-tempo workflow and verify each carries the
 * protocol-2 stamp. See the module header for the fail-closed contract.
 *
 * Never throws — every failure (un-stamped run, scan timeout, scan error) is
 * returned as a structured `ok: false` result so the daemon caller decides how
 * to surface it (it prints + `process.exit(1)`).
 */
export async function checkProtocolGuard(
  client: Client,
  deps: ProtocolGuardDeps = {},
): Promise<ProtocolGuardResult> {
  const log = deps.log ?? (() => {});
  const deadlineMs = deps.deadlineMs ?? VISIBILITY_DEADLINES_MS.protocolGuardBoot;
  const query = buildProtocolGuardQuery();
  const listWorkflows =
    deps.listWorkflows ?? ((q: string) => client.workflow.list({ query: q }));

  const offenders: ProtocolOffender[] = [];
  let scanned = 0;

  try {
    for await (const wf of iterateWithDeadline(
      listWorkflows(query),
      deadlineMs,
      'protocolGuardBoot',
      deps.now,
    )) {
      scanned++;
      const protocol = getWorkflowProtocol(wf);
      if (protocol !== PROTOCOL_VERSION) {
        offenders.push({
          workflowId: wf.workflowId,
          // `WorkflowExecutionInfo.type` is the workflow type name string.
          workflowType: (wf as { type?: string }).type,
          protocol,
        });
      }
    }
  } catch (err) {
    // FAIL-CLOSED: a timeout OR any other scan error means we could not prove
    // the namespace is clean. Refuse — never proceed on an unverified scan.
    const kind = isVisibilityTimeout(err) ? 'timed out' : 'failed';
    const detail = err instanceof Error ? err.message : String(err);
    const message =
      `agent-tempo 2.0 boot guard could NOT verify a clean cutover — the ` +
      `protocol scan ${kind} after ${scanned} workflow(s): ${detail}. ` +
      `Refusing to boot (fail-closed): a 2.0 worker cannot safely replay a ` +
      `1.x history. Retry once the Temporal namespace is responsive; if this ` +
      `persists, run \`agent-tempo upgrade-to-2\` to complete the cutover.`;
    log(`[boot-guard] scan-incomplete: ${message}`);
    return { ok: false, reason: 'scan-incomplete', scanned, offenders, message };
  }

  if (offenders.length > 0) {
    const sample = offenders
      .slice(0, 5)
      .map((o) => `  - ${o.workflowId} (protocol=${o.protocol ?? 'v1/unset'})`)
      .join('\n');
    const more = offenders.length > 5 ? `\n  …and ${offenders.length - 5} more` : '';
    const message =
      `agent-tempo 2.0 boot guard REFUSED to boot: ${offenders.length} of ` +
      `${scanned} Running agent-tempo workflow(s) are not protocol-${PROTOCOL_VERSION} ` +
      `(2.0) stamped — these are pre-cutover 1.x runs that a 2.0 worker cannot ` +
      `safely replay:\n${sample}${more}\n` +
      `Complete the cutover with \`agent-tempo upgrade-to-2\` (it snapshots ` +
      `continuity, then destroys the 1.x runs), then restart the daemon.`;
    log(`[boot-guard] unstamped: refusing (${offenders.length}/${scanned} un-stamped)`);
    return { ok: false, reason: 'unstamped', scanned, offenders, message };
  }

  log(`[boot-guard] clean: ${scanned} Running agent-tempo workflow(s), all protocol-${PROTOCOL_VERSION} stamped`);
  return { ok: true, scanned, offenders: [] };
}
