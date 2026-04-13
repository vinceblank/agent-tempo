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
import { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import { getConfig, CLAUDE_TEMPO_HOME, GLOBAL_MAESTRO_WORKFLOW_ID, loadDaemonConfig, isEnsembleAllowed, type DaemonConfig } from './config';
import { createWorkers } from './worker';
import { createTemporalConnection } from './connection';
import { DAEMON_PID_PATH, DAEMON_LOG_PATH } from './cli/daemon';
import { createTempoClient } from './client';
import { queryOrphanedSessions, type OrphanCandidate } from './reconcile/orphans';
import { getMetadataQuery } from './workflows/signals';
import type { GlobalMaestroInput, SessionMetadata } from './types';

const log = (...args: unknown[]) => console.error(`[claude-tempo:daemon ${new Date().toISOString()}]`, ...args);

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

// ── Reconcile-on-boot (PR-E §10.1) ──

/**
 * Extract the `ClaudeTempoEnsemble` search attribute from a workflow id by
 * asking the workflow directly. Falls back to workflow-id parsing when the
 * query fails (workflow completed between listing and query).
 *
 * Used to evaluate `autoRestoreEnsembles` allowlist against each orphan.
 */
async function ensembleOfOrphan(client: Client, orphan: OrphanCandidate): Promise<string | null> {
  try {
    const handle = client.workflow.getHandle(orphan.workflowId);
    const meta = await handle.query(getMetadataQuery) as SessionMetadata;
    return meta.ensemble ?? null;
  } catch {
    // `claude-session-{ensemble}-{playerId}` — best-effort parse if the
    // workflow is gone already. `ensemble` may itself contain dashes; we
    // take everything between the prefix and the last `-{playerId}`.
    const match = /^claude-session-(.+)-[^-]+$/.exec(orphan.workflowId);
    return match ? match[1] : null;
  }
}

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
  const now = Date.now();
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
    const ensemble = await ensembleOfOrphan(client, o);
    if (ensemble === null) {
      log(`reconcile: [auto] skip ${o.workflowId} — could not determine ensemble`);
      continue;
    }
    if (!isEnsembleAllowed(ensemble, daemonConfig.autoRestoreEnsembles)) {
      log(`reconcile: [auto] skip ${o.workflowId} — ensemble "${ensemble}" not in allowlist`);
      continue;
    }

    // Restore target — extract playerId from workflow id.
    const playerId = /^claude-session-.+-([^-]+)$/.exec(o.workflowId)?.[1];
    if (!playerId) {
      log(`reconcile: [auto] skip ${o.workflowId} — could not extract playerId`);
      continue;
    }

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
 * Runs on a 6-hour timer (hardcoded per §8 answer 2). Two passes:
 *
 *  1. **Detached orphans older than `detachedMaxAgeDays`** → terminate via
 *     `TempoClient.destroy` so the workflow completes and eventually falls
 *     out of the namespace (or is reaped by {@link cleanupDestroyedWorkflows}
 *     on a later tick).
 *  2. **Destroyed workflows older than `destroyedMaxAgeDays`** → best-effort
 *     terminate-via-handle. Most Temporal namespaces have their own retention
 *     policy; this is additive.
 *
 * Never touches `Running` workflows that still hold a live attachment
 * (filter is explicit on `phase === 'detached'` in pass 1; pass 2 uses
 * `ExecutionStatus = "Completed"`).
 */
export async function cleanupLoop(
  client: Client,
  daemonConfig: DaemonConfig,
  hostname: string = os.hostname(),
): Promise<void> {
  const tempo = createTempoClient(client);
  const now = Date.now();

  // Pass 1 — stale detached orphans.
  try {
    const orphans = await queryOrphanedSessions(client, { hostname }, log);
    const stale = selectStaleDetachedOrphans(
      orphans,
      daemonConfig.cleanupPolicy.detachedMaxAgeDays,
      now,
    );
    for (const o of stale) {
      const ensemble = await ensembleOfOrphan(client, o);
      const playerId = /^claude-session-.+-([^-]+)$/.exec(o.workflowId)?.[1];
      if (!ensemble || !playerId) {
        log(`cleanup: [detached] skip ${o.workflowId} — could not parse ensemble/playerId`);
        continue;
      }
      try {
        await tempo.destroy(ensemble, playerId, `detached >${daemonConfig.cleanupPolicy.detachedMaxAgeDays}d`);
        log(`cleanup: [detached] destroyed ${o.workflowId} (detachedSince=${o.summary.detachedSince})`);
      } catch (err) {
        log(`cleanup: [detached] destroy failed for ${o.workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log('cleanup: pass-1 failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }

  // Pass 2 — purge long-closed workflows (best-effort; most namespaces have
  // a retention policy that already does this).
  try {
    const cutoffMs = now - daemonConfig.cleanupPolicy.destroyedMaxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const query =
      `WorkflowType = "claudeSessionWorkflow" ` +
      `AND ExecutionStatus = "Completed" ` +
      `AND CloseTime < "${cutoffIso}"`;
    let count = 0;
    for await (const wf of client.workflow.list({ query })) {
      try {
        await client.workflow.getHandle(wf.workflowId).terminate('cleanup: destroyed retention');
        count++;
      } catch { /* already gone */ }
    }
    if (count > 0) {
      log(`cleanup: [destroyed] terminated ${count} workflow${count === 1 ? '' : 's'} older than ${daemonConfig.cleanupPolicy.destroyedMaxAgeDays}d`);
    }
  } catch (err) {
    log('cleanup: pass-2 failed (non-fatal):', err instanceof Error ? err.message : String(err));
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

  // Write PID file — the parent polls for this to confirm startup
  fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
  log(`Daemon started (pid ${process.pid})`);
  log(`PID file: ${DAEMON_PID_PATH}`);
  log(`Log file: ${DAEMON_LOG_PATH}`);

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

  // Auto-start the global Maestro workflow (non-blocking, non-fatal)
  ensureGlobalMaestro(config).catch((err) => {
    log('ensureGlobalMaestro background error:', err);
  });

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
