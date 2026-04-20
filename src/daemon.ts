#!/usr/bin/env node
/**
 * Daemon entry point — runs Temporal workers in a detached background process.
 *
 * Started by `startDaemon()` in `src/cli/daemon.ts`.
 * Config is passed via environment variables set by the parent.
 *
 * Writes its PID to ~/.claude-tempo/daemon.pid on startup and removes it
 * on graceful shutdown (SIGTERM/SIGINT).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import { getConfig, type Config, CLAUDE_TEMPO_HOME, GLOBAL_MAESTRO_WORKFLOW_ID, loadDaemonConfig, isEnsembleAllowed, type DaemonConfig } from './config';
import { createWorkers } from './worker';
import { createTemporalConnection } from './connection';
import { DAEMON_PID_PATH, DAEMON_LOG_PATH, DAEMON_HEARTBEAT_PATH, HEARTBEAT_INTERVAL_MS } from './cli/daemon';
import { createTempoClient } from './client';
import { queryOrphanedSessions, type OrphanCandidate } from './reconcile/orphans';
import { listAgentTypes } from './ensemble/agent-types';
import type { GlobalMaestroInput, HostProfile } from './types';

const log = (...args: unknown[]) => console.error(`[claude-tempo:daemon ${new Date().toISOString()}]`, ...args);

/**
 * Atomically write the daemon PID file via `writeFile(tmp) + rename(tmp, final)`.
 *
 * A racing reader (a CLI invocation that happens to poll during startup) will
 * either see the previous file or the new one — never a half-written one.
 *
 * Windows sometimes fails the rename with EPERM/EBUSY/EACCES if an antivirus
 * scanner or the previous handle is still active. We retry with short backoffs
 * before giving up so a transient scanner doesn't crash startup.
 *
 * Exported for unit testing.
 */
export async function writePidFileAtomic(pidFilePath: string, pid: number): Promise<void> {
  const tmp = `${pidFilePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, String(pid));

  const retryCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const backoffs = [50, 100, 200, 400]; // ms — total ≤ 750ms, bounded for startup
  let lastErr: unknown;

  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      fs.renameSync(tmp, pidFilePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !retryCodes.has(code) || attempt === backoffs.length) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      await sleep(backoffs[attempt]);
    }
  }
  // Unreachable — loop either returns or throws.
  throw lastErr;
}

/**
 * Ensure the global Maestro workflow is running.
 * Uses USE_EXISTING conflict policy so it's safe to call on every daemon start.
 */
async function ensureGlobalMaestro(config: ReturnType<typeof getConfig>): Promise<void> {
  try {
    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });

    const input: GlobalMaestroInput = {};
    await client.workflow.start('claudeGlobalMaestroWorkflow', {
      workflowId: GLOBAL_MAESTRO_WORKFLOW_ID,
      taskQueue: config.taskQueue,
      args: [input],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    log(`Global Maestro ensured (id: ${GLOBAL_MAESTRO_WORKFLOW_ID})`);
  } catch (err) {
    // Non-fatal — the global maestro is optional for basic operation
    log('Failed to ensure global Maestro (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ────────────────────────────────────────────────────────────────────────
// #274 — host capability profile: compute → scrub → signal
// ────────────────────────────────────────────────────────────────────────

/**
 * Daemon package version, lazily read from `package.json` so the test
 * build (which compiles daemon.ts into `dist-test/src/` where
 * `../package.json` doesn't resolve) can exercise daemon-boot logic
 * without MODULE_NOT_FOUND. Tests that exercise `computeHostProfile`
 * pass a stubbed version via `HostProfile.version` on the input.
 */
function daemonVersion(): string {
  try {
    const { version } = require('../package.json') as { version: string };
    return version;
  } catch {
    return 'unknown';
  }
}

/**
 * Build the daemon's capability profile from its config + runtime env.
 * Result is NOT scrubbed — call `scrubHostProfile` before signaling.
 *
 * Exported for testability; production callers go through
 * `runDaemonBoot(client, deps)` which provides this as the default
 * `computeHostProfile` dep.
 */
export function computeHostProfile(config: Config): HostProfile {
  const agentTypes = (() => {
    try {
      return listAgentTypes().map((a) => a.name);
    } catch {
      // listAgentTypes reads the filesystem; treat any failure as "no
      // discoverable types" rather than crashing boot.
      return [];
    }
  })();

  return {
    hostname: os.hostname(),
    version: daemonVersion(),
    defaultAgent: config.defaultAgent,
    // Currently the daemon advertises only the configured default as an
    // "available runtime"; future work can probe for Copilot bridge via
    // `require.resolve('@github/copilot-sdk')`. Recording as an array
    // keeps the wire shape forward-compatible.
    availableAgentTypes: [config.defaultAgent],
    availablePlayerTypes: agentTypes,
    claudeBin: config.claudeBin,
    platform: process.platform,
    capabilities: [],
  };
}

/**
 * #274 AC5c / M10 — HARD REQUIREMENT privacy scrub.
 *
 * Strips absolute paths and file extensions from every `HostProfile` field
 * before the payload crosses the signal boundary. The global maestro is
 * namespace-wide; a multi-tenant or multi-ensemble corporate setup would
 * leak username-containing paths across ensembles if this is ever
 * violated. Unit-tested in `test/daemon-boot.test.ts` with a dedicated
 * "no `/` or `\\` in any string" invariant assertion against pathological
 * inputs.
 *
 * Contract per architect AC5c:
 * - `claudeBin` — basename only (e.g. `claude`), never absolute
 * - `availableAgentTypes` — names only, never paths
 * - `availablePlayerTypes` — names only, never paths
 * - No env var values, no `workDir`, no user directories in any field
 *
 * The scrub is defense-in-depth: production callers (`computeHostProfile`)
 * already produce clean inputs from `listAgentTypes().map(a => a.name)`.
 * If a future code path accidentally passes a path, this function catches
 * it before the workflow handler ever sees it.
 */
export function scrubHostProfile(raw: HostProfile): HostProfile {
  const stripPath = (s: string): string => {
    // `path.basename` handles both POSIX and Win32 separators on any
    // platform (it picks the right parser for the running runtime).
    // Also strip a single trailing `.md` — player-type files are
    // shipped as e.g. `tempo-soloist.md` but the name should be just
    // `tempo-soloist` on the wire.
    const base = path.basename(s);
    return base.endsWith('.md') ? base.slice(0, -3) : base;
  };
  const scrubList = (list: string[] | undefined): string[] | undefined =>
    list?.map(stripPath);

  return {
    hostname: raw.hostname,
    version: raw.version,
    defaultAgent: raw.defaultAgent,
    availableAgentTypes: scrubList(raw.availableAgentTypes),
    availablePlayerTypes: scrubList(raw.availablePlayerTypes),
    claudeBin: raw.claudeBin ? stripPath(raw.claudeBin) : undefined,
    platform: raw.platform,
    capabilities: raw.capabilities,
  };
}

/** Production default: signal the global maestro with the profile. */
async function realSendHostProfileSignal(client: Client, profile: HostProfile): Promise<void> {
  const handle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
  await handle.signal('hostProfile', profile);
}

/**
 * Signal `hostProfile` with bounded retry (AC5b / M11).
 *
 * Default backoff: `[0, 5000, 15000]` ms → 3 attempts, ≤20 s wall-clock,
 * well under the 30 s budget. Tests override to `[0, 0, 0]` for fast
 * execution. On total failure, logs a warning and returns — the daemon
 * stays alive without its profile advertised.
 *
 * Exported for reuse by the Phase 5 `claude-tempo refresh-host-profile`
 * CLI subcommand, which re-signals without needing the full
 * `runDaemonBoot` sequence (the global maestro is already up).
 */
export async function advertiseHostProfile(
  client: Client,
  profile: HostProfile,
  opts: {
    retryBackoffsMs?: number[];
    log?: (...args: unknown[]) => void;
    sendSignal?: (client: Client, profile: HostProfile) => Promise<void>;
  } = {},
): Promise<{ ok: boolean; attempts: number; lastError?: unknown }> {
  const backoffs = opts.retryBackoffsMs ?? [0, 5000, 15000];
  const logFn = opts.log ?? log;
  const send = opts.sendSignal ?? realSendHostProfileSignal;
  let lastError: unknown;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    const delay = backoffs[attempt];
    if (delay > 0) await sleep(delay);
    try {
      await send(client, profile);
      logFn(`Advertised host profile for "${profile.hostname}" (attempt ${attempt + 1}/${backoffs.length})`);
      return { ok: true, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      logFn(`hostProfile signal attempt ${attempt + 1}/${backoffs.length} failed:`, err instanceof Error ? err.message : err);
    }
  }
  logFn(
    `Failed to advertise host profile after ${backoffs.length} attempts (non-fatal; daemon stays alive):`,
    lastError instanceof Error ? lastError.message : lastError,
  );
  return { ok: false, attempts: backoffs.length, lastError };
}

/**
 * #274 M14 — boot-sequence deps. Injected at `runDaemonBoot` so the
 * ordering + retry + scrub invariants are all unit-testable without
 * subprocess fixtures. Production callers pass the default impls
 * already exported from this module.
 */
export interface DaemonBootDeps {
  /** Ensure the global maestro workflow is running. Awaited before any signal. */
  ensureGlobalMaestro: () => Promise<void>;
  /** Signal the global maestro with the scrubbed host profile. */
  sendHostProfileSignal: (client: Client, profile: HostProfile) => Promise<void>;
  /**
   * Compute the daemon's capability profile. Output is fed into
   * `scrubHostProfile` before signaling — computeHostProfile itself does
   * not need to scrub, the dep-swap pattern makes the pipeline testable.
   */
  computeHostProfile: () => HostProfile;
  /**
   * Retry backoffs for the `hostProfile` signal (ms). Production uses
   * `[0, 5000, 15000]`; tests override to `[0, 0, 0]` for speed.
   */
  retryBackoffsMs?: number[];
  /** Log sink. Tests stub to capture output. Defaults to module-level `log`. */
  log?: (...args: unknown[]) => void;
}

/**
 * #274 M14 — daemon boot sequence: ensure global maestro is running,
 * then advertise the (scrubbed) capability profile with bounded retry.
 *
 * Ordering is load-bearing (AC5a / M11): the `hostProfile` signal MUST
 * NOT fire until `ensureGlobalMaestro` has resolved. Otherwise the
 * signal races the workflow-start and gets silently dropped by Temporal
 * (WorkflowNotFound on an unknown workflow id).
 *
 * Hard-failure behavior (AC5b): if `ensureGlobalMaestro` rejects, the
 * daemon stays alive WITHOUT advertising its profile. Next opportunity
 * is the next daemon restart OR a manual `claude-tempo refresh-host-profile`
 * invocation (Phase 5).
 *
 * Tests in `test/daemon-boot.test.ts` exercise:
 *   - ensure-before-signal ordering via deferred promises
 *   - retry success on 3rd attempt
 *   - all-retries-exhausted stays alive
 *   - ensure-fails-stays-alive
 */
export async function runDaemonBoot(client: Client, deps: DaemonBootDeps): Promise<void> {
  const logFn = deps.log ?? log;
  const raw = deps.computeHostProfile();
  const profile = scrubHostProfile(raw);

  try {
    await deps.ensureGlobalMaestro();
  } catch (err) {
    logFn(
      'ensureGlobalMaestro failed (non-fatal); host profile not advertised this boot:',
      err instanceof Error ? err.message : err,
    );
    return;
  }

  await advertiseHostProfile(client, profile, {
    retryBackoffsMs: deps.retryBackoffsMs,
    log: logFn,
    sendSignal: deps.sendHostProfileSignal,
  });
}

// ── Reconcile-on-boot (PR-E §10.1) ──

/**
 * PR-E reconcile-on-boot — design §10.1.
 *
 * Called once during daemon startup, after workers are running but before
 * the main run loop blocks. Queries for orphaned sessions owned by this
 * host and applies the effective {@link DaemonConfig.restorePolicy}:
 *
 *  - `auto`: call `restart` on each orphan inside the allowlist + age
 *    window. `AttachmentConflict` is caught silently — another process
 *    may have restored concurrently.
 *  - `prompt`: log the orphan list and leave the restore to the CLI
 *    `claude-tempo restore` command. No automatic action.
 *  - `never`: silent no-op.
 *
 * All three branches exit in bounded time — never blocks worker startup.
 * Non-fatal: any failure is logged and reconcile bails without crashing
 * the daemon (worker loop takes over and the user can re-run the query
 * via the CLI).
 */
export async function reconcileOnBoot(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
  // Injectable clock — default to wall-clock at call time. Exposed so tests can pass a
  // pinned reference time alongside fixtures that use ISO strings derived from that time
  // (otherwise the 24h age filter below vs. a hardcoded test NOW drifts out of sync as
  // calendar days roll over; matches the pattern used by the cleanup path below).
  now: number = Date.now(),
): Promise<void> {
  if (daemonConfig.restorePolicy === 'never') {
    log(`reconcile: restorePolicy="never" — skipping orphan scan`);
    return;
  }

  log(`reconcile: scanning for orphans on host="${hostname}" (policy=${daemonConfig.restorePolicy})`);

  let orphans: OrphanCandidate[];
  try {
    orphans = await queryOrphanedSessions(client, { hostname }, log);
  } catch (err) {
    log('reconcile: orphan query failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return;
  }

  if (orphans.length === 0) {
    log('reconcile: no orphans found');
    return;
  }

  log(`reconcile: found ${orphans.length} orphan${orphans.length === 1 ? '' : 's'}`);

  // PR-F cross-host filter (design §16 + brief §8 answer 2). A session whose
  // `preferredHost` points to a different machine should not be restored by
  // this daemon — the remote host's daemon is the authoritative restorer.
  // Log-and-skip only: proactive cross-daemon signaling is a v0.26 feature
  // (tracked as a follow-up; see brief §6 "reconcileOnBoot cross-host signal
  // path is out of scope").
  const originalOrphans = orphans;
  orphans = originalOrphans.filter((o) => {
    if (o.summary.preferredHost && o.summary.preferredHost !== hostname) {
      log(`skipping restore for ${o.workflowId}: preferredHost=${o.summary.preferredHost}, localHost=${hostname}`);
      return false;
    }
    return true;
  });
  const crossHostSkipped = originalOrphans.length - orphans.length;
  if (crossHostSkipped > 0) {
    log(`reconcile: skipped ${crossHostSkipped} orphan${crossHostSkipped === 1 ? '' : 's'} preferring remote hosts`);
  }
  if (orphans.length === 0) {
    // All candidates filtered out — nothing to do on this host.
    return;
  }

  if (daemonConfig.restorePolicy === 'prompt') {
    for (const o of orphans) {
      log(
        `reconcile: [prompt] ${o.workflowId} ` +
        `— phase=${o.info.phase} detachedSince=${o.summary.detachedSince ?? '(unknown)'} ` +
        `preferredHost=${o.summary.preferredHost ?? '(unset)'}`,
      );
    }
    log('reconcile: [prompt] run `claude-tempo restore` to restore interactively');
    return;
  }

  // restorePolicy === 'auto'
  const ageWindowMs = daemonConfig.autoRestoreMaxAgeHours * 60 * 60 * 1000;
  const tempo = createTempoClient(client);

  for (const o of orphans) {
    // Age filter — ignore orphans older than autoRestoreMaxAgeHours.
    if (o.summary.detachedSince) {
      const detachedAt = Date.parse(o.summary.detachedSince);
      if (Number.isFinite(detachedAt) && now - detachedAt > ageWindowMs) {
        log(`reconcile: [auto] skip ${o.workflowId} — detachedSince out of age window`);
        continue;
      }
    }

    // Ensemble allowlist — simple prefix match per §8 answer 5.
    const ensemble = o.summary.ensemble;
    if (!isEnsembleAllowed(ensemble, daemonConfig.autoRestoreEnsembles)) {
      log(`reconcile: [auto] skip ${o.workflowId} — ensemble "${ensemble}" not in allowlist`);
      continue;
    }

    // Restore target — read canonical playerId from OrphanSummary (#143).
    const playerId = o.summary.playerId;
    const targetHost = o.summary.preferredHost ?? hostname;
    try {
      const result = await tempo.restart(ensemble, playerId, {
        host: targetHost,
        invokerPlayerId: 'daemon',
      });
      log(
        `reconcile: [auto] queued restart for "${playerId}" in "${ensemble}" ` +
        `on host="${targetHost}" (outbox ${result.entryId})`,
      );
    } catch (err) {
      // §10.6: silent backoff on AttachmentConflict. Any other failure logs
      // but doesn't break the reconcile loop.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('AttachmentConflict')) {
        log(`reconcile: [auto] skip ${o.workflowId} — attachment already claimed (AttachmentConflict)`);
      } else {
        log(`reconcile: [auto] restart failed for ${o.workflowId}: ${msg}`);
      }
    }
  }
}

// ── Cleanup loop (PR-E §13.4) ──

/** Hardcoded cleanup loop period per PR-E §8 answer 2. */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Filter a set of orphan candidates to those that exceed the
 * `detachedMaxAgeDays` retention threshold. Exported for unit testing the
 * retention math without a live Temporal connection.
 */
export function selectStaleDetachedOrphans(
  orphans: OrphanCandidate[],
  detachedMaxAgeDays: number,
  now: number = Date.now(),
): OrphanCandidate[] {
  const thresholdMs = detachedMaxAgeDays * 24 * 60 * 60 * 1000;
  return orphans.filter((o) => {
    if (o.info.phase !== 'detached') return false;
    if (!o.summary.detachedSince) return false;
    const detachedAt = Date.parse(o.summary.detachedSince);
    if (!Number.isFinite(detachedAt)) return false;
    return now - detachedAt > thresholdMs;
  });
}

/**
 * PR-E cleanup loop — design §13.4 regression row 1.
 *
 * Runs on a 6-hour timer (hardcoded per §8 answer 2). Destroys detached
 * orphans older than `detachedMaxAgeDays` via `TempoClient.destroy` so the
 * workflow completes and eventually falls out of the namespace.
 *
 * Never touches `Running` workflows that still hold a live attachment
 * (filter is explicit on `phase === 'detached'`).
 *
 * **Note (#144)**: an earlier revision included a "pass 2" that tried to
 * `terminate()` already-Completed workflows as belt-and-suspenders retention.
 * `terminate()` throws on Completed workflows in every Temporal namespace
 * setting, so the pass was dead code masked by a swallowing catch. It was
 * removed: namespace retention (Temporal Cloud default 30d, self-hosted
 * configurable) is the authoritative reaper for Completed workflows.
 */
export async function cleanupLoop(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
): Promise<void> {
  const tempo = createTempoClient(client);
  const now = Date.now();

  try {
    const orphans = await queryOrphanedSessions(client, { hostname }, log);
    const stale = selectStaleDetachedOrphans(
      orphans,
      daemonConfig.cleanupPolicy.detachedMaxAgeDays,
      now,
    );
    for (const o of stale) {
      const { ensemble, playerId } = o.summary;
      try {
        await tempo.destroy(ensemble, playerId, `detached >${daemonConfig.cleanupPolicy.detachedMaxAgeDays}d`);
        log(`cleanup: [detached] destroyed ${o.workflowId} (detachedSince=${o.summary.detachedSince})`);
      } catch (err) {
        log(`cleanup: [detached] destroy failed for ${o.workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log('cleanup: failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Schedule {@link cleanupLoop} to run every 6 hours. Returns a clearer
 * function that cancels the timer — called during shutdown.
 */
export function startCleanupLoop(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
): () => void {
  let timer: NodeJS.Timeout | null = null;

  const tick = () => {
    cleanupLoop(client, daemonConfig, hostname).catch((err) => {
      log('cleanup: tick failed:', err instanceof Error ? err.message : String(err));
    });
    timer = setTimeout(tick, CLEANUP_INTERVAL_MS);
    timer.unref();
  };

  // Run first tick after the initial interval (not immediately — startup is
  // busy enough). The retention math is idempotent so a delayed first run is
  // always safe.
  timer = setTimeout(tick, CLEANUP_INTERVAL_MS);
  timer.unref();

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function main() {
  // Ensure daemon directory exists
  fs.mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });

  // Write PID file — the parent polls for this to confirm startup.
  // Atomic write: tmp + rename so a racing reader never sees a half-written
  // file. Retries on Windows EPERM/EBUSY/EACCES (see #182).
  await writePidFileAtomic(DAEMON_PID_PATH, process.pid);
  log(`Daemon started (pid ${process.pid})`);
  log(`PID file: ${DAEMON_PID_PATH}`);
  log(`Log file: ${DAEMON_LOG_PATH}`);

  // Create the heartbeat file synchronously so the first `daemon status`
  // invocation after startup never races the first interval tick. The
  // subsequent interval only has to refresh the mtime — no branching on
  // file-existence each tick (#157 PR B).
  try {
    fs.writeFileSync(DAEMON_HEARTBEAT_PATH, '');
  } catch (err) {
    // Non-fatal — the daemon still runs, `daemon status` just reports
    // `heartbeatAge: null`. Log loudly so operators notice.
    log('Failed to create heartbeat file (non-fatal):', (err as Error)?.message ?? err);
  }
  const heartbeatInterval = setInterval(() => {
    try {
      const now = Date.now() / 1000; // `fs.utimes` takes seconds since epoch
      fs.utimesSync(DAEMON_HEARTBEAT_PATH, now, now);
    } catch {
      // Swallow — transient fs errors shouldn't take down the daemon.
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  // Get config from env vars (passed by startDaemon via spawn env)
  const config = getConfig({});

  // Use mutable refs so signal handlers can be registered before workers
  // are created — closes the narrow window where a SIGTERM during
  // createWorkers() would be missed.
  let sharedWorker: Awaited<ReturnType<typeof createWorkers>>['sharedWorker'] | null = null;
  let hostWorker: Awaited<ReturnType<typeof createWorkers>>['hostWorker'] | null = null;

  // Register signal handlers first — idempotent, drain-only (no process.exit).
  let shuttingDown = false;
  const hardExit = () => {
    log('Shutdown timeout — forcing exit');
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
    process.exit(1);
  };
  // Mutable ref so the reconcile/cleanup init below can register its
  // cancellation with shutdown (declared after signal handlers to preserve
  // the existing signal-handler-first safety ordering).
  let stopCleanupLoopRef: (() => void) | null = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down (draining in-flight activities)...');
    // Safety net: force exit if workers don't stop within 15s
    const timer = setTimeout(hardExit, 15_000);
    timer.unref();
    stopCleanupLoopRef?.();
    clearInterval(heartbeatInterval);
    try { fs.unlinkSync(DAEMON_HEARTBEAT_PATH); } catch { /* ignore */ }
    sharedWorker?.shutdown();
    hostWorker?.shutdown();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Create workers (signal handlers already active via mutable refs)
  log(`Connecting to Temporal at ${config.temporalAddress} (namespace: ${config.temporalNamespace})`);
  const workers = await createWorkers(config);
  sharedWorker = workers.sharedWorker;
  hostWorker = workers.hostWorker;
  log('Workers created — processing tasks');

  // #274 — daemon boot sequence: ensure the global maestro is running,
  // then advertise this host's capability profile with bounded retry.
  // Fire-and-forget from main's perspective (the workers above are
  // already polling tasks; we don't block the run loop on maestro
  // ensure + profile signaling). Ordering INSIDE runDaemonBoot is
  // load-bearing — see M11 / AC5a — so the outer `.catch` only
  // handles unexpected throws (both ensure and signal paths log +
  // return gracefully on their own).
  (async () => {
    try {
      const bootConnection = await createTemporalConnection(config);
      const bootClient = new Client({ connection: bootConnection, namespace: config.temporalNamespace });
      await runDaemonBoot(bootClient, {
        ensureGlobalMaestro: () => ensureGlobalMaestro(config),
        sendHostProfileSignal: realSendHostProfileSignal,
        computeHostProfile: () => computeHostProfile(config),
      });
    } catch (err) {
      log('runDaemonBoot background error:', err);
    }
  })();

  // PR-E reconcile-on-boot + cleanup loop (design §10, §13.4). Both run
  // against their own Temporal Client, not the worker connection — they
  // call `workflow.list` + `workflow.getHandle().query(...)` which are
  // client-side operations. Non-fatal: any failure is logged and the
  // daemon continues running.
  try {
    const daemonConfig = loadDaemonConfig();
    const reconcileConnection = await createTemporalConnection(config);
    const reconcileClient = new Client({ connection: reconcileConnection, namespace: config.temporalNamespace });

    // Fire-and-forget reconcile; the daemon must not block on this.
    reconcileOnBoot(reconcileClient, daemonConfig).catch((err) => {
      log('reconcileOnBoot background error:', err);
    });

    // Schedule the 6-hour cleanup loop (hardcoded per §8 answer 2).
    stopCleanupLoopRef = startCleanupLoop(reconcileClient, daemonConfig);
    log(`cleanup loop scheduled (every ${CLEANUP_INTERVAL_MS / 3_600_000}h)`);
  } catch (err) {
    log('reconcile/cleanup init failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  // Run both workers — blocks until shutdown + drain completes
  try {
    await Promise.all([sharedWorker.run(), hostWorker.run()]);
  } catch (err) {
    log('Worker error:', err);
  }

  // Workers have stopped — clean up PID file and exit
  try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
  log('Daemon stopped');
  process.exit(0);
}

// Only run `main()` when this file is invoked directly (e.g. via
// `node dist/daemon.js` or `npx ts-node src/daemon.ts`). Tests that
// import `reconcileOnBoot` / `cleanupLoop` / `selectStaleDetachedOrphans`
// must not trigger the worker-bootstrap path as a module side-effect.
if (require.main === module) {
  main().catch((err) => {
    log('Fatal error:', err);
    try { fs.unlinkSync(DAEMON_PID_PATH); } catch { /* ignore */ }
    process.exit(1);
  });
}
