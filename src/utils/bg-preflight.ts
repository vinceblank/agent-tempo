/**
 * #596 / ADR 0016 — permission preflight for `claude --bg`.
 *
 * Anthropic's per-user supervisor refuses bypass modes
 * (`--dangerously-skip-permissions`) that were never accepted interactively
 * in the target cwd. The bypass-consent record is NOT transparently readable
 * on disk (not in `~/.claude/settings*.json`, not in
 * `~/.claude/projects/<encoded-cwd>/`), so a behavioral probe is the most
 * robust signal.
 *
 * **Surprise observed during live E2E** (documented for ADR follow-up):
 * `claude --bg --dangerously-skip-permissions --help` does NOT short-circuit
 * on `--help` — the supervisor adopts the session FIRST then processes the
 * help flag. So a "dry-run" probe actually creates a real supervisor job
 * (prints `backgrounded · <shortId> (idle …)` and exits 0). The probe is
 * still our most reliable acceptance signal — we just have to immediately
 * `claude stop <shortId>` the session we created so the probe is truly
 * side-effect-free from the operator's perspective. Cache hits skip
 * probe+stop entirely.
 *
 * Result is cached per `(host, cwd)` in an in-process `Map` for the
 * daemon's lifetime — once a daemon has confirmed a cwd is ok, subsequent
 * recruits in that cwd skip the probe. On failure we surface an actionable
 * error string the recruit activity logs and rethrows.
 *
 * Cache invalidates on daemon restart (the user might have accepted in the
 * intervening time) — `__resetBgPreflightCacheForTests` exists for unit
 * coverage. Production code never invalidates the cache directly.
 */
import { spawnSync } from 'child_process';
import * as os from 'os';
import { resolveClaudePath } from '../spawn';

const log = (...args: unknown[]) => console.error('[agent-tempo:bg-preflight]', ...args);

interface CacheKey {
  host: string;
  cwd: string;
}

const cache = new Map<string, true>();

function cacheKey(k: CacheKey): string {
  return `${k.host}:::${k.cwd}`;
}

/**
 * Test hook — never call from production code. Convention per
 * `docs/adr/0006-test-hooks-naming.md`.
 */
export function __resetBgPreflightCacheForTests(): void {
  cache.clear();
}

export interface BgPreflightResult {
  ok: boolean;
  /** Populated when `ok === false`. Single line, ready to surface to the user. */
  error?: string;
  /** True when the result was served from the daemon-lifetime cache. */
  cached: boolean;
}

/**
 * Probe whether `claude --bg` can spawn in the given cwd without prompting
 * the operator for permission acceptance. First call probes; subsequent
 * calls for the same `(host, cwd)` hit the in-process cache.
 *
 * Returns `{ ok: true }` when the dry-run succeeded (exit 0). On any other
 * exit code (or spawn-side ENOENT), returns `{ ok: false, error: ... }`
 * with an actionable message. Never throws — callers handle the result.
 */
export function bgPreflight(
  cwd: string,
  options?: { claudeBin?: string; host?: string },
): BgPreflightResult {
  const host = options?.host ?? os.hostname();
  const key = cacheKey({ host, cwd });
  if (cache.has(key)) {
    return { ok: true, cached: true };
  }

  const claudeBin = resolveClaudePath(options?.claudeBin);

  // Dry-run: `--help` exits immediately without spawning a real session.
  // Bypass-permissions flag triggers the supervisor's accept-consent check,
  // which is the behavior we actually want to verify.
  let result;
  try {
    result = spawnSync(
      claudeBin,
      ['--bg', '--dangerously-skip-permissions', '--help'],
      {
        cwd,
        encoding: 'utf8',
        timeout: 15_000,
        shell: process.platform === 'win32',
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const error = `claude --bg preflight failed to launch (${msg}). Run 'claude' once in ${cwd} and accept the permission dialog, then retry recruit.`;
    log(error);
    return { ok: false, error, cached: false };
  }

  if (result.error) {
    const error = `claude --bg preflight failed to launch (${result.error.message}). Run 'claude' once in ${cwd} and accept the permission dialog, then retry recruit.`;
    log(error);
    return { ok: false, error, cached: false };
  }

  if (result.status === 0) {
    // The probe spawned a real supervisor job — clean it up immediately so
    // the operator never sees a leaked `idle` session in `claude agents`.
    // Stdout format observed: `backgrounded · <shortId> (idle — send a prompt to start)`
    const stdoutCombined = (result.stdout || '').toString();
    const shortIdMatch = stdoutCombined.match(/backgrounded\s*[·•]\s*([0-9a-f]{8})/i);
    if (shortIdMatch) {
      const probeShortId = shortIdMatch[1];
      try {
        spawnSync(claudeBin, ['stop', probeShortId], {
          cwd,
          encoding: 'utf8',
          timeout: 10_000,
          shell: process.platform === 'win32',
        });
        log(`probe stopped its own session ${probeShortId} in ${cwd}`);
      } catch (err) {
        log(`probe-cleanup warning: failed to stop ${probeShortId} (${err instanceof Error ? err.message : String(err)}); operator may see an idle 'agents' row`);
      }
    } else {
      log(`probe in ${cwd} exit 0 but no shortId in stdout — supervisor surface may have changed; not stopping anything`);
    }
    cache.set(key, true);
    return { ok: true, cached: false };
  }

  const stderr = (result.stderr || '').trim();
  const stdout = (result.stdout || '').trim();
  const detail = stderr || stdout || `exit ${result.status}`;
  const error = `claude --bg preflight rejected in ${cwd} (${detail}). Run 'claude' once in ${cwd} and accept the permission dialog, then retry recruit.`;
  log(error);
  return { ok: false, error, cached: false };
}
