/**
 * `listHosts` — join layer for #274 host discovery.
 *
 * Three RPCs per invocation (AC6b):
 *   1. `DescribeTaskQueue` on the shared queue with `TASK_QUEUE_TYPE_WORKFLOW`
 *      — populates `hasWorkflowWorker` per identity.
 *   2. Same queue, `TASK_QUEUE_TYPE_ACTIVITY` — populates `hasActivityWorker`.
 *   3. `DescribeTaskQueue` on each per-host queue
 *      (`agent-tempo-<hostname>`), `TASK_QUEUE_TYPE_ACTIVITY` — populates
 *      `hasHostQueueWorker`. Runs in parallel across discovered hostnames.
 *
 * Plus one `hostProfiles` query against the global maestro when it's
 * running (AC6g). Absent → liveness-only with
 * `profileStaleness: 'missing'`.
 *
 * Identity is parsed with dual-format tolerance (AC6d / M6):
 *   - `agent-tempo:<hostname>:<pid>:<version>` (set by v1.0+ workers)
 *   - `<pid>@<hostname>` (legacy SDK default, pre-#274 daemons)
 *   - Anything else is skipped silently as opaque third-party.
 *
 * Results are cached for `CACHE_TTL_MS` (AC6h) to keep rapid-fire CLI/TUI
 * invocations cheap; pass `force: true` to bypass.
 */
import type { Client } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import pLimit from 'p-limit';
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

/**
 * #281 — concurrency cap for the per-host RPC fan-out.
 *
 * `Promise.all(hostnames.map(describe...))` is unbounded; at >20 hosts that
 * thunder-herds the Temporal frontend's per-namespace RPS budget. 8 keeps
 * the common case (≤8 hosts) at full parallelism while preventing the worst
 * case from spiking the backend.
 */
export const HOST_FANOUT_CONCURRENCY = 8;

// Module-level memo. Not exported — bypass via `listHosts(client, { force: true })`.
interface CacheEntry {
  timestamp: number;
  hosts: HostInfo[];
}
let cache: CacheEntry | null = null;

/**
 * Test hook — never call from production code.
 *
 * Convention: `__<verb><Noun>ForTests`, co-located with the module that owns
 * the state. See `docs/adr/0006-test-hooks-naming.md`.
 */
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
 * The v1.0 format (`agent-tempo:<hostname>:<pid>:<version>`) is
 * guaranteed to have exactly 4 colon-delimited segments because every
 * component has its own validation: hostname passes `PLAYER_NAME_REGEX`
 * (no colons possible), pid is numeric, and version is a semver-ish
 * string (no colons).
 *
 * Pre-v1.0 daemons emitted a `claude-tempo:` prefix. Under the v1.0 hard
 * break those daemons can't reach v1.x task queues anyway, but if one does
 * surface in a host listing we tag it `legacy: true` so operators can
 * distinguish a still-running old daemon from a fresh v1.x worker.
 */
export function parseIdentity(identity: string): ParsedIdentity | null {
  if (identity.startsWith('agent-tempo:') || identity.startsWith('claude-tempo:')) {
    const legacy = identity.startsWith('claude-tempo:');
    const parts = identity.split(':');
    if (parts.length === 4) {
      const [, hostname, pidStr, version] = parts;
      const pid = Number(pidStr);
      if (hostname.length > 0 && Number.isFinite(pid) && pid > 0 && version.length > 0) {
        return { hostname, pid, version, legacy };
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

/**
 * #280 — single combined query against the global maestro.
 *
 * Replaces the prior two-RPC dance (`handle.describe()` for liveness
 * then `handle.query('hostProfiles')` for data) with one round trip.
 * Reaching the handler proves the workflow is running, so the caller
 * gets `{ exists: true, profiles }`. Any transport-level failure
 * (workflow not found, terminated, namespace unreachable, query
 * handler not registered on an older maestro) is caught and surfaced
 * as `null`, which the join site treats as `profileStaleness: 'missing'`.
 *
 * Note: we deliberately fall back to `null` on ANY error rather than
 * trying the legacy `hostProfiles` query as a second attempt — the
 * combined query has been on every maestro since this commit, so a
 * mismatched daemon/maestro pair is a deployment bug worth surfacing
 * as missing-profile (which still lets the listing succeed) rather
 * than masking with extra RPCs.
 */
async function fetchHostProfiles(client: Client): Promise<Record<string, HostProfile> | null> {
  try {
    const handle = client.workflow.getHandle(GLOBAL_MAESTRO_WORKFLOW_ID);
    const result = (await handle.query('hostProfilesWithExistence')) as {
      exists: boolean;
      profiles: Record<string, HostProfile>;
    } | undefined;
    if (!result || !result.exists) return null;
    return result.profiles;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// listHosts — the public join helper
// ────────────────────────────────────────────────────────────────────────

/**
 * Dep-injection seam used by tests. Production callers OMIT this entirely —
 * grouping it under `deps` (vs. mixing into the top level of `ListHostsOpts`)
 * keeps the user-facing surface (`force`, `namespace`, `taskQueue`) cleanly
 * separated from internal test wiring. See #283.
 */
export interface ListHostsDeps {
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

export interface ListHostsOpts {
  /** Bypass the 3s TTL cache. CLI/TUI refresh handlers pass `true`. */
  force?: boolean;
  /** Default `'default'`. */
  namespace?: string;
  /** Default `'agent-tempo'`. */
  taskQueue?: string;
  /** Test-only dep-injection seam. Production callers omit. */
  deps?: ListHostsDeps;
}

export async function listHosts(client: Client, opts: ListHostsOpts = {}): Promise<HostInfo[]> {
  const deps = opts.deps ?? {};
  const now = deps.now ? deps.now() : Date.now();
  if (!opts.force && cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.hosts;
  }

  const namespace = opts.namespace ?? 'default';
  const taskQueue = opts.taskQueue ?? 'agent-tempo';
  const describe = deps.describePollers ?? describeQueuePollers;
  const fetchProfiles = deps.fetchProfiles ?? fetchHostProfiles;

  const { TASK_QUEUE_TYPE_WORKFLOW, TASK_QUEUE_TYPE_ACTIVITY } = temporal.api.enums.v1.TaskQueueType;

  // RPCs 1 + 2 — shared queue, both worker types. Parallel.
  const [sharedWorkflow, sharedActivity] = await Promise.all([
    describe(client, namespace, taskQueue, TASK_QUEUE_TYPE_WORKFLOW),
    describe(client, namespace, taskQueue, TASK_QUEUE_TYPE_ACTIVITY),
  ]);

  // ── Build InstanceInfo per (hostname, pid) as we consume each stream ──
  // Each daemon sets the same identity on both the shared-workflow and
  // shared-activity pollers AND on the per-host-activity worker, so the
  // (hostname, pid) key merges naturally across streams. Opaque identities
  // drop out of `parseIdentity` and are skipped silently (AC6d).
  const hostInstances = new Map<string, Map<number, InstanceInfo>>();
  const markInstance = (
    hostname: string,
    pid: number,
    flag: 'hasWorkflowWorker' | 'hasActivityWorker' | 'hasHostQueueWorker',
    ident: ParsedIdentity,
    poller: RawPoller,
  ) => {
    let byPid = hostInstances.get(hostname);
    if (!byPid) {
      byPid = new Map();
      hostInstances.set(hostname, byPid);
    }
    let inst = byPid.get(pid);
    if (!inst) {
      inst = {
        pid,
        version: ident.version,
        identity: poller.identity,
        lastAccessTime: poller.lastAccessTimeIso,
        hasWorkflowWorker: false,
        hasActivityWorker: false,
        hasHostQueueWorker: false,
        ...(ident.legacy ? { legacy: true as const } : {}),
      };
      byPid.set(pid, inst);
    }
    inst[flag] = true;
  };
  const consume = (pollers: RawPoller[], flag: 'hasWorkflowWorker' | 'hasActivityWorker' | 'hasHostQueueWorker') => {
    for (const p of pollers) {
      const ident = parseIdentity(p.identity);
      if (!ident) continue;
      markInstance(ident.hostname, ident.pid, flag, ident, p);
    }
  };
  consume(sharedWorkflow, 'hasWorkflowWorker');
  consume(sharedActivity, 'hasActivityWorker');

  // Hostnames discovered from the shared queues drive the per-host RPC fan-out.
  const hostnames = Array.from(hostInstances.keys()).sort();

  // RPC 3 — per-host activity queue. Parallel with the profile fetch,
  // but capped at HOST_FANOUT_CONCURRENCY so a deployment with many hosts
  // doesn't thunder-herd the Temporal frontend (#281).
  const limit = pLimit(HOST_FANOUT_CONCURRENCY);
  const [perHostActivityRows, profiles] = await Promise.all([
    Promise.all(
      hostnames.map((hostname) =>
        limit(async () => {
          try {
            const rows = await describe(client, namespace, hostTaskQueue(taskQueue, hostname), TASK_QUEUE_TYPE_ACTIVITY);
            return [hostname, rows] as const;
          } catch {
            // Per-host-queue not registered yet → empty. Don't fail the whole call.
            return [hostname, [] as RawPoller[]] as const;
          }
        }),
      ),
    ),
    fetchProfiles(client).catch(() => null),
  ]);
  for (const [, rows] of perHostActivityRows) {
    consume(rows, 'hasHostQueueWorker');
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
