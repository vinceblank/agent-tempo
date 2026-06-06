/**
 * Aggregate poll loop (SSE-PROTOCOL.md §8, §11; ADR 0004).
 *
 * **Job**: every `pollIntervalMs` (default 750), snapshot the cluster
 * state via `TempoClient`, diff against the prior snapshot, and emit
 * events to the per-ensemble + global buses. Subscriber count is
 * irrelevant — every TUI / web-dashboard reads from the same one
 * snapshot per tick.
 *
 * **Backpressure** (§8): serial-with-skip. If a tick's queries don't
 * complete before the next 750 ms boundary, the next tick is skipped
 * and a `[agent-tempo:aggregate]` warn-log fires. The daemon never
 * has more than one in-flight aggregate fetch.
 *
 * **Coalescing** (§6, §8):
 *
 * - `player.added/removed` — diff player set
 * - `player.phase_changed` — emitted whenever the phase string changes
 *   between polls. The 250 ms / playerId latest-wins debounce in §6
 *   collapses naturally to "one emit per poll" because the poll
 *   cadence (750 ms) is wider than the debounce window — no extra
 *   timer needed.
 * - `chat.appended` — per new message id since last poll. Bus-level
 *   §8 chat cap collapses excess to `chat.compressed`.
 * - `flags.changed` — only when `(paused, held)` tuple changes.
 * - `schedules.changed` — SHA-256 diff of sorted-by-name JSON.
 * - `host_profile.changed` — per-host SHA-256 diff (scrubbed payload
 *   from `listHosts` already; aggregate just hashes the projection).
 * - `ensemble.created/destroyed` — diff ensemble-name set.
 */
import { createHash } from 'crypto';
import type { TempoClient } from '../client/interface';
import type { HostProfile, EnsembleChatMessage, ScheduleEntry } from '../types';
import { EnsembleEventBus, type EventBus } from './event-bus';
import { SeqAllocator } from './event-id';
import type { EnsembleStateV1, PlayerSummaryV1 } from './event-types';
import { buildEnsembleSnapshot, EnsembleNotFoundError } from './snapshot';
import { MAESTRO_ANSWER_TTL_MS } from '../utils/validation';

/** Default cadence per spec §8. */
export const DEFAULT_POLL_INTERVAL_MS = 750;
/** How many chat-message ids to remember per ensemble. */
const CHAT_ID_MEMORY = 1024;
/** How many chat messages to fetch per poll — wider than the snapshot limit so bursts aren't silently lost. */
const POLL_CHAT_LIMIT = 200;
/**
 * #336/#529 site 6 — correctness deadline for `listEnsemblesBounded()`
 * inside `collect()`. 500ms < 750ms cadence leaves ≥250ms headroom for
 * `applyDiff()` + per-ensemble fan-out + emission. Architect's call:
 * the 15s `tickWatchdogMs` is the *liveness* guard; this 500ms is the
 * *correctness* guard preventing partial-input ensemble diffs.
 */
export const AGGREGATE_LIST_DEADLINE_MS = 500;
/**
 * #550 — consecutive-failure cap for the per-ensemble fan-out
 * carry-forward. After this many `'failed'` outcomes in a row, the
 * ensemble is promoted from `'failed'` (carry-forward in liveNames) to
 * `'gone'` (excluded → emits `ensemble.destroyed`). Matches the
 * 15s tick watchdog ceiling at 750ms cadence: 20 ticks × 750ms ≈ 15s.
 * Operator-coherent: "can't observe → eventually treat as gone."
 *
 * Counted as the threshold to EXCEED (cf > K) so the spec table holds:
 * 20 consecutive `'failed'` ticks stay 'failed'; the 21st promotes.
 */
export const MAX_CONSECUTIVE_FAILURES = 20;

const log = (...args: unknown[]) =>
  console.error('[agent-tempo:aggregate]', ...args);

/**
 * #336/#529 site 6 — sentinel thrown by `collect()` when the
 * visibility-iterator deadline trips. `tick()`'s catch logs it calmly
 * and SKIPS `applyDiff()`, preserving `knownEnsembles` so the next
 * successful tick diffs against the truthful prior set rather than
 * emitting phantom `ensemble.destroyed` events.
 *
 * Modeled as a distinct error class so the catch can branch
 * informatively (`if (err instanceof TickSkipped)`) without parsing
 * error messages — and so callers downstream don't accidentally
 * propagate it as a fatal error.
 */
export class TickSkipped extends Error {
  override readonly name = 'TickSkipped';
  constructor(reason: string) { super(reason); }
}

/**
 * 3c Tier-1 coarse activity snapshot for a single player — the bits the
 * aggregate diffs to decide whether to emit `player.activity`. `currentTool`
 * is normalized to `null` when idle/absent; the context fields are `undefined`
 * when Pi can't report usage (e.g. right after compaction).
 */
export interface PlayerCoarse {
  currentTool: string | null;
  contextTokens?: number;
  contextPercent?: number;
}

/** Extract the coarse-activity tuple from a player summary, normalizing idle → null. */
export function coarseOf(p: PlayerSummaryV1): PlayerCoarse {
  return {
    currentTool: p.currentTool ?? null,
    ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}),
    ...(p.contextPercent !== undefined ? { contextPercent: p.contextPercent } : {}),
  };
}

/** True when two coarse snapshots differ in any field. */
export function coarseChanged(a: PlayerCoarse | undefined, b: PlayerCoarse): boolean {
  return (
    !a ||
    a.currentTool !== b.currentTool ||
    a.contextTokens !== b.contextTokens ||
    a.contextPercent !== b.contextPercent
  );
}

/** Per-ensemble tracking state across ticks. */
interface EnsembleTrack {
  bus: EnsembleEventBus;
  /**
   * #550 — consecutive `'failed'` outcomes since the last `'ok'` in
   * `collect()`'s per-ensemble fan-out. Reset to 0 on a successful
   * fan-out; incremented on `'failed'`. When it exceeds
   * {@link MAX_CONSECUTIVE_FAILURES} the ensemble is promoted to
   * `'gone'` and its track torn down by `applyDiff`. While this
   * counter is `> 0` the cluster diff still treats the ensemble as
   * alive (no phantom `ensemble.destroyed`).
   */
  consecutiveFailures: number;
  /** Last seen player phase, keyed by playerId. */
  playerPhases: Map<string, string | undefined>;
  /**
   * 3c Tier-1 — last-seen coarse activity per playerId (currentTool + context
   * usage). Diffed each poll to emit `player.activity` on change. Seeded on
   * `player.added`, dropped on `player.removed` — lockstep with `playerPhases`.
   */
  playerCoarse: Map<string, PlayerCoarse>;
  /**
   * Adapter family per playerId — used to faithfully reconstruct the
   * prior `AggregateEnsembleSnapshot` view at tick boundaries (see #535).
   * Pre-#535 the prior carried a hardcoded `agentType: 'claude'` because
   * the wire union was closed at `'claude' | 'copilot' | 'mock'`; once the
   * union mirrors `AgentType`, the prior must carry a real adapter type
   * so the type system can't be blindsided by a future entry. Set in
   * lockstep with `playerPhases` (`player.added` → `set`, `player.removed`
   * → `delete`); agentType is treated as immutable for a player's
   * lifetime (matches `MaestroPlayerInfo` semantics).
   */
  playerAgentTypes: Map<string, PlayerSummaryV1['agentType']>;
  /** Last (paused, held) tuple. */
  flags: { paused: boolean; held: boolean } | null;
  /** SHA-256 of last emitted schedules JSON. */
  schedulesHash: string | null;
  /** Recently-emitted chat ids — bounded LRU set. */
  chatIds: Set<string>;
  /** Insertion-order list backing the LRU eviction. */
  chatIdOrder: string[];
}

/** Aggregate-level snapshot — small projection of `EnsembleStateV1` plus the bits we diff. */
export interface AggregateEnsembleSnapshot {
  ensemble: string;
  hasConductor: boolean;
  flags: { paused: boolean; held: boolean };
  players: PlayerSummaryV1[];
  schedules: ScheduleEntry[];
  chat: EnsembleChatMessage[];
}

/**
 * #550 — Per-ensemble fan-out outcome. The discriminated union lets
 * `collect()` distinguish "we observed full state" (`'ok'`) from
 * "ensemble is genuinely destroyed per Temporal" (`'gone'`, only on
 * `EnsembleNotFoundError`) from "we couldn't observe this tick — try
 * again next time" (`'failed'`, any other error).
 *
 * The classification decision lives in `collect()`'s `Promise.all`
 * body; `applyDiff` stays ignorant of the failure mode and just
 * consumes the resulting `AggregateSnapshot.liveEnsembleNames` set
 * plus the `'ok'`-only `ensembles` array.
 *
 * Why this matters: lumping both into `null` (pre-#550 behavior)
 * caused the cluster diff to emit `ensemble.destroyed` for ensembles
 * whose fan-out merely timed out, producing phantom destroy events
 * to every SSE subscriber every time a single per-ensemble query
 * stalled.
 */
export type FanoutResult =
  | { kind: 'ok'; snapshot: AggregateEnsembleSnapshot }
  | { kind: 'gone'; name: string }
  | { kind: 'failed'; name: string };

/** Aggregate cluster snapshot — what one tick gathers. */
export interface AggregateSnapshot {
  capturedAt: string;
  /**
   * Only `'ok'` fan-out results — i.e. ensembles for which we observed
   * full per-ensemble state this tick. `applyDiff` iterates this for
   * per-ensemble diff events (player.added, flags.changed, …).
   */
  ensembles: AggregateEnsembleSnapshot[];
  /**
   * #550 — Cluster-diff input. Slim `{ensemble, hasConductor}` entries
   * for the union of `'ok'` + `'failed'` outcomes (`'gone'` results
   * excluded — they're the only kind that should trigger
   * `ensemble.destroyed`).
   *
   * `hasConductor` for `'ok'` entries reflects the truthful
   * fresh-this-tick value from `buildEnsembleSnapshot`; for `'failed'`
   * entries it carries forward from the listEnsembles prelude (the
   * cluster-list result already knew `hasConductor` per ensemble,
   * even if the per-ensemble fan-out timed out). This keeps
   * `ensemble.created` payloads truthful even when the very first
   * tick for a new ensemble is a fan-out failure (researcher's
   * "one-tick-delayed" carry-forward semantics).
   *
   * `applyDiff` consumes this directly without re-classifying the
   * failure mode — the carry-forward decision is fully encoded by
   * `collect()` upstream (architect's spec).
   */
  livePrelude: Array<{ ensemble: string; hasConductor: boolean }>;
  hostProfiles: Record<string, HostProfile>;
}

/**
 * Stable JSON canonicalization — keys sorted, no extraneous whitespace.
 * Used for SHA-256 diff suppression so reordered key emits don't
 * produce false-positive `*.changed` events.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) =>
    JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]),
  ).join(',') + '}';
}

/** SHA-256 of `canonicalize(value)`. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Diff two AggregateEnsembleSnapshots and the prior tracking state to
 * produce the events the bus should emit. Pure function — no I/O,
 * easily unit-testable.
 *
 * Mutates `track` to reflect the post-emit state (this is intentional;
 * the caller calls `emit` for each returned event and trusts the
 * tracker is now current).
 */
export interface DiffEvent {
  type: import('./event-types').SseEventKind;
  payload: unknown;
}
export function diffEnsembleSnapshot(
  prev: AggregateEnsembleSnapshot | null,
  next: AggregateEnsembleSnapshot,
  track: Pick<EnsembleTrack, 'playerPhases' | 'playerCoarse' | 'playerAgentTypes' | 'flags' | 'schedulesHash' | 'chatIds' | 'chatIdOrder'>,
  capturedAt: string,
): DiffEvent[] {
  const events: DiffEvent[] = [];
  const ensemble = next.ensemble;

  // Build maps for O(1) lookup.
  const prevPlayers = new Map<string, PlayerSummaryV1>();
  if (prev) for (const p of prev.players) prevPlayers.set(p.playerId, p);
  const nextPlayers = new Map<string, PlayerSummaryV1>();
  for (const p of next.players) nextPlayers.set(p.playerId, p);

  // player.added / player.phase_changed — iterate next.
  for (const p of next.players) {
    if (!prevPlayers.has(p.playerId)) {
      events.push({ type: 'player.added', payload: p });
      track.playerPhases.set(p.playerId, p.phase);
      // 3c — seed coarse so the first real change (not the add itself, whose
      // payload already carries currentTool/context) emits player.activity.
      track.playerCoarse.set(p.playerId, coarseOf(p));
      // #535 — record the adapter family so the prior reconstruction at
      // the next tick (aggregate.ts ~L600) carries the real agentType
      // instead of a hardcoded `'claude'` stand-in. Treated as immutable
      // for the player's lifetime; cleared on `player.removed` below.
      track.playerAgentTypes.set(p.playerId, p.agentType);
      continue;
    }
    const lastPhase = track.playerPhases.get(p.playerId);
    if (p.phase !== lastPhase) {
      events.push({
        type: 'player.phase_changed',
        payload: {
          playerId: p.playerId,
          ensemble,
          phase: p.phase,
          ...(p.lastHeartbeatAt ? { lastHeartbeatAt: p.lastHeartbeatAt } : {}),
          ...(p.processingSince ? { processingSince: p.processingSince } : {}),
          at: capturedAt,
        },
      });
      track.playerPhases.set(p.playerId, p.phase);
    }
    // player.activity (3c Tier-1) — emit when coarse currentTool/context
    // changes between polls. Distinct from phase_changed (phase vs activity).
    // Source freshness ~30s (heartbeat metadata piggyback); the live, fine
    // tail is the off-wire /inner side-channel.
    const nextCoarse = coarseOf(p);
    if (coarseChanged(track.playerCoarse.get(p.playerId), nextCoarse)) {
      events.push({
        type: 'player.activity',
        payload: {
          playerId: p.playerId,
          ensemble,
          currentTool: nextCoarse.currentTool,
          ...(nextCoarse.contextTokens !== undefined ? { contextTokens: nextCoarse.contextTokens } : {}),
          ...(nextCoarse.contextPercent !== undefined ? { contextPercent: nextCoarse.contextPercent } : {}),
          at: capturedAt,
        },
      });
      track.playerCoarse.set(p.playerId, nextCoarse);
    }
  }

  // player.removed — iterate prev.
  if (prev) {
    for (const p of prev.players) {
      if (!nextPlayers.has(p.playerId)) {
        events.push({
          type: 'player.removed',
          payload: {
            playerId: p.playerId,
            ensemble,
            removedAt: capturedAt,
            // We can't tell from a snapshot diff whether the player was
            // destroyed or moved to `gone` — pick the safer default.
            // PR-2 callers shouldn't depend on this distinction; PR-3+
            // can refine when there's a stronger signal source.
            reason: 'gone',
          },
        });
        track.playerPhases.delete(p.playerId);
        track.playerCoarse.delete(p.playerId);
        track.playerAgentTypes.delete(p.playerId);
      }
    }
  }

  // flags.changed — only on tuple change.
  const prevFlags = track.flags;
  if (
    !prevFlags ||
    prevFlags.paused !== next.flags.paused ||
    prevFlags.held !== next.flags.held
  ) {
    events.push({
      type: 'flags.changed',
      payload: {
        ensemble,
        paused: next.flags.paused,
        held: next.flags.held,
        at: capturedAt,
      },
    });
    track.flags = { ...next.flags };
  }

  // schedules.changed — SHA-256 of sorted-by-name JSON.
  const sortedSchedules = [...next.schedules].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const newScheduleHash = hashOf(sortedSchedules);
  if (track.schedulesHash !== newScheduleHash) {
    events.push({
      type: 'schedules.changed',
      payload: { ensemble, schedules: sortedSchedules, at: capturedAt },
    });
    track.schedulesHash = newScheduleHash;
  }

  // chat.appended — every message whose id we haven't seen yet.
  for (const msg of next.chat) {
    if (track.chatIds.has(msg.id)) continue;
    events.push({ type: 'chat.appended', payload: msg });
    track.chatIds.add(msg.id);
    track.chatIdOrder.push(msg.id);
    while (track.chatIdOrder.length > CHAT_ID_MEMORY) {
      const evicted = track.chatIdOrder.shift();
      if (evicted !== undefined) track.chatIds.delete(evicted);
    }
  }

  return events;
}

/**
 * Diff host profiles map → per-host events. Pure function.
 */
export function diffHostProfiles(
  prevHashes: Map<string, string>,
  nextProfiles: Record<string, HostProfile>,
): { events: DiffEvent[]; hashes: Map<string, string> } {
  const nextHashes = new Map<string, string>();
  const events: DiffEvent[] = [];
  for (const [hostname, profile] of Object.entries(nextProfiles)) {
    const h = hashOf(profile);
    nextHashes.set(hostname, h);
    if (prevHashes.get(hostname) !== h) {
      events.push({ type: 'host_profile.changed', payload: profile });
    }
  }
  return { events, hashes: nextHashes };
}

/**
 * Diff ensemble-name set → ensemble.created / ensemble.destroyed events.
 *
 * #550 — accepts the slim `{ensemble, hasConductor}` shape rather than
 * a full `AggregateEnsembleSnapshot[]`. The full-snapshot type still
 * satisfies it structurally, so existing tests passing
 * `AggregateEnsembleSnapshot[]` continue to compile. The slimmer
 * input lets `applyDiff` feed the `livePrelude` carry-forward set
 * (which contains stub entries for `'failed'` outcomes that have no
 * full snapshot this tick).
 */
export function diffEnsembleSet(
  prev: ReadonlySet<string>,
  nextEnsembles: ReadonlyArray<{ ensemble: string; hasConductor: boolean }>,
  capturedAt: string,
): { events: DiffEvent[]; names: Set<string> } {
  const events: DiffEvent[] = [];
  const names = new Set<string>();
  const seen = new Map<string, { ensemble: string; hasConductor: boolean }>();
  for (const e of nextEnsembles) { names.add(e.ensemble); seen.set(e.ensemble, e); }
  for (const name of names) {
    if (!prev.has(name)) {
      const e = seen.get(name)!;
      events.push({
        type: 'ensemble.created',
        payload: {
          ensemble: name,
          createdAt: capturedAt,
          hasConductor: e.hasConductor,
        },
      });
    }
  }
  for (const name of prev) {
    if (!names.has(name)) {
      events.push({
        type: 'ensemble.destroyed',
        payload: { ensemble: name, destroyedAt: capturedAt },
      });
    }
  }
  return { events, names };
}

// ── Runner ──────────────────────────────────────────────────────────────

export interface AggregateRunnerOptions {
  client: TempoClient;
  /** Shared per-process bootEpoch — same value used everywhere. */
  bootEpoch: number;
  /** Default 750 ms; tests pin lower values. */
  pollIntervalMs?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Per-ensemble bus override (mainly tests). Default constructs `EnsembleEventBus`. */
  busFactory?: (ensemble: string, allocator: SeqAllocator) => EnsembleEventBus;
  /**
   * Issue #433 — watchdog ceiling for an in-flight tick. If a tick exceeds
   * this without finishing, the watchdog force-clears `inFlight` so the
   * next scheduled tick can run. Defaults to `20 × pollIntervalMs` (15s
   * at the production default). Tests pin a small value to assert the
   * unwedge behavior.
   */
  tickWatchdogMs?: number;
}

/**
 * Coordinates the poll loop and owns the per-ensemble + global buses.
 * Daemon constructs one of these after `runDaemonBoot`. Hot path is
 * `tick()` — production schedules it on a timer, tests call it
 * directly for deterministic diffing.
 */
export class AggregateRunner {
  private readonly client: TempoClient;
  readonly bootEpoch: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly busFactory: (ensemble: string, allocator: SeqAllocator) => EnsembleEventBus;

  /** Per-ensemble bus + tracking state. */
  private readonly tracks = new Map<string, EnsembleTrack>();
  /** Global bus — handles `ensemble.created/destroyed` + `host_profile.changed`. */
  private readonly _globalBus: EnsembleEventBus;
  private readonly globalSeqAllocator: SeqAllocator;

  /** Last seen ensemble names + host profile hashes for diff. */
  private knownEnsembles: Set<string> = new Set();
  private hostHashes: Map<string, string> = new Map();

  /**
   * #700 P2 — outstanding Q&A asks the daemon is watching for an answer. The
   * daemon served `POST /ask`, so it knows `{ensemble, questionId}`; each tick
   * it polls `getAnswer(questionId)` per-outstanding (NOT a whole-map diff —
   * that would need a new list-query) and emits the `answer` event + drops the
   * entry on first resolve. Keyed by `${ensemble} ${questionId}`. Daemon
   * restart loses this in-memory set → degrades to read-on-reconnect (the
   * `GET /answer/:id` route is the source of truth). `since` bounds the set:
   * an unanswered ask is dropped past the mailbox TTL (no answer readable after).
   */
  private readonly outstandingAsks = new Map<string, { ensemble: string; questionId: string; since: number }>();

  /** Loop state. */
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private skipCount = 0;
  /** Last skip-warning emit time — rate-limited so a wedged Temporal doesn't drown the log. */
  private lastSkipWarn = 0;
  private stopped = false;

  /**
   * Issue #433 — tick generation counter. Incremented each time a tick
   * starts. The watchdog stamps the current generation when it force-clears
   * `inFlight`; a late-arriving completion checks `myGen === currentGen`
   * before resetting state so it doesn't clobber a fresh tick that the
   * watchdog already handed to the loop.
   */
  private tickGen = 0;
  /**
   * Watchdog ceiling — if a tick exceeds this without finishing, the
   * watchdog force-clears `inFlight` so the next scheduled tick can run.
   * Default: 20 × poll interval (15s at the 750ms default). Should be
   * comfortably larger than `pollIntervalMs × DEFAULT_QUERY_TIMEOUT_MS /
   * pollInterval` so `queryHandleWithTimeout`-bounded ticks finish well
   * inside the watchdog window in normal operation.
   */
  private readonly tickWatchdogMs: number;

  constructor(opts: AggregateRunnerOptions) {
    this.client = opts.client;
    this.bootEpoch = opts.bootEpoch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.tickWatchdogMs = opts.tickWatchdogMs ?? this.pollIntervalMs * 20;
    this.busFactory = opts.busFactory
      ?? ((ensemble, allocator) => new EnsembleEventBus({
        scope: `ensemble:${ensemble}`, allocator, now: this.now,
      }));
    this.globalSeqAllocator = new SeqAllocator(opts.bootEpoch);
    this._globalBus = new EnsembleEventBus({
      scope: 'global', allocator: this.globalSeqAllocator, now: this.now,
    });
  }

  /**
   * Begin polling on the configured cadence.
   *
   * **One-shot by design**: a single `start()` schedules the first
   * tick immediately and chains subsequent ticks via `setTimeout` —
   * each tick reschedules the next as it completes. Repeated
   * `start()` calls are no-ops once the chain is running (and after
   * `stop()` flips `stopped = true`, future `start()` calls are
   * also no-ops). Tests that want to drive ticks deterministically
   * skip `start()` and call `tick()` directly. PR #324 review nit
   * folded in.
   */
  start(): void {
    if (this.timer || this.stopped) return;
    const tickAndSchedule = () => {
      if (this.stopped) return;
      void this.tick();
      this.timer = setTimeout(tickAndSchedule, this.pollIntervalMs);
      this.timer.unref();
    };
    // Run once immediately so a fresh boot has events to serve.
    tickAndSchedule();
  }

  /** Stop polling. Buses stay alive — daemon owns their close lifecycle. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Drain every bus + clear tracking. */
  close(): void {
    this.stop();
    for (const t of this.tracks.values()) t.bus.close();
    this.tracks.clear();
    this._globalBus.close();
  }

  /** The global bus — exposed for the SSE handler's `/v1/events` route. */
  globalBus(): EventBus { return this._globalBus; }

  /**
   * Look up (or lazily build) the per-ensemble bus. SSE handler uses
   * this to subscribe a new client; aggregate diff uses it to emit
   * `player.added`-and-friends.
   */
  getOrCreateEnsembleBus(ensemble: string): EnsembleEventBus {
    let track = this.tracks.get(ensemble);
    if (!track) {
      const allocator = new SeqAllocator(this.bootEpoch);
      const bus = this.busFactory(ensemble, allocator);
      track = {
        bus,
        consecutiveFailures: 0,
        playerPhases: new Map(),
        playerCoarse: new Map(),
        playerAgentTypes: new Map(),
        flags: null,
        schedulesHash: null,
        chatIds: new Set(),
        chatIdOrder: [],
      };
      this.tracks.set(ensemble, track);
    }
    return track.bus;
  }

  /** Returns the bus for an ensemble if one exists, else `null`. */
  getEnsembleBus(ensemble: string): EnsembleEventBus | null {
    return this.tracks.get(ensemble)?.bus ?? null;
  }

  /**
   * #700 P2 — register an outstanding Q&A ask. Called by the `POST /ask` route
   * after it cues the target player; the next ticks poll for the answer and
   * emit the `answer` event when it lands. Idempotent (re-asking the same
   * questionId just refreshes `since`).
   */
  trackAsk(ensemble: string, questionId: string): void {
    this.outstandingAsks.set(`${ensemble} ${questionId}`, {
      ensemble, questionId, since: this.now(),
    });
  }

  /** Test seam — number of outstanding asks awaiting an answer. */
  get _outstandingAskCount(): number { return this.outstandingAsks.size; }

  /**
   * #700 P2 — poll each outstanding ask's answer mailbox; emit `answer` + drop
   * on first resolve. Sequential (the set is small + transient); `getAnswer`
   * is collision-safe (direct bounded query). Drops asks older than the mailbox
   * TTL — no answer is readable past it, so polling forever is pointless.
   */
  async pollOutstandingAnswers(): Promise<void> {
    if (this.outstandingAsks.size === 0) return;
    const nowMs = this.now();
    for (const [key, ask] of [...this.outstandingAsks]) {
      if (nowMs - ask.since > MAESTRO_ANSWER_TTL_MS) {
        this.outstandingAsks.delete(key);
        continue;
      }
      let answer;
      try {
        answer = await this.client.getAnswer(ask.ensemble, ask.questionId);
      } catch {
        continue; // transient — retry next tick
      }
      if (answer) {
        this.getOrCreateEnsembleBus(ask.ensemble).emit('answer', {
          questionId: ask.questionId,
          from: answer.from,
          ts: answer.answeredAt,
        });
        this.outstandingAsks.delete(key);
      }
    }
  }

  /** Total live subscriber count across all buses — `/v1/health.subscriberCount`. */
  totalSubscriberCount(): number {
    let n = this._globalBus.subscriberCount();
    for (const t of this.tracks.values()) n += t.bus.subscriberCount();
    return n;
  }

  /**
   * Run one diff pass. Production schedules this on a timer; tests
   * call it directly. Serial-with-skip per §8 — if a previous tick
   * is still in flight, this one skips with a warn-log.
   *
   * **Watchdog (#433)**. Each tick takes a generation stamp. After
   * `tickWatchdogMs` elapses without completion, the watchdog bumps
   * the generation and clears `inFlight` so the next scheduled tick
   * can run. The hung tick's eventual completion checks its own
   * generation against the current one; if it's stale (watchdog
   * already advanced past it), it returns without touching `inFlight`
   * — the new tick owns that flag now.
   */
  async tick(): Promise<void> {
    if (this.inFlight) {
      this.skipCount++;
      const now = this.now();
      // Throttle warn-logs to once per 5 s so a wedged Temporal doesn't flood.
      if (now - this.lastSkipWarn >= 5_000) {
        this.lastSkipWarn = now;
        log(`tick skipped — prior tick still in flight (skipCount=${this.skipCount})`);
      }
      return;
    }
    this.inFlight = true;
    const myGen = ++this.tickGen;

    // Watchdog — if we don't complete within `tickWatchdogMs`, force-clear
    // `inFlight` so the next tick can run. Bumping `tickGen` ensures our
    // own (eventually-arriving) finally clause sees a stale generation
    // and skips the second `inFlight = false`.
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      if (this.tickGen === myGen) {
        watchdogFired = true;
        this.tickGen++;
        this.inFlight = false;
        log(
          `tick watchdog fired after ${this.tickWatchdogMs}ms — ` +
          `clearing inFlight so the loop can advance ` +
          `(prior tick may still be pending in memory; see #433)`,
        );
      }
    }, this.tickWatchdogMs);
    watchdog.unref?.();

    try {
      const snapshot = await this.collect();
      this.applyDiff(snapshot);
      // #700 P2 — resolve any outstanding Q&A asks (emits `answer` events that
      // wake the inbox-less planner). Kept inside the tick's single-flight
      // guard; bounded by the (transient, small) outstanding set.
      await this.pollOutstandingAnswers();
    } catch (err) {
      // #336/#529 site 6 — `TickSkipped` is the architect-approved
      // signal that `collect()` deliberately bailed before applying
      // any diff (e.g. visibility-iterator deadline tripped). It is
      // expected and frequent under load; do NOT log noisily. Other
      // throws are unexpected failures worth surfacing.
      if (err instanceof TickSkipped) {
        log(`tick=${myGen}: skipped — ${err.message}`);
      } else {
        log('tick error (non-fatal):', err instanceof Error ? err.message : err);
      }
    } finally {
      clearTimeout(watchdog);
      // Only release `inFlight` if the watchdog hasn't already done so —
      // otherwise we'd clobber a fresh tick that the loop is in the
      // middle of running on the next scheduled boundary.
      if (!watchdogFired && this.tickGen === myGen) {
        this.inFlight = false;
      }
    }
  }

  /** Fetch the current cluster state via `TempoClient`. */
  async collect(): Promise<AggregateSnapshot> {
    const tickGen = this.tickGen;
    const preludeStart = this.now();
    log(`collect tick=${tickGen}: prelude started`);
    const capturedAt = new Date(this.now()).toISOString();
    // #336/#529 site 6 — bounded variant prevents the 750ms poll from
    // emitting phantom `ensemble.destroyed` events when the visibility
    // iterator partially enumerates under load. On timeout, throw
    // `TickSkipped` so `tick()`'s catch preserves `knownEnsembles`
    // unchanged (no `applyDiff` runs). 500ms budget leaves >=250ms
    // headroom for the rest of `collect()` + `applyDiff` + emission
    // within the 750ms cadence (architect's call).
    const listRes = await this.client.listEnsemblesBounded(AGGREGATE_LIST_DEADLINE_MS);
    if (listRes.timedOut) {
      log(
        `collect tick=${tickGen}: listEnsembles deadline (` +
        `${AGGREGATE_LIST_DEADLINE_MS}ms, ${listRes.scanned} scanned) — skip diff`,
      );
      throw new TickSkipped('listEnsembles deadline');
    }
    const ensembles = listRes.items;
    const hostProfiles: Record<string, HostProfile> = {};
    try {
      const hosts = await this.client.listHosts();
      for (const h of hosts) {
        if (h.profile) hostProfiles[h.hostname] = h.profile;
      }
    } catch { /* fall through with empty hostProfiles */ }
    const preludeMs = this.now() - preludeStart;
    log(
      `collect tick=${tickGen}: prelude complete ` +
      `(${preludeMs}ms, ensembles=${ensembles.length}, ` +
      `hosts=${Object.keys(hostProfiles).length})`,
    );

    // Per-ensemble fan-out. #550 — returns `FanoutResult` discriminated
    // union so the cluster diff downstream can distinguish "still alive
    // (carry forward)" from "actually destroyed (emit destroy)."
    const pollStart = this.now();
    log(`collect tick=${tickGen}: poll started`);
    const initialResults: FanoutResult[] = await Promise.all(
      ensembles.map(async (e): Promise<FanoutResult> => {
        try {
          // Reuse `buildEnsembleSnapshot` so the projection logic stays in
          // one place. We only need a subset, but the full builder is cheap.
          const snap: EnsembleStateV1 = await buildEnsembleSnapshot(this.client, e.name, {
            now: () => new Date(this.now()),
          });
          // Replace chat with a wider window so the aggregate doesn't miss
          // bursts between polls. The bus's §8 cap collapses excess.
          let chat: EnsembleChatMessage[] = snap.chat.messages;
          try {
            const wider = await this.client.getEnsembleChat(e.name, 0, POLL_CHAT_LIMIT);
            chat = wider.messages;
          } catch { /* fall back to the snapshot's narrow slice */ }
          return {
            kind: 'ok',
            snapshot: {
              ensemble: e.name,
              hasConductor: snap.hasConductor,
              flags: snap.flags,
              players: snap.players,
              schedules: snap.schedules,
              chat,
            },
          };
        } catch (err) {
          // #550 — conservative classification: only `EnsembleNotFoundError`
          // counts as a real removal. Everything else (query timeout,
          // network blip, transient worker wedge) is `'failed'` →
          // carry-forward. False-negative destroy events are the worst
          // possible failure mode (SSE consumers may take destructive
          // action), so be deliberate about what gets classified as
          // genuinely gone.
          if (err instanceof EnsembleNotFoundError) {
            return { kind: 'gone', name: e.name };
          }
          log(`collect: ensemble "${e.name}" failed (carry-forward):`,
            err instanceof Error ? err.message : err);
          return { kind: 'failed', name: e.name };
        }
      }),
    );

    // #550 — Update per-ensemble `consecutiveFailures` counters and
    // apply the K=20 promotion pass. Mutating tracks here is safe (we
    // serialize after Promise.all completes; the tick is single-flight
    // courtesy of `inFlight`). Promoting 'failed' → 'gone' triggers
    // `applyDiff` to tear the track down.
    let okCount = 0, goneCount = 0, failedCount = 0, promotedCount = 0;
    const finalResults: FanoutResult[] = initialResults.map((r) => {
      if (r.kind === 'ok') {
        const t = this.tracks.get(r.snapshot.ensemble);
        if (t) t.consecutiveFailures = 0;
        okCount++;
        return r;
      }
      if (r.kind === 'gone') {
        goneCount++;
        return r;
      }
      // r.kind === 'failed' — ensure a track exists so the counter has
      // a home, then increment + maybe promote.
      this.getOrCreateEnsembleBus(r.name);
      const t = this.tracks.get(r.name)!;
      t.consecutiveFailures++;
      if (t.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        log(
          `collect tick=${tickGen}: ensemble "${r.name}" failed ` +
          `${t.consecutiveFailures}× consecutively (cap=${MAX_CONSECUTIVE_FAILURES}) — promote to 'gone'`,
        );
        promotedCount++;
        // applyDiff's teardown loop will drop the track on the next tick.
        return { kind: 'gone', name: r.name };
      }
      failedCount++;
      return r;
    });

    // #550 — Build the cluster-diff input: ('ok' ∪ 'failed') with
    // truthful `hasConductor` for each (from the fresh ok snapshot
    // OR carried forward from the listEnsembles prelude for failed).
    // 'gone' results (including K-promoted) are excluded so they
    // trigger `ensemble.destroyed` downstream.
    const preludeHasConductor = new Map<string, boolean>(
      ensembles.map((e) => [e.name, e.hasConductor]),
    );
    const livePrelude: Array<{ ensemble: string; hasConductor: boolean }> = [];
    const okSnapshots: AggregateEnsembleSnapshot[] = [];
    for (const r of finalResults) {
      if (r.kind === 'ok') {
        okSnapshots.push(r.snapshot);
        livePrelude.push({ ensemble: r.snapshot.ensemble, hasConductor: r.snapshot.hasConductor });
      } else if (r.kind === 'failed') {
        livePrelude.push({
          ensemble: r.name,
          hasConductor: preludeHasConductor.get(r.name) ?? false,
        });
      }
      // 'gone' — explicitly excluded.
    }
    const pollMs = this.now() - pollStart;
    log(
      `collect tick=${tickGen}: poll complete (${pollMs}ms, ` +
      `ok=${okCount}, failed=${failedCount}, gone=${goneCount}, promoted=${promotedCount})`,
    );
    return {
      capturedAt,
      ensembles: okSnapshots,
      livePrelude,
      hostProfiles,
    };
  }

  /** Apply diff and emit events — exposed for tests that want to inject fixtures. */
  applyDiff(snapshot: AggregateSnapshot): void {
    // Global: ensemble created/destroyed. #550 — diff against
    // `snapshot.livePrelude` (ok ∪ failed) so a transient per-ensemble
    // fan-out failure does NOT trigger `ensemble.destroyed`. The
    // discrimination between "failed (carry forward)" and "gone (real
    // removal)" was made upstream in `collect()` per architect's spec;
    // `applyDiff` is intentionally ignorant of the failure mode and
    // just consumes the resolved live set.
    const { events: ensembleEvents, names } = diffEnsembleSet(
      this.knownEnsembles, snapshot.livePrelude, snapshot.capturedAt,
    );
    for (const ev of ensembleEvents) this._globalBus.emit(ev.type, ev.payload);
    this.knownEnsembles = names;

    // Global: host profile diffs.
    const hostDiff = diffHostProfiles(this.hostHashes, snapshot.hostProfiles);
    for (const ev of hostDiff.events) this._globalBus.emit(ev.type, ev.payload);
    this.hostHashes = hostDiff.hashes;

    // Per-ensemble: player.added/removed/phase_changed, chat.appended, flags.changed, schedules.changed.
    for (const eState of snapshot.ensembles) {
      const track = this.ensureTrack(eState.ensemble);
      // Build prior aggregate-snapshot view from track state — only used
      // for player set diff; flags/schedules/chat use their own track fields.
      const prior: AggregateEnsembleSnapshot = {
        ensemble: eState.ensemble,
        hasConductor: false, // not used by diffEnsembleSnapshot
        flags: track.flags ?? { paused: false, held: false }, // not used; uses track.flags directly
        players: [...track.playerPhases.keys()].map((id) => ({
          // Minimal stand-in — only `playerId` is consulted by `diffEnsembleSnapshot`
          // for `player.removed` events (see L154-L174). The other fields are
          // zero-cost placeholders that satisfy `PlayerSummaryV1` typing without
          // affecting any emitted event payload. `agentType` reads from the
          // parallel track Map so the prior carries the player's real adapter
          // family (#535) — pre-#535 this was hardcoded `'claude' as const`,
          // which became a type lie once the wire union expanded to mirror
          // `AgentType`. Fallback to `'claude'` covers the brief migration
          // window where a long-running daemon's tracks predate the new Map.
          playerId: id, ensemble: eState.ensemble, hostname: '', isConductor: false,
          agentType: track.playerAgentTypes.get(id) ?? 'claude', part: '', workDir: '',
          phase: track.playerPhases.get(id) as import('../types').AttachmentPhase | undefined,
        })),
        schedules: [],
        chat: [],
      };
      const events = diffEnsembleSnapshot(prior, eState, track, snapshot.capturedAt);
      for (const ev of events) track.bus.emit(ev.type, ev.payload);
    }

    // Tear down buses for ensembles that disappeared.
    for (const name of [...this.tracks.keys()]) {
      if (!this.knownEnsembles.has(name)) {
        const t = this.tracks.get(name);
        if (t) {
          t.bus.close();
          this.tracks.delete(name);
        }
      }
    }
  }

  private ensureTrack(ensemble: string): EnsembleTrack {
    let track = this.tracks.get(ensemble);
    if (!track) {
      this.getOrCreateEnsembleBus(ensemble);
      track = this.tracks.get(ensemble)!;
    }
    return track;
  }

  /** Test-only — skip count for assertions. */
  get _skipCount(): number { return this.skipCount; }
}
