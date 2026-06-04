/**
 * Operator-gate audit writer (3d / MD-G, R5 — security-locked) — the daemon's
 * append-only JSONL sink for {@link GateRegistry} events. One file per player at
 *
 *   <AGENT_TEMPO_HOME>/gate-audit/<ensemble>/<workflowId>.jsonl
 *
 * Each {@link GateAuditRecord} (arm | disarm | decision) is one JSON line,
 * appended SYNCHRONOUSLY at the decision/posture-change point so the durable
 * record lands before the daemon hands back control (no buffering window where a
 * crash loses an allow/deny). The `ensemble` sidecar (not part of the locked
 * record schema) only paths the file.
 *
 * Daemon-side ONLY. The writer is wired as the GateRegistry's audit sink in
 * `daemon.ts`; failures are swallowed + logged (audit is best-effort durable —
 * never let an append error break a live gate decision).
 */
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_TEMPO_HOME } from '../config';
import type { GateAuditRecord, GateAuditSink } from './gate-registry';

const log = (...args: unknown[]): void => console.error('[agent-tempo:gate-audit]', ...args);

/** Root of the per-player gate-audit tree. */
export function gateAuditRoot(): string {
  return path.join(AGENT_TEMPO_HOME, 'gate-audit');
}

/**
 * Sanitize a single path segment (ensemble / workflowId) so a crafted name can't
 * traverse out of the audit root. Ensemble + workflowId are already validated
 * upstream (ENSEMBLE_NAME_REGEX / the workflowId is daemon-built), but defend the
 * filesystem boundary anyway: strip anything outside `[A-Za-z0-9._-]`, collapse
 * to a non-empty token.
 */
function safeSegment(seg: string): string {
  const cleaned = seg.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/** Absolute JSONL path for a (ensemble, workflowId) pair under `root`. */
export function gateAuditPath(ensemble: string, workflowId: string, root: string = gateAuditRoot()): string {
  return path.join(root, safeSegment(ensemble || '_'), `${safeSegment(workflowId)}.jsonl`);
}

/**
 * Build the daemon's audit sink. Returns a {@link GateAuditSink} that appends one
 * JSON line per record. Append + mkdir are synchronous (durable-before-return);
 * any I/O error is logged + swallowed so a disk problem never wedges a gate
 * decision. `root` is injectable for tests (defaults to {@link gateAuditRoot}).
 */
export function createGateAuditSink(root: string = gateAuditRoot()): GateAuditSink {
  return (record: GateAuditRecord, ensemble: string): void => {
    try {
      const file = gateAuditPath(ensemble, record.workflowId, root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      log('append failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  };
}
