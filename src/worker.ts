import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { Config, hostTaskQueue } from './config';
import { createTemporalNativeConnection } from './connection';
import { createTemporalConnection } from './connection';
import { createScheduleActivities } from './activities/schedule-fire';
import { createOutboxActivities, type DoorbellSink } from './activities/outbox';
import { createMaestroActivities, type ObserverPresenceSource } from './activities/maestro';
import type { IngestTokenRegistry } from './http/ingest-registry';
import { actionCountingInterceptors } from './utils/action-counters';

const log = (...args: unknown[]) => console.error('[agent-tempo:worker]', ...args);

const BUNDLE_PATH = path.resolve(__dirname, '..', 'workflow-bundle.js');

/**
 * #274 — deliberately set worker identity so host-discovery (`listHosts` in
 * `src/utils/hosts.ts`) can parse pollers back into `hostname:pid:version`
 * tuples without guessing at the SDK default (`<pid>@<hostname>`, which
 * loses the version axis and is only informally guaranteed).
 *
 * Format: `agent-tempo:<hostname>:<pid>:<version>`. Colons are safe
 * because the middle segments have their own validation:
 *   - hostname passes `PLAYER_NAME_REGEX` on the signal side (≤64 chars,
 *     no colons by construction on any platform the daemon supports)
 *   - pid is numeric
 *   - version is a semver-ish string (no colons)
 *
 * Legacy identities (`<pid>@<hostname>`) from pre-#274 daemons remain
 * parseable at the join site — see `parseIdentity` in
 * `src/utils/hosts.ts` for the dual-format tolerance.
 */
function workerIdentity(): string {
  // Lazy-require so the test build (which compiles worker.ts into
  // `dist-test/src/` where `../package.json` doesn't resolve) doesn't
  // throw MODULE_NOT_FOUND at module-load time when daemon tests
  // transitively import this file. `createWorkers` is only called from
  // production code paths, so this runs against the real `dist/`
  // layout where `../package.json` is the repo root.
  const { version } = require('../package.json') as { version: string };
  return `agent-tempo:${os.hostname()}:${process.pid}:${version}`;
}

async function getWorkflowBundle(): Promise<{ code: string }> {
  // Use pre-built bundle if it exists, otherwise bundle from source
  if (fs.existsSync(BUNDLE_PATH)) {
    log(`Loading pre-built workflow bundle from ${BUNDLE_PATH}`);
    return { code: fs.readFileSync(BUNDLE_PATH, 'utf-8') };
  }
  log('No pre-built workflow bundle found — bundling from source (run `npm run build` to avoid this)');
  const bundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(__dirname, 'workflows', 'index'),
  });
  // Cache for subsequent workers
  fs.writeFileSync(BUNDLE_PATH, bundle.code);
  return bundle;
}

export interface DualWorkers {
  /** Shared queue worker: workflows + delivery activities + schedule activities */
  sharedWorker: Worker;
  /** Per-host queue worker: spawnProcess activity only */
  hostWorker: Worker;
}

/**
 * Create dual workers:
 * - Shared queue: workflows + all delivery activities (deliverCue, deliverReport, terminateSession, startRecruitedSession) + schedule activities
 * - Per-host queue: spawnProcess only (routes recruit spawns to the correct machine)
 */
export async function createWorkers(
  config: Config,
  ingestTokens?: IngestTokenRegistry,
  /**
   * T0.1 (#748) — late-wired SSE observer presence source for the maestro
   * V2 refresh activity. The daemon constructs the holder before workers
   * and fills `current` in once the AggregateRunner exists.
   */
  observerPresence?: ObserverPresenceSource,
  /**
   * T1.1 PR-1 — late-wired cue-doorbell sink for the outbox delivery
   * activities (same holder pattern as observerPresence). The daemon fills
   * `current` with its DoorbellRegistry; a non-daemon worker leaves it null
   * (ring() no-ops; fallback polling covers delivery latency).
   */
  doorbells?: DoorbellSink,
): Promise<DualWorkers> {
  const connection = await createTemporalNativeConnection(config);

  // Create a Client connection for activities that need to interact with Temporal
  const clientConnection = await createTemporalConnection(config);
  const client = new Client({
    connection: clientConnection,
    namespace: config.temporalNamespace,
    interceptors: actionCountingInterceptors(),
  });
  const scheduleActivities = createScheduleActivities(client);
  // 3c Tier-2 — thread the daemon's shared IngestTokenRegistry into the outbox
  // activities so the pi spawn branch can mint per-player ingest tokens and the
  // destroy path can revoke them. Same singleton the HTTP server validates
  // against (both run in this daemon process).
  const outboxActivities = createOutboxActivities(client, config, ingestTokens, doorbells);
  const maestroActivities = createMaestroActivities(client, {
    costProfile: config.costProfile,
    observerPresence,
  });

  const workflowBundle = await getWorkflowBundle();

  const SHUTDOWN_GRACE_TIME = '10s';
  const SHUTDOWN_FORCE_TIME = '15s';

  /**
   * PR-A of the 2026-07-13 daemon-resilience program (architect ruling
   * `docs/research/daemon-resilience-architect-ruling.md` §1, PR-A).
   *
   * `isolateExecutionTimeout` is the vm-script deadline for a SINGLE call
   * into the workflow sandbox (activation or query). The SDK default is 5s —
   * exactly the `Script execution timed out after 5000ms` that started the
   * 2026-07-13 escalation: ~20 q/s of visibility-driven queries share ONE
   * workflow V8 thread, so a query against a large never-CAN'd history can
   * be starved past 5s even though nothing is wrong with the workflow code.
   * The blown deadline fails the workflow task, invalidates the sticky
   * cache, forces a full-history replay, starves the thread further, and
   * eventually escalated to a fatal Core error that killed the daemon.
   *
   * 30s absorbs the stall instead of amplifying it. Pairs with the
   * `WORKFLOW_TASK_TIMEOUT = '30s'` start option in `src/constants.ts` —
   * the two budgets should move together.
   *
   * Deliberately NOT flipping `reuseV8Context: false` to buy a second
   * workflow thread — ruling §4.6: that trades a query-starvation outage
   * for an OOM outage (fresh V8 context per cached workflow on a daemon
   * already observed at 919 MB rss).
   *
   * The option exists at runtime (user options are spread AFTER the SDK
   * defaults in `addDefaultWorkerOptions`) but is absent from the public
   * `WorkerOptions` type ("not exposed at the moment" — worker-options.d.ts),
   * hence the widening below. Takes effect for ALL workflows on daemon
   * restart (worker-side, unlike the per-run workflowTaskTimeout).
   */
  const ISOLATE_EXECUTION_TIMEOUT = '30s';
  const isolateTimeoutOpts = {
    isolateExecutionTimeout: ISOLATE_EXECUTION_TIMEOUT,
  } as Partial<Parameters<typeof Worker.create>[0]>;

  const sharedWorker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    identity: workerIdentity(), // #274 — parseable agent-tempo:<host>:<pid>:<version>
    workflowBundle,
    shutdownGraceTime: SHUTDOWN_GRACE_TIME,
    shutdownForceTime: SHUTDOWN_FORCE_TIME,
    ...isolateTimeoutOpts,
    activities: {
      ...scheduleActivities,
      ...maestroActivities,
      // Shared-queue delivery activities (everything except spawnProcess)
      deliverCue: outboxActivities.deliverCue,
      deliverReport: outboxActivities.deliverReport,
      terminateSession: outboxActivities.terminateSession,
      startRecruitedSession: outboxActivities.startRecruitedSession,
      releasePlayer: outboxActivities.releasePlayer,
      deliverDetach: outboxActivities.deliverDetach,
      deliverDestroy: outboxActivities.deliverDestroy,
      deliverRestart: outboxActivities.deliverRestart,
    },
  });

  // Per-host worker — spawnProcess only, no workflow bundle
  const hostConnection = await createTemporalNativeConnection(config);
  const hostWorker = await Worker.create({
    connection: hostConnection,
    namespace: config.temporalNamespace,
    taskQueue: hostTaskQueue(config.taskQueue, os.hostname()),
    identity: workerIdentity(), // #274 — same format, both pollers under one identity
    shutdownGraceTime: SHUTDOWN_GRACE_TIME,
    shutdownForceTime: SHUTDOWN_FORCE_TIME,
    activities: {
      spawnProcess: outboxActivities.spawnProcess,
      // #159 Gap 2: host-local OS-process kill. Must live on the per-host queue so it runs
      // on the machine where the claude.exe / bridge process actually lives.
      hardTerminateAttachment: outboxActivities.hardTerminateAttachment,
    },
  });

  return { sharedWorker, hostWorker };
}
