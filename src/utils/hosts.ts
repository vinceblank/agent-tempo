/**
 * `listHosts` — join layer for #274 host discovery.
 *
 * Three RPCs per invocation (AC6b):
 *   1. `DescribeTaskQueue` on the shared queue with `TASK_QUEUE_TYPE_WORKFLOW`
 *      — populates `hasWorkflowWorker` per identity.
 *   2. Same queue, `TASK_QUEUE_TYPE_ACTIVITY` — populates `hasActivityWorker`.
 *   3. `DescribeTaskQueue` on each per-host queue
 *      (`claude-tempo-<hostname>`), `TASK_QUEUE_TYPE_ACTIVITY` — populates
 *      `hasHostQueueWorker`. Runs in parallel across discovered hostnames.
 *
 * Plus one `hostProfiles` query against the global maestro when it's
 * running (AC6g). Absent → liveness-only with
 * `profileStaleness: 'missing'`.
 *
 * Identity is parsed with dual-format tolerance (AC6d / M6):
 *   - `claude-tempo:<hostname>:<pid>:<version>` (set by #274 workers)
 *   - `<pid>@<hostname>` (legacy SDK default, pre-#274 daemons)
 *   - Anything else is skipped silently as opaque third-party.
 *
 * Results are cached for `CACHE_TTL_MS` (AC6h) to keep rapid-fire CLI/TUI
 * invocations cheap; pass `force: true` to bypass.
 */
import type { Client } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { hostTaskQueue, GLOBAL_MAESTRO_WORKFLOW_ID } from '../config';
import type { HostInfo, HostProfile, InstanceInfo } from '../types';

/**
 * Freshness threshold — pollers seen in the last minute are `'live'`,
 * older ones are tagged `'stale'` and hidden by default. Temporal
 * server-side LRU keeps pollers for ~5 min; 1-min gives a tighter
 * "currently polling" signal and aligns with the daemon heartbeat
 * cadence. AC6c.
 */
export const HOST_FRESHNESS_THRESHOLD_MS = 60_000;

/** Read-through cache TTL for the join result. AC6h. */
export const CACHE_TTL_MS = 3_000;

// Module-level memo. Not exported — bypass via `listHosts(client, { force: true })`.
interface CacheEntry {
  timestamp: number;
  hosts: HostInfo[];
}
let cache: CacheEntry | null = null;

/** Test hook — never call from production code. */
export function __resetHostsCacheForTests(): void {
  cache = null;
}

// ────────────────────────────────────────────────────────────────────────
// parseIdentity — dual-format tolerance (AC6d / M6)
// ────────────────────────────────────────────────────────────────────────

export interface ParsedIdentity {
  hostname: string;
  pid: number;
  version: string;
  /** `true` when the identity was in the legacy `<pid>@<hostname>` SDK-default shape. */
  legacy: boolean;
}

/**
 * Parse a Temporal poller identity back into the daemon that emitted it.
 *
 * Returns `null` for opaque / third-party identities (e.g. Temporal's own
 * system pollers or an unrelated worker sharing the namespace). Callers
 * skip those silently.
 *
 * The post-#274 format (`claude-tempo:<hostname>:<pid>:<version>`) is
 * guaranteed to have exactly 4 colon-delimited segments because every
 * component has its own validation: hostname passes `PLAYER_NAME_REGEX`
 * (no colons possible), pid is numeric, and version is a semver-ish
 * string (no colons).
 */
export function parseIdentity(identity: string): ParsedIdentity | null {
  if (identity.startsWith('claude-tempo:')) {
    const parts = identity.split(':');
    if (parts.length === 4) {
      const [, hostname, pidStr, version] = parts;
      const pid = Number(pidStr);
      if (hostname.length > 0 && Number.isFinite(pid) && pid > 0 && version.length > 0) {
        return { hostname, pid, version, legacy: false };
      }
    }
    return null;
  }
  // Legacy SDK default format: `<pid>@<hostname>`
  const legacyMatch = identity.match(/^(\d+)@(.+)$/);
  if (legacyMatch) {
    const pid = Number(legacyMatch[1]);
    const hostname = legacyMatch[2];
    if (Number.isFinite(pid) && pid > 0 && hostname.length > 0) {
      return { hostname, pid, version: 'unknown', legacy: true };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Low-level RPC + timestamp helpers — exposed for dep-injection in tests
// ────────────────────────────────────────────────────────────────────────

/** Convert a protobuf Timestamp to ISO 8601. Returns `''` for unset timestamps. */
function timestampToIso(ts: temporal.api.enums.v1.TaskQueueType | unknown): string {
  // Protobuf Timestamp is `{seconds: Long | number | string, nanos: number}`.
  // Protobuf.js may deliver `seconds` as a Long object, a raw number, or a
  // string depending on the runtime — normalise defensively.
  if (!ts || typeof ts !== 'object') return '';
  const t = ts as { seconds?: number | string | { toString(): string }; nanos?: number };
  const secondsRaw = t.seconds;
  if (secondsRaw === undefined || secondsRaw === null) return '';
  const seconds = typeof secondsRaw === 'number' ? secondsRaw : Number(String(secondsRaw));
  if (!Number.isFinite(seconds)) return '';
  const ms = seconds * 1000 + Math.floor((t.nanos ?? 0) / 1_000_000);
  return new Date(ms).toISOString();
}

interface RawPoller {
  identity: string;
  lastAccessTimeMs: number; // unix ms; 0 if unset
  lastAccessTimeIso: string;
}

async function describeQueuePollers(
  client: Client,
  namespace: string,
  taskQueueName: string,
  taskQueueType: temporal.api.enums.v1.TaskQueueType,
): Promise<RawPoller[]> {
  const res = await client.workflowService.describeTaskQueue({
    namespace,
    taskQueue: { name: taskQueueName },
    taskQueueType,
  });
  const pollers = res.pollers ?? [];
  const out: RawPoller[] = [];
  for (const p of pollers) {
    const identity = p.identity ?? '';
    if (!identity) continue;
    const iso = timestampToIso(p.lastAccessTime);
    const ms = iso ? Date.parse(iso) : 0;
    out.push({ identity, lastAccessTimeMs: ms, lastAccessTimeIso: iso });
  }
  return out;
}

async function hasGlobalMaestro(client: Client): Promise<boolean> {
  try {
    const handle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
    const desc = await handle.describe();
    return desc.status.name === 'RUNNING';
  } catch {
    return false;
  }
}

async function fetchHostProfiles(client: Client): Promise<Record<string, HostProfile> | null> {
  if (!(await hasGlobalMaestro(client))) return null;
  try {
    const handle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
    return (await handle.query('hostProfiles')) as Record<string, HostProfile>;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// listHosts — the public join helper
// ────────────────────────────────────────────────────────────────────────

export interface ListHostsOpts {
  /** Bypass the 3s TTL cache. CLI/TUI refresh handlers pass `true`. */
  force?: boolean;
  /** Default `'default'`. */
  namespace?: string;
  /** Default `'claude-tempo'`. */
  taskQueue?: string;
  /** `Date.now` replacement for deterministic tests. */
  now?: () => number;
  /**
   * Dep-injected poller fetcher — tests stub to return canned rows.
   * Production callers omit and the helper uses
   * `client.workflowService.describeTaskQueue` directly.
   */
  describePollers?: (
    client: Client,
    namespace: string,
    taskQueueName: string,
    taskQueueType: temporal.api.enums.v1.TaskQueueType,
  ) => Promise<RawPoller[]>;
  /** Dep-injected profile fetcher. Tests stub to control profile state. */
  fetchProfiles?: (client: Client) => Promise<Record<string, HostProfile> | null>;
}

export async function listHosts(client: Client, opts: ListHostsOpts = {}): Promise<HostInfo[]> {
  const now = opts.now ? opts.now() : Date.now();
  if (!opts.force && cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.hosts;
  }

  const namespace = opts.namespace ?? 'default';
  const taskQueue = opts.taskQueue ?? 'claude-tempo';
  const describe = opts.describePollers ?? describeQueuePollers;
  const fetchProfiles = opts.fetchProfiles ?? fetchHostProfiles;

  const { TASK_QUEUE_TYPE_WORKFLOW, TASK_QUEUE_TYPE_ACTIVITY } = temporal.api.enums.v1.TaskQueueType;

  // RPCs 1 + 2 — shared queue, both worker types. Parallel.
  const [sharedWorkflow, sharedActivity] = await Promise.all([
    describe(client, namespace, taskQueue, TASK_QUEUE_TYPE_WORKFLOW),
    describe(client, namespace, taskQueue, TASK_QUEUE_TYPE_ACTIVITY),
  ]);

  // Parse identities and group by hostname+pid. Opaque identities drop out.
  interface Key { hostname: string; pid: number }
  const parsedByIdentity = new Map<string, ParsedIdentity & Key>();
  const takePoller = (p: RawPoller) => {
    const parsed = parseIdentity(p.identity);
    if (!parsed) return null;
    parsedByIdentity.set(p.identity, parsed);
    return parsed;
  };
  for (const p of sharedWorkflow) takePoller(p);
  for (const p of sharedActivity) takePoller(p);

  const hostnames = Array.from(new Set(Array.from(parsedByIdentity.values()).map((p) => p.hostname)));
  hostnames.sort();

  // RPC 3 — per-host activity queue. Parallel across hostnames.
  const perHostActivityMap = new Map<string, RawPoller[]>();
  await Promise.all(
    hostnames.map(async (hostname) => {
      try {
        const rows = await describe(client, namespace, hostTaskQueue(taskQueue, hostname), TASK_QUEUE_TYPE_ACTIVITY);
        perHostActivityMap.set(hostname, rows);
      } catch {
        // Per-host-queue not registered yet → empty. Don't fail the whole call.
        perHostActivityMap.set(hostname, []);
      }
    }),
  );

  // Profile fetch (guarded by maestro presence)
  const profiles = await fetchProfiles(client).catch(() => null);

  // ── Build InstanceInfo per (hostname, pid) ──
  // Merge the three poller streams by `identity`; each daemon sets the
  // same identity on both the shared-workflow and shared-activity pollers
  // AND on the per-host-activity worker. If the hostname → pid is
  // present in any stream, an InstanceInfo entry is emitted.
  const hostInstances = new Map<string, Map<number, InstanceInfo>>();
  const markInstance = (hostname: string, pid: number, mutate: (i: InstanceInfo) => void, ident?: ParsedIdentity, poller?: RawPoller) => {
    let byPid = hostInstances.get(hostname);
    if (!byPid) {
      byPid = new Map();
      hostInstances.set(hostname, byPid);
    }
    let inst = byPid.get(pid);
    if (!inst) {
      inst = {
        pid,
        version: ident?.version ?? 'unknown',
        identity: poller?.identity ?? '',
        lastAccessTime: poller?.lastAccessTimeIso ?? '',
        hasWorkflowWorker: false,
        hasActivityWorker: false,
        hasHostQueueWorker: false,
        ...(ident?.legacy ? { legacy: true as const } : {}),
      };
      byPid.set(pid, inst);
    } else if (poller && poller.lastAccessTimeMs > (Date.parse(inst.lastAccessTime) || 0)) {
      // Keep the freshest timestamp across the three streams; helps tests
      // and operators see the most recent signal-of-life for this pid.
      inst.lastAccessTime = poller.lastAccessTimeIso;
      inst.identity = poller.identity;
    }
    mutate(inst);
  };
  const consume = (pollers: RawPoller[], flag: 'hasWorkflowWorker' | 'hasActivityWorker' | 'hasHostQueueWorker') => {
    for (const p of pollers) {
      const ident = parsedByIdentity.get(p.identity) ?? parseIdentity(p.identity);
      if (!ident) continue;
      parsedByIdentity.set(p.identity, ident as ParsedIdentity & Key);
      markInstance(ident.hostname, ident.pid, (i) => { i[flag] = true; }, ident, p);
    }
  };
  consume(sharedWorkflow, 'hasWorkflowWorker');
  consume(sharedActivity, 'hasActivityWorker');
  for (const hostname of hostnames) {
    consume(perHostActivityMap.get(hostname) ?? [], 'hasHostQueueWorker');
  }

  // ── Build HostInfo per hostname ──
  const hosts: HostInfo[] = [];
  for (const hostname of hostnames) {
    const byPid = hostInstances.get(hostname);
    if (!byPid || byPid.size === 0) continue;
    const instances: InstanceInfo[] = Array.from(byPid.values()).sort((a, b) => a.pid - b.pid);
    const isFresh = (iso: string): boolean => {
      const ts = iso ? Date.parse(iso) : 0;
      return ts > 0 && now - ts <= HOST_FRESHNESS_THRESHOLD_MS;
    };
    const freshness: 'live' | 'stale' = instances.some((i) => isFresh(i.lastAccessTime)) ? 'live' : 'stale';
    const recruitReady = instances.some((i) =>
      i.hasActivityWorker && i.hasHostQueueWorker && isFresh(i.lastAccessTime),
    );
    const profile = profiles?.[hostname];
    const profileStaleness = determineStaleness(profile, instances, profiles);
    hosts.push({ hostname, instances, recruitReady, freshness, profile, profileStaleness });
  }

  cache = { timestamp: now, hosts };
  return hosts;
}

/**
 * M13 — identity-vs-profile reconciliation.
 *
 *   - `'missing'` — maestro is absent OR this host has no profile entry
 *   - `'fresh'`   — profile present AND some live instance's version
 *                   matches `profile.version`
 *   - `'stale'`   — profile present but no live instance matches its
 *                   version (rolling upgrade, GC pending, etc.)
 */
function determineStaleness(
  profile: HostProfile | undefined,
  instances: InstanceInfo[],
  profiles: Record<string, HostProfile> | null | undefined,
): 'fresh' | 'stale' | 'missing' {
  if (!profiles) return 'missing'; // maestro unreachable or absent
  if (!profile) return 'missing';
  if (!profile.version) return 'fresh'; // legacy profile with no version — trust as-is
  return instances.some((i) => i.version === profile.version) ? 'fresh' : 'stale';
}
