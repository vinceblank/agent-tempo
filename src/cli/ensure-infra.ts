/**
 * Shared infrastructure bootstrap (#700 P1 / command-center).
 *
 * `ensureInfra()` is the ONE path that brings the local agent-tempo infra up —
 * Temporal dev server, the AgentTempo* search attributes, the shipped agent
 * types, and the worker daemon — so BOTH the CLI (`agent-tempo up`) and the
 * mission-control Pi extension (`/ensemble-up`) call identical logic and can't
 * drift. Extracted from `up()` (the Temporal-start + SA + agent-types + daemon
 * steps) per the command-center design §2/§7A.
 *
 * CONNECT-ONLY: this never registers the MCP server (`init()`) — that's a
 * CLI-only step and is explicitly cut from the bootstrap path (the Pi extension
 * registers tools natively, no MCP).
 *
 * ORDERING IS LOAD-BEARING: search attributes MUST be registered BEFORE the
 * daemon starts — the daemon refuses to boot (process.exit) if the SAs are
 * missing (see `sa-preflight` + `daemon.ts` boot gate). `up()` did SA at step 3,
 * daemon at step 3.7; ensureInfra preserves that order.
 *
 * `isTemporalReachable` + `registerSearchAttributes` MOVED here from
 * `commands.ts` (their natural infra home); `commands.ts` re-imports them. This
 * keeps ensure-infra a LEAF (imports only connection / sa-preflight / daemon /
 * config / output) — no `commands.ts ↔ ensure-infra` cycle.
 */
import { spawn as cpSpawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { Client } from '@temporalio/client';
import { Config, getConfig, AGENT_TEMPO_HOME } from '../config';
import { createTemporalConnection } from '../connection';
import {
  REQUIRED_SEARCH_ATTRIBUTES,
  registerSearchAttribute,
  isPermissionError,
} from './sa-preflight';
import { isDaemonRunning, startDaemon, getDaemonStatus } from './daemon';
import { readAndClearLastExit, type DaemonLastExit } from '../utils/last-exit';
import * as out from './output';

/** SQLite db file for the bundled Temporal dev server (same path `up()` uses). */
export const DEFAULT_DB_PATH = join(AGENT_TEMPO_HOME, 'temporal-data.db');
/** Package root (dist/cli/ensure-infra.js → dist → pkgRoot) — holds examples/agents. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/**
 * Probe whether Temporal is reachable AND its namespace can serve requests (a
 * gRPC connect alone doesn't prove readiness — issue a cheap visibility query).
 * MOVED from commands.ts; the CLI's other temporal-start sites import it back.
 */
export async function isTemporalReachable(config: {
  temporalAddress: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
}): Promise<boolean> {
  try {
    const conn = await createTemporalConnection(config as Config);
    try {
      const client = new Client({ connection: conn, namespace: config.temporalNamespace || 'default' });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.workflow.list({ query: 'WorkflowId = "__readiness_probe__"' })) {
        break;
      }
    } finally {
      await conn.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Register all {@link REQUIRED_SEARCH_ATTRIBUTES}. Permission errors (Temporal
 * Cloud namespace keys can't reach the operator service) are NOT counted as
 * failures — collapsed to one soft line (#686). Definitive failures (e.g. the
 * SQLite 10-Keyword cap) keep the hard "will fail" conclusion. MOVED from
 * commands.ts; re-imported there.
 *
 * `quiet` (#700 P2 / H) suppresses the per-attribute success/already-registered
 * lines — the ~20-line spew that would otherwise scroll into a Pi TUI's render
 * when bootstrap runs from `/ensemble-up`. The `ensureInfra` default dep passes
 * `quiet: true` and surfaces the outcome through its `onStep` progress callback
 * instead; standalone CLI callers keep the verbose default. Error warnings
 * (permission-blocked / definitive failures) are NEVER suppressed — they are
 * rare + actionable, so they print in both modes.
 */
export function registerSearchAttributes(temporalAddress: string, namespace = 'default', quiet = false): { failed: number } {
  let failed = 0;
  let permissionBlocked = 0;
  for (const attr of REQUIRED_SEARCH_ATTRIBUTES) {
    const r = registerSearchAttribute(attr, temporalAddress, namespace);
    switch (r.status) {
      case 'created':
        if (!quiet) out.success(`Registered search attribute: ${attr.name}`);
        break;
      case 'already-exists':
        if (!quiet) out.dim(`  ${attr.name} (already registered)`);
        break;
      case 'failed':
        if (isPermissionError(r.detail)) {
          permissionBlocked++;
        } else {
          failed++;
          out.warn(`Failed to register ${attr.name}: ${r.detail}`);
        }
        break;
    }
  }
  if (permissionBlocked > 0) {
    const saList = REQUIRED_SEARCH_ATTRIBUTES.map((a) => `${a.name}:${a.type}`).join(', ');
    out.warn(
      `Couldn't verify search attributes — this credential lacks permission to manage them ` +
      `(normal on Temporal Cloud, where search attributes are managed via the Cloud UI or tcld). ` +
      `If workflow starts fail with "search attribute ... is not defined", create these ` +
      `${REQUIRED_SEARCH_ATTRIBUTES.length} via the Cloud UI / tcld: ${saList}. ` +
      `Otherwise this is safe to ignore.`,
    );
  }
  if (failed > 0) {
    out.warn(
      `${failed} search attribute${failed === 1 ? '' : 's'} not registered — ` +
      `workflow starts will fail. Resolve the errors above before continuing.`,
    );
  }
  return { failed };
}

/**
 * Copy the shipped agent-type definitions into `~/.claude/agents/` if absent, so
 * recruiting TYPED lineup players resolves. Idempotent (skips existing). MOVED
 * from `up()` step 3.5 — folded into ensureInfra so `/ensemble-up` gets it too.
 */
export function installAgentTypes(): { installed: number; total: number } {
  const userAgentsDir = join(homedir(), '.claude', 'agents');
  const shippedAgentsPath = join(PACKAGE_ROOT, 'examples', 'agents');
  if (!existsSync(shippedAgentsPath)) return { installed: 0, total: 0 };
  mkdirSync(userAgentsDir, { recursive: true });
  const shipped = readdirSync(shippedAgentsPath).filter((f) => f.endsWith('.md'));
  let installed = 0;
  for (const file of shipped) {
    const dest = join(userAgentsDir, file);
    if (!existsSync(dest)) {
      copyFileSync(join(shippedAgentsPath, file), dest);
      installed++;
    }
  }
  return { installed, total: shipped.length };
}

/** A bootstrap-progress event, surfaced to the caller's UI (out.check / ctx.ui). */
export interface InfraProgress {
  step: 'temporal' | 'search-attributes' | 'agent-types' | 'daemon';
  status: 'ok' | 'started' | 'done';
  detail?: string;
}

export interface EnsureInfraResult {
  config: Config;
  temporal: 'up' | 'started';
  daemon: 'up' | 'started';
}

/**
 * Injectable seam (tests only). Defaults to the real functions; a test overrides
 * to assert ordering (SA-before-daemon), connect-only, and explicit-config
 * propagation without spawning anything.
 */
export interface EnsureInfraDeps {
  isTemporalReachable: (config: Config) => Promise<boolean>;
  startTemporalDevServer: (config: Config) => Promise<{ pid?: number }>;
  registerSearchAttributes: (addr: string, ns: string) => { failed: number };
  installAgentTypes: () => { installed: number; total: number };
  isDaemonRunning: () => boolean;
  startDaemon: (config: Config) => Promise<number>;
  getDaemonStatus: () => { pid?: number };
}

/** Default Temporal dev-server start (detached spawn + readiness poll). Throws on timeout. */
async function startTemporalDevServer(config: Config): Promise<{ pid?: number }> {
  mkdirSync(AGENT_TEMPO_HOME, { recursive: true });
  const port = config.temporalAddress.split(':')[1] || '7233';
  const child = cpSpawn('temporal', ['server', 'start-dev', '--port', port, '--db-filename', DEFAULT_DB_PATH], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isTemporalReachable(config)) return { pid: child.pid };
  }
  throw new Error('Temporal did not start within 10 seconds');
}

const defaultDeps: EnsureInfraDeps = {
  isTemporalReachable,
  startTemporalDevServer,
  // #700 P2 / H — bootstrap reports SA progress via onStep, so suppress the
  // per-attribute console spew (it would scroll into a Pi TUI's render).
  registerSearchAttributes: (addr, ns) => registerSearchAttributes(addr, ns, true),
  installAgentTypes,
  isDaemonRunning,
  startDaemon,
  getDaemonStatus,
};

/** Human label per {@link DaemonLastExit.reason} — used by {@link formatLastExitNotice}. */
const REASON_LABEL: Record<DaemonLastExit['reason'], string> = {
  'worker-give-up': 'a worker gave up after repeated restarts',
  'boot-guard-refused': 'a boot-guard check refused to start',
  'unhandled-fatal': 'an unhandled fatal error',
  'drain-timeout': 'shutdown drain timed out',
  'stale-pid-unexplained': 'an unexplained crash (no self-reported cause — OOM-kill, forced termination, or power loss are common causes)',
};

/** Pretty-print a millisecond duration as `Xh Ym` / `Xm Ys` / `Xs`. */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown duration';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Render a {@link DaemonLastExit} marker into the one-shot CLI notice.
 * Exported for unit testing without a live daemon or filesystem.
 */
export function formatLastExitNotice(marker: DaemonLastExit, now: number = Date.now()): string {
  const reasonText = REASON_LABEL[marker.reason] ?? marker.reason;
  const restartsText = marker.restarts > 0 ? `, ${marker.restarts} restart${marker.restarts === 1 ? '' : 's'}` : '';
  const workerText = marker.worker ? ` (${marker.worker} worker)` : '';
  const fatalText = marker.lastFatalMessage ? ` — "${marker.lastFatalMessage.split('\n')[0]}"` : '';

  let downtimeText = '';
  if (marker.lastHeartbeatAt) {
    const lastHeartbeatMs = Date.parse(marker.lastHeartbeatAt);
    if (Number.isFinite(lastHeartbeatMs)) {
      downtimeText = ` — down ~${formatDurationMs(now - lastHeartbeatMs)}`;
    }
  }

  return (
    `⚠ agent-tempo daemon crashed${workerText}${downtimeText}: ${reasonText}${restartsText}${fatalText} ` +
    `(at ${marker.at}). Schedules/cues did not fire during the downtime — now restarted.`
  );
}

/**
 * Check for a `daemon.last-exit.json` marker and print a one-shot notice if
 * present, then clear it. Exported for unit testing (inject `deps`); the
 * `ensureInfra()` call site below uses the real filesystem-backed default.
 * Never throws — {@link readAndClearLastExit} already degrades a malformed
 * marker to `null` rather than propagating, and this wrapper adds no new
 * failure surface (just a `console`/`out.warn` call).
 */
export function printLastExitNoticeIfAny(
  deps: { readAndClearLastExit?: () => DaemonLastExit | null; warn?: (msg: string) => void } = {},
): void {
  const read = deps.readAndClearLastExit ?? readAndClearLastExit;
  const warn = deps.warn ?? out.warn;
  const marker = read();
  if (marker) warn(formatLastExitNotice(marker));
}

/**
 * Bring local infra up (CONNECT-ONLY — never registers MCP). Order: Temporal →
 * search attributes → agent types → daemon (SA MUST precede the daemon, which
 * refuses to boot without them). `onStep` lets the caller render progress
 * (`up()` → out.check; the Pi extension → ctx.ui.notify). Throws if Temporal
 * can't be reached/started; the caller decides how to surface that.
 */
export async function ensureInfra(
  opts: { config?: Config; onStep?: (p: InfraProgress) => void; deps?: Partial<EnsureInfraDeps> } = {},
): Promise<EnsureInfraResult> {
  const config = opts.config ?? getConfig();
  const onStep = opts.onStep ?? (() => { /* no-op */ });
  const d: EnsureInfraDeps = { ...defaultDeps, ...opts.deps };

  // 1. Temporal — reachable, or auto-start the dev server.
  let temporal: 'up' | 'started';
  if (await d.isTemporalReachable(config)) {
    temporal = 'up';
    onStep({ step: 'temporal', status: 'ok', detail: config.temporalAddress });
  } else {
    const { pid } = await d.startTemporalDevServer(config);
    temporal = 'started';
    onStep({ step: 'temporal', status: 'started', detail: pid != null ? `pid ${pid}` : undefined });
  }

  // 2. Search attributes — BEFORE the daemon (it refuses to boot without them).
  const sa = d.registerSearchAttributes(config.temporalAddress, config.temporalNamespace);
  onStep({ step: 'search-attributes', status: 'done', detail: sa.failed > 0 ? `${sa.failed} failed` : undefined });

  // 3. Agent types — so recruiting typed lineup players resolves.
  const at = d.installAgentTypes();
  onStep({ step: 'agent-types', status: 'done', detail: at.installed > 0 ? `installed ${at.installed}` : `${at.total} present` });

  // 4. Worker daemon (detached; reused verbatim from the CLI path).
  let daemon: 'up' | 'started';
  if (d.isDaemonRunning()) {
    daemon = 'up';
    onStep({ step: 'daemon', status: 'ok', detail: d.getDaemonStatus().pid != null ? `pid ${d.getDaemonStatus().pid}` : undefined });
  } else {
    const pid = await d.startDaemon(config);
    daemon = 'started';
    onStep({ step: 'daemon', status: 'started', detail: `pid ${pid}` });
  }

  // 5. One-shot crash notice — surfaces (and clears) a `daemon.last-exit.json`
  // marker left by a prior abnormal exit. Runs after the daemon is confirmed
  // up/started (not gated on `daemon === 'started'`): a marker can exist even
  // when THIS invocation found an already-healthy daemon (e.g. the periodic
  // Windows Scheduled Task re-trigger — PR-C — restarted it between CLI
  // invocations, and this is simply the first CLI call since). See
  // docs/design/daemon-last-exit-schema.md.
  printLastExitNoticeIfAny();

  return { config, temporal, daemon };
}
