// Shared types used by both workflow code (V8 sandbox) and Node.js server code.
// This file must NOT import from @temporalio/* — it's pure TypeScript types.

/**
 * Agent runtime selector.
 *
 * - `'claude'` / `'copilot'` — production adapters; ship in the npm tarball.
 * - `'mock'` — dev-mode-only adapter (ADR 0014 PR-2). Defense-in-depth gates
 *   (build-time exclusion, registry gate behind `isDevMode()`, recruit-time
 *   rejection, runtime banner) keep this off production paths. The string
 *   value lives in the type union so workflow / outbox / recruit code can
 *   discriminate without `any` casts even in production builds; the runtime
 *   gates are what actually prevent execution.
 *
 * Single source of truth: {@link AGENT_TYPES}. The CLI argv parser
 * (`src/cli.ts`'s `--agent` validation) and the recruit MCP tool's
 * `z.enum` import this tuple so adding a new adapter only requires
 * editing one line — see #476 (the `claude-api` allowlist drift bug
 * that motivated centralising this).
 */
export const AGENT_TYPES = ['claude', 'copilot', 'mock', 'claude-api', 'opencode', 'claude-code-headless', 'pi'] as const;
export type AgentType = typeof AGENT_TYPES[number];

/**
 * Mock-adapter mode (ADR 0014 §4.2). Single source of truth shared by the
 * adapter, the recruit tool's zod enum (`z.enum(MOCK_MODES)`), the spawn
 * options, the recruit outbox entry, the lineup schema, and the lineup
 * dispatcher. `'echo' | 'scripted'` shipped in PR-2; `'silent' | 'chaos'`
 * landed in PR-3.
 *
 * Declared here rather than in `src/adapters/mock/` so non-dev-mode modules
 * (recruit, spawn, schema) can reference the type without pulling the
 * adapter source unit into their dep graph.
 */
export const MOCK_MODES = ['echo', 'scripted', 'silent', 'chaos'] as const;
export type MockMode = typeof MOCK_MODES[number];

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
 *
 * `reconnect-exhausted` is fired adapter-side by `BaseAttachment.runReconnectLoop` (#201)
 * when the reconnect budget elapsed without recovering a live lease. Distinct from
 * `heartbeat-timeout` so post-mortems can tell "lease expired once" from "poller tried
 * to recover and gave up" — workflow-side reap accounting treats them identically.
 *
 * `continued-as-new` is fired adapter-side by `BaseAttachment.tickHeartbeat` /
 * `tickPhaseWatcher` (#226) when the pinned runId returns
 * `WorkflowExecutionAlreadyCompleted` AND the closed run's history carries a
 * `WorkflowExecutionContinuedAsNewEvent` pointing at a successor runId. When the
 * subclass opts in via `shouldReconnect`, the base class transparently rebinds the
 * pinned handle to the successor (no re-claim — the workflow's §2.3 CAN-boundary
 * lease extension keeps the lease alive across the transition) and resumes delivery.
 * When not opted in, the base class fires the reason as terminal just like any
 * other non-recoverable lease loss.
 */
export type DetachReason =
  | 'user-stop'
  | 'restart'
  | 'heartbeat-timeout'
  | 'superseded'
  | 'agent-exited'
  | 'spawn-failed'
  | 'destroy'
  | 'force'
  | 'reconnect-exhausted'
  | 'continued-as-new';

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
 *
 * `ensemble` and `playerId` carry the workflow's canonical metadata identity —
 * sourced from `input.metadata` in the workflow handler, not parsed from the
 * workflow id (see #143). Consumers like `reconcileOnBoot`, `cleanupLoop`, and
 * `restoreOneOrphan` read these directly instead of regex-parsing the workflow
 * id (which loses dashes from player names like `tempo-eng`).
 */
export interface OrphanSummary {
  ensemble: string;
  playerId: string;
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
  /**
   * Adapter-specific session identifier. Stashed via `updateMetadataSignal`
   * by the adapter on first turn / first claim; read back on restart /
   * encore for resume continuity. Three usage paths today:
   *
   *   - **Copilot bridge** — Copilot SDK session id (UUIDv4-shaped).
   *   - **Claude Code interactive** (`agent: 'claude'`) — UUIDv4 used as
   *     `claude --session-id <id>` on spawn and `claude --resume <id>` on
   *     restart for deterministic session resume.
   *   - **Claude Code headless** (`agent: 'claude-code-headless'`, #520)
   *     — UUIDv4 used as `claude -p --session-id <id>` per turn and
   *     `--resume <id>` on subsequent turns. Shares the field with the
   *     interactive adapter so an interactive↔headless migrate within the
   *     same cwd preserves session continuity for free (Claude Code's
   *     session JSONL is per-cwd, not per-adapter).
   *   - **OpenCode** (`agent: 'opencode'`) — OpenCode-server session id.
   *   - **Mock** — `mock-<pid>` placeholder (dev mode only).
   *
   * **Treat as opaque**: consumers MUST NOT depend on a specific UUID
   * format or origin — different adapters write different shapes through
   * this field, and that's by design.
   */
  sessionId?: string;
  /**
   * #131 Phase C — model id for the claude-api adapter (e.g.
   * `claude-opus-4-7`). Lives on durable session metadata so restart /
   * encore / migrate of a claude-api player can recover the original
   * model selection across `continueAsNew` boundaries (the recruit-arg
   * lives only in `RecruitOutboxEntry` which is dropped after dispatch).
   * Absent for non-claude-api sessions; absent for pre-#131 sessions
   * (the spawn falls back to `AGENT_TEMPO_API_MODEL` env / pinned default).
   */
  model?: string;
  /**
   * #700 (P2 / G) — the durable guardrail posture for this autonomous agent.
   * One knob, applied consistently to any autonomous LLM agent (headless
   * conductor + interactive planner alike):
   *
   *   - `autonomous` (**default**, absent ⇒ this) — no gate; every op runs
   *     free. vinceblank's hard requirement: hands-off orchestration is the
   *     point, so supervision is strictly opt-in.
   *   - `monitored` — gate armed, **fail-OPEN** (today's MD-G): a non-low-risk
   *     op auto-ALLOWs after {@link GATE_AUTO_ALLOW_MS} if the operator doesn't
   *     intervene. "Let the operator catch + override," not "block until yes."
   *   - `supervised` — gate armed, **fail-CLOSED**: a non-low-risk op auto-DENIES
   *     after `GATE_CLOSED_DENY_MS` (300s) on operator absence / daemon-down.
   *     Silence ≠ consent.
   *   - `observe-only` — a separate *no-act* axis (tool-access denial, MD-C
   *     style), not a gate state; the agent may read/observe/advise but cannot
   *     act.
   *
   * **Why DURABLE (not the env-path `toolAccess` uses):** a policy delivered
   * only via spawn-env that a restart / re-attach failed to re-thread would
   * silently DOWNGRADE a supervised agent to autonomous — that downgrade IS the
   * guardrail bypass. Persisting it on session metadata means arm-at-boot reads
   * the real posture on EVERY attach (across restart / migrate / re-attach), so
   * a previously-`supervised` agent stays supervised. (tempo-architect ruling.)
   *
   * **★ P2 scope — CLIENT-COOPERATIVE, not tamper-proof (conductor ruling).**
   * The agent stamps the per-request `failMode` from THIS policy in its own
   * extension (`src/pi/extension.ts`), so `supervised` is only as strong as the
   * agent HONORING its own policy — exactly MD-C tool-access parity (also
   * client-enforced). It is NOT a hard security boundary against a compromised /
   * prompt-injected agent that stamps `'open'` to self-downgrade. The tamper-
   * proof form (the daemon cross-checks the request's `failMode` against this
   * durable policy and FORCES `closed` for a supervised player) is **P2.1**, and
   * is additive — it reads `failMode` off the same per-request seam. Do not
   * describe `supervised` as a hard guarantee until daemon-side enforcement lands.
   */
  guardrailPolicy?: GuardrailPolicy;
}

/**
 * #700 (P2 / G) — the durable guardrail posture for an autonomous agent.
 * See {@link SessionMetadata.guardrailPolicy}. Absent ⇒ `autonomous`.
 */
export type GuardrailPolicy = 'autonomous' | 'monitored' | 'supervised' | 'observe-only';

export interface AgentTypeInfo {
  name: string;
  description?: string;
  source: 'project' | 'user' | 'shipped';
  path: string;
  nativeResolvable: boolean;
  allowedTools?: string[];
}

// ── Host profile / liveness types (#274) ────────────────────────────────
// `HostProfile` is the capability snapshot each daemon advertises to the
// global maestro at boot via the `hostProfile` signal. `HostInfo` +
// `InstanceInfo` are the client-side join shapes returned by
// `listHosts(client)` — they layer Temporal poller liveness on top of the
// advertised profile. Live workflow wire type is `HostProfile`; everything
// else is consumer-side.

/**
 * Capability snapshot advertised by a daemon at boot.
 *
 * Intentionally an OPEN schema: only `hostname` is required and validated
 * at signal receipt. All other fields are optional and stored opaquely so
 * the global maestro can accept payloads from daemons running newer or
 * older versions without breaking. Per-field Zod validation happens at the
 * `listHosts` join site, never at the workflow signal handler (see #274
 * architect delta AC3c / M9).
 *
 * **Privacy contract (AC5c / M10 — HARD REQUIREMENT):** daemon-side scrub
 * MUST strip absolute paths, env vars, and user-home directories before
 * signaling. The global maestro is namespace-wide; a multi-tenant or
 * multi-ensemble corporate setup would leak username-containing paths
 * across ensembles if this is ever violated. `claudeBin` is basename only.
 * `availableAgentTypes` is type names only.
 */
export interface HostProfile {
  /** Required. Validated against PLAYER_NAME_REGEX at signal receipt. */
  hostname: string;
  /** Daemon package version string (e.g. `0.26.0-beta.7`). Optional — legacy daemons may omit. */
  version?: string;
  defaultAgent?: AgentType;
  /** Agent type NAMES only. Never file paths — see privacy contract above. */
  availableAgentTypes?: string[];
  availablePlayerTypes?: string[];
  /** Basename only (e.g. `'claude'`). Never absolute — see privacy contract above. */
  claudeBin?: string;
  platform?: NodeJS.Platform;
  capabilities?: string[];
  /**
   * Daemon process start time (epoch ms, `Date.now()` at module load).
   * Resets on every daemon restart; semantics are
   * **daemon-process uptime**, not host-first-seen. Issue #399 Q5.3b.
   * The Hosts table renders `now - daemonStartedAt` client-side.
   */
  daemonStartedAt?: number;
  /**
   * Adapter name → upstream tool version (e.g.
   * `{ "claude-code": "1.2.4", "copilot": "0.5.2" }`).
   * Probed once at daemon boot in parallel with the global-maestro ensure;
   * adapters whose probe fails or whose output can't be parsed are
   * omitted entirely (the dashboard shows `—`). Issue #399 Q5.4.
   */
  adapterVersions?: Record<string, string>;
  /**
   * Open-schema escape hatch: unknown fields carried opaquely across
   * daemon-version skew. Consumers MUST NOT rely on specific keys here
   * without a Zod guard at read time.
   */
  [extraField: string]: unknown;
}

/**
 * Single daemon-process instance observed by Temporal's poller registry.
 * A `HostInfo` may carry ≥1 instance when multiple daemons run on the same
 * hostname (e.g. different `AGENT_TEMPO_HOME` per user session).
 */
export interface InstanceInfo {
  pid: number;
  /** Parsed from worker identity. `'unknown'` for legacy-format identities (`<pid>@<hostname>`). */
  version: string;
  /** Raw `poller.identity` as Temporal returned it. */
  identity: string;
  /** ISO 8601. */
  lastAccessTime: string;
  hasWorkflowWorker: boolean;
  hasActivityWorker: boolean;
  /** `true` when the per-host activity queue (`agent-tempo-<hostname>`) has a live poller. Controls `HostInfo.recruitReady`. */
  hasHostQueueWorker: boolean;
  /** Set only when identity was in the legacy `<pid>@<hostname>` form. */
  legacy?: true;
}

/**
 * Joined liveness + capability view returned by `src/utils/hosts.ts`.
 * `freshness === 'live'` iff any instance's `lastAccessTime` is within the
 * `HOST_FRESHNESS_THRESHOLD_MS` window. `recruitReady` is `true` iff some
 * instance has BOTH shared-activity AND per-host-activity pollers live —
 * the minimum a recruit dispatch needs.
 */
export interface HostInfo {
  hostname: string;
  instances: InstanceInfo[];
  recruitReady: boolean;
  freshness: 'live' | 'stale';
  profile?: HostProfile;
  /**
   * - `'fresh'` — profile present and the signaling daemon's parsed version matches a live identity
   * - `'stale'` — profile present but identity/version disagrees (M13 reconciliation) or the signaling daemon is not currently polling
   * - `'missing'` — daemon is live but no profile record exists (pre-HostProfile daemon, global maestro unreachable at boot, or global maestro absent)
   */
  profileStaleness: 'fresh' | 'stale' | 'missing';
}

/**
 * One slot of player-saveable state (#334 PR-1, ADR 0011).
 *
 * Curated artifact written by the owning player itself via the `save_state`
 * MCP tool — opaque string content with a markdown-template docstring nudge
 * (no enforced schema). Read by any peer in the ensemble via `fetch_state`;
 * cleared by the owner via `clear_state`.
 *
 * Sizing: per-key content max 32 KiB; up to 4 slots per player; aggregate
 * structural max 128 KiB. See `src/utils/validation.ts` constants and
 * `docs/design/334-player-saveable-state.md` §3 for the CAN-payload analysis.
 *
 * `savedAt` is an ISO timestamp produced via `workflow.now()` so replay stays
 * deterministic. `savedBy` records the player id that wrote the slot — the
 * audit identity for peer reads.
 */
export interface PlayerStateEntry {
  content: string;
  savedAt: string;
  savedBy: string;
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
  /** Restored from continue-as-new (D14) — an un-acked pending reset survives a CAN. */
  pendingReset?: PendingReset | null;
  autoSummary?: string;
  /** Disable stale session detection (for passive mailbox workflows like maestro) */
  disableStaleDetection?: boolean;
  /** Restored from continue-as-new: last inbound message with responseRequested=true */
  lastInboundRRTime?: number;
  /** Restored from continue-as-new: last outbound activity timestamp */
  lastOutboundTime?: number;
  /**
   * #399 W2 — counters carried across continueAsNew. Each is monotonic
   * across the workflow's lifetime; the dashboard surfaces them via
   * `getMessagingStateQuery` and `getActivityStateQuery`.
   *
   * - `receivedCount`: bumped per inbound `receiveMessage` cue.
   * - `sentCount`: bumped per `submitOutboxUpdate` (every entry the
   *   session pushes to its outbox). The dashboard's "Messages" KV
   *   row reads this as outbound volume.
   * - `activityCount`: bumped at every "work" event — cue, outbox
   *   submit, schedule fire, report, recruit, restart, destroy,
   *   migrate. Mirrors the existing `lastActivityTime` mutation
   *   sites (~20 of them) and feeds W1's tempo bucket projection.
   */
  receivedCount?: number;
  sentCount?: number;
  activityCount?: number;
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
  /**
   * Restored from continue-as-new: per-player saveable-state slots
   * (#334 PR-1 / ADR 0011). Map of `slotKey → PlayerStateEntry`. Carried
   * forward only when at least one slot is populated — empty maps are
   * omitted from the CAN payload to keep the wire small for the common
   * no-state case (same idiom as `currentAttachment` / `preferredHost`).
   * See `src/utils/validation.ts` for size + slot-count caps.
   */
  playerState?: Record<string, PlayerStateEntry>;
}

export interface Message {
  id: string;
  from: string;
  text: string;
  timestamp: string;
  delivered: boolean;
  /** True when sent from the Maestro dashboard by a human. */
  isMaestro?: boolean;
  /**
   * #357: Stable id shared across every fan-out target of a single
   * `broadcast` tool invocation. Generated once in the broadcaster's
   * MCP-tool process and threaded through `CueOutboxEntry` →
   * `receiveMessage` signal → this field. The TUI uses it to fold N
   * identical broadcast deliveries into a single chat row. `undefined`
   * for non-broadcast direct cues.
   */
  broadcastId?: string;
  /**
   * #318: Coat-check ticket id when the sender stashed content via
   * `coat_check_put` and called `cue` with `attachmentTicket`. Receivers
   * call `coat_check_get` with this value to pull the full content body.
   * `undefined` for cues without an attachment.
   */
  attachmentTicket?: string;
}

export interface SentMessage {
  id: string;
  to: string;
  text: string;
  timestamp: string;
  /** #357: Mirrors {@link Message.broadcastId} on the sender side. */
  broadcastId?: string;
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
  /**
   * #357: Stable id shared across every fan-out target of a single
   * `broadcast` tool invocation. Generated once in the MCP-tool process
   * (NOT inside the workflow — workflow determinism is preserved
   * because the workflow only sees the id as an opaque string on
   * `OutboxEntryInput`). Threaded through to the target's `Message`
   * and the sender's `SentMessage` so the TUI can fold the fan-out
   * into a single chat row. `undefined` for non-broadcast cues.
   */
  broadcastId?: string;
  /**
   * #318: Optional coat-check ticket id referencing content stashed on
   * per-ensemble Maestro state via `coat_check_put`. Receivers see this
   * field on their delivered `Message` and can call `coat_check_get` to
   * pull the full content body. Backward-compatible — pre-#318 cues just
   * don't have it.
   */
  attachmentTicket?: string;
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
  /**
   * Mock-adapter configuration (ADR 0014 §4.2). Only set when `agent === 'mock'`.
   * `mockMode` defaults to `'echo'` if absent. `mockScenario` is required when
   * `mockMode === 'scripted'` and accepts either a bare scenario name (resolved
   * against the package's shipped `scenarios/` dir) or an absolute YAML path.
   * Neither `silent` nor `chaos` consume `mockScenario`.
   */
  mockMode?: MockMode;
  mockScenario?: string;
  /**
   * Optional model id for the claude-api adapter (#131 Phase C). Falls back
   * to `AGENT_TEMPO_API_MODEL` env then a constants-pinned default at the
   * adapter's spawn time. Ignored when `agent !== 'claude-api'`.
   */
  model?: string;
  /**
   * #520 — claude-code-headless permission mode. Forwarded to `claude -p
   * --permission-mode`. Recruit-arg → `AGENT_TEMPO_PERMISSION_MODE` env →
   * `'acceptEdits'` default. Mutually exclusive with
   * {@link dangerouslySkipPermissions}. Ignored when
   * `agent !== 'claude-code-headless'`.
   *
   * Type literal kept inline (not imported from
   * {@link ClaudeCodeHeadlessPermissionMode}) because this file is the
   * V8 workflow-sandbox-safe shared types module — importing from
   * `src/adapters/` would invert the dependency direction and risk
   * loading adapter code into the sandbox. The Zod enum, spawn helper,
   * and outbox `SpawnProcessInput` re-derive from the canonical tuple at
   * their consumer surfaces (where `src/adapters/claude-code-headless/types`
   * is safe to import).
   */
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
  /**
   * #520 — claude-code-headless dangerous-skip-permissions opt-in. When
   * true, the adapter passes `--dangerously-skip-permissions` to `claude
   * -p` instead of `--permission-mode`. Use only in trusted / sandboxed
   * contexts. Mutually exclusive with {@link permissionMode}. Ignored
   * when `agent !== 'claude-code-headless'`.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Phase 3a / MD-C — headless Pi tool-class policy. `'restricted'` (default;
   * Bash/shell/exec hard-blocked) | `'standard'` (scoped Bash) | `'full'`
   * (unsandboxed; admin/force-gated at recruit). Ignored when `agent !== 'pi'`.
   * Inline literal — types.ts is the V8-sandbox-safe shared module; do NOT import
   * the type from src/pi or src/adapters.
   */
  toolAccess?: 'restricted' | 'standard' | 'full';
  /**
   * #700 (P2 / G) — headless Pi guardrail posture (recruit-arg). Persisted onto
   * durable {@link SessionMetadata.guardrailPolicy} by `startRecruitedSession`,
   * so restart / migrate / re-attach recover it from metadata (NOT this entry,
   * which is dropped after dispatch). Ignored when `agent !== 'pi'`. Absent ⇒
   * `autonomous`. {@link GuardrailPolicy} is defined in THIS module, so the
   * reference is in-file (no cross-module import — sandbox-safe).
   */
  guardrailPolicy?: GuardrailPolicy;
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
  /**
   * #334 PR-2 — seed the restarted session with a saved-state slot instead of
   * (or alongside) transcript replay. `true` resolves to `PLAYER_STATE_DEFAULT_KEY`
   * (`'main'`); a string names a specific slot. Absent = current behaviour
   * (transcript replay only). Backward compat is structural — old payloads
   * omit this field and the new `wantsState` branch evaluates to `false`. See
   * [docs/design/334-player-saveable-state.md](../../docs/design/334-player-saveable-state.md) §7.2.
   */
  loadFromState?: boolean | string;
  /**
   * #334 PR-2 — controls transcript-replay interaction when `loadFromState`
   * is set:
   *   - `'suppress'` (default when `loadFromState` set): only the saved
   *     state seeds the new session.
   *   - `'replay'`: both saved state and transcript are seeded (saved
   *     state delivered first).
   *   - When `loadFromState` is absent: ignored — transcript replay always
   *     happens (governed by the existing `fresh` flag).
   */
  transcript?: 'suppress' | 'replay';
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
  /**
   * #131 Phase C — claude-api model id carried across restart / encore /
   * migrate. Read from durable {@link SessionMetadata.model} by
   * `deliverRestart` and forwarded into the spawn so the restarted
   * subprocess runs the same model the original recruit chose.
   */
  model?: string;
  /**
   * #700 (P2 / G) — guardrail posture carried across restart / encore / migrate.
   * Read from durable {@link SessionMetadata.guardrailPolicy} by `deliverRestart`
   * and forwarded into the spawn so the restarted subprocess re-arms the SAME
   * posture (the no-silent-downgrade durability point). Absent ⇒ `autonomous`.
   */
  guardrailPolicy?: GuardrailPolicy;
}

/**
 * Reset outbox entry (D14) — enqueued by the `reset` tool so the dispatch loop
 * runs `deliverReset` on the target, which sets a `pendingReset` flag the Pi
 * extension polls + acts on (CLEAN-WIPE → Pi `newSession()`). POLL-delivery
 * (mirrors cue/pendingMessages), NOT a direct signal into the subprocess.
 * Operator-initiated → does NOT route through the MD-G tool gate.
 */
export interface ResetOutboxEntry extends OutboxEntryBase {
  type: 'reset';
  /** Player whose context is wiped. */
  targetPlayerId: string;
  /** Who requested the reset (owner or conductor). Recorded for audit. */
  invokerPlayerId?: string;
  /** Clean-wipe (D14 default `true` → `newSession`). `false` reserved for a softer reset. */
  fresh?: boolean;
  /** Optional human-readable reason, surfaced to the wiped session + audit. */
  reason?: string;
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
  | RestartOutboxEntry
  | ResetOutboxEntry;

/**
 * Pending reset flag set on a session workflow by `deliverReset`, polled by the
 * Pi extension via `pendingResetQuery` and cleared via `ackResetSignal(resetId)`
 * after the extension performs the wipe. Single-slot, latest-wins.
 */
export interface PendingReset {
  /** Correlation id (the originating outbox entry id). Ack clears only on match. */
  resetId: string;
  /** Clean-wipe (`newSession`) when true (D14 default). */
  fresh: boolean;
  /** Optional reason. */
  reason?: string;
  /** Who requested it (audit). */
  requestedBy?: string;
  /** ISO timestamp, stamped by the workflow (`workflow.now()`) — deterministic. */
  requestedAt: string;
}

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
  /** Attachment phase (post-#177 — replaced legacy `status` field). */
  phase?: AttachmentPhase;
  /**
   * #399 W1 (Q5.6 Flavor B) — monotonic message-activity counter from
   * the session's `getActivityState` query. Maestro diffs the value
   * across refreshes to compute per-player deltas for the tempo strip.
   * Optional so older sessions (or query failures) degrade silently to
   * zero contribution.
   */
  activityCount?: number;
  /**
   * #399 W1 (Q5.6 Flavor B) — ISO timestamp of the most recent
   * activity-counter bump on the session. Currently unused by the tempo
   * computation (count deltas are sufficient) but exposed for future
   * surfaces that want to show "last active 12s ago" per player.
   */
  lastActivityAt?: string;
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
  /**
   * #274 — `hostname → HostProfile` map maintained from daemon boot
   * signals. Carried through continue-as-new alongside the other ring
   * buffers. `Record` (not `Map`) so Temporal's default payload converter
   * serializes it cleanly across the CAN boundary.
   */
  hostProfiles?: Record<string, HostProfile>;
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
  /**
   * #357: Mirrors {@link Message.broadcastId} / {@link SentMessage.broadcastId}.
   * Same value on every fan-out target of a single `broadcast` invocation;
   * the TUI's `ConversationStream` collapses consecutive entries sharing
   * a non-null `broadcastId` into one row. `undefined` for non-broadcast cues.
   */
  broadcastId?: string;
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
  /**
   * #399 W1 (Q5.1) — ensemble description, restored across CAN.
   * Empty string when unset. Updated via `setEnsembleDescriptionSignal`.
   */
  description?: string;
  /**
   * #399 W1 (Q5.3a) — ISO timestamp of the maestro's *original* first
   * start. The first execution writes `workflowInfo().startTime`; every
   * subsequent CAN forwards the same value so dashboard uptime stays
   * monotonic across continue-as-new. Absent on the first execution.
   */
  startTimeIso?: string;
  /**
   * #399 W1 (Q5.6 Flavor B) — finished 30s activity buckets (oldest
   * first, max 60). Restored across CAN so the sparkline doesn't reset
   * on workflow boundary.
   */
  tempoHistoryBuckets?: number[];
  /**
   * #399 W1 (Q5.6 Flavor B) — current in-progress 30s bucket. Carried
   * across CAN so a continue-as-new boundary mid-bucket doesn't lose
   * accumulated activity.
   */
  tempoCurrentBucket?: { startMs: number; count: number };
  /**
   * #318 coat-check pattern — ticket-keyed stash for large content. Carried
   * across CAN only when the map is non-empty (mirrors the `playerState`
   * carry idiom in `src/workflows/session.ts:1617-1638`).
   */
  coatCheck?: Record<string, CoatCheckEntry>;
  /**
   * #700 P2 — maestro Q&A answer mailbox (the planner asks an inbox-less
   * question; a player answers via `respond`). Keyed by the CALLER-supplied
   * `questionId`. Mirrors the coat-check carry idiom — carried across CAN only
   * when the map is non-empty. TTL-swept (`MAESTRO_ANSWER_TTL_MS`).
   */
  answers?: Record<string, AnswerEntry>;
}

// ── Maestro Q&A answer mailbox (#700 P2) ───────────────────────────────────

/**
 * A single correlated answer parked on per-ensemble Maestro state. The planner
 * (command center) has no Temporal inbox, so a player routes its answer here
 * via the `respond` tool (a direct maestro-handle write, like coat-check); the
 * planner reads it back by `questionId`. `answeredAt` is `workflowNow()`-stamped
 * for replay determinism; expiry is derived (`answeredAt + MAESTRO_ANSWER_TTL_MS`),
 * so no separate `expiresAt` field is stored.
 */
export interface AnswerEntry {
  /** Caller-supplied correlation id (the planner mints it; the workflow never does). */
  questionId: string;
  /** Audit identity — the answering player (`getPlayerId()`); not a spoofable arg. */
  from: string;
  /** The answer body (≤ `MESSAGE_MAX`). */
  text: string;
  /** When the answer landed, `workflowNow().toISOString()`. */
  answeredAt: string;
}

// ── Coat-check (#318, ADR 0008) ────────────────────────────────────────────

/**
 * A single coat-check entry as stored on per-ensemble Maestro workflow
 * state. `content` is opaque to the system — author-supplied markdown,
 * JSON, or arbitrary text up to `COAT_CHECK_CONTENT_MAX`. All timestamps
 * are ISO 8601 from `workflowNow()` for replay determinism.
 *
 * The `lastFetched*` / `fetchCount` triple is the fetch-audit surface
 * vinceblank added on top of the architect's verdict — owners need to
 * know if a recipient consumed their ticket. Default semantics: undefined
 * `lastFetchedAt` + `fetchCount === 0` means "never fetched."
 */
export interface CoatCheckEntry {
  /** Short human-readable preamble (≤ `COAT_CHECK_SUMMARY_MAX`). */
  summary: string;
  /** Opaque body (≤ `COAT_CHECK_CONTENT_MAX` UTF-8 bytes). */
  content: string;
  /** Optional MIME-shaped hint (e.g. `'text/markdown'`); free-form. */
  contentType?: string;
  /** Audit identity — player who called `coat_check_put`. */
  putBy: string;
  /** When the entry was admitted, `workflowNow().toISOString()`. */
  putAt: string;
  /** When the entry expires under TTL inline-sweep, `workflowNow().toISOString()`. */
  expiresAt: string;
  /** UTF-8 byte length of `content` — pre-computed at put time for cheap listing. */
  size: number;
  /** Last successful `coat_check_get` timestamp, or undefined if never fetched. */
  lastFetchedAt?: string;
  /** Last `coat_check_get` caller's playerId, or undefined if never fetched. */
  lastFetchedBy?: string;
  /** Successful `coat_check_get` count. 0 until first fetch. */
  fetchCount: number;
}

/**
 * Listing projection — `coat_check_list` and the put/evict update return
 * shapes that omit `content` so callers can survey without pulling the
 * whole body for every entry. `size` is preserved so dashboards can
 * present an at-a-glance "how big" without an extra fetch.
 */
export interface CoatCheckEntryHeader {
  ticket: string;
  summary: string;
  contentType?: string;
  putBy: string;
  putAt: string;
  expiresAt: string;
  size: number;
  /** Mirrors `CoatCheckEntry.lastFetchedAt`. */
  lastFetchedAt?: string;
  /** Mirrors `CoatCheckEntry.lastFetchedBy`. */
  lastFetchedBy?: string;
  /** Mirrors `CoatCheckEntry.fetchCount`. */
  fetchCount: number;
}
