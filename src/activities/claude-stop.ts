/**
 * #596 / ADR 0016 — `claude stop <shortId>` per-host activity.
 *
 * `claude --bg` hands the session to Anthropic's per-user Claude Code
 * supervisor. We don't own the PID anymore (the supervisor does), so the
 * existing `hard-terminate` PID-scan helper would always return
 * `strategy: 'none'` and leak the supervisor job. Instead, ask the
 * supervisor to stop the job via its documented CLI verb.
 *
 * **Routing**: registered on the per-host activity queue
 * (`agent-tempo-{hostname}`) so the `claude` CLI runs on the same machine
 * the supervisor lives on. The workflow proxy in `src/workflows/session.ts`
 * picks the right host via `AgentTempoHostname` exactly the same way
 * `hardTerminateAttachment` already does.
 *
 * **Idempotency**: `claude stop` exits 1 with `No job matching '<id>'` when
 * the job is already gone. We classify that as success — destroy must be
 * idempotent and a re-run of an already-stopped session is a normal flow.
 * Any other non-zero exit (network/socket failure, supervisor itself wedged,
 * unexpected CLI shape) is reported as `success: false` so the workflow's
 * destroy path can fall back to the existing `hardTerminateAttachment`
 * PID-scan as defense in depth.
 *
 * **Timing**: 15-second timeout. The supervisor responds in <100ms on a
 * healthy host, but Windows process-spawn overhead and antivirus scanners
 * can stretch the worst case. 15s leaves slack without holding up destroy.
 */
import { spawnSync } from 'child_process';
import { ApplicationFailure } from '@temporalio/activity';
import { resolveClaudePath } from '../spawn';

const log = (...args: unknown[]) => console.error('[agent-tempo:claude-stop]', ...args);

export interface ClaudeStopInput {
  /** Supervisor's 8-char short id from `SessionMetadata.bgShortId`. */
  shortId: string;
  /** Custom claude binary path (defaults to `'claude'` on PATH). */
  claudeBin?: string;
}

export interface ClaudeStopResult {
  success: boolean;
  /** One of `'stopped'` | `'already-gone'` | `'error'`. */
  outcome: 'stopped' | 'already-gone' | 'error';
  /** Populated on `outcome === 'error'` — the raw stderr/stdout snippet for diagnostics. */
  detail?: string;
  /** Exit code from `claude stop`. Undefined on spawn-side failure. */
  exitCode?: number;
}

/**
 * Validate the supervisor short id before shelling out. Anthropic uses
 * lowercase hex from the full UUID's first 8 chars; reject anything else
 * to avoid passing user-influenced strings into argv.
 */
function isValidShortId(s: string): boolean {
  return typeof s === 'string' && /^[0-9a-f]{8}$/.test(s);
}

/**
 * Invoke `claude stop <shortId>` synchronously. Never throws — returns a
 * structured `ClaudeStopResult` the workflow can act on. Routes through
 * `resolveClaudePath` so the `claudeBin` config option is honoured.
 */
export async function claudeStop(input: ClaudeStopInput): Promise<ClaudeStopResult> {
  const { shortId, claudeBin } = input;
  if (!isValidShortId(shortId)) {
    throw ApplicationFailure.nonRetryable(
      `claudeStop: invalid shortId "${shortId}" (must be 8 lowercase hex chars). ` +
        `This indicates corrupt SessionMetadata.bgShortId — check the recruit path.`,
    );
  }
  const bin = resolveClaudePath(claudeBin);

  let result;
  try {
    result = spawnSync(bin, ['stop', shortId], {
      encoding: 'utf8',
      timeout: 15_000,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`claude stop ${shortId} failed to launch: ${detail}`);
    return { success: false, outcome: 'error', detail };
  }

  if (result.error) {
    log(`claude stop ${shortId} spawn error: ${result.error.message}`);
    return { success: false, outcome: 'error', detail: result.error.message };
  }

  const exitCode = result.status ?? -1;
  const stderr = (result.stderr || '').toString();
  const stdout = (result.stdout || '').toString();
  const combined = `${stderr}\n${stdout}`.trim();

  if (exitCode === 0) {
    log(`claude stop ${shortId} → stopped`);
    return { success: true, outcome: 'stopped', exitCode };
  }

  // Anthropic's "already gone" signal — exit 1 with `No job matching '<id>'`
  // somewhere in the combined output. Match case-insensitively to absorb
  // small phrasing drift across CLI versions.
  if (/no job matching/i.test(combined)) {
    log(`claude stop ${shortId} → already-gone (exit ${exitCode}, idempotent success)`);
    return { success: true, outcome: 'already-gone', exitCode };
  }

  log(`claude stop ${shortId} → error (exit ${exitCode}): ${combined || '(no output)'}`);
  return {
    success: false,
    outcome: 'error',
    exitCode,
    detail: combined || `exit ${exitCode} with no output`,
  };
}
