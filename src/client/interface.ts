/**
 * TempoClient — public interface and related types.
 *
 * Extracted from `src/tui/client.ts` so that non-TUI consumers (CLI, tests,
 * external integrations) can depend on the interface without pulling in Ink/React.
 */
import type {
  AgentType,
  MaestroPlayerInfo,
  MaestroRelayMessage,
  HistoryEntry,
  Message,
  SentMessage,
  SessionMetadata,
  ScheduleEntry,
  QualityGate,
  StageEntry,
  WorktreeEntry,
  EnsembleChatResult,
  AttachmentInfo,
  HostInfo,
} from '../types';
import type { RestoreOrphansSummary } from '../reconcile/orphans';
import type { SubscribeOptions, TempoEvent } from '../http/event-types';

// ── Recall (#128) ──

/**
 * Raw (unfiltered, unsorted, unsliced) output of `TempoClient.recall`.
 * The shared formatter at `src/utils/recall-format.ts` turns this into a
 * timeline + pagination header; returning the raw shape keeps every
 * surface's presentation logic testable without booting a client.
 */
export interface RecallClientResult {
  received: Message[];
  sent: SentMessage[];
}

// ── PR-D verb options ──

// ── #306: Recruit (direct TempoClient path) ──

/**
 * Options for {@link TempoClient.recruit} — direct submit of a `recruit`
 * outbox entry from the caller's maestro session. Mirrors the `recruit`
 * MCP tool's parameters, minus the conductor-only bits handled by the
 * `load_lineup` flow. The TUI uses this to bypass the conductor LLM hop
 * for UI-initiated recruiting (the prior path routed through the
 * maestro hub → conductor → MCP tool, which required a live conductor).
 */
export interface RecruitClientOpts {
  name: string;
  workDir: string;
  agent?: AgentType;
  /** Agent type name from the subagent registry (e.g. "tempo-soloist"). */
  playerType?: string;
  isConductor?: boolean;
  initialMessage?: string;
  systemPrompt?: string;
  host?: string;
  /** When true, spawn process but lock outbox until `release`. */
  held?: boolean;
}

export interface RecruitClientResult {
  playerId: string;
  /** Outbox entry id submitted on the maestro session's workflow. */
  entryId: string;
}

// ── #306: Release (direct TempoClient path) ──

export interface ReleaseClientResult {
  /** Names of players released, in scan order. */
  released: string[];
  /** Soft-failure diagnostics per player, if any. */
  errors: Array<{ playerId: string; error: string }>;
}

export interface RestartClientOpts {
  /** Target host (defaults to session's preferredHost or last-known hostname). */
  host?: string;
  /** Skip context replay. */
  fresh?: boolean;
  /** Steal a live attachment via forceDetach. */
  force?: boolean;
  /** Number of recent messages to include in context replay. */
  contextMessages?: number;
  /** Identifier of the invoker for audit messages (default: 'cli'). */
  invokerPlayerId?: string;
  /**
   * #334 PR-2 — seed the restarted session from a saved-state slot. `true`
   * resolves to the default key (`'main'`); a string names a specific slot.
   * Suppresses transcript replay by default; pass `transcript: 'replay'` to
   * stack. Falls back to transcript replay if the slot is empty.
   */
  loadFromState?: boolean | string;
  /**
   * #334 PR-2 — controls transcript-replay interaction when `loadFromState`
   * is set: `'suppress'` (default) or `'replay'` (stack saved state + transcript).
   * Ignored when `loadFromState` is absent.
   */
  transcript?: 'suppress' | 'replay';
  /**
   * #580 / design §16.5 Option B — deliberate-action gate for cross-host
   * force-restart. When `force: true` AND the target's current attachment
   * is on a host other than the caller's, the value must match the
   * current holder's hostname exactly. The shared MCP-tool guard
   * (`enforceYesStealGuard` in `src/tools/restart.ts`) enforces the same
   * property when callers go through the `restart` / `migrate` MCP tools;
   * the TUI's `/migrate` handler enforces it locally and forwards the
   * confirmed value here so the recorded intent rides the call. Workflow
   * trusts the caller — the check happens pre-submit, not in the outbox.
   */
  confirmStealFromHost?: string;
}

export interface RestartClientResult {
  /** Player the restart was queued for. */
  playerId: string;
  /** Target host — `undefined` when the caller didn't specify and the activity uses `preferredHost`. */
  host?: string;
  /** Outbox entry id; callers can poll `submitOutbox` history or `outboxQuery` for status. */
  entryId: string;
}

// ── #287: ensemble-scope verb summaries ──

/** Per-target outcome returned by `shutdown`. */
export interface EnsembleShutdownDetail {
  playerId: string;
  /**
   * #299 sibling: removed `'skipped-self'`. The only public consumer of
   * this type is `EnsembleShutdownSummary.details`, returned by
   * `TempoClient.shutdown()`. The TempoClient implementation does not pass
   * a `skip` predicate to `signalAllSessions`, so the fan-out never
   * produces a `'skipped'` outcome and the `'skipped-self'` mapping was
   * unreachable. Mirror cleanup of the destroy-detail change.
   */
  outcome: 'detaching' | 'failed';
  error?: string;
}

export interface EnsembleShutdownSummary {
  detached: number;
  skipped: number;
  failed: number;
  maestroPaused: boolean;
  schedulerPaused: boolean;
  details: EnsembleShutdownDetail[];
}

/** Per-target outcome returned by ensemble-scope `destroy`. */
export interface EnsembleDestroyDetail {
  target: string;
  /**
   * #299: removed `'skipped-self'`. The only public consumer of this type is
   * `EnsembleDestroySummary.details`, returned by `TempoClient.destroy()`,
   * and the TempoClient implementation has no caller-self concept (the
   * client is a programmatic caller, not a player in the ensemble) — so it
   * never produces a self-skip. The MCP-tool path (`src/tools/destroy.ts`)
   * does internally branch on caller-self for control flow but never
   * surfaces those entries to a public consumer.
   */
  outcome: 'destroyed' | 'terminated' | 'failed';
  error?: string;
}

export interface EnsembleDestroySummary {
  destroyed: number;
  terminated: number;
  failed: number;
  details: EnsembleDestroyDetail[];
}

// ── Public Types ──

export interface EnsembleSummary {
  name: string;
  playerCount: number;
  hasConductor: boolean;
  conductorStatus?: string;
  /**
   * Lifecycle classification populated by {@link TempoClient.listEnsembles}
   * (absent on `discoverEnsembles` results):
   *
   * - `'online'`  — maestro hub is unpaused (`maestroPaused === false`).
   * - `'paused'`  — maestro hub is paused **and** at least one session is
   *                 still in a live attachment phase. Operationally this is
   *                 a `/pause` (resume in place via `/play`).
   * - `'offline'` — maestro hub is paused **and** no live adapters remain.
   *                 Operationally this is a `/shutdown` (requires `/restore`).
   */
  state?: 'online' | 'paused' | 'offline';
}

/** Options for {@link TempoClient.createEnsemble}. */
export interface CreateEnsembleOpts {
  /** New ensemble name. Must pass `validateEnsembleName`. */
  ensemble: string;
  /** Working directory for the spawned conductor terminal. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Optional lineup name or path forwarded to `agent-tempo up --lineup …`. */
  lineup?: string;
}

/**
 * #308 follow-up: pure-RPC subset of the TempoClient surface.
 *
 * `TempoClientCore` is the headless-safe interface — every method routes
 * through the Temporal `Client` and never spawns a local terminal. Safe to
 * instantiate inside the daemon, the SSE event source, MCP tools, and
 * future SDK consumers that don't carry a `child_process` dependency.
 *
 * The TUI (and any other TTY-bound consumer that needs to launch a
 * conductor terminal) imports {@link TempoClientWithSpawn} instead, which
 * extends this interface with the two spawn methods.
 *
 * See `docs/adr/0007-tempoclient-core-withspawn-split.md` and
 * `docs/design/tempoclient-core-spawn-split.md` for the rationale.
 */
export interface TempoClientCore {
  /** Discover all running ensembles across the cluster. */
  discoverEnsembles(): Promise<EnsembleSummary[]>;
  /**
   * List every ensemble with at least one live workflow, splitting running
   * from parked (all-sessions-detached) via `state`.
   */
  listEnsembles(): Promise<EnsembleSummary[]>;
  /**
   * #336/#529 — bounded variant of {@link listEnsembles}. Wraps the
   * underlying visibility iterator with a wall-clock deadline and
   * surfaces a `timedOut` flag so callers that diff against prior
   * state (e.g. `AggregateRunner.collect()` at 750ms cadence) can
   * skip an entire tick rather than silently produce a partial
   * snapshot that would emit phantom `ensemble.destroyed` events.
   *
   * Unlike `listEnsembles()`, this method propagates non-timeout
   * errors — the existing "swallow-and-return-empty" path is reserved
   * for the unbounded variant's CLI / dashboard callers that don't
   * need to distinguish timeout from emptiness.
   *
   * @param deadlineMs Wall-clock budget for the visibility iterator.
   *                   `AggregateRunner` uses 500ms (correctness, well
   *                   below the 750ms tick cadence); ad-hoc callers
   *                   should match the caller's surrounding timeout.
   */
  listEnsemblesBounded(deadlineMs: number): Promise<{
    items: EnsembleSummary[];
    timedOut: boolean;
    scanned: number;
  }>;
  /** Get current player snapshot for an ensemble. */
  getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]>;
  /**
   * Issue #399 W1 — read the per-ensemble maestro hub's wire-extension
   * fields (description / startedAt / currentBpm / tempoSeries) in a
   * single fan-out. The four queries run in parallel against the same
   * maestro workflow handle so total latency is bounded by the slowest
   * query, not the sum.
   *
   * Returns an object with sentinel defaults (`description: ''`,
   * `startedAt: ''`, `currentBpm: 0`, `tempoSeries: []`) when individual
   * queries soft-fail — the snapshot endpoint must NEVER 500 because of
   * a transient maestro query glitch.
   */
  getEnsembleMeta(ensemble: string): Promise<{
    description: string;
    startedAt: string;
    currentBpm: number;
    tempoSeries: number[];
  }>;
  /**
   * Issue #399 W2 — read a session workflow's wire-extension fields
   * (runId / messaging / lease) in a single fan-out. The three queries
   * run in parallel against the same session handle. Returns `null`
   * when the session workflow can't be resolved (just-recruited,
   * just-destroyed, or transient lookup failure); soft-fails individual
   * fields to `undefined` in the returned shape so partial results
   * still surface.
   */
  getPlayerWireMeta(ensemble: string, playerId: string): Promise<{
    runId?: string;
    messaging?: { received: number; sent: number; outbox: string };
    lease?: { expiresAt: number | null; leaseMs: number | null };
  } | null>;
  /** Get recent messages for an ensemble. */
  getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]>;
  /** Get conductor command/report history for an ensemble. */
  getConductorHistory(ensemble: string): Promise<HistoryEntry[]>;
  /** Get a player's message history (received + sent). */
  getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>>;
  /** Get a player's workflow metadata. */
  getPlayerMetadata(ensemble: string, playerId: string): Promise<SessionMetadata | null>;
  /** Send a command to an ensemble's conductor via Maestro. Returns command ID. */
  sendCommand(ensemble: string, text: string, source: string): Promise<string>;
  /** Send a message to a specific player in an ensemble. Returns message ID. */
  sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string>;
  /** Terminate a player's workflow. */
  terminatePlayer(ensemble: string, playerId: string): Promise<void>;
  /**
   * #306: Recruit a player directly via the caller's maestro session outbox.
   * Replaces the legacy TUI path of routing `/recruit …` through the
   * conductor's Claude Code session. Structural-op parity with the `recruit`
   * MCP tool — enqueues a `recruit` outbox entry; the dispatch loop spawns
   * the process. The conductor's LLM is never in the critical path.
   */
  recruit(ensemble: string, opts: RecruitClientOpts): Promise<RecruitClientResult>;
  /**
   * #306: Release held players directly via the caller's maestro session
   * outbox. Without `playerId`, scans the ensemble for sessions whose
   * outbox is locked and enqueues a `release` entry for each. With
   * `playerId`, releases just that session. Structural-op parity with
   * the `release` MCP tool.
   */
  release(ensemble: string, playerId?: string): Promise<ReleaseClientResult>;
  /** PR-D: Restart a player — §8.2 algorithm. Works on any non-`gone` phase. */
  restart(ensemble: string, playerId: string, opts?: RestartClientOpts): Promise<RestartClientResult>;
  /** PR-D: Gracefully detach a player's adapter. Workflow survives in `detached`. */
  detach(ensemble: string, playerId: string, deadlineMs?: number): Promise<void>;
  /**
   * #287: Terminally destroy a workflow. Single-player when `playerId` is
   * given; ensemble-scope (peer sessions → scheduler → maestro → conductor)
   * when `playerId` is omitted. Ensemble-scope returns a count summary.
   */
  destroy(ensemble: string, playerId?: string, reason?: string): Promise<void | EnsembleDestroySummary>;
  /**
   * #287: Pause every session in the ensemble + scheduler + maestro. MCP
   * counterpart of the `pause` tool. Replaces the v0.26 `pauseEnsemble` shape.
   */
  pause(ensemble: string): Promise<void>;
  /**
   * #287: Unpause every session + scheduler + maestro. `release: true` also
   * fans out `releaseHeld` so any held sessions deliver their buffered task
   * messages. MCP counterpart of the `play` tool.
   */
  play(ensemble: string, opts?: { release?: boolean }): Promise<void>;
  /**
   * #287: Graceful ensemble teardown — fan-out detach + pause scheduler +
   * pause maestro. Workflows survive in `detached`; pair with `restore`.
   */
  shutdown(ensemble: string, opts?: { deadlineMs?: number; reason?: string }): Promise<EnsembleShutdownSummary>;
  /**
   * #287: Bring the ensemble back up after `shutdown`. Reattaches all local
   * orphans (delegates to the shared `restoreOrphansOnce` helper) and
   * unpauses the scheduler + maestro. Does NOT spawn a conductor terminal
   * — CLI owns that (design #285 S4).
   */
  restore(ensemble: string): Promise<RestoreOrphansSummary>;
  /** PR-D: Migrate a player to a different host — sugar for restart({host}). */
  migrate(ensemble: string, playerId: string, host: string, opts?: Omit<RestartClientOpts, 'host'>): Promise<RestartClientResult>;
  /** PR-D: Query a player's V2 attachment lifecycle state. */
  attachmentInfo(ensemble: string, playerId: string): Promise<AttachmentInfo>;
  /**
   * #128: Fetch a player's raw message timeline (received + sent). Throws
   * when the session cannot be resolved. Callers are expected to feed the
   * result through the shared `formatRecall` helper for filter / sort /
   * slice / render; the client stays presentation-free.
   */
  recall(ensemble: string, playerId: string): Promise<RecallClientResult>;
  /**
   * #274: List all daemons polling this Temporal namespace, joined with
   * their boot-signaled capability profiles. Consumers typically feed
   * the result through `formatHostList` for a consistent UX across
   * CLI / TUI / MCP. `force: true` bypasses the 3-second result cache.
   */
  listHosts(opts?: { force?: boolean }): Promise<HostInfo[]>;
  /** Get active schedules for an ensemble. */
  getSchedules(ensemble: string): Promise<ScheduleEntry[]>;
  /** Cancel a named schedule in an ensemble. */
  cancelSchedule(ensemble: string, name: string): Promise<void>;
  /** Get quality gates from the conductor workflow. */
  getGates(ensemble: string): Promise<QualityGate[]>;
  /** Get stages from the conductor workflow. */
  getStages(ensemble: string): Promise<StageEntry[]>;
  /** Get worktrees from the conductor workflow. */
  getWorktrees(ensemble: string): Promise<WorktreeEntry[]>;
  /** Get aggregated ensemble chat (maestro + conductor traffic). */
  getEnsembleChat(ensemble: string, offset?: number, limit?: number): Promise<EnsembleChatResult>;
  /**
   * Bug B: Read the maestro hub's `maestroPaused` flag for an ensemble.
   * Returns `false` when the hub workflow doesn't exist (treat absence as
   * "not paused" — the StatusBar renders nothing for the bare-ensemble case).
   * The TUI polls this so a paused conductor swallowing messages becomes
   * visible (status bar segment + tooltip-style hint to type `/play`).
   */
  isMaestroPaused(ensemble: string): Promise<boolean>;
  /**
   * #306 follow-up: True when at least one session in the ensemble has its
   * outbox locked (i.e. is `held`). Companion to {@link isMaestroPaused};
   * the two are orthogonal — `/load_lineup` flips both, `/pause` flips just
   * paused, `/recruit --held` flips just held. The TUI polls this to surface
   * a yellow `held` segment + a `Tip: /go` hint, so users don't sit paused
   * watching held players that need releasing.
   *
   * Skips the maestro session (the TUI's own dashboard attachment) so a
   * locked maestro outbox — never a real held-player state — doesn't
   * trigger the indicator. Returns `false` when the scan or every per-
   * session query fails (treat absence as "not held").
   */
  isAnySessionHeld(ensemble: string): Promise<boolean>;
  /** Disband an ensemble: terminate all sessions, scheduler, and maestro workflows. */
  disbandEnsemble(ensemble: string): Promise<{ terminated: number }>;
  /** Check if the Temporal connection is alive. */
  isConnected(): Promise<boolean>;
  /** Check if the Global Maestro workflow is running. */
  hasGlobalMaestro(): Promise<boolean>;

  // ── #94/#95 PR-3: Subscribe to the daemon's SSE event stream ──

  /**
   * Subscribe to the per-ensemble SSE event stream exposed by the daemon
   * at `/v1/events/:ensemble`. Returns an `AsyncIterable<TempoEvent>` —
   * iterate with `for await` to consume events. The stream is
   * snapshot-then-stream: a synthetic `event: snapshot` arrives first
   * (carrying the `/v1/state/:ensemble` payload), then live diff events
   * follow per [`docs/SSE-PROTOCOL.md`](../../docs/SSE-PROTOCOL.md).
   *
   * **Cancellation**: pass `opts.signal` (`AbortSignal`) to terminate the
   * stream from the caller side, or simply `break` out of the `for await`
   * — the wrapper's iterator hooks `return()` to abort the underlying
   * transport (§7.4). The wrapper transparently reconnects on TCP drops
   * with `Last-Event-ID` carried across reconnects (§7.5).
   *
   * **Gap recovery**: `gap` and `chat.compressed` events surface to the
   * consumer (not swallowed). `gap` requires a `/v1/state/:ensemble`
   * re-fetch + resubscribe per §7.2; `chat.compressed` is a soft gap
   * scoped to the chat slice only per §7.6.
   */
  subscribe(ensemble: string, opts?: SubscribeOptions): AsyncIterable<TempoEvent>;
  /**
   * Subscribe to the global cluster-shape stream at `/v1/events`. Carries
   * only the cluster-wide events (`ensemble.created`, `ensemble.destroyed`,
   * `host_profile.changed`, `heartbeat`, `gap`, `throttled`).
   */
  subscribe(opts?: SubscribeOptions): AsyncIterable<TempoEvent>;

  // ── Maestro session (TUI-owned workflow for two-way messaging) ──

  /** Ensure a maestro session workflow exists for the ensemble (create or reuse). */
  ensureMaestroSession(ensemble: string): Promise<string>;
  /** Send a message as the maestro to a target player. */
  sendAsMaestro(ensemble: string, targetPlayer: string, text: string): Promise<void>;
  /** Get messages received + sent by the maestro session. */
  getMaestroMessages(ensemble: string): Promise<{ received: Message[]; sent: SentMessage[] }>;
}

/**
 * #308 follow-up: TTY-bound superset of {@link TempoClientCore}.
 *
 * Adds the two methods that shell out to a local terminal via
 * `agent-tempo up …`. Required for the TUI's "create ensemble" wizard
 * and the restore-after-shutdown flow. **DO NOT depend on this interface
 * from headless contexts** — the daemon, MCP tools, and SSE event source
 * must use {@link TempoClientCore}.
 */
export interface TempoClientWithSpawn extends TempoClientCore {
  /**
   * Spawn a new conductor terminal for a brand-new ensemble. Shells out to
   * `agent-tempo up <name>` so the spawned conductor terminal matches the
   * CLI path. **Requires a TTY context** — DO NOT call from MCP tools, the
   * daemon, or other headless processes.
   */
  createEnsemble(opts: CreateEnsembleOpts): Promise<void>;
  /**
   * Spawn a conductor terminal for an existing ensemble — the restore-
   * after-shutdown path. Shells out to `agent-tempo up <name>` which is
   * idempotent at the workflow layer. Semantically distinct from
   * {@link TempoClientWithSpawn.createEnsemble}: this fires on an ensemble
   * that already exists; a "create" contradiction would mislead future
   * readers. **Requires a TTY context.**
   */
  spawnConductor(opts: { ensemble: string; workDir?: string }): Promise<void>;
}

/**
 * Backwards-compatible alias preserved indefinitely (per ADR 0007's
 * forward-looking note). Existing code that imports `TempoClient` keeps
 * the full surface (Core + spawn). New consumers that want headless
 * safety should import {@link TempoClientCore} directly.
 */
export type TempoClient = TempoClientWithSpawn;
