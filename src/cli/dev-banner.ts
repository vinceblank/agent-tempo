/**
 * `[DEV MODE]` banner formatter (ADR 0014 §5.4 — gate 4 of production
 * safety). Single conspicuous header line, printed on every CLI invocation
 * in dev mode and on every dev daemon startup so logs self-identify.
 *
 * Crash-proof: imports only `os` and `../config`. No Temporal, no rxjs.
 * Safe to call from `src/cli/daemon-command.ts` and `src/cli.ts` without
 * breaking the #157 isolation guarantee.
 *
 * **Load-bearing invariant (#423 PR-A).** The banner output MUST reflect
 * the daemon's actual resolved config — any divergence is a silent
 * coordination bug. `formatDevBanner` stays pure (testable) over
 * caller-injected inputs; `emitDevBannerIfActive` owns the resolution.
 * Source annotations are uniform across all fields so a leak shows up as
 * a single-character diff (`(default)` → `(env)`) rather than requiring
 * the operator to know what "no annotation" means.
 */
import { homedir } from 'os';
import {
  CLAUDE_TEMPO_HOME,
  type ConfigSource,
  DEV_DAEMON_PORT,
  DEV_TASK_QUEUE,
  DEV_TEMPORAL_NAMESPACE,
  ENV,
  PROD_DAEMON_PORT,
  PROD_TASK_QUEUE,
  PROD_TEMPORAL_NAMESPACE,
  getConfigWithSources,
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
  // Always check both `/` and `\` separators regardless of the host OS.
  // The function is sometimes called on POSIX with Windows-shaped path
  // strings (e.g. unit tests that fix a fixture homedir of `C:\Users\alice`,
  // or env-var values that escaped from a Windows shell). Using the
  // platform's `path.sep` alone would leave half of those cases broken.
  const trailers = ['/', '\\'];
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
  /** Source of the namespace value; annotates the banner when provided. */
  namespaceSource?: ConfigSource;
  /** Task queue; defaults to {@link DEV_TASK_QUEUE}. */
  taskQueue?: string;
  /**
   * Source of the task queue value. Only `'env'` and `'default'` are
   * possible today (queue resolution is hardcoded — env var wins, dev/prod
   * default fills in), but the type widens to {@link ConfigSource} so a
   * future PR-B carve-out has somewhere to land without a type change.
   */
  taskQueueSource?: ConfigSource;
  /**
   * Override `homedir()` resolution for path prettification. Tests pass an
   * explicit value to keep fixtures stable across machines.
   */
  homedirOverride?: string;
}

/**
 * Annotate a banner field with its source. Always emits the `(source)`
 * suffix when a source is provided so the banner is uniformly diagnostic
 * — every field tells the operator where its value came from. `'none'`
 * suppresses the annotation (the value couldn't be resolved at all, so
 * a source label would be misleading).
 *
 * The architect's `docs/design/dev-mode-isolation-fix-423.md` example:
 *
 *   `namespace claude-tempo-dev (default) · queue claude-tempo-dev (default)`
 *
 * After a leak this becomes `namespace default (env)` — operator instantly
 * sees what changed. If we suppressed `(default)` they'd have to know
 * what "no annotation" means before they could spot the drift.
 */
function annotateField(
  name: string,
  value: string,
  source?: ConfigSource,
): string {
  if (!source || source === 'none') return `${name} ${value}`;
  return `${name} ${value} (${source})`;
}

/**
 * Format the single-line `[DEV MODE]` banner. Pure function — no I/O.
 *
 *   [DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace claude-tempo-dev (default) · queue claude-tempo-dev (default)
 *
 * After a leak the banner self-narrates the drift:
 *
 *   [DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace default (env) · queue claude-tempo-dev (default)
 *
 * The `[DEV MODE]` prefix is rendered with ANSI yellow + bold when stdout
 * is a TTY (`out.bold`/`out.yellow` handle the `NO_COLOR` / non-TTY
 * fallback). The remainder is plain text so it greps cleanly out of
 * `~/.claude-tempo-dev/daemon.log`.
 *
 * Production callers go through {@link emitDevBannerIfActive}, which
 * resolves the inputs from {@link getConfigWithSources}. Tests pin every
 * input to keep fixtures deterministic.
 */
export function formatDevBanner(inputs: DevBannerInputs = {}): string {
  const home = inputs.home ?? CLAUDE_TEMPO_HOME;
  const port = inputs.port ?? DEV_DAEMON_PORT;
  const namespace = inputs.namespace ?? DEV_TEMPORAL_NAMESPACE;
  const taskQueue = inputs.taskQueue ?? DEV_TASK_QUEUE;
  const display = prettyPath(home, inputs.homedirOverride);
  const namespaceField = annotateField('namespace', namespace, inputs.namespaceSource);
  const queueField = annotateField('queue', taskQueue, inputs.taskQueueSource);
  return (
    `${bold(yellow('[DEV MODE]'))} using ${display} · ` +
    `port ${port} · ${namespaceField} · ${queueField}`
  );
}

/**
 * Resolve the runtime inputs the banner should display. Reads from
 * {@link getConfigWithSources} so the printed values match what the daemon
 * actually connects to. On any resolution error (e.g. invalid ensemble
 * name throwing out of `getConfig`'s validator), falls back to the dev
 * profile's hardcoded constants — the banner is best-effort diagnostics
 * and must not be load-bearing for daemon startup.
 *
 * Exported for unit testing without monkey-patching the config module.
 *
 * @internal
 */
export function resolveDevBannerInputs(): DevBannerInputs {
  // `taskQueue` source isn't tracked by `getConfigWithSources` (queue
  // resolution lives directly in `getConfig`'s constructor). Compute it
  // here so the banner annotates it uniformly with the namespace source.
  const taskQueueSource: ConfigSource = process.env[ENV.TASK_QUEUE] ? 'env' : 'default';
  try {
    const { config, sources } = getConfigWithSources();
    return {
      namespace: config.temporalNamespace,
      namespaceSource: sources.temporalNamespace,
      taskQueue: config.taskQueue,
      taskQueueSource,
    };
  } catch (err) {
    // `getConfigWithSources` validates the ensemble name and may throw
    // when an operator has e.g. invalid characters in `$CLAUDE_TEMPO_ENSEMBLE`.
    // Surface the cause to stderr — the banner stays diagnostic and the
    // operator sees that the displayed values are dev defaults, not the
    // actual resolution. The CLI surfaces the same validation error a
    // moment later, so the duplicate isn't noisy enough to suppress.
    console.error(
      '[dev-mode] banner falling back to defaults — config resolution failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { taskQueueSource };
  }
}

/**
 * Convenience: emit the banner to stderr if `isDevMode()` is true,
 * otherwise no-op. Stderr (not stdout) so the banner doesn't pollute
 * commands whose stdout is captured by callers (e.g. `claude-tempo
 * --dev recall --json …`).
 *
 * Resolves the displayed values from {@link getConfigWithSources} so the
 * banner reflects what the daemon ACTUALLY connects to. The previous
 * implementation read the dev profile's hardcoded constants directly, so
 * a `TEMPORAL_NAMESPACE=default` shell export silently disagreed with the
 * banner (#423).
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
  console.error(formatDevBanner(resolveDevBannerInputs()));
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
  return isDevMode() ? formatDevBanner(resolveDevBannerInputs()) : '';
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
