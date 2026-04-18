// Shared types used by both workflow code (V8 sandbox) and Node.js server code.
// This file must NOT import from @temporalio/* — it's pure TypeScript types.

export type AgentType = 'claude' | 'copilot';

// ── v0.25 Attachment Lifecycle Types ──
// Source of truth: docs/design/session-lifecycle-rebuild-v2.md §§2.2–2.6, §8, §11.1

/**
 * The seven phases of a session workflow's lifecycle.
 *
 * - `booting` — workflow exists, no adapter has claimed it yet
 * - `attached` — an adapter holds a valid attachment and is idle-ready
 * - `processing` — attached AND at least one message is in-flight in the adapter
 * - `awaiting` — attached, idle, outbox empty (presentation refinement of `attached`)
 * - `draining` — attachment requested detach; flushing outbox + awaiting `adapterExited`
 * - `detached` — workflow RUNNING, no attachment; outbox dispatch paused (stop/destroy bypass)
 * - `gone` — terminal; workflow COMPLETES after `destroy`
 */
export type AttachmentPhase =
  | 'booting'
  | 'attached'
  | 'processing'
  | 'awaiting'
  | 'draining'
  | 'detached'
  | 'gone';

/** Classes of adapter with different lifecycle requirements. */
export type AdapterClass = 'interactive' | 'sdk';

/**
 * Descriptor registered by an adapter — declares class, identity, and required guarantees.
 * Used by the workflow to size timers (heartbeat cadence) and by the adapter registry
 * to route `recruit` to the right adapter implementation.
 */
export interface AdapterDescriptor {
  /** Adapter identifier, e.g. `'claude-code'`, `'copilot'`. */
  adapterId: string;
  adapterClass: AdapterClass;
  /** True iff the adapter blocks on an LLM turn (SDK adapters). Drives `processingStart`/`End` expectations. */
  blocksOnLLMTurn: boolean;
  /** Heartbeat cadence in milliseconds. Interactive: 60_000; SDK: 30_000. */
  heartbeatMs: number;
}

/**
 * Reason an attachment detached or was detached. Used for audit and UX messaging.
 *
 * Canonical values per design §3.1 (`docs/design/session-lifecycle-rebuild-v2.md`):
 *   `user-stop` | `restart` | `heartbeat-timeout` | `superseded` | `agent-exited` | `spawn-failed` | `destroy`
 *
 * `force` is a PR-A implementation extension used by the main loop's `drainingDeadline`
 * fire path (§9.5.c) when the adapter never sent `adapterExited` after `requestDetach`.
 * Kept alongside the spec values so the workflow has a non-empty reason to record even
 * when the graceful drain path never acked. Safe to merge into `heartbeat-timeout` in a
 * future cleanup if the semantics converge.
 */
export type DetachReason =
  | 'user-stop'
  | 'restart'
  | 'heartbeat-timeout'
  | 'superseded'
  | 'agent-exited'
  | 'spawn-failed'
  | 'destroy'
  | 'force';

/**
 * Workflow-emitted directive to the attached adapter. Delivered via {@link AttachmentInfo}
 * polling (no reverse-RPC surface in Temporal).
 */
export type AdapterDirective = 'detach-now' | 'heartbeat' | 'continue';

/**
 * A live or expired lease. Exactly one (or none) lives on the workflow at any time.
 * Lease-expiry enforcement happens in the main loop's deadline race (§9.5.a).
 */
export interface Attachment {
  attachmentId: string;
  hostname: string;
  adapterId: string;
  adapterClass: AdapterClass;
  /** ISO timestamp from `workflow.now()` at claim. */
  claimedAt: string;
  /** ISO timestamp of last heartbeat (signal or claimAttachment renewal). */
  lastHeartbeatAt: string;
  /** ISO timestamp; after this the main loop reaps the attachment → `detached`. */
  expiresAt: string;
  /**
   * Lease duration negotiated at claim time (milliseconds). Heartbeats renew
   * `expiresAt` by this amount — honours the caller's requested lease rather than a
   * workflow-side hardcoded default. Added in PR-C commit 6 (#119a).
   */
  leaseMs: number;
  /** Workflow runId captured at claim time — adapters must pin subsequent `getHandle` to this. */
  runId: string;
}

/** Opaque token returned from `claimAttachment`; adapter carries it on every subsequent call. */
export interface AttachmentToken {
  attachmentId: string;
  runId: string;
  /** ISO timestamp; adapter may use this to schedule early renewal before expiry. */
  expiresAt: string;
  leaseMs: number;
}

/**
 * Snapshot returned by the `attachmentInfo` query.
 * Adapters, tools, and the TUI poll this to drive UX.
 */
export interface AttachmentInfo {
  phase: AttachmentPhase;
  currentAttachment?: Attachment;
  preferredHost?: string;
  inFlightCount: number;
  /** ISO timestamp when the in-flight set became non-empty. */
  processingSince?: string;
}

/**
 * Returned by the `orphanSummary` query — shape matches what the daemon needs to render
 * a detached-orphan card and decide whether to auto-restore per `restorePolicy`.
 */
export interface OrphanSummary {
  detachedSince?: string;
  reason?: DetachReason;
  preferredHost?: string;
  lastAdapter?: { hostname: string; adapterId: string };
}

export interface SessionMetadata {
  playerId: string;
  ensemble: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType?: AgentType;
  /**
   * Adapter identifier resolved from the registry (`src/adapters/`). Populated on
   * fresh recruits in PR-B (v0.25 step 2/7); pre-PR-B sessions leave this
   * undefined and the dispatcher falls back to {@link agentType} → adapterId
   * mapping via `AdapterRegistry.resolveFromAgentType`.
   */
  adapterId?: string;
  /** Agent definition name (e.g., "tempo-soloist"). */
  playerType?: string;
  /** Short description from the agent definition. */
  playerTypeDescription?: string;
  /** Player ID of who recruited this player. */
  recruitedBy?: string;
  /** Worktree path if this session was spawned in an isolated worktree. */
  worktreePath?: string;
  /** Session UUID — used for Copilot SDK sessionId and Claude Code --resume/--session-id. */
  sessionId?: string;
}

export interface AgentTypeInfo {
  name: string;
  description?: string;
  source: 'project' | 'user' | 'shipped';
  path: string;
  nativeResolvable: boolean;
  allowedTools?: string[];
}

export interface SessionInput {
  metadata: SessionMetadata;
  /** Restored from continue-as-new */
  part?: string;
  /** Restored from continue-as-new (undelivered only) */
  messages?: Message[];
  /** Restored from continue-as-new */
  sentMessages?: SentMessage[];
  /** Restored from continue-as-new (conductor only) */
  commandHistory?: Command[];
  /** Restored from continue-as-new (conductor only) */
  reportHistory?: PlayerReport[];
  /** Restored from continue-as-new (pending/processing entries only) */
  outbox?: OutboxEntry[];
  autoSummary?: string;
  /** Disable stale session detection (for passive mailbox workflows like maestro) */
  disableStaleDetection?: boolean;
  /** Restored from continue-as-new: last inbound message with responseRequested=true */
  lastInboundRRTime?: number;
  /** Restored from continue-as-new: last outbound activity timestamp */
  lastOutboundTime?: number;
  /** Restored from continue-as-new (conductor only) */
  qualityGates?: QualityGate[];
  /** Restored from continue-as-new (conductor only) */
  worktrees?: WorktreeEntry[];
  /** Restored from continue-as-new (conductor only) */
  stages?: StageEntry[];
  /** When true, outbox dispatch is paused until releaseHeld signal is received (warm hold). */
  outboxLocked?: boolean;
  /** Stored initial message to deliver when the hold is released. */
  heldMessage?: string;
  /** When true, outbox dispatch is paused ensemble-wide (pause/resume). */
  paused?: boolean;
  /** Restored from continue-as-new: message IDs currently being processed (blocks stale detection). */
  inFlightMessageIds?: string[];
  /** Restored from continue-as-new: timestamp when in-flight set became non-empty.
   *  v0.24 wrote a numeric Date.now() value; v0.25 writes ISO strings via `workflow.now()`. */
  processingSince?: number | string;
  /** Restored from continue-as-new: workflow has been destroyed (terminal). */
  destroyed?: boolean;
  // ── v0.25 Attachment State (carried across continueAsNew) ──
  /** Current lease, if any. Expiry checked against `workflow.now()` in the main-loop deadline race. */
  currentAttachment?: Attachment;
  /** Host last seen as preferred for spawn; daemon `reconcileOnBoot` uses this. */
  preferredHost?: string;
  /** Current phase — authoritative after v0.25 replaces the legacy `status` field. */
  phase?: AttachmentPhase;
  /** ISO timestamp of when the current `draining` phase started. Carried for drainingDeadline race. */
  drainingSince?: string;
  /** Caller-supplied grace window for the current `draining` phase, in ms. When absent the
   *  workflow falls back to `DEFAULT_DRAINING_DEADLINE_MS`. Carried across continueAsNew so a
   *  detach request with a non-default deadline isn't silently reset to 5s mid-drain. */
  drainingDeadlineMs?: number;
  /** Temporal config passed through for outbox activities (non-secret fields only). */
  temporalConfig?: {
    temporalAddress: string;
    temporalNamespace: string;
    taskQueue: string;
  };
}

export interface Message {
  id: string;
  from: string;
  text: string;
  timestamp: string;
  delivered: boolean;
  /** True when sent from the Maestro dashboard by a human. */
  isMaestro?: boolean;
}

export interface SentMessage {
  id: string;
  to: string;
  text: string;
  timestamp: string;
}

export interface Command {
  text: string;
  source: string;
  replyTo?: string;
  timestamp: string;
}

export interface PlayerReport {
  playerId: string;
  text: string;
  type: 'result' | 'blocker' | 'question';
  timestamp: string;
}

export interface HistoryEntry {
  type: 'command' | 'report';
  timestamp: string;
  data: Command | PlayerReport;
}

// ── Outbox Types ──

export type OutboxEntryStatus = 'pending' | 'processing' | 'delivered' | 'failed';

interface OutboxEntryBase {
  id: string;
  createdAt: string;
  status: OutboxEntryStatus;
  error?: string;
  deliveredAt?: string;
}

export interface CueOutboxEntry extends OutboxEntryBase {
  type: 'cue';
  targetPlayerId: string;
  message: string;
}

export interface RecruitOutboxEntry extends OutboxEntryBase {
  type: 'recruit';
  targetName: string;
  workDir: string;
  isConductor: boolean;
  initialMessage?: string;
  agent: AgentType;
  systemPrompt?: string;
  targetHostname?: string;
  /** Agent type name (e.g., "tempo-soloist"). */
  agentDefinition?: string;
  /** Resolved absolute path to .md file (for shipped fallback). */
  agentDefinitionPath?: string;
  /** Short description from the agent definition frontmatter. */
  agentDefinitionDescription?: string;
  /** Whether the agent definition is in a Claude Code-resolvable location. */
  nativeResolvable?: boolean;
  /** Tool restrictions from the agent definition frontmatter. */
  allowedTools?: string[];
  /** Custom claude binary path (from config.claudeBin). */
  claudeBin?: string;
  /** When true, spawn process but lock outbox and defer initial message until release (warm hold). */
  held?: boolean;
}

export interface ReleaseOutboxEntry extends OutboxEntryBase {
  type: 'release';
  targetPlayerId: string;
}

export interface ReportOutboxEntry extends OutboxEntryBase {
  type: 'report';
  text: string;
  reportType: 'result' | 'blocker' | 'question' | 'update';
}

export interface StopOutboxEntry extends OutboxEntryBase {
  type: 'stop';
  targetPlayerId: string;
}

/**
 * Detach outbox entry (PR-D) — enqueued by the `detach` tool / TempoClient /
 * CLI to gracefully reap the target's adapter. The dispatch `deliverDetach`
 * activity signals `requestDetachSignal` on the target's workflow.
 */
export interface DetachOutboxEntry extends OutboxEntryBase {
  type: 'detach';
  targetPlayerId: string;
  reason?: DetachReason;
  deadlineMs?: number;
}

/**
 * Destroy outbox entry (PR-D) — enqueued by the `destroy` tool / TempoClient /
 * CLI to terminally end the target's workflow. Dispatch `deliverDestroy`
 * activity executes `destroyUpdate` on the target and optionally posts a
 * system receiveMessage on the ensemble conductor.
 */
export interface DestroyOutboxEntry extends OutboxEntryBase {
  type: 'destroy';
  targetPlayerId: string;
  reason?: string;
  /** When true (default), post a system message on the ensemble conductor. */
  notifyConductor?: boolean;
}

/**
 * Restart outbox entry (PR-D) — enqueued by the `restart` / `migrate` tools,
 * the TempoClient, and the CLI. Dispatch `deliverRestart` activity owns the
 * §8.2 algorithm on the target (graceful detach → optional force → claim →
 * optional context replay → enqueueSpawn). Durable across the per-attempt
 * retry window of the activity itself.
 */
export interface RestartOutboxEntry extends OutboxEntryBase {
  type: 'restart';
  targetPlayerId: string;
  /** When true, force-steal a live attachment via forceDetach. */
  force?: boolean;
  /** Target host for the new attachment; defaults to preferredHost/last-hostname. */
  host?: string;
  /** Skip context replay (equivalent to --fresh). */
  fresh?: boolean;
  /** Number of recent messages to include in context (when !fresh). */
  contextMessages?: number;
  /** Identifier of the invoker for audit messages (default: 'cli'). */
  invokerPlayerId?: string;
}

/**
 * Spawn outbox entry — enqueued by the `enqueueSpawn` update so a host activity
 * launches (or relaunches) an adapter process that will then claim the carried
 * attachment. Distinguished from `RecruitOutboxEntry` because the target
 * workflow already exists and an attachment has been pre-claimed; the dispatch
 * side therefore skips workflow creation and drives the restart/resume path.
 *
 * PR-C commit 6 (#118): planted the discriminated union member. PR-D wires
 * full end-to-end consumption of the 5 attachment-specific fields through the
 * `startRecruitedSession` + `spawnProcess` activities.
 */
export interface SpawnOutboxEntry extends OutboxEntryBase {
  type: 'spawn';
  /** The name of the player this spawn lands on (matches workflow metadata.playerId). */
  targetName: string;
  /** Working directory for the spawned adapter process. */
  workDir: string;
  /** True if the spawn is for the ensemble conductor session. */
  isConductor: boolean;
  /** Agent kind to spawn (claude | copilot | future SDK variants). */
  agent: AgentType;
  /** Host task queue the spawn activity should dispatch against. */
  targetHostname: string;
  /** Attachment pre-claimed for this spawn — adapter consumes it on boot. */
  attachmentId: string;
  /** RunId pinned during the pre-claim — adapter `getHandle`s against this. */
  attachmentRunId: string;
  /** Adapter class descriptor id (`'claude-code'`, `'copilot'`, …). */
  adapterId: string;
  /** True if the spawn should `claude --resume` into the prior `sessionId`. */
  resumeAttachment: boolean;
  /** Claude session id used for `--resume` and continuity. Optional — fresh spawns omit it. */
  sessionId?: string;
  /** Resolved agent-definition name (e.g. `my-tempo-engineer`). */
  agentDefinition?: string;
  /** Absolute path to the agent-definition `.md` on the invoker host. */
  agentDefinitionPath?: string;
  /** True when the agent-definition is resolvable by name on the target host
   *  (project/user tier) so the spawn can use `--agent <name>` instead of
   *  `--system-prompt <path>`. */
  nativeResolvable?: boolean;
}

export type OutboxEntry =
  | CueOutboxEntry
  | RecruitOutboxEntry
  | ReportOutboxEntry
  | StopOutboxEntry
  | ReleaseOutboxEntry
  | SpawnOutboxEntry
  | DetachOutboxEntry
  | DestroyOutboxEntry
  | RestartOutboxEntry;

/** Distributive Omit that works correctly on union types. */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** Input type for submitting outbox entries — auto-fields (id, createdAt, status, error, deliveredAt) are added by the workflow. */
export type OutboxEntryInput = DistributiveOmit<OutboxEntry, 'id' | 'createdAt' | 'status' | 'error' | 'deliveredAt'>;

// ── Quality Gate Types ──

export interface QualityGateCriterion {
  text: string;
  status: 'pending' | 'passed' | 'failed';
  evaluatedBy?: string;
  evaluatedAt?: string;
  notes?: string;
}

export interface QualityGate {
  /** Unique key identifying the task this gate covers. */
  task: string;
  criteria: QualityGateCriterion[];
  createdBy: string;
  createdAt: string;
  /** Derived: all passed → passed, any failed → failed, else open. */
  status: 'open' | 'passed' | 'failed';
}

// ── Worktree Types ──

export interface WorktreeEntry {
  /** Player name assigned to this worktree. */
  player: string;
  /** Absolute path to worktree directory. */
  path: string;
  /** Git branch for this worktree. */
  branch: string;
  /** Original git root (for git worktree remove). */
  gitRoot: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Player ID of creator. */
  createdBy: string;
}

// ── Stage Types ──

export interface StagePlayerStatus {
  playerId: string;
  status: 'waiting' | 'reported' | 'blocked';
  reportType?: 'result' | 'blocker' | 'question' | 'update';
  reportText?: string;
  reportedAt?: string;
}

export interface StageEntry {
  /** Unique name identifying this stage. */
  name: string;
  /** Players tracked in this stage. */
  players: StagePlayerStatus[];
  /** Aggregate status: active until all report or a blocker halts. */
  status: 'active' | 'complete' | 'failed' | 'cancelled';
  /** What happens when a player reports a blocker. */
  failurePolicy: 'halt' | 'continue';
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Player ID of the conductor that created the stage. */
  createdBy: string;
  /** ISO timestamp of completion/failure/cancellation. */
  completedAt?: string;
}

export interface ScheduleEntry {
  /** Unique name for this schedule (used as key for add/replace/remove). */
  name: string;
  /** The message text to deliver when the schedule fires. */
  message: string;
  /** Target player name to deliver the cue to. */
  target: string;
  /** Player name of whoever created this schedule. */
  createdBy: string;
  /** ISO timestamp of the next fire time. */
  nextFireAt: string;
  /** Interval in milliseconds for repeating schedules. */
  interval?: number;
  /** ISO timestamp after which the schedule should be removed. */
  until?: string;
  /** Number of remaining fires (decremented each fire, removed at 0). */
  remainingCount?: number;
  /** Total number of times this schedule has fired. */
  firedCount: number;
  /** Schedule type for display purposes. */
  type: 'once' | 'interval' | 'cron';
  /** Cron expression string (e.g., "0 9 * * 1-5"). Stored for re-computing next fire. */
  cronExpression?: string;
  /** IANA timezone for cron evaluation (e.g., "America/New_York"). Defaults to UTC. */
  timezone?: string;
}

// ── Maestro Types ──

/** Snapshot of a player as seen by the Maestro workflow. */
export interface MaestroPlayerInfo {
  playerId: string;
  ensemble: string;
  part: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType: string;
  playerType?: string;
  /**
   * Attachment phase value (e.g. `'attached'`, `'detached'`, `'gone'`).
   *
   * TODO: rename to `phase` and retype as AttachmentPhase once the shim epic
   * settles; kept as `status?: string` during #176 to minimize workflow-replay
   * blast radius. Safe to clean up any time after beta.6.
   */
  status?: string;
}

/** A message relayed through the global Maestro for dashboard visibility. */
export interface MaestroRelayMessage {
  id: string;
  ensemble: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
}

/** Input for the global Maestro workflow. */
export interface GlobalMaestroInput {
  /** Restored from continue-as-new. */
  knownEnsembles?: string[];
  /** Restored from continue-as-new. */
  playersByEnsemble?: Record<string, MaestroPlayerInfo[]>;
  /** Restored from continue-as-new (ring buffer, max 500). */
  recentMessages?: MaestroRelayMessage[];
  /** Restored from continue-as-new (ring buffer, max 500). */
  events?: MaestroEvent[];
  /** Restored from continue-as-new. */
  pendingCommands?: MaestroPendingCommand[];
  /** Refresh interval in milliseconds (default 10000). Lowered in tests. */
  pollIntervalMs?: number;
}

/** An event generated by diffing consecutive Maestro snapshots. */
export interface MaestroEvent {
  type: 'player_joined' | 'player_left' | 'status_changed' | 'part_changed';
  playerId: string;
  timestamp: string;
  oldValue?: string;
  newValue?: string;
}

/** A command queued via the maestroSendCommand update, awaiting relay. */
export interface MaestroPendingCommand {
  id: string;
  text: string;
  source: string;
  replyTo?: string;
  createdAt: string;
  status: 'pending' | 'delivered' | 'failed';
  error?: string;
  /** Ensemble to route to (used by global Maestro only). */
  ensemble?: string;
}

/** A single message in the aggregated ensemble chat feed. */
export interface EnsembleChatMessage {
  id: string;
  from: string;
  to: string;
  /** Truncated to 500 chars max. Full text available via getPlayerMessages. */
  text: string;
  timestamp: string;
  /**
   * Message perspective:
   * - 'maestro-out': maestro (you) sent to a player
   * - 'maestro-in': a player sent to maestro (you)
   * - 'conductor-out': conductor sent to a non-maestro player
   * - 'conductor-in': a non-maestro player sent to conductor
   */
  role: 'maestro-out' | 'maestro-in' | 'conductor-out' | 'conductor-in';
}

/** Input for the maestroEnsembleChat query. */
export interface EnsembleChatQuery {
  /** Messages to skip from the tail (default 0). */
  offset?: number;
  /** Max messages to return (default 50, max 200). */
  limit?: number;
}

/** Result from the maestroEnsembleChat query. */
export interface EnsembleChatResult {
  messages: EnsembleChatMessage[];
  /** Total message count in cache. */
  total: number;
  /** True if messages exist beyond offset+limit. */
  hasMore: boolean;
  /** Whether a conductor was found during last refresh. */
  hasConductor: boolean;
}

/** High-water marks for incremental chat fetch. */
export interface ChatHighWater {
  maestroRecv: number;
  maestroSent: number;
  conductorRecv: number;
  conductorSent: number;
}

/** Zero-value for ChatHighWater — use as default when no prior fetch. */
export const ZERO_CHAT_HIGH_WATER: ChatHighWater = {
  maestroRecv: 0, maestroSent: 0, conductorRecv: 0, conductorSent: 0,
};

/** Input for the Maestro workflow. */
export interface MaestroInput {
  ensemble: string;
  /** Restored from continue-as-new. */
  players?: MaestroPlayerInfo[];
  /** Restored from continue-as-new (ring buffer, max 200). */
  events?: MaestroEvent[];
  /** Restored from continue-as-new. */
  pendingCommands?: MaestroPendingCommand[];
  /** Refresh interval in milliseconds (default 10000). Lowered in tests. */
  pollIntervalMs?: number;
  /** Restored from continue-as-new (ring buffer, max 500). */
  cachedChat?: EnsembleChatMessage[];
  /** Metadata about last chat refresh. */
  cachedChatMeta?: { hasConductor: boolean };
  /** High-water marks for incremental chat fetch. */
  chatHighWater?: ChatHighWater;
  /** Restored from continue-as-new: ensemble-wide paused state. */
  paused?: boolean;
}
