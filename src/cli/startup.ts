/**
 * Auto-provisioning bootstrap state machine (#289 / S7 of #285).
 *
 * Bare `claude-tempo` invocation runs this on the way to the TUI. Six steps
 * get the user from "nothing installed" → "ready for the TUI home view";
 * each step is idempotent and cached where safe so a warm system completes
 * in <50ms (steps 1–5) and a cold system stays under ~200ms.
 *
 * Step 7 is the caller's TUI handoff (`src/cli.ts` default path) — this
 * module only produces the `BootstrapResult` that the TUI consumes as
 * initial props.
 *
 * Per-step caching (`~/.claude-tempo/.bootstrap-cache.json`) is keyed by
 * `schemaVersion` + `binaryVersion` so an upgrade wipes the cache and the
 * new binary re-validates everything. Steps with volatile state (daemon
 * liveness, orphan count) are never cached.
 *
 * No auto-resume on bare invocation (#289 pin item 1) — the home view is
 * responsible for letting the user pick a parked ensemble to restore. Step
 * 6 prefetches the ensemble list so the TUI renders instantly.
 */
import { performance } from 'perf_hooks';
import { execFileSync, spawn as cpSpawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { Client } from '@temporalio/client';
import { Config, CLAUDE_TEMPO_HOME } from '../config';
import { createTemporalConnection } from '../connection';
import { resolveClaudePath } from '../spawn';
import { isMcpConfigured, isGlobalMcpRegistered, addGlobalMcp } from './mcp';
import {
  DAEMON_PID_PATH,
  DAEMON_HEARTBEAT_PATH,
  DAEMON_LOG_PATH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MULTIPLIER,
  isDaemonRunning,
  startDaemon,
} from './daemon';
import { queryOrphanedSessions } from '../reconcile/orphans';
import { createTempoClient } from '../client';
import type { EnsembleSummary } from '../client/interface';
import { hostname as osHostname } from 'os';
import { getGitInfo } from '../git-info';

// ─────────────────────────────────────────────────────────────────────────
// Public types (locked by #289 + #290 spec pins)
// ─────────────────────────────────────────────────────────────────────────

export type StepName =
  | 'preflight'
  | 'mcpConfig'
  | 'temporalReach'
  | 'searchAttrs'
  | 'daemonBoot'
  | 'badgeCollection';

/** Structured per-step result. `ok` = ran successfully; `skipped` = cache hit;
 *  `action-taken` = needed repair (e.g. started daemon, registered MCP);
 *  `failed` = non-fatal failure recorded for the TUI to surface. */
export interface StepOutcome {
  status: 'ok' | 'skipped' | 'action-taken' | 'failed';
  durationMs: number;
  detail?: string;
}

export interface OutdatedVersionBadge {
  latest: string;
  severity: 'major' | 'minor';
}

export interface DaemonLogErrorsBadge {
  count: number;
  /** Up to 3 most recent ERROR lines from the daemon log tail. */
  sample: string[];
  logPath: string;
}

export interface BootstrapResult {
  durationMs: number;
  steps: Record<StepName, StepOutcome>;
  badges: {
    /** Orphan count from `queryOrphanedSessions` on this host. Always fresh. */
    orphanCount: number;
    /** Undefined = up-to-date, patch-only, or npm-check offline / timed out. */
    outdatedVersion?: OutdatedVersionBadge;
    /** Undefined = clean daemon-log tail. */
    daemonLogErrors?: DaemonLogErrorsBadge;
  };
  /** Pre-fetched for HomeView's first render; TUI re-polls every 10s. */
  ensembles: EnsembleSummary[];
  cwd: string;
  /** `null` when not in a git dir. */
  cwdGitRoot: string | null;
}

export interface BootstrapArgs {
  config: Config;
  cwd?: string;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable cache-path override for tests. Default: `CLAUDE_TEMPO_HOME`. */
  cacheDir?: string;
  /** Injectable npm-version fetcher for tests. Default: live registry fetch. */
  fetchLatestVersion?: (pkgName: string, timeoutMs: number) => Promise<string | null>;
  /** Binary version (defaults to `require('../../package.json').version`). Tests pin. */
  binaryVersion?: string;
  /**
   * Inject step-5 daemon-boot. Default spawns the real daemon via
   * `startDaemon` (up to 30s wait). Tests should always override to avoid
   * spawning a real daemon process from the test harness. Returning
   * `'skipped'` simulates "daemon already running"; `'action-taken'`
   * simulates a successful start; `'failed'` + `detail` simulates failure.
   */
  daemonBoot?: (config: Config) => Promise<StepOutcome>;
  /**
   * Inject the Temporal reachability probe (steps 3 + 6). Tests override
   * to avoid real network I/O — default performs `createTemporalConnection`
   * with a 3s timeout. Returning `false` simulates unreachable;
   * `true` simulates reachable (step 3 caches success, step 6 still
   * attempts connect but is tolerant of failure).
   */
  isTemporalReachable?: (config: Config) => Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────
// Cache (schema v1)
// ─────────────────────────────────────────────────────────────────────────

const CACHE_SCHEMA_VERSION = 1 as const;
const CACHE_FILENAME = '.bootstrap-cache.json';

type CacheStepKey =
  | 'preflight'
  | 'mcpConfig'
  | 'temporalReach'
  | 'searchAttrs'
  | 'npmVersionCheck';

interface CacheStepEntry {
  lastSuccess: string; // ISO
  /** MCP config file mtime snapshot at last success — `mcpConfig` only. */
  configMtime?: string;
  /** Cached npm-registry result — `npmVersionCheck` only. */
  result?: { latest: string };
}

interface BootstrapCache {
  schemaVersion: number;
  binaryVersion: string;
  steps: Partial<Record<CacheStepKey, CacheStepEntry>>;
}

function defaultCache(binaryVersion: string): BootstrapCache {
  return { schemaVersion: CACHE_SCHEMA_VERSION, binaryVersion, steps: {} };
}

/** Read the cache, validating schema + binary version. Any failure returns
 *  a fresh empty cache — malformed / upgrade-mismatched files are treated
 *  as a cache miss, the caller just does a cold bootstrap. */
export function readCache(cacheDir: string, binaryVersion: string): BootstrapCache {
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BootstrapCache>;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return defaultCache(binaryVersion);
    if (parsed.binaryVersion !== binaryVersion) return defaultCache(binaryVersion);
    if (!parsed.steps || typeof parsed.steps !== 'object') return defaultCache(binaryVersion);
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      binaryVersion,
      steps: parsed.steps,
    };
  } catch {
    // Missing / unreadable / malformed — treat as cold.
    return defaultCache(binaryVersion);
  }
}

/** Best-effort cache write; never throws (a cache failure must not break bootstrap). */
export function writeCache(cacheDir: string, cache: BootstrapCache): void {
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch { /* non-fatal — next run will re-fill */ }
}

/** Decide if a cached step is fresh enough to skip. `undefined` entry or
 *  `lastSuccess` older than `ttlMs` → stale. */
export function isCacheFresh(
  entry: CacheStepEntry | undefined,
  ttlMs: number,
  now: number,
): boolean {
  if (!entry?.lastSuccess) return false;
  const last = Date.parse(entry.lastSuccess);
  if (!Number.isFinite(last)) return false;
  return now - last < ttlMs;
}

const TTL_24H = 24 * 60 * 60 * 1000;
const TTL_60S = 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Search-attribute list (single source of truth — matches src/cli/commands.ts
// SEARCH_ATTRIBUTES until a future PR consolidates them; if that list drifts
// it'll silently under-register here, so tests assert both contain the same
// set via `sortedSearchAttributeNames()` helper).
// ─────────────────────────────────────────────────────────────────────────

const SEARCH_ATTRIBUTES: ReadonlyArray<{ name: string; type: 'Keyword' | 'Bool' }> = [
  { name: 'ClaudeTempoHostname', type: 'Keyword' },
  { name: 'ClaudeTempoGitRoot', type: 'Keyword' },
  { name: 'ClaudeTempoEnsemble', type: 'Keyword' },
  { name: 'ClaudeTempoPlayerId', type: 'Keyword' },
  { name: 'ClaudeTempoPlayerType', type: 'Keyword' },
  { name: 'ClaudeTempoIsConductor', type: 'Bool' },
  { name: 'ClaudeTempoAttachedHost', type: 'Keyword' },
  { name: 'ClaudeTempoAttachmentState', type: 'Keyword' },
  { name: 'ClaudeTempoAttachmentId', type: 'Keyword' },
];

// ─────────────────────────────────────────────────────────────────────────
// Semver-aware outdated-version badge rendering (#289 pin item 4)
// ─────────────────────────────────────────────────────────────────────────

/** Decide the outdated-version badge shape per the policy table:
 *  - major/minor behind → badge with severity
 *  - patch-only → silent
 *  - prerelease vs stable mismatches → silent (respect release channel)
 */
export function classifyVersion(
  installed: string,
  latest: string,
): OutdatedVersionBadge | undefined {
  const i = semver.parse(installed);
  const l = semver.parse(latest);
  if (!i || !l) return undefined;
  if (semver.gte(i, l)) return undefined;

  const iPrerelease = i.prerelease.length > 0;
  const lPrerelease = l.prerelease.length > 0;

  // Channel respect: never nudge prerelease→stable downgrade or stable→prerelease.
  if (iPrerelease && !lPrerelease) return undefined;
  if (!iPrerelease && lPrerelease) return undefined;
  // Prerelease iteration of the same minor — beta iteration is expected.
  if (iPrerelease && lPrerelease && i.major === l.major && i.minor === l.minor) {
    return undefined;
  }

  const diff = semver.diff(installed, latest);
  if (diff === 'major' || diff === 'premajor') return { latest, severity: 'major' };
  if (diff === 'minor' || diff === 'preminor') return { latest, severity: 'minor' };
  // 'patch', 'prepatch', 'prerelease' → silent
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Step helpers
// ─────────────────────────────────────────────────────────────────────────

async function timed<T>(fn: () => Promise<T> | T): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

/** Fetch the latest published version from npm with a hard timeout. Never
 *  throws — returns `null` on any network / timeout / parse error so the
 *  caller can silently proceed (spec pin item 3). */
async function defaultFetchLatestVersion(
  pkgName: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded tail-read budget. Long-running daemons can accumulate multi-MB
 *  logs; reading the entire file on every bootstrap is wasteful. Seek back
 *  from EOF by at most this many bytes — 32 KiB comfortably covers the last
 *  few hundred log lines without loading the full file. */
const DAEMON_LOG_TAIL_BYTES = 32 * 1024;

/** Read the last ~200 ERROR-tagged lines from the daemon log. Returns at
 *  most 3 samples. Bounded-tail read (see {@link DAEMON_LOG_TAIL_BYTES}). */
function daemonLogErrorTail(logPath: string): DaemonLogErrorsBadge | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size;
    if (size === 0) return undefined;
    const start = Math.max(0, size - DAEMON_LOG_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buf, 0, length, start);
    const content = buf.toString('utf8');
    const lines = content.split(/\r?\n/);
    // If we seeked mid-file, the first line may be a partial — discard it.
    const tail = start > 0 ? lines.slice(1) : lines;
    const errors = tail.filter((l) => /\bERROR\b/i.test(l));
    if (errors.length === 0) return undefined;
    return { count: errors.length, sample: errors.slice(-3), logPath };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Individual steps
// ─────────────────────────────────────────────────────────────────────────

async function stepPreflight(
  cache: BootstrapCache,
  now: number,
): Promise<StepOutcome> {
  if (isCacheFresh(cache.steps.preflight, TTL_24H, now)) {
    return { status: 'skipped', durationMs: 0 };
  }
  const { result, durationMs } = await timed(() => {
    const errors: string[] = [];
    const major = parseInt(process.version.slice(1), 10);
    if (major < 20) errors.push(`Node.js 20+ required, found ${process.version}`);

    const claudePath = resolveClaudePath();
    if (claudePath === 'claude') {
      // `resolveClaudePath` returns the literal `'claude'` on miss — the
      // caller is expected to rely on `PATH`. That's fine at runtime, but
      // preflight catches the "not installed" case early.
      try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
          stdio: 'ignore',
        });
      } catch {
        errors.push('claude binary not found on PATH. Install Claude Code from https://claude.com/claude-code');
      }
    }

    try {
      fs.mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });
      fs.accessSync(CLAUDE_TEMPO_HOME, fs.constants.W_OK);
    } catch {
      errors.push(`${CLAUDE_TEMPO_HOME} is not writable. Check permissions or set $HOME.`);
    }

    return errors;
  });

  if (result.length > 0) {
    return { status: 'failed', durationMs, detail: result.join('; ') };
  }
  cache.steps.preflight = { lastSuccess: new Date(now).toISOString() };
  return { status: 'ok', durationMs };
}

async function stepMcpConfig(
  cache: BootstrapCache,
  cwd: string,
  now: number,
): Promise<StepOutcome> {
  const cached = cache.steps.mcpConfig;
  let configMtime: string | undefined;
  try {
    const projectMcp = path.join(cwd, '.mcp.json');
    if (fs.existsSync(projectMcp)) {
      configMtime = fs.statSync(projectMcp).mtime.toISOString();
    }
  } catch { /* ignore — no-mtime path */ }

  if (
    isCacheFresh(cached, TTL_24H, now) &&
    cached?.configMtime === configMtime
  ) {
    return { status: 'skipped', durationMs: 0 };
  }

  const { result: outcome, durationMs } = await timed<StepOutcome>(() => {
    if (isMcpConfigured(cwd)) {
      return { status: 'ok', durationMs: 0 };
    }
    // Install into global user scope (matches current `init` behavior).
    if (!isGlobalMcpRegistered() && addGlobalMcp()) {
      return { status: 'action-taken', durationMs: 0, detail: 'registered claude-tempo in user MCP scope' };
    }
    return { status: 'failed', durationMs: 0, detail: 'Could not register claude-tempo MCP. Run `claude-tempo init` manually.' };
  });

  if (outcome.status !== 'failed') {
    cache.steps.mcpConfig = {
      lastSuccess: new Date(now).toISOString(),
      ...(configMtime !== undefined ? { configMtime } : {}),
    };
  }
  return { ...outcome, durationMs };
}

async function stepTemporalReach(
  cache: BootstrapCache,
  config: Config,
  now: number,
  reachableProbe: (config: Config) => Promise<boolean>,
): Promise<StepOutcome> {
  if (isCacheFresh(cache.steps.temporalReach, TTL_60S, now)) {
    return { status: 'skipped', durationMs: 0 };
  }
  const { result: outcome, durationMs } = await timed<StepOutcome>(async () => {
    const reachable = await reachableProbe(config);
    if (reachable) return { status: 'ok', durationMs: 0 };

    // Auto-start only when the address is local. Remote failures surface
    // an actionable error; we don't try to spawn a remote server.
    if (!isLocalAddress(config.temporalAddress)) {
      return {
        status: 'failed',
        durationMs: 0,
        detail: `Cannot reach remote Temporal at ${config.temporalAddress}. Check TEMPORAL_ADDRESS + network.`,
      };
    }

    if (!hasTemporalCli()) {
      return {
        status: 'failed',
        durationMs: 0,
        detail: 'temporal CLI not found on PATH. Install from https://docs.temporal.io/cli and re-run.',
      };
    }

    const started = await startTemporalDevServer(config, reachableProbe);
    if (started) {
      return { status: 'action-taken', durationMs: 0, detail: `started temporal dev server at ${config.temporalAddress}` };
    }
    return {
      status: 'failed',
      durationMs: 0,
      detail: `temporal dev server did not become reachable at ${config.temporalAddress}`,
    };
  });

  if (outcome.status !== 'failed') {
    cache.steps.temporalReach = { lastSuccess: new Date(now).toISOString() };
  }
  return { ...outcome, durationMs };
}

async function stepSearchAttrs(
  cache: BootstrapCache,
  config: Config,
  now: number,
): Promise<StepOutcome> {
  if (isCacheFresh(cache.steps.searchAttrs, TTL_24H, now)) {
    return { status: 'skipped', durationMs: 0 };
  }
  const { result: outcome, durationMs } = await timed<StepOutcome>(() => {
    // Idempotent — "already registered" errors are swallowed. Any exception
    // from `execFileSync` (temporal CLI missing, unreachable server) caught
    // below as a step failure.
    try {
      for (const attr of SEARCH_ATTRIBUTES) {
        try {
          execFileSync('temporal', [
            'operator', 'search-attribute', 'create',
            '--address', config.temporalAddress,
            '--namespace', config.temporalNamespace,
            '--name', attr.name,
            '--type', attr.type,
          ], { stdio: 'ignore' });
        } catch { /* already registered — expected on warm systems */ }
      }
      return { status: 'ok', durationMs: 0 };
    } catch (err) {
      return {
        status: 'failed',
        durationMs: 0,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });

  if (outcome.status !== 'failed') {
    cache.steps.searchAttrs = { lastSuccess: new Date(now).toISOString() };
  }
  return { ...outcome, durationMs };
}

async function stepDaemonBootAsync(config: Config): Promise<StepOutcome> {
  const start = performance.now();
  if (isDaemonRunning()) {
    // Cheap authoritative check: heartbeat file mtime must be within 2×
    // the interval — otherwise the daemon is hung.
    try {
      const age = Date.now() - fs.statSync(DAEMON_HEARTBEAT_PATH).mtimeMs;
      if (age > HEARTBEAT_INTERVAL_MS * HEARTBEAT_STALE_MULTIPLIER) {
        return {
          status: 'failed',
          durationMs: performance.now() - start,
          detail: `daemon heartbeat stale (${Math.round(age / 1000)}s). Check ${DAEMON_LOG_PATH}.`,
        };
      }
    } catch { /* no heartbeat file yet — daemon is fresh, treat as ok */ }
    return { status: 'skipped', durationMs: performance.now() - start };
  }
  try {
    const pid = await startDaemon(config);
    return {
      status: 'action-taken',
      durationMs: performance.now() - start,
      detail: `started daemon (pid ${pid})`,
    };
  } catch (err) {
    return {
      status: 'failed',
      durationMs: performance.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

interface BadgeCollectionResult {
  badges: BootstrapResult['badges'];
  ensembles: EnsembleSummary[];
  outcome: StepOutcome;
}

async function stepBadgeCollection(
  config: Config,
  cache: BootstrapCache,
  now: number,
  binaryVersion: string,
  fetchLatest: (pkgName: string, timeoutMs: number) => Promise<string | null>,
  reachableProbe: (config: Config) => Promise<boolean>,
): Promise<BadgeCollectionResult> {
  const start = performance.now();
  let orphanCount = 0;
  let ensembles: EnsembleSummary[] = [];
  let outdatedVersion: OutdatedVersionBadge | undefined;
  const hostname = osHostname();

  // Sub-A: orphan count + ensembles list — Temporal connect runs through the
  // injected `reachableProbe` first so a stale `temporalAddress` can't block
  // the TUI. Hard 3s wall-clock budget on the actual connect + queries.
  let connection: Awaited<ReturnType<typeof createTemporalConnection>> | undefined;
  try {
    if (!(await reachableProbe(config))) throw new Error('unreachable');
    connection = await Promise.race([
      createTemporalConnection(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const client = new Client({ connection, namespace: config.temporalNamespace });
    const tempo = createTempoClient(client);
    const [orphans, summaries] = await Promise.all([
      queryOrphanedSessions(client, { hostname }).catch(() => []),
      tempo.discoverEnsembles().catch(() => [] as EnsembleSummary[]),
    ]);
    orphanCount = orphans.length;
    ensembles = summaries;
  } catch { /* degraded — bootstrap still returns, TUI shows connection error */ }
  finally {
    if (connection) try { await connection.close(); } catch { /* ignore */ }
  }

  // Sub-B: npm-version check — 24h cached, 500ms AbortController timeout,
  // silent fallback on network failure (pin items 2 + 3).
  const cachedNpm = cache.steps.npmVersionCheck;
  let latest: string | null = null;
  if (isCacheFresh(cachedNpm, TTL_24H, now) && cachedNpm?.result) {
    latest = cachedNpm.result.latest;
  } else {
    latest = await fetchLatest('claude-tempo', 500);
    if (latest) {
      cache.steps.npmVersionCheck = {
        lastSuccess: new Date(now).toISOString(),
        result: { latest },
      };
    }
    // If fetch returned null (timeout / offline), do NOT update the cache —
    // next bootstrap will try again immediately.
  }
  if (latest) {
    outdatedVersion = classifyVersion(binaryVersion, latest);
  }

  // Sub-C: daemon log error tail. Cheap, always runs.
  const daemonLogErrors = daemonLogErrorTail(DAEMON_LOG_PATH);

  return {
    badges: {
      orphanCount,
      ...(outdatedVersion ? { outdatedVersion } : {}),
      ...(daemonLogErrors ? { daemonLogErrors } : {}),
    },
    ensembles,
    outcome: { status: 'ok', durationMs: performance.now() - start },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Plumbing helpers (Temporal reachability probe + dev-server spawn)
// ─────────────────────────────────────────────────────────────────────────

async function isTemporalReachable(config: Config, timeoutMs = 3000): Promise<boolean> {
  try {
    const conn = await Promise.race([
      createTemporalConnection(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    try {
      const client = new Client({ connection: conn, namespace: config.temporalNamespace });
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

function isLocalAddress(address: string): boolean {
  const host = address.split(':')[0] || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
}

function hasTemporalCli(): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, ['temporal'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function startTemporalDevServer(
  config: Config,
  reachableProbe: (config: Config) => Promise<boolean>,
): Promise<boolean> {
  fs.mkdirSync(CLAUDE_TEMPO_HOME, { recursive: true });
  const port = config.temporalAddress.split(':')[1] || '7233';
  const dbPath = path.join(CLAUDE_TEMPO_HOME, 'temporal-data.db');
  const child = cpSpawn('temporal', ['server', 'start-dev', '--port', port, '--db-filename', dbPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachableProbe(config)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────

/** Read the installed package version. Cached behind a function so tests
 *  can override via `BootstrapArgs.binaryVersion`. */
function readBinaryVersion(): string {
  try {
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Run the 7-step auto-provisioning sequence. Returns a `BootstrapResult`
 * the caller feeds to the TUI; step 7 (TUI launch) is the caller's
 * handoff — this function does NOT spawn UI processes.
 */
export async function bootstrap(args: BootstrapArgs): Promise<BootstrapResult> {
  const start = performance.now();
  const cwd = args.cwd ?? process.cwd();
  const now = (args.now ?? (() => Date.now()))();
  const cacheDir = args.cacheDir ?? CLAUDE_TEMPO_HOME;
  const binaryVersion = args.binaryVersion ?? readBinaryVersion();
  const fetchLatest = args.fetchLatestVersion ?? defaultFetchLatestVersion;

  const cache = readCache(cacheDir, binaryVersion);
  const reachableProbe = args.isTemporalReachable ?? ((c: Config) => isTemporalReachable(c, 3000));

  // Steps 1–5: fail-fast on step 1 so we don't try to register MCP on an
  // incompatible Node. Each step mutates the cache in-place.
  const preflight = await stepPreflight(cache, now);

  // Steps 2 + 3 are independent (MCP config is local fs/shell; Temporal
  // reachability is network), so run them in parallel — up to ~300ms
  // cold-path savings when the claude-mcp-list shell-out is slow.
  const [mcpConfig, temporalReach] = preflight.status === 'failed'
    ? [
        { status: 'skipped', durationMs: 0 } satisfies StepOutcome,
        { status: 'skipped', durationMs: 0 } satisfies StepOutcome,
      ]
    : await Promise.all([
        stepMcpConfig(cache, cwd, now),
        stepTemporalReach(cache, args.config, now, reachableProbe),
      ]);

  const searchAttrs = temporalReach.status === 'failed'
    ? ({ status: 'skipped', durationMs: 0, detail: 'skipped — temporal unreachable' } satisfies StepOutcome)
    : await stepSearchAttrs(cache, args.config, now);
  const daemonBoot = preflight.status === 'failed'
    ? ({ status: 'skipped', durationMs: 0 } satisfies StepOutcome)
    : await (args.daemonBoot ?? stepDaemonBootAsync)(args.config);

  // Step 6: badges + ensembles prefetch. Runs even on partial-failure paths
  // so the TUI can render something meaningful; Temporal-connect failure
  // degrades to zeros / empty lists rather than throwing.
  const badgeStep = await stepBadgeCollection(
    args.config,
    cache,
    now,
    binaryVersion,
    fetchLatest,
    reachableProbe,
  );

  // Persist cache after all steps — one write per bootstrap.
  writeCache(cacheDir, cache);

  return {
    durationMs: performance.now() - start,
    steps: {
      preflight,
      mcpConfig,
      temporalReach,
      searchAttrs,
      daemonBoot,
      badgeCollection: badgeStep.outcome,
    },
    badges: badgeStep.badges,
    ensembles: badgeStep.ensembles,
    cwd,
    cwdGitRoot: getGitInfo(cwd).gitRoot ?? null,
  };
}
