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
 * and a `[claude-tempo:aggregate]` warn-log fires. The daemon never
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

/** Default cadence per spec §8. */
export const DEFAULT_POLL_INTERVAL_MS = 750;
/** How many chat-message ids to remember per ensemble. */
const CHAT_ID_MEMORY = 1024;
/** How many chat messages to fetch per poll — wider than the snapshot limit so bursts aren't silently lost. */
const POLL_CHAT_LIMIT = 200;

const log = (...args: unknown[]) =>
  console.error('[claude-tempo:aggregate]', ...args);

/** Per-ensemble tracking state across ticks. */
interface EnsembleTrack {
  bus: EnsembleEventBus;
  /** Last seen player phase, keyed by playerId. */
  playerPhases: Map<string, string | undefined>;
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

/** Aggregate cluster snapshot — what one tick gathers. */
export interface AggregateSnapshot {
  capturedAt: string;
  ensembles: AggregateEnsembleSnapshot[];
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
  track: Pick<EnsembleTrack, 'playerPhases' | 'playerAgentTypes' | 'flags' | 'schedulesHash' | 'chatIds' | 'chatIdOrder'>,
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
 */
export function diffEnsembleSet(
  prev: ReadonlySet<string>,
  nextEnsembles: AggregateEnsembleSnapshot[],
  capturedAt: string,
): { events: DiffEvent[]; names: Set<string> } {
  const events: DiffEvent[] = [];
  const names = new Set<string>();
  const seen = new Map<string, AggregateEnsembleSnapshot>();
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
        playerPhases: new Map(),
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
    } catch (err) {
      log('tick error (non-fatal):', err instanceof Error ? err.message : err);
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
    const ensembles = await this.client.listEnsembles().catch(() => []);
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

    // Per-ensemble fan-out.
    const pollStart = this.now();
    log(`collect tick=${tickGen}: poll started`);
    const perEnsemble = await Promise.all(
      ensembles.map(async (e): Promise<AggregateEnsembleSnapshot | null> => {
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
            ensemble: e.name,
            hasConductor: snap.hasConductor,
            flags: snap.flags,
            players: snap.players,
            schedules: snap.schedules,
            chat,
          };
        } catch (err) {
          if (err instanceof EnsembleNotFoundError) return null;
          // Per-ensemble soft fail — log and skip.
          log(`collect: ensemble "${e.name}" failed:`, err instanceof Error ? err.message : err);
          return null;
        }
      }),
    );
    const dropped = perEnsemble.filter((x) => x === null).length;
    const succeeded = perEnsemble.length - dropped;
    const pollMs = this.now() - pollStart;
    log(
      `collect tick=${tickGen}: poll complete ` +
      `(${pollMs}ms, succeeded=${succeeded}, dropped=${dropped})`,
    );
    return {
      capturedAt,
      ensembles: perEnsemble.filter((x): x is AggregateEnsembleSnapshot => x !== null),
      hostProfiles,
    };
  }

  /** Apply diff and emit events — exposed for tests that want to inject fixtures. */
  applyDiff(snapshot: AggregateSnapshot): void {
    // Global: ensemble created/destroyed.
    const { events: ensembleEvents, names } = diffEnsembleSet(
      this.knownEnsembles, snapshot.ensembles, snapshot.capturedAt,
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
