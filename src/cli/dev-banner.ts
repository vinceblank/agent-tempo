/**
 * `[DEV MODE]` banner formatter (ADR 0014 §5.4 — gate 4 of production
 * safety). Single conspicuous header line, printed on every CLI invocation
 * in dev mode and on every dev daemon startup so logs self-identify.
 *
 * Crash-proof: imports only `path`, `os`, and `../config`. No Temporal,
 * no rxjs. Safe to call from `src/cli/daemon-command.ts` and
 * `src/cli.ts` without breaking the #157 isolation guarantee.
 */
import { homedir } from 'os';
import { sep } from 'path';
import {
  CLAUDE_TEMPO_HOME,
  DEV_DAEMON_PORT,
  DEV_TASK_QUEUE,
  DEV_TEMPORAL_NAMESPACE,
  PROD_DAEMON_PORT,
  PROD_TASK_QUEUE,
  PROD_TEMPORAL_NAMESPACE,
  isDevMode,
} from '../config';
import { bold, yellow } from './output';

/**
 * Render `<homedir>/foo/bar` as `~/foo/bar` for human-readable banner
 * output. Falls back to the absolute path when it doesn't live under the
 * user's home dir (e.g. `CLAUDE_TEMPO_HOME_OVERRIDE=/tmp/scratch`).
 *
 * Exported for unit testing — banner output is checked against this
 * formatter so the test fixtures don't bake in a developer's username.
 */
export function prettyPath(absPath: string, home: string = homedir()): string {
  if (!home) return absPath;
  if (absPath === home) return '~';
  // Match either `home/` or `home\` depending on platform separator. We
  // tolerate the path being passed with the opposite separator (rare; happens
  // when env vars are set with forward slashes on Windows) by also checking
  // the POSIX form.
  const trailers = new Set([sep, '/']);
  for (const trailer of trailers) {
    const prefix = home + trailer;
    if (absPath.startsWith(prefix)) {
      return '~/' + absPath.slice(prefix.length).replace(/\\/g, '/');
    }
  }
  return absPath;
}

/** Inputs to {@link formatDevBanner}. Exposed so tests can pin every value. */
export interface DevBannerInputs {
  /** Resolved home dir; defaults to `CLAUDE_TEMPO_HOME`. */
  home?: string;
  /** Daemon port; defaults to {@link DEV_DAEMON_PORT}. */
  port?: number;
  /** Temporal namespace; defaults to {@link DEV_TEMPORAL_NAMESPACE}. */
  namespace?: string;
  /** Task queue; defaults to {@link DEV_TASK_QUEUE}. */
  taskQueue?: string;
  /**
   * Override `homedir()` resolution for path prettification. Tests pass an
   * explicit value to keep fixtures stable across machines.
   */
  homedirOverride?: string;
}

/**
 * Format the single-line `[DEV MODE]` banner. Pure function — no I/O.
 *
 *   [DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace claude-tempo-dev · queue claude-tempo-dev
 *
 * The `[DEV MODE]` prefix is rendered with ANSI yellow + bold when stdout
 * is a TTY (`out.bold`/`out.yellow` handle the `NO_COLOR` / non-TTY
 * fallback). The remainder is plain text so it greps cleanly out of
 * `~/.claude-tempo-dev/daemon.log`.
 */
export function formatDevBanner(inputs: DevBannerInputs = {}): string {
  const home = inputs.home ?? CLAUDE_TEMPO_HOME;
  const port = inputs.port ?? DEV_DAEMON_PORT;
  const namespace = inputs.namespace ?? DEV_TEMPORAL_NAMESPACE;
  const taskQueue = inputs.taskQueue ?? DEV_TASK_QUEUE;
  const display = prettyPath(home, inputs.homedirOverride);
  return (
    `${bold(yellow('[DEV MODE]'))} using ${display} · ` +
    `port ${port} · namespace ${namespace} · queue ${taskQueue}`
  );
}

/**
 * Convenience: emit the banner to stderr if `isDevMode()` is true,
 * otherwise no-op. Stderr (not stdout) so the banner doesn't pollute
 * commands whose stdout is captured by callers (e.g. `claude-tempo
 * --dev recall --json …`).
 *
 * Called from:
 *   - `src/cli.ts` (every dev-mode CLI invocation)
 *   - `src/cli/daemon-command.ts` (dev daemon start)
 *   - `src/daemon.ts` (daemon child process startup)
 */
export function emitDevBannerIfActive(): void {
  if (!isDevMode()) return;
  // stderr keeps stdout clean for `--json` / pipe consumers. Same reasoning
  // as `out.error` / `out.warn`. Ship it via console.error directly so we
  // don't depend on `out.log` (which writes to stdout).
  console.error(formatDevBanner());
}

/**
 * Production banner counterpart used only by tests — verifies the negative
 * case (env var unset → empty string). Production callers always go through
 * `emitDevBannerIfActive()` which short-circuits when not in dev mode.
 *
 * Exported for `tests/cli/dev-banner.test.ts` so the test asserts both
 * positive ("dev mode renders banner") AND negative ("not in dev mode
 * renders nothing") branches without duplicating the env-var-toggling
 * scaffolding.
 */
export function devBannerOrEmpty(): string {
  return isDevMode() ? formatDevBanner() : '';
}

/**
 * Single-line summary of the prod defaults — used by tests to confirm
 * that the dev banner doesn't accidentally pick up production values.
 *
 * @internal
 */
export const PROD_DEFAULTS_FOR_TESTS = {
  port: PROD_DAEMON_PORT,
  namespace: PROD_TEMPORAL_NAMESPACE,
  taskQueue: PROD_TASK_QUEUE,
} as const;
