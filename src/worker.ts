import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { Config, hostTaskQueue } from './config';
import { createTemporalNativeConnection } from './connection';
import { createTemporalConnection } from './connection';
import { createScheduleActivities } from './activities/schedule-fire';
import { createOutboxActivities } from './activities/outbox';
import { createMaestroActivities } from './activities/maestro';

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
export async function createWorkers(config: Config): Promise<DualWorkers> {
  const connection = await createTemporalNativeConnection(config);

  // Create a Client connection for activities that need to interact with Temporal
  const clientConnection = await createTemporalConnection(config);
  const client = new Client({ connection: clientConnection, namespace: config.temporalNamespace });
  const scheduleActivities = createScheduleActivities(client);
  const outboxActivities = createOutboxActivities(client, config);
  const maestroActivities = createMaestroActivities(client);

  const workflowBundle = await getWorkflowBundle();

  const SHUTDOWN_GRACE_TIME = '10s';
  const SHUTDOWN_FORCE_TIME = '15s';

  const sharedWorker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    identity: workerIdentity(), // #274 — parseable claude-tempo:<host>:<pid>:<version>
    workflowBundle,
    shutdownGraceTime: SHUTDOWN_GRACE_TIME,
    shutdownForceTime: SHUTDOWN_FORCE_TIME,
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
