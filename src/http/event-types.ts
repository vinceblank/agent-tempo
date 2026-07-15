/**
 * SSE event-source wire types — shared by the daemon (server, PR-1/PR-2) and
 * the TempoClient subscribe wrapper (PR-3). The drift detector at
 * `test/sse/wire-protocol.test.ts` (PR-2 deliverable) cross-checks
 * `SSE_EVENT_KINDS` against the §6 table in `docs/SSE-PROTOCOL.md`.
 *
 * **Reference**: [`docs/SSE-PROTOCOL.md`](../../docs/SSE-PROTOCOL.md).
 *
 * **Stability**: every name and field shape here is part of the v1 wire
 * contract. Renaming or removing requires a major version bump (path prefix
 * `/v1/` → `/v2/`). Adding new event types or additive payload fields is
 * non-breaking.
 *
 * **PR-1 scope**: the snapshot endpoints (`/v1/health`, `/v1/state/:ensemble`,
 * `/v1/ensembles`, `/v1/hosts`) consume `HealthV1`, `EnsembleStateV1`, and
 * `PlayerSummaryV1`. The SSE event union and `TempoClient.subscribe`
 * interface are defined here for PR-2/PR-3 to import without duplication.
 */
import type {
  AttachmentPhase,
  EnsembleChatMessage,
  HostProfile,
  HostInfo,
  ScheduleEntry,
} from '../types';
import type { EnsembleSummary } from '../client/interface';
import type { WorkersHealthV1 } from '../daemon-worker-supervisor';

// ── §4. Snapshot payload shapes ──────────────────────────────────────────

/** §4.1 — `/v1/health` — never authenticated. */
export interface HealthV1 {
  ok: true;
  /** Temporal namespace the daemon is connected to. */
  namespace: string;
  /**
   * Shared task queue the daemon's workers poll. Mirrors `config.taskQueue`
   * (e.g. `agent-tempo` in production, `agent-tempo-dev` in dev mode).
   * Surfaced for the dashboard's Settings → Connection panel so the displayed
   * value reflects the live runtime instead of a hard-coded default. (#444)
   */
  taskQueue: string;
  /** Daemon package version. */
  version: string;
  uptimeMs: number;
  /** Count of distinct ensembles known to the daemon at request time. */
  ensembleCount: number;
  /**
   * Open SSE connections (`/v1/events*`). Always `0` in PR-1 — the daemon
   * has no streaming endpoints yet. PR-2 wires this to the live subscriber set.
   */
  subscriberCount: number;
  /**
   * #336 memory diagnostics — exposes `process.memoryUsage()` at request
   * time so external monitors and `agent-tempo daemon stats` can spot
   * leaks without attaching a debugger. Bytes; see Node docs for field
   * semantics. Optional so legacy clients ignoring the field don't break.
   */
  memory?: MemoryUsageV1;
  /**
   * #886 slice 1 — daemon-side nondeterminism alarm state. Present when the
   * daemon installed the alarm (always, in 2.0+); a non-zero `count` means a
   * nondeterminism / determinism-violation flap was observed since boot (e.g.
   * a 2.0 worker replaying a 1.x history, or a code/bundle skew). Lets external
   * monitors and the dashboard poll the alarm without scraping `daemon.log`.
   * Optional so pre-#886 clients (and non-daemon health responders) ignore it.
   */
  nondeterminism?: NondeterminismAlarmV1;
  /**
   * PR-D (2026-07-13 daemon-resilience program) — per-worker supervisor
   * state. Present when the daemon runs its workers under supervision
   * (always, post-PR-D). The heartbeat file's mtime keeps refreshing every
   * 60s regardless of worker health, so this field is the ONLY external
   * truth about dispatch capability: `state: 'running'` on both workers
   * means tasks are being polled; `restarting`/`reconnecting` means a
   * temporary gap; `gave-up` means the daemon is about to exit 1.
   * See `WorkersHealthV1` in src/daemon-worker-supervisor.ts (Temporal-free
   * type). Optional so pre-PR-D clients and non-daemon responders ignore it.
   */
  workers?: WorkersHealthV1;
}

/** #886 — `/v1/health` shape of the nondeterminism alarm snapshot. */
export interface NondeterminismAlarmV1 {
  /** Total nondeterminism records seen since daemon boot (0 = healthy). */
  count: number;
  /** ISO timestamp of the first hit; absent when `count === 0`. */
  firstSeenAt?: string;
  /** ISO timestamp of the most recent hit; absent when `count === 0`. */
  lastSeenAt?: string;
  /** Most-recent samples (capped, newest last) — `{ at, detail }`. */
  recent: Array<{ at: string; detail: string }>;
}

/** Snapshot of `process.memoryUsage()` at request time. All values in bytes. */
export interface MemoryUsageV1 {
  /** Resident Set Size — the total memory the OS has allocated for the process. */
  rss: number;
  /** V8 heap total. */
  heapTotal: number;
  /** V8 heap used. */
  heapUsed: number;
  /** Memory used by native C++ objects bound to JS (e.g. Temporal SDK). */
  external: number;
  /** Memory allocated for ArrayBuffers + SharedArrayBuffers. */
  arrayBuffers: number;
}

/**
 * §4.3 — `/v1/state/:ensemble` — single-ensemble snapshot.
 *
 * `lastEventId` is the snapshot/stream bridge token. PR-1 returns the
 * sentinel `"0:0"`; PR-2 pairs this with the live aggregate so consumers
 * passing it back as `Last-Event-ID` to `/v1/events/:ensemble` resume from
 * the exact tick the snapshot reflects.
 */
export interface EnsembleStateV1 {
  v: 1;
  ensemble: string;
  /** ISO timestamp recorded when the snapshot was assembled. */
  capturedAt: string;
  /**
   * Opaque event-id token of the form `"<bootEpoch>:<seq>"` (see §5).
   *
   * **Atomicity contract**: the snapshot reflects state as of this id.
   * Every event with a `(bootEpoch, seq)` lexicographically greater than
   * `lastEventId` is NOT yet reflected in `players`, `chat`, `schedules`,
   * `flags`, or `hostProfiles`.
   *
   * **PR-1 sentinel**: the snapshot endpoints ship before any event source
   * exists, so PR-1 returns `"0:0"`. PR-2 subscribers passing this back
   * see an `epoch-mismatch` `gap` event and re-fetch — correct behavior.
   */
  lastEventId: string;
  state: 'online' | 'paused' | 'offline';
  hasConductor: boolean;
  flags: { paused: boolean; held: boolean };
  players: PlayerSummaryV1[];
  schedules: ScheduleEntry[];
  /**
   * Bounded slice of the maestro hub's chat ring (most-recent-first per
   * the hub's `maestroEnsembleChat` query). Consumers paging older
   * messages drop down to `recall` / `getEnsembleChat` direct.
   */
  chat: { messages: EnsembleChatMessage[]; total: number; hasMore: boolean };
  /**
   * Snapshot of the global hostname → `HostProfile` map. Embedded so a
   * consumer rendering one ensemble doesn't need a parallel `/v1/hosts`
   * call to label players by host capabilities. Same shape as the global
   * map; daemons do not partition by ensemble.
   */
  hostProfiles: Record<string, HostProfile>;
  /**
   * Issue #399 W1 wire extensions — projected from the per-ensemble maestro
   * hub's `getEnsembleDescriptionQuery` / `getEnsembleStartTimeQuery` /
   * `getCurrentBpmQuery` / `getTempoSeriesQuery`. Consumers (Hosts/Workspace
   * dashboard) render these without further round-trips.
   */
  /** Free-form description of what the ensemble is working on. `''` when the
   * conductor hasn't set one. */
  description: string;
  /** ISO timestamp of when the maestro hub workflow first started. Used by
   * the dashboard to compute uptime client-side. `''` when the hub isn't
   * reachable. */
  startedAt: string;
  /** Current beats-per-minute (msgs/min activity rate). `0` baseline when
   * activity hasn't accrued yet or the hub is unreachable. */
  currentBpm: number;
  /** 60-element ring of recent activity counts (one per minute, most recent
   * last). Powers the `<TempoStrip>` sparkline. Empty array when the hub
   * isn't reachable. */
  tempoSeries: number[];
}

/**
 * §4.3 — per-player projection used inside `EnsembleStateV1.players` and
 * the `player.added` event payload (§6).
 */
export interface PlayerSummaryV1 {
  playerId: string;
  ensemble: string;
  hostname: string;
  isConductor: boolean;
  /**
   * Adapter family the player runs on. Mirrors {@link AgentType} from
   * `src/types.ts` — every shipped adapter is exposed verbatim so dashboards
   * can render the actual backend instead of coercing headless adapters into
   * `'claude'`. `'mock'` is dev-mode-only (recruit gate rejects it in
   * production); the headless adapters (`'claude-api'`, `'opencode'`,
   * `'claude-code-headless'`) ship as additive `/v1/` extensions per the
   * stability rule at §6 — adding new adapters in future versions remains
   * non-breaking, removing one requires `/v2/`. See #535.
   */
  agentType:
    | 'claude'
    | 'copilot'
    | 'mock'
    | 'claude-api'
    | 'opencode'
    | 'claude-code-headless'
    | 'pi';
  playerType?: string;
  /** Authoritative attachment phase (post-v0.26 — see WIRE-PROTOCOL.md). */
  phase?: AttachmentPhase;
  part: string;
  workDir: string;
  gitBranch?: string;
  /** Absent on `detached` / `gone` phases. ISO timestamp. */
  lastHeartbeatAt?: string;
  /** Present only when `phase === 'processing'`. ISO timestamp. */
  processingSince?: string;
  /**
   * Issue #399 W2 wire extensions — projected from per-session queries
   * (`getRunIdQuery` / `getMessagingStateQuery` / `getLeaseStateQuery`)
   * during snapshot fan-out. Optional everywhere — when the session
   * workflow is unreachable or a query soft-fails the field is absent
   * (or set to a sentinel for objects), and the dashboard renders `—`.
   */
  /** Q5.2 — current execution's runId. UUID; dashboard truncates client-side. */
  runId?: string;
  /** Q5.5 — messaging counters + outbox status string. */
  messaging?: {
    received: number;
    sent: number;
    /** `'empty'` / `'N pending'` / `'N pending (oldest 2m)'`. Server-rendered. */
    outbox: string;
  };
  /** Q5.7 — current attachment lease window. `null` when no active lease
   * (phase ∈ booting / detached / gone). */
  lease?: {
    /** Epoch ms when the lease expires, or `null` when no active lease. */
    expiresAt: number | null;
    /** Lease window length in ms, or `null` when no active lease. */
    leaseMs: number | null;
  };
  /** Q5.6 — monotonic activity counter (cue + outbox push + report + recruit
   * + restart + destroy + migrate). Already on `MaestroPlayerInfo`; passed
   * through verbatim by `toPlayerSummaryV1`. */
  activityCount?: number;
  /** Q5.6 — ISO timestamp of the most recent activity. Already on
   * `MaestroPlayerInfo`; passed through verbatim by `toPlayerSummaryV1`. */
  lastActivityAt?: string;
  /**
   * 3c Tier-1 coarse observability — the tool the player is currently
   * executing, or `null` when idle/between tools. Sourced from session
   * metadata via the heartbeat piggyback (~30s freshness); the live,
   * fine-grained tail is the off-wire `/inner` side-channel (MD-F). Additive.
   */
  currentTool?: string | null;
  /**
   * 3c Tier-1 coarse — estimated context tokens in use (pull-only, from Pi's
   * `getContextUsage()`; `null`/absent right after compaction). Additive.
   */
  contextTokens?: number;
  /** 3c Tier-1 coarse — context usage as a percentage of the model window. Additive. */
  contextPercent?: number;
  /**
   * #886 slice 2 — `true` when the daemon's observation scan could only produce
   * a DEGRADED row for this player: the session workflow was listed but its
   * metadata extraction failed, so the non-identity fields (part/workDir/phase/…)
   * are best-effort blanks. Lets the dashboard/board render an "uncertain" badge
   * instead of dropping the player, which would read as a departure and cause
   * roster flapping (contra #777). Additive + optional per the §6 stability rule;
   * absent on every healthy row.
   */
  degraded?: boolean;
}

// ── §5. SSE framing — event-id token format ─────────────────────────────

/**
 * The eventId token used in the `id:` line of the SSE frame and as the
 * `Last-Event-ID` header round-trip. Format `"<bootEpoch>:<seq>"`:
 *
 * - `bootEpoch` — daemon process boot time as Unix epoch milliseconds,
 *   frozen for the process lifetime. A daemon restart advances the epoch;
 *   a worker restart (e.g. Temporal connection reset) does NOT.
 * - `seq` — uint64 monotonic counter starting at 0, incrementing once per
 *   event emitted to the bus.
 *
 * Comparison rule: server compares the client-supplied `Last-Event-ID` to
 * the live `(bootEpoch, seq)` pair as a numeric tuple — `clientEpoch`
 * first, then `clientSeq`. Mismatched epoch → `gap` event with reason
 * `epoch-mismatch`. Matched epoch with `seq < ringStart` → `gap` with
 * reason `overflow`.
 */
export type EventIdToken = string;

// ── §4.x — `/v1/orphans` cross-host orphan listing (#579) ──────────────────

/**
 * §4.x — single row in the `/v1/orphans` cluster-wide orphan listing.
 *
 * An orphan is a session workflow whose `attachmentInfo.phase ∈ {detached,
 * draining, attached, processing, awaiting}` but whose home-host daemon
 * isn't running an adapter for it — typically because the home host is
 * down or the adapter crashed without orderly destroy. The dashboard
 * `/orphans` screen surfaces these so an operator on a live host can
 * migrate the player over.
 *
 * `hostLiveness` is joined server-side against `listHosts()` so the
 * dashboard doesn't have to re-issue a hosts query per row:
 *   - `'live'`  — `preferredHost` matches a host with `freshness === 'live'`
 *   - `'stale'` — matches a host with `freshness === 'stale'`
 *   - `'missing'` — `preferredHost` is null OR no matching host record
 *
 * `migrateCommand` is the `/migrate` slash-command the operator pastes into
 * their own session on the migrate target (the command-center board; the Ink
 * TUI that originally handled it was removed in #789). `--yes-steal=` (NOT
 * `--confirm-steal-from-host`) is the actual flag the `/migrate` handler
 * accepts. When `preferredHost` is null the
 * command targets the local host and includes the steal guard pre-filled
 * with the last-known host (or a literal `'(unknown)'` when even that is
 * missing — the operator must edit it before submit).
 */
export interface OrphanV1 {
  playerId: string;
  ensemble: string;
  workflowId: string;
  preferredHost: string | null;
  hostLiveness: 'live' | 'stale' | 'missing';
  phase: AttachmentPhase;
  detachedSince: string | null;
  lastHeartbeatAt: string | null;
  migrateCommand: string;
}

/** §4.x — response shape for `GET /v1/orphans[?ensemble=<name>]`. */
export interface OrphansV1 {
  v: 1;
  capturedAt: string;
  orphans: OrphanV1[];
}

/**
 * The PR-1 sentinel `lastEventId` value — emitted on `/v1/state/:ensemble`
 * before PR-2 lights up the aggregate poll loop. Subscribers passing this
 * back as `Last-Event-ID` once PR-2 ships will see an `epoch-mismatch`
 * gap event (because the live daemon's `bootEpoch` is non-zero) and
 * re-fetch — correct behavior.
 */
export const PR1_SENTINEL_EVENT_ID: EventIdToken = '0:0';

// ── §6. Event types — drift-detector contract ────────────────────────────

/**
 * Canonical list of every SSE event `type` the daemon emits. The drift
 * detector (PR-2) reads this array and asserts every `## row` in
 * `docs/SSE-PROTOCOL.md` §6 has a matching entry — and vice versa.
 *
 * **Append-only**. Do not remove. New event types ship as additive `/v1/`
 * additions; removals require `/v2/`.
 */
export const SSE_EVENT_KINDS = [
  'snapshot',
  'gap',
  'throttled',
  'heartbeat',
  'ensemble.created',
  'ensemble.destroyed',
  'player.added',
  'player.removed',
  'player.phase_changed',
  'chat.appended',
  'chat.compressed',
  'flags.changed',
  'schedules.changed',
  'host_profile.changed',
  'player.activity',
  'answer',
] as const;

export type SseEventKind = (typeof SSE_EVENT_KINDS)[number];

/** Common envelope for every event. */
export interface SseEventBase {
  v: 1;
  /** §5 — `"<bootEpoch>:<seq>"`. */
  eventId: EventIdToken;
}

/**
 * Discriminated union of every event payload exposed by the daemon's
 * `/v1/events*` endpoints. PR-3's `TempoClient.subscribe` returns
 * `AsyncIterable<TempoEvent>`.
 */
export type TempoEvent =
  | (SseEventBase & { type: 'snapshot'; payload: EnsembleStateV1 })
  | (SseEventBase & {
      type: 'gap';
      payload: { from: string; to: string; reason: 'epoch-mismatch' | 'overflow' };
    })
  | (SseEventBase & {
      type: 'throttled';
      payload: { droppedSince: string; count: number };
    })
  | (SseEventBase & { type: 'heartbeat'; payload: { at: string } })
  | (SseEventBase & {
      type: 'ensemble.created';
      payload: { ensemble: string; createdAt: string; hasConductor: boolean };
    })
  | (SseEventBase & {
      type: 'ensemble.destroyed';
      payload: { ensemble: string; destroyedAt: string };
    })
  | (SseEventBase & { type: 'player.added'; payload: PlayerSummaryV1 })
  | (SseEventBase & {
      type: 'player.removed';
      payload: {
        playerId: string;
        ensemble: string;
        removedAt: string;
        reason: 'destroyed' | 'gone';
      };
    })
  | (SseEventBase & {
      type: 'player.phase_changed';
      payload: {
        playerId: string;
        ensemble: string;
        phase: AttachmentPhase;
        lastHeartbeatAt?: string;
        processingSince?: string;
        at: string;
      };
    })
  | (SseEventBase & { type: 'chat.appended'; payload: EnsembleChatMessage })
  | (SseEventBase & {
      type: 'chat.compressed';
      payload: { dropped: number; since: string };
    })
  | (SseEventBase & {
      type: 'flags.changed';
      payload: { ensemble: string; paused: boolean; held: boolean; at: string };
    })
  | (SseEventBase & {
      type: 'schedules.changed';
      payload: { ensemble: string; schedules: ScheduleEntry[]; at: string };
    })
  | (SseEventBase & { type: 'host_profile.changed'; payload: HostProfile })
  | (SseEventBase & {
      type: 'player.activity';
      /**
       * 3c Tier-1 coarse activity (MD-F). Emitted by the aggregate poll/diff
       * when a player's `currentTool` or context usage changes between polls.
       * `busy/idle` is DERIVED consumer-side from the player's phase
       * (busy = phase==='processing'); `activityCount`/`lastActivityAt` already
       * ride `PlayerSummaryV1`. This is the ON-wire coarse tier; the fine,
       * live inner tail is the off-wire `/inner` side-channel.
       */
      payload: {
        playerId: string;
        ensemble: string;
        currentTool: string | null;
        contextTokens?: number;
        contextPercent?: number;
        at: string;
      };
    })
  | (SseEventBase & {
      /**
       * #700 P2 — a parked Q&A answer resolved. Emitted by the aggregate's
       * outstanding-ask poll when `maestroGetAnswer(questionId)` first returns
       * non-null. Wakes the inbox-less command-center planner (which consumes
       * this ensemble stream) — the planner-side mirror of how a cue wakes a
       * player. Payload is intentionally small (`text` is fetched on read via
       * `GET /v1/ensembles/:e/answer/:questionId`).
       */
      type: 'answer';
      payload: { questionId: string; from: string; ts: string };
    });

// ── §6.1 — `TempoClient.subscribe` API surface ───────────────────────────

/**
 * Subset of event categories the server can pre-filter on `?topics=...`.
 * Maps roughly to `phase → player.phase_changed`, `chat → chat.*`,
 * `flags → flags.changed`, `schedules → schedules.changed`,
 * `heartbeat → heartbeat`. Setup events (`snapshot`, `gap`, `throttled`,
 * `player.added`, `player.removed`, ensemble lifecycle, `host_profile.*`)
 * are always included — they're the bare minimum for correctness.
 */
export type SubscribeTopic = 'phase' | 'chat' | 'flags' | 'schedules' | 'heartbeat';

export interface SubscribeOptions {
  /**
   * Aborts the iterator and tears down the underlying transport. See
   * SSE-PROTOCOL.md §7.4.
   */
  signal?: AbortSignal;
  /**
   * Server-side topic filter. Server drops other event kinds before they
   * hit the wire. Setup/correctness events are always emitted regardless.
   */
  topics?: SubscribeTopic[];
  // NOTE: `lastEventId` (caller-controllable cursor resume) was deliberately
  // dropped — see ADR 0010. Snapshot-then-stream covers every realistic
  // case; in-session reconnect uses Last-Event-ID under the hood
  // (auto-managed by native EventSource on browser; tracked manually by
  // the fetch wrapper on Node).
}

// ── Re-exports — convenience for PR-2/PR-3 importers ─────────────────────

export type { EnsembleSummary, HostInfo, AttachmentPhase, HostProfile, EnsembleChatMessage, ScheduleEntry };
