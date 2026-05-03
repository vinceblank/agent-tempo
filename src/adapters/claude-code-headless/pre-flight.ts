/**
 * Pre-flight probes for the claude-code-headless adapter.
 *
 * Two checks, both invoked from `src/tools/recruit.ts` before submitting the
 * spawn outbox entry; both also re-used by the daemon boot probe (PR-2) so
 * cross-host recruit can fail fast against an unconfigured host.
 *
 *   1. **Binary probe** — `claude --version` exits 0 within 3s. Catches the
 *      "Claude Code not installed" case with an actionable error, distinct
 *      from "logged out" (#2 below).
 *   2. **Auth probe** — `claude auth status` exits 0 within 5s and emits a
 *      JSON envelope with `loggedIn: true`. Confirms the host's Claude Code
 *      CLI has a usable OAuth session — which is the whole point of this
 *      adapter (subscription extra-usage credits, design §1).
 *
 * Both probes are pure observers — they make NO billed API call and NO
 * subprocess that registers as an ensemble player. The auth probe is an
 * official `claude auth` subcommand; the version probe is a one-line
 * `--version` invocation.
 *
 * Spike findings (issue #520 §11.3, captured 2026-05-02): `claude auth
 * status` outputs JSON in all logged-in states; exit code is 0 even when
 * logged out, so the boolean `loggedIn` field is the source of truth.
 *
 * Design reference: `docs/design/520-claude-code-headless-adapter.md`
 *   §3.4 (recruit pre-flight contract)
 *   §11.3 (auth-status parser fixtures)
 */
import { spawnSync } from 'child_process';

/** Result of {@link probeClaudeBinary} — combined version + presence info. */
export interface BinaryProbeResult {
  /** True if `claude --version` exited 0 within the timeout. */
  ok: boolean;
  /** Reported version string (e.g. `"2.1.126"`) when `ok`; undefined otherwise. */
  version?: string;
  /** Operator-actionable error string when `ok === false`. */
  error?: string;
}

/** Result of {@link probeClaudeAuth} — parsed `claude auth status` envelope. */
export interface AuthProbeResult {
  /** True iff the CLI reports `loggedIn: true`. */
  loggedIn: boolean;
  /** `'claude.ai'` (subscription) | `'api-token'` (long-lived OAuth) | other CLI string. Undefined when logged out. */
  authMethod?: string;
  /** `'firstParty'` (Anthropic direct) | other (Bedrock, Vertex, …). */
  apiProvider?: string;
  /** Operator-actionable error string when the probe failed (timeout, parse error, exit non-zero). */
  error?: string;
}

const VERSION_PROBE_TIMEOUT_MS = 3_000;
const AUTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe whether `claude --version` is callable on the host PATH and returns
 * a parseable version string. Bounded by {@link VERSION_PROBE_TIMEOUT_MS} so
 * a hung binary can't stall the recruit pre-flight.
 *
 * Returns `{ ok: false, error }` for missing binary, hung process, or
 * non-zero exit. The error string is operator-actionable (mentions both
 * "install" and "PATH" so the user knows where to start).
 */
export function probeClaudeBinary(claudeBin = 'claude'): BinaryProbeResult {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(claudeBin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      // shell: false on Windows — npm-installed `claude` is a `.cmd` shim;
      // spawnSync's `shell: false` path won't find it. Workaround: call via
      // `cmd.exe /c` on Windows so the shim resolves.
      shell: false,
    });
  } catch (err) {
    return {
      ok: false,
      error: `\`${claudeBin} --version\` failed to spawn: ${(err as Error)?.message ?? err}. Install Claude Code (https://claude.com/download) and ensure \`${claudeBin}\` is on PATH.`,
    };
  }

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Try Windows `.cmd` fallback — npm-installed CLI binaries land as `.cmd`
    // shims that bare spawnSync without shell can't resolve.
    if (process.platform === 'win32' && claudeBin === 'claude') {
      const winResult = spawnSync('cmd.exe', ['/c', 'claude', '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: VERSION_PROBE_TIMEOUT_MS,
      });
      if (winResult.status === 0) {
        const version = (winResult.stdout?.toString('utf8') ?? '').trim();
        return { ok: true, version: parseVersion(version) };
      }
    }
    return {
      ok: false,
      error: `\`${claudeBin}\` not found on PATH. Install Claude Code (https://claude.com/download) and verify \`which ${claudeBin}\` resolves.`,
    };
  }

  // spawnSync sets `signal: 'SIGTERM'` on timeout; status is null in that case.
  if (result.signal === 'SIGTERM' || (result.status === null && result.signal !== null)) {
    return {
      ok: false,
      error: `\`${claudeBin} --version\` timed out after ${VERSION_PROBE_TIMEOUT_MS}ms. The binary may be hung or stuck on a first-run prompt; try \`${claudeBin} --version\` interactively first.`,
    };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr?.toString('utf8') ?? '').trim().slice(0, 200);
    return {
      ok: false,
      error: `\`${claudeBin} --version\` exited ${result.status}${stderr ? `: ${stderr}` : ''}.`,
    };
  }

  const version = parseVersion((result.stdout?.toString('utf8') ?? '').trim());
  return { ok: true, version };
}

/**
 * Probe whether the host's Claude Code CLI is logged in to an Anthropic
 * account. Calls `claude auth status` — an official supported subcommand
 * that does NOT make a billed API call.
 *
 * Per spike findings (#520 §11.3), exit code is 0 in all cases — the
 * boolean `loggedIn` field in the JSON envelope is the source of truth.
 *
 * Returns `{ loggedIn: false, error }` for: not-logged-in, malformed JSON,
 * timeout, or spawn failure. Caller surfaces `error` actionably.
 */
export function probeClaudeAuth(claudeBin = 'claude'): AuthProbeResult {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(claudeBin, ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: AUTH_PROBE_TIMEOUT_MS,
      shell: false,
    });
  } catch (err) {
    return {
      loggedIn: false,
      error: `\`${claudeBin} auth status\` failed to spawn: ${(err as Error)?.message ?? err}.`,
    };
  }

  // Windows .cmd shim fallback (mirrors probeClaudeBinary). Per QA Nit 2 from
  // PR-1's review: explicitly check whether the cmd.exe fallback also failed,
  // so the error copy stays "not found on PATH" instead of degrading to the
  // generic "produced no output" the parser would otherwise emit on empty stdout.
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    if (process.platform === 'win32' && claudeBin === 'claude') {
      result = spawnSync('cmd.exe', ['/c', 'claude', 'auth', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: AUTH_PROBE_TIMEOUT_MS,
      });
      if (result.status !== 0 && (!result.stdout || result.stdout.length === 0)) {
        const stderr = (result.stderr?.toString('utf8') ?? '').trim().slice(0, 200);
        return {
          loggedIn: false,
          error: `\`${claudeBin}\` not found on PATH (cmd.exe shim also failed: ${stderr || `exit ${result.status}`}).`,
        };
      }
    } else {
      return { loggedIn: false, error: `\`${claudeBin}\` not found on PATH.` };
    }
  }

  if (result.signal === 'SIGTERM' || (result.status === null && result.signal !== null)) {
    return {
      loggedIn: false,
      error: `\`${claudeBin} auth status\` timed out after ${AUTH_PROBE_TIMEOUT_MS}ms.`,
    };
  }

  const stdout = (result.stdout?.toString('utf8') ?? '').trim();
  return parseAuthStatusOutput(stdout, result.status, claudeBin);
}

/**
 * Parse a `claude auth status` stdout envelope. Exported for unit tests
 * that load fixtures from `tests/adapters/fixtures/claude-code-headless/`.
 *
 * Per spike findings, the schema is JSON `{loggedIn, authMethod?, apiProvider?, ...}`.
 * Logged-out variant is `{loggedIn: false}`. We tolerate trailing whitespace
 * and missing optional fields.
 */
export function parseAuthStatusOutput(
  stdout: string,
  exitStatus: number | null,
  claudeBin = 'claude',
): AuthProbeResult {
  if (!stdout) {
    return {
      loggedIn: false,
      error: `\`${claudeBin} auth status\` produced no output (exit=${exitStatus}).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      loggedIn: false,
      error: `Failed to parse \`${claudeBin} auth status\` JSON output: ${(err as Error)?.message ?? err}. First 200 bytes: ${stdout.slice(0, 200)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      loggedIn: false,
      error: `\`${claudeBin} auth status\` returned non-object JSON: ${stdout.slice(0, 200)}`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const loggedIn = obj.loggedIn === true;
  const authMethod = typeof obj.authMethod === 'string' ? obj.authMethod : undefined;
  const apiProvider = typeof obj.apiProvider === 'string' ? obj.apiProvider : undefined;
  if (!loggedIn) {
    return {
      loggedIn: false,
      error: `\`${claudeBin}\` is installed but not logged in. Run \`${claudeBin} auth login\` (subscription) or \`${claudeBin} auth setup-token\` (CI/long-lived OAuth), or recruit with \`agent: 'claude-api'\` to use a Console API key instead.`,
    };
  }
  return { loggedIn: true, authMethod, apiProvider };
}

/**
 * Parse the version string from `claude --version` stdout. The CLI prints
 * `"2.1.126 (Claude Code)"` — we keep just the dotted-number prefix so
 * downstream comparators work cleanly.
 */
function parseVersion(raw: string): string | undefined {
  const m = raw.match(/^(\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.]+)?)/);
  return m ? m[1] : raw || undefined;
}
