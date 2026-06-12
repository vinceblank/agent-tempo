# SSE Protocol Reference

This document is the authoritative reference for the **HTTP/SSE event source** exposed by the agent-tempo daemon (#94, #95). It mirrors the role of [`WIRE-PROTOCOL.md`](WIRE-PROTOCOL.md) for the Temporal layer: every endpoint, event name, and payload here is part of a stable contract between the daemon and any consumer (TUI, web dashboard, CLI follower, third-party integration).

## Stability guarantee

> **The endpoints, event types, and payload field names in this document are stable as of v0.28** (target — Phase 3 implementation). Renaming or removing any is a breaking change requiring a major version bump. Adding new event types, additive payload fields, or new endpoints is non-breaking.
>
> **Adding a new `## Section` to this file** also requires a matching entry in the drift detector at `test/sse/wire-protocol.test.ts` (Phase 3 PR-2 deliverable).
>
> Initial protocol version: `1`. The path prefix `/v1/` is the major version.

---

## 1. Transport

| Property | Value | Rationale |
|---|---|---|
| Wire format | HTTP/1.1 + Server-Sent Events | One-way push, native browser/EventSource support, trivial Node consumption. WebSocket rejected (bidi unnecessary; commands flow over MCP). Long-poll rejected (hides reconnect semantics). |
| Default bind | `127.0.0.1:8473` | Loopback only by default. Port: `t-e-m-p-o` mnemonic; not IANA-registered — operators MAY override. |
| Bind override | `AGENT_TEMPO_HTTP_BIND=0.0.0.0` | Forces token mode (see §3). Daemon refuses to start if token mode prerequisites unmet. |
| Port override | `AGENT_TEMPO_DAEMON_PORT` | |
| Port discovery | `~/.agent-tempo/daemon.port` | Atomic-write file containing the bound port. TUI reads this on startup so the port is config-free for local consumers. Removed on daemon shutdown. |
| Snapshot Content-Type | `application/json; charset=utf-8` | |
| Stream Content-Type | `text/event-stream; charset=utf-8` | |
| Encoding | UTF-8 | Required by SSE spec. |
| Keepalive | TCP keepalive on; SSE comment lines emitted as heartbeats per §6 | Browsers and intermediate proxies expire idle TCP. |

---

## 2. Endpoints

| Method | Path | Returns | Description |
|---|---|---|---|
| `GET` | `/v1/health` | `application/json` | `{ ok, namespace, version, uptimeMs, ensembleCount, subscriberCount }`. **Never authenticated** — used by reverse proxies, supervisord probes, the TUI bootstrap state machine. |
| `GET` | `/v1/ensembles` | `application/json` | `EnsembleSummary[]` — replaces existing `TempoClient.listEnsembles()` polling. |
| `GET` | `/v1/state/:ensemble` | `application/json` | Single-ensemble snapshot, including `lastEventId` (see §7.2). |
| `GET` | `/v1/hosts` | `application/json` | `HostInfo[]` — mirror of `TempoClient.listHosts()`. Cached 3 s server-side (matches existing TempoClient cache). |
| `GET` | `/v1/orphans[?ensemble=<name>]` | `application/json` | `OrphansV1` — cluster-wide cross-host orphans (#579). Cached 3 s server-side; keyed by ensemble filter. Same bearer + CORS gate as `/v1/hosts`. See § 4.5. |
| `GET` | `/v1/events/:ensemble` | `text/event-stream` | Per-ensemble SSE stream. Optional `?topics=phase,chat,flags,schedules,heartbeat` query filter. |
| `GET` | `/v1/events` | `text/event-stream` | **Global stream** — strictly limited to cluster-shape events (`ensemble.created`, `ensemble.destroyed`, `host_profile.changed`, `heartbeat`). Never per-ensemble events; subscribers wanting those open `/v1/events/:ensemble`. |
| `OPTIONS` | (any) | `204 No Content` | CORS preflight (see §3). |
| `POST` | `/v1/ensembles/:ensemble/{cue,pause,play,release,recruit,restart,reset,destroy,detach,recall}` | `application/json` | Safe-write endpoints (PR-7a of #340; per-player destructive verbs added by `feat/daemon-action-http-endpoints`; `reset` added by H5b/#645). See § 11b for full request/response shapes. |
| `POST` | `/v1/ensembles` | `application/json` | Create a fresh ensemble (issue #400) — recruits the conductor + lineup players. See § 11c. |
| `POST` | `/v1/ensembles/:ensemble/coat-check` | `application/json` | **#713.** Stash a content body on the per-ensemble coat-check (#318). Body `{ summary, content, contentType?, ttlMs? }` → `{ ok, ensemble, ticket, expiresAt, slotsUsed, slotsTotal }`. Lets the inbox-less command-center planner park a plan + hand off a ticket. **Does NOT raise the handoff ceiling** — the coat-check entry cap (32 KiB) is *below* the 100 KB cue cap; this keeps cues lean, it does not enable >100 KB plans. See § 11d. |
| `GET` | `/v1/ensembles/:ensemble/coat-check/:ticket` | `application/json` | **#713.** Redeem a coat-check ticket → `{ ok, ensemble, ticket, found, entry }` (`entry` includes `content`, or `null`/`found:false` when missing/expired/evicted). **Mutates fetch-audit counters** (`fetchCount` / `lastFetched*`) — it is NOT a pure read, so it is gated at **T2**, not the usual T1 read tier. See § 11d. |
| `GET` | `/v1/agent-types` | `application/json` | Available player-type catalog (project + user + shipped, three-tier dedup). See § 11c. |
| `GET` | `/v1/lineups` | `application/json` | Available lineup catalog (saved + shipped). See § 11c. |
| `GET` | `/v1/debug/action-counters` | `application/json` | **#753.** Per-source Temporal action counters for the **daemon process** (`{ sinceIso, windowMs, total, bySource }`; sources: maestro/aggregate/outbox/schedule/reconcile/other × kinds: query/signal/update/start/describe/terminate/cancel/list). In-memory diagnostic for the cost-rearchitecture metering (epic #747) — zero Temporal calls; resets on daemon restart; T1 read tier. Adapter/Pi processes self-report via their periodic `[agent-tempo:action-counters]` log line instead. |

**Reads via GET, writes via POST under the same auth model.** The
read-side endpoints stay cacheable, durable, and replay-safe; the
write-side endpoints (PR-7a) are explicitly non-cached, bearer-gated on
non-loopback binds, and translate to the daemon's existing TempoClient
calls (which carry their own Temporal-backed durability).

**Auth tiers (3e MD-E):** loopback bind → no auth required (all tiers pass). Non-loopback bearer mode:

| Route group | Required tier | Token |
|---|---|---|
| `GET /v1/health` | None — always open | — |
| All other `GET` reads | **T1** (read or admin) | `AGENT_TEMPO_HTTP_READ_TOKEN` or admin |
| `POST` write surface | **T2** (admin required) | `AGENT_TEMPO_HTTP_ADMIN_TOKEN` |
| `POST` / `GET` coat-check (#713) | **T2** (admin required) | `AGENT_TEMPO_HTTP_ADMIN_TOKEN` — note the GET redeem is T2 (it mutates fetch-audit counters), not the usual T1 read tier |
| `GET /v1/players/:e/:p/inner` SSE | **T3** (admin required) | `AGENT_TEMPO_HTTP_ADMIN_TOKEN` |
| `POST /inner/ingest`, `GET /inner/presence` | Source plane (loopback + `X-Ingest-Token`) | Daemon-minted per-player `AGENT_TEMPO_INGEST_TOKEN` |
| `GET /doorbell/:ensemble/:playerId` | Source plane (loopback + `X-Ingest-Token`) | Same token as above — T1.1 cue-doorbell hint route; see `docs/INNER-LOOP-PROTOCOL.md` §Doorbell |

T2 and T3 both require the admin token — there is no T2-only token. The admin token grants all tiers (3 ⊇ 2 ⊇ 1). See §3.1 for the full two-token model.

**Deliberately out of scope** (keep on TempoClient → Temporal direct):

- `/v1/players/:ensemble/:playerId` — per-player drill-ins are user-invoked, not background streams
- `/v1/messages/:ensemble/:playerId` — covered by `recall`
- `/v1/recall` — covered by existing tool surface
- Standalone `/v1/schedules/:ensemble` — included inside `/v1/state/:ensemble` already

---

## 3. Authentication

| Mode | Trigger | Behavior |
|---|---|---|
| **Loopback (no auth)** | `Origin` is loopback (`127.0.0.1`, `::1`, `localhost`) AND bind addr is loopback | Auth check skipped. Default for single-user dev workflows. |
| **Bearer mode** | Any non-loopback `Origin` OR `AGENT_TEMPO_HTTP_BIND=0.0.0.0` | `Authorization: Bearer <token>` required on every endpoint except `/v1/health`. Mismatch → `401`. Missing → `401`. |

### 3.1 Two-token model (3e MD-E)

Two separate tokens, each scoped to a specific access tier:

| Token | Env var | Config field | Tier granted | Auto-gen? |
|---|---|---|---|---|
| **Read token** | `AGENT_TEMPO_HTTP_READ_TOKEN` | `readToken` in `~/.agent-tempo/config.json` | T1 (observe) | Yes — auto-generated on first non-loopback boot if unset |
| **Admin token** | `AGENT_TEMPO_HTTP_ADMIN_TOKEN` | **none — env-var-only, never persisted to disk** | T1 + T2 + T3 (full) | No — never auto-generated |

**Resolution order for the read token:** env `AGENT_TEMPO_HTTP_READ_TOKEN` → `config.json#readToken` → legacy `config.json#httpToken` (adopted as T1; daemon emits a one-time startup notice to set an admin token) → auto-generate and persist.

**The admin token is ENV-VAR-ONLY.** It is never written to `config.json` and never auto-generated. An operator who needs write/inner access must set `AGENT_TEMPO_HTTP_ADMIN_TOKEN` explicitly in the environment (e.g. container env, Tailscale ACL, systemd override).

**Token rotation:**
- Read token: delete `readToken` from `config.json` (and unset the env var); next daemon boot regenerates.
- Admin token: update the env var and restart.

> **Bearer mode requires the fetch transport.** Native browser `EventSource`
> cannot set custom request headers on the initial connect, so any
> consumer that supplies a token (or whose request `Origin` triggers
> bearer mode) must use the `TempoClient.subscribe` fetch path. The
> wrapper picks transports automatically — see Appendix A and ADR 0010.

#### Legacy `httpToken` migration

If `config.json` contains `httpToken` but no `readToken`, the daemon adopts it as the read token (T1) and emits a startup notice recommending the operator set `AGENT_TEMPO_HTTP_ADMIN_TOKEN`. No data migration is required — the existing token continues to work for read access. To gain write/inner access, set the admin env var separately.

### 3.2 CORS (only enforced when bearer mode is active)

| Property | Default | Override |
|---|---|---|
| Allowlist | `localhost:*`, `127.0.0.1:*` echoed in `Access-Control-Allow-Origin` | `AGENT_TEMPO_CORS_ORIGINS` (comma-separated explicit origins, no wildcards) |
| `Access-Control-Allow-Credentials` | `false` | non-configurable (bearer in header makes cookies unnecessary; `*` Origin is incompatible with credentials) |
| `Access-Control-Allow-Methods` | `GET, OPTIONS` | non-configurable |
| `Access-Control-Allow-Headers` | `Authorization, Last-Event-ID` | non-configurable |
| Preflight cache | `Access-Control-Max-Age: 600` | non-configurable |

---

## 4. Snapshot payload shapes

### 4.1 `/v1/health`

```ts
interface HealthV1 {
  ok: true;
  namespace: string;
  version: string;          // daemon package version
  uptimeMs: number;
  ensembleCount: number;
  subscriberCount: number;  // open SSE connections
}
```

### 4.2 `/v1/ensembles`

`EnsembleSummary[]` — see `src/client/interface.ts`. Field shapes are stable.

### 4.3 `/v1/state/:ensemble`

```ts
interface EnsembleStateV1 {
  v: 1;
  ensemble: string;
  capturedAt: string;        // ISO timestamp
  /**
   * Opaque event-id token of the form `"<bootEpoch>:<seq>"` (see §5). Pass
   * verbatim as `Last-Event-ID` to `/v1/events/:ensemble` to bridge from
   * snapshot to live tail without a gap.
   *
   * **Atomicity contract**: the snapshot reflects state as of this id.
   * Every event with a `(bootEpoch, seq)` lexicographically greater than
   * `lastEventId` is NOT yet reflected in the snapshot's `players`,
   * `chat`, `schedules`, `flags`, or `hostProfiles` fields. The `/v1/events`
   * stream resumes at `seq + 1` (same epoch).
   *
   * **PR-1 sentinel**: when the snapshot endpoints ship without a live
   * event source (Phase 3 PR-1, snapshot-only), the daemon returns
   * `lastEventId: "0:0"`. PR-2 subscribers passing this back will see an
   * epoch mismatch against the live aggregate and fall through to the
   * `event: gap` branch — correct behavior.
   */
  lastEventId: string;
  state: 'online' | 'paused' | 'offline';
  hasConductor: boolean;
  flags: { paused: boolean; held: boolean };
  players: PlayerSummaryV1[];
  schedules: ScheduleEntry[];   // shape from WIRE-PROTOCOL §Type Reference
  chat: { messages: EnsembleChatMessage[]; total: number; hasMore: boolean };
  hostProfiles: Record<string, HostProfile>;
  // Issue #399 W1 wire extensions — projected from the per-ensemble
  // maestro hub. Sentinel defaults (`''`, `0`, `[]`) when the maestro
  // workflow soft-fails any individual query — the snapshot endpoint
  // never 500s on a transient query glitch.
  description: string;          // from getEnsembleDescriptionQuery; '' when unset
  startedAt: string;            // ISO from getEnsembleStartTimeQuery; '' when hub absent
  currentBpm: number;           // from getCurrentBpmQuery; 0 baseline
  tempoSeries: number[];        // 60-element ring from getTempoSeriesQuery
}

interface PlayerSummaryV1 {
  playerId: string;
  ensemble: string;
  hostname: string;
  isConductor: boolean;
  agentType: 'claude' | 'copilot' | 'mock' | 'claude-api' | 'opencode' | 'claude-code-headless';  // #535 — mirrors AgentType in src/types.ts
  playerType?: string;
  phase?: AttachmentPhase;     // from WIRE-PROTOCOL §Type Reference
  part: string;
  workDir: string;
  gitBranch?: string;
  lastHeartbeatAt?: string;    // ISO; absent on detached/gone
  processingSince?: string;    // ISO; present only when phase === 'processing'
  // Issue #399 W2 wire extensions — projected from per-session queries
  // during snapshot fan-out. Optional everywhere; absent fields render
  // as `—` placeholders client-side.
  runId?: string;              // Q5.2 — from getRunIdQuery
  messaging?: {                // Q5.5 — from getMessagingStateQuery
    received: number;
    sent: number;
    outbox: string;            // 'empty' / 'N pending' / 'N pending (oldest 2m)'
  };
  lease?: {                    // Q5.7 — from getLeaseStateQuery
    expiresAt: number | null;
    leaseMs: number | null;
  };
  // Issue #399 Q5.6 — pass-through from MaestroPlayerInfo (no extra
  // round-trip; the maestro hub already populates these fields).
  activityCount?: number;
  lastActivityAt?: string;     // ISO
}
```

### 4.4 `/v1/hosts`

`HostInfo[]` — shape from `src/utils/hosts.ts`.

### 4.5 `/v1/orphans[?ensemble=<name>]` (#579)

Cluster-wide cross-host orphan listing. Returns `OrphansV1` (defined in `src/http/event-types.ts`):

```ts
interface OrphansV1 {
  v: 1;
  capturedAt: string;
  orphans: OrphanV1[];
}
interface OrphanV1 {
  playerId: string;
  ensemble: string;
  workflowId: string;
  preferredHost: string | null;
  hostLiveness: 'live' | 'stale' | 'missing';
  phase: AttachmentPhase;
  detachedSince: string | null;
  lastHeartbeatAt: string | null;
  /** Render-ready TUI slash command the operator pastes to recover. */
  migrateCommand: string;
}
```

- **Auth**: identical bearer + CORS gates to `/v1/hosts`. Loopback bind without `--http-token`: allowed unauthenticated; non-loopback or with a token: bearer required.
- **Filter**: optional `?ensemble=<name>` narrows to a single ensemble. Omitted → all ensembles.
- **Cache**: 3 s server-side cache keyed by `ensembleFilter ?? '__all__'` (mirrors `/v1/hosts`). The filter and unfiltered call have independent cache entries.
- **`hostLiveness`** is joined server-side against `listHosts()` so consumers don't have to re-issue a hosts query per row. `'live'` / `'stale'` mirror `HostInfo.freshness`; `'missing'` covers both null `preferredHost` AND absent-from-hosts cases.
- **`migrateCommand`** is a TUI slash-command string the operator pastes into any local session. Always positional `<player> <host>`; falls back to `--force --yes-steal=<lastKnownHost>` (with `(unknown)` placeholder if even that is missing) when `preferredHost` is null. Wording matches `src/tui/commands.ts:handleMigrate` — flag form is `--yes-steal=` NOT `--confirm-steal-from-host`.
- **Partial-tolerance**: a per-candidate `attachmentInfo` / `orphanSummary` query failure does NOT fail the request — the row is dropped silently and the remainder of the listing is returned with HTTP 200. Mirrors `queryOrphanedSessions`'s existing skip-and-log contract.
- **View-only in v1**: no click-to-adopt / click-to-destroy on the response. Recovery is operator-side via `migrateCommand`.

---

## 5. SSE framing

```
id: <eventId>
event: <eventType>
data: <json payload>

```

- **`eventId` format: `"<bootEpoch>:<seq>"`.** A two-part opaque token. `bootEpoch` is the daemon process's boot time as Unix epoch milliseconds (frozen for the process lifetime). `seq` is a uint64 monotonic counter starting at `0` and incrementing once per event emitted to the buffer. Both parts are decimal ASCII; the colon separator is invariant.
- **Comparison rule**: server compares the client-supplied `Last-Event-ID` to the live `(bootEpoch, seq)` pair as a lexicographic-on-numbers tuple — `clientEpoch` first, then `clientSeq`. If `clientEpoch !== serverEpoch` the client is from a previous daemon process; the server emits `event: gap` (consumer re-fetches `/v1/state/:ensemble`). If epochs match, the standard `seq >= ringStart` check selects replay vs gap (§7.2). This is the daemon-restart correctness guard — without the epoch prefix, a post-restart `seq=0` ring would treat any prior client's `Last-Event-ID` as a non-gap and silently lose the snapshot bridge.
- `eventType` is the canonical name from §6.
- `data` is a single line of JSON. Payloads MAY exceed typical SSE samples — consumers MUST NOT cap line length.

---

## 6. Event types

All event payloads carry `v: 1`. Field types reference WIRE-PROTOCOL.md §Type Reference (`AttachmentPhase`, `EnsembleChatMessage`, `HostProfile`, `ScheduleEntry`).

| Event | Scope | Payload | Coalescing rule |
|---|---|---|---|
| `snapshot` | per-ensemble | `EnsembleStateV1` | One-shot — emitted on fresh connect (no `Last-Event-ID`) before any diff event |
| `gap` | both | `{ from: string; to: string; reason: 'epoch-mismatch' \| 'overflow' }` | One-shot — emitted when client's `Last-Event-ID` epoch doesn't match server's bootEpoch (`epoch-mismatch`) OR client's `seq` predates the ring's oldest live `seq` (`overflow`). Client MUST re-fetch `/v1/state/:ensemble` and reconnect with the snapshot's `lastEventId`. |
| `throttled` | both | `{ droppedSince: string; count: number }` | One-shot when ensemble-wide 50 ev/s ceiling trips (§8) |
| `heartbeat` | both | `{ at: string }` | Every 10 000 ms; **suppressed if any other event has been emitted on the same connection within the last 8 000 ms** |
| `ensemble.created` | global only | `{ ensemble: string; createdAt: string; hasConductor: boolean }` | Always emit |
| `ensemble.destroyed` | global only | `{ ensemble: string; destroyedAt: string }` | Always emit |
| `player.added` | per-ensemble | `PlayerSummaryV1` | Always emit |
| `player.removed` | per-ensemble | `{ playerId: string; ensemble: string; removedAt: string; reason: 'destroyed' \| 'gone' }` | Always emit |
| `player.phase_changed` | per-ensemble | `{ playerId: string; ensemble: string; phase: AttachmentPhase; lastHeartbeatAt?: string; processingSince?: string; at: string }` | **Debounce 250 ms per `playerId`, latest-wins.** Swallows `attached → processing → awaiting → attached` flicker. |
| `chat.appended` | per-ensemble | `EnsembleChatMessage` | Per-message, no batching. **Hard cap 100 msg/sec/ensemble** — excess collapses into a single `chat.compressed` event. |
| `chat.compressed` | per-ensemble | `{ dropped: number; since: string }` | Emitted when chat hits the per-ensemble rate cap |
| `flags.changed` | per-ensemble | `{ ensemble: string; paused: boolean; held: boolean; at: string }` | Diff-only — suppress if both bools equal previous emitted state |
| `schedules.changed` | per-ensemble | `{ ensemble: string; schedules: ScheduleEntry[]; at: string }` | Hash-diff — suppress if SHA-256 of sorted-by-name JSON unchanged |
| `host_profile.changed` | global only | `HostProfile` | Diff-only — hash compare against last emitted (uses scrubbed profile per `scrubHostProfile`) |
| `player.activity` | per-ensemble | `{ playerId: string; ensemble: string; currentTool: string \| null; contextTokens?: number; contextPercent?: number; at: string }` | **3c Tier-1 coarse.** Diff-only — emitted by the aggregate poll when `currentTool` or context usage changes. `currentTool: null` = idle/between tools. `contextTokens`/`contextPercent` are absent until Pi's `getContextUsage()` first returns a value. Sourced from the heartbeat piggyback (~30 s freshness). For live fine-grained observability (thinking deltas, tool I/O, per-turn events) see the off-wire [`/inner` side-channel](INNER-LOOP-PROTOCOL.md). |
| `answer` | per-ensemble | `{ questionId: string; from: string; ts: string }` | **#700 P2.** A parked Q&A answer resolved. Emitted by the aggregate's outstanding-ask poll when `maestroGetAnswer(questionId)` first returns non-null, then the ask is dropped from the tracker. Wakes the inbox-less command-center planner (the planner-side mirror of how a cue wakes a player). Payload is small — `text` is fetched on read via `GET /v1/ensembles/:e/answer/:questionId`. |

**Adding new event types is non-breaking.** Consumers MUST gracefully ignore unknown `event:` lines.

### 6.1 `TempoClient.subscribe` API surface

The PR-3 client wrapper exposes the SSE stream as an `AsyncIterable<TempoEvent>`. The discriminated union and options shape are part of the wire contract — every event in §6's table maps to exactly one variant. The Phase 3 implementer MUST place these types in `src/http/event-types.ts` so PR-2 (server) and PR-3 (client) import the same definitions. The drift detector at `test/sse/wire-protocol.test.ts` cross-checks this file against §6.

```ts
// src/http/event-types.ts (Phase 3 PR-2 deliverable; PR-3 imports)

type AttachmentPhase =          // re-export from src/types.ts
  | 'booting' | 'attached' | 'processing'
  | 'awaiting' | 'draining' | 'detached' | 'gone';

interface BaseEvent { v: 1; eventId: string; }

export type TempoEvent =
  | (BaseEvent & { type: 'snapshot';            payload: EnsembleStateV1 })
  | (BaseEvent & { type: 'gap';                 payload: { from: string; to: string; reason: 'epoch-mismatch' | 'overflow' } })
  | (BaseEvent & { type: 'throttled';           payload: { droppedSince: string; count: number } })
  | (BaseEvent & { type: 'heartbeat';           payload: { at: string } })
  | (BaseEvent & { type: 'ensemble.created';    payload: { ensemble: string; createdAt: string; hasConductor: boolean } })
  | (BaseEvent & { type: 'ensemble.destroyed'; payload: { ensemble: string; destroyedAt: string } })
  | (BaseEvent & { type: 'player.added';        payload: PlayerSummaryV1 })
  | (BaseEvent & { type: 'player.removed';      payload: { playerId: string; ensemble: string; removedAt: string; reason: 'destroyed' | 'gone' } })
  | (BaseEvent & { type: 'player.phase_changed'; payload: { playerId: string; ensemble: string; phase: AttachmentPhase; lastHeartbeatAt?: string; processingSince?: string; at: string } })
  | (BaseEvent & { type: 'chat.appended';       payload: EnsembleChatMessage })
  | (BaseEvent & { type: 'chat.compressed';     payload: { dropped: number; since: string } })
  | (BaseEvent & { type: 'flags.changed';       payload: { ensemble: string; paused: boolean; held: boolean; at: string } })
  | (BaseEvent & { type: 'schedules.changed';   payload: { ensemble: string; schedules: ScheduleEntry[]; at: string } })
  | (BaseEvent & { type: 'host_profile.changed'; payload: HostProfile })
  | (BaseEvent & { type: 'player.activity';     payload: { playerId: string; ensemble: string; currentTool: string | null; contextTokens?: number; contextPercent?: number; at: string } })
  | (BaseEvent & { type: 'answer';              payload: { questionId: string; from: string; ts: string } });

export interface SubscribeOptions {
  /** Aborts the iterator and tears down the underlying transport. See §7.4. */
  signal?: AbortSignal;
  /** Server-side topic filter — server drops other event kinds before they hit the wire. */
  topics?: ('phase' | 'chat' | 'flags' | 'schedules' | 'heartbeat')[];
  // NOTE: caller-controllable cursor resume (`lastEventId`) was deliberately
  // dropped — see ADR 0010. Snapshot-then-stream covers every realistic
  // case; in-session reconnect uses Last-Event-ID under the hood.
}
```

The TempoClient method signature:

```ts
// src/client/subscribe.ts (Phase 3 PR-3 deliverable)
subscribe(ensemble: string, opts?: SubscribeOptions): AsyncIterable<TempoEvent>;
subscribe(opts?: SubscribeOptions): AsyncIterable<TempoEvent>;   // global stream
```

`SE_EVENT_KINDS` const array — the Phase 3 PR-2 deliverable also exports a `const SSE_EVENT_KINDS = [...] as const` whose entries are exactly the `type` literals above. The drift detector reads this array to assert §6's table is in sync with the TS module.

---

## 7. Reconnect and replay

### 7.1 Ring buffer

| Parameter | Value | Notes |
|---|---|---|
| Per-ensemble buffer size | **256 events** | Power of two. With §6 coalescing rules, ≥5 min of history at p99 traffic. <128 KiB worst case (each event <500 B typical). |
| Global buffer size | 256 events | Same — global stream is sparse |
| Eviction policy | FIFO (oldest dropped) | non-configurable |
| Persistence | In-memory only | Daemon restart drops the buffer; reconnecting consumers receive a `gap` event. Acceptable — Temporal is the durable store; the daemon is a cache. |
| Heartbeats in buffer | **NO** | Heartbeats are connection-local and never replayed |

### 7.2 Connection flow

```
        ┌─── client connects with Last-Event-ID? ───┐
        │                                           │
       YES                                         NO
        │                                           │
        ▼                                           ▼
 clientEpoch === serverEpoch?              emit `snapshot`
        │                                           │
   ┌────┴────┐                                      ▼
  YES        NO                            resume live tail
   │          │
   ▼          ▼
seq >= ringStart?            emit `gap` (reason: epoch-mismatch)
   │                         client re-fetches /v1/state/:ensemble
   ┌────┴────┐                then reconnects with snapshot's lastEventId
  YES        NO
   │          │
   ▼          ▼
replay      emit `gap` (reason: overflow)
[seq+1…now] client re-fetches
then live   /v1/state/:ensemble
            then reconnects
```

`/v1/state/:ensemble` returns `lastEventId` so a client can subscribe with `Last-Event-ID: <that>` immediately after — bridging the snapshot/stream gap atomically.

### 7.3 Per-connection backpressure

- Each connection has a 1 MiB write buffer.
- If a TCP write would block AND buffer is full, the daemon drops the connection. The consumer auto-reconnects, and the client's recorded `Last-Event-ID` either lands in the ring (replay) or triggers `gap`.
- Per-process connection cap: `AGENT_TEMPO_SSE_MAX_CONNECTIONS` (default `100`). Above the cap → `503 Service Unavailable` with `Retry-After: 5`.

### 7.4 Cancellation contract (consumer side)

The PR-3 wrapper MUST honor consumer cancellation through both standard JavaScript paths:

- **`AbortSignal`** — `subscribe(ensemble, { signal })`. When `signal.aborted` flips to `true`, the wrapper closes the underlying transport (calls `EventSource.close()` or aborts the `fetch().body` reader), drains the iterator with `return undefined`, and rejects any pending `.next()` promise with `signal.reason ?? new DOMException('aborted', 'AbortError')`.
- **`for-await … break`** — when the consumer breaks out of the loop, the JavaScript runtime invokes the iterator's `return()` method. The wrapper MUST forward this to an internal `AbortController.abort('iterator.return')` so the transport tears down promptly. Without this, an idle SSE stream would leak the underlying socket.

**Server side**: when the SSE connection closes (either via FIN or via `socket.destroy()` on the abort path), the daemon's per-connection emitter is removed from its `EnsembleEventBus` subscriber set within one event-loop tick. No queued writes remain after cleanup. The connection cap (§7.3) reflects only live subscribers.

### 7.5 Transport reconnect parity (`EventSource` vs `fetch`)

The PR-3 wrapper picks one of two transports per `subscribe(...)` invocation. Selection is hidden from the consumer — the AsyncIterable contract is identical either way.

**Native `EventSource`** is preferred when both:
- it's available in the runtime (browser; Node 22+ optionally), AND
- no bearer token is set (loopback dev — bearer requires custom headers, see §3.1).

Native `EventSource` automatically reconnects on TCP drop and replays the last received `id:` line as `Last-Event-ID` on the new connection. **In-session reconnect is browser-managed.** The wrapper just opens it, listens, and closes on consumer abort.

**`fetch().body`** is used otherwise (Node 20, or any path that needs `Authorization: Bearer …`). Manual reconnect logic in the wrapper:

- Tracks the most recently parsed `id:` line in memory.
- On transport disconnect (TCP error, `fetch` body iterator end before `signal.aborted`), opens a fresh request with `Last-Event-ID: <last-tracked-id>` and resumes the AsyncIterable yield without surfacing the reconnect to the consumer.
- Reconnect backoff: `100 ms × 2^attempt`, capped at 30 s, reset on a successful connection that yields ≥ 1 event.
- If `Last-Event-ID` triggers `event: gap` on the new connection, the wrapper yields that `gap` event to the consumer (do not swallow — the consumer needs to re-fetch state).

**Caller-controllable cursor for cross-session resume is intentionally NOT supported** — see [ADR 0010](adr/0010-drop-caller-controllable-event-cursor.md). `Last-Event-ID` is a wrapper-internal mechanism for in-session reconnect only. Consumers that want post-restart resume re-fetch `/v1/state/:ensemble` and resubscribe — the same path they'd take after `event: gap`.

The result: a `for-await` loop over `subscribe(...)` is transport-agnostic. The consumer can't tell whether the underlying socket dropped 12 times during the loop's lifetime, or which transport is in use.

### 7.6 `chat.compressed` consumer recovery

`chat.compressed` is a **soft gap** scoped to chat alone — the rest of the stream remains valid and the consumer does NOT need to re-subscribe. Recovery procedure:

1. Consumer SHOULD fetch `/v1/state/:ensemble` to repopulate the chat slice from the authoritative snapshot. The snapshot's `chat.messages` reflects the maestro aggregate and includes any messages that were dropped from the SSE stream.
2. The consumer MAY render an inline indicator (e.g. "N messages compressed; refreshing…") while the re-fetch is in flight.
3. Other event streams (`player.*`, `flags.*`, `schedules.*`) continue uninterrupted — do not tear down the SSE connection.

Contrast with `event: gap`, which is a **hard gap** spanning all event kinds and requires a full snapshot re-fetch + `Last-Event-ID` reset.

---

## 8. Rate-cap and coalescing summary

| Source signal | Cadence | Rule |
|---|---|---|
| Daemon aggregate poll | every **750 ms** (local profile) | Single internal loop; mirrors today's TUI fan-out once per tick. Under `costProfile: 'local'` subscriber count has zero impact on Temporal RPC volume. **T0.4/#751 demand gate**: under `costProfile: 'cloud'`, zero live SSE subscribers stretches the cadence to a 30 s slow reconcile; the first subscriber's connect wakes the loop (immediate tick + 750 ms resumes). Consumers already tolerate this by design (`Last-Event-ID` replay + snapshot-on-connect); worst case a freshly opened board reads ≤1 reconcile-interval stale for one tick. |
| **Aggregate poll backpressure** | serial-with-skip | If a tick's Temporal queries don't complete before the next 750 ms boundary, the next tick is **skipped** and the daemon emits a structured warn-log (`[agent-tempo:aggregate] tick skipped — prior tick still in flight (Xms)`). The daemon NEVER has more than one in-flight aggregate fetch. Overlapping ticks would risk unbounded RPC volume during Temporal slowness; serial-with-skip is the conservative ceiling. Persistent skips (e.g. ≥5 in 60 s) are an operator alert signal — surface in `/v1/health` as a future field if metrics warrant. |
| **Per-ensemble fan-out carry-forward (#550)** | bounded by `MAX_CONSECUTIVE_FAILURES = 20` | When per-ensemble fan-out (`buildEnsembleSnapshot` per ensemble) fails transiently — timeout, query error, network blip — the ensemble is **carried forward** in the cluster-diff input rather than emitting `ensemble.destroyed`. Only `EnsembleNotFoundError` from the existence gate counts as genuine destruction. The cluster diff's `liveEnsembleNames` = (`'ok'` ∪ `'failed'`) outcomes; `'gone'` is the only kind that triggers `ensemble.destroyed`. After 20 consecutive `'failed'` outcomes (~15 s at 750 ms cadence — matches the tick watchdog ceiling), the ensemble is promoted to `'gone'` and a single `ensemble.destroyed` event fires. Carry-forward means per-track diff state (`playerPhases`, `flags`, `schedulesHash`, `chatIds`) is NOT updated for `'failed'` ticks — the next successful tick observes the truthful prior state and emits player-level events with one-tick delay. Prevents the pre-#550 phantom-destroy bug where a transient per-ensemble timeout silently triggered `ensemble.destroyed` to every connected dashboard subscriber. |
| `ClaudeTempoAttachmentState` change | ≤ once / 250 ms / playerId | Latest-wins debounce |
| `maestroEnsembleChat` append | per-message | Hard cap 100/sec/ensemble; excess → one `chat.compressed` |
| `getSchedules` diff | per-diff | SHA-256 suppress |
| `maestroPaused` flip | per-flip | Diff-only |
| `outboxLocked` flip | per-flip | Folded into `flags.changed` (diff-only) |
| `hostProfiles` diff | per-diff | Hash compare, scrubbed |
| Heartbeat | every 10 s | Suppress if any other event in last 8 s |
| **Ensemble-wide ceiling** | **50 events/sec/ensemble** | Above ceiling → emit `throttled` once and pause non-essential streams (`heartbeat`, `flags.changed`) for 1 s. `chat.appended` keeps flowing through its own 100/sec cap. |

---

## 9. Error responses

| Code | Body | When |
|---|---|---|
| `401` | `{ error: 'unauthorized' }` | Missing or invalid bearer when bearer mode is active. **L2 floor — checked before tier enforcement.** An unauthenticated request to any tier-gated route (T1 read, T2 write, T3 supervisory) gets `401`, not `403`. `401` bodies carry no `detail` — unauthenticated callers don't learn config state. |
| `403` | `{ error: 'insufficient-tier', detail: string }` | **Surface-wide** — emitted by the shared `denyTier` helper for any tier-gated route (T1 reads, T2 writes, T3 inner-tail) when the presented bearer's granted tier is below the route's requirement. The `detail` field carries an actionable migration hint on every denial, e.g. `"This token is read-tier. Writes and the inner-tail require the admin token (set AGENT_TEMPO_HTTP_ADMIN_TOKEN)."` |
| `404` | `{ error: 'ensemble-not-found', ensemble }` | `/v1/state/:ensemble` or `/v1/events/:ensemble` for unknown ensemble |
| `503` | `{ error: 'admin-token-not-configured', detail: string }` | **Misconfiguration / safety-net** — a T≥2 route was reached but `AGENT_TEMPO_HTTP_ADMIN_TOKEN` is not set. Not reachable in a correctly configured deployment (no token resolves T≥2 when admin is absent). Emitted by `denyTier` alongside `403` via the same surface-wide helper. Detail: `"Set AGENT_TEMPO_HTTP_ADMIN_TOKEN (env-var only) to enable writes / inner-tail."` |
| `503` | `{ error: 'connection-cap-exceeded' }` | Per-process SSE cap hit; `Retry-After: 5` |

CORS rejection sends a normal CORS-failure response (browser handles it). `/v1/health` is never authenticated and never returns `401`/`403`/`503`.

---

## 10. Versioning

- Path prefix `/v1/` is the major version.
- Additive payload fields, new event types, and new endpoints ship within `/v1/` and are non-breaking.
- Renames, removals, semantic changes → `/v2/` with deprecation overlap.
- The `v` field on event payloads exists so a future `/v1/` event MAY have a richer schema variant; consumers select handling by `(eventType, v)` pair.
- **The `eventId` `(bootEpoch, seq)` tuple is part of the wire contract, not an implementation detail.** Both halves are observable to consumers via `Last-Event-ID`, the `gap` event's `from`/`to` fields, and the `lastEventId` snapshot field. Changing the format (e.g. swapping the colon separator, dropping the epoch, repurposing `bootEpoch` to mean something other than daemon process boot time) is a `/v2/` break — not an internal refactor.

---

## 11. State source

The daemon maintains an **in-memory aggregate** fed by a single internal poll loop at 750 ms cadence. Each tick fans out the same Temporal queries the TUI runs today (one `workflow.list` + per-ensemble `maestroPlayersByEnsemble` + `maestroEnsembleChat` + `getSchedules`), diffs against the previous snapshot, and emits events.

**Why an aggregate, not direct Temporal-history streaming**

The Temporal SDK has no broad "subscribe to namespace events" API. Visibility-query polling is the realistic path. The aggregate is the abstraction that hides this from clients.

**Subscriber count has zero impact on Temporal RPC volume** (local profile). Five TUIs and one web dashboard all read from one snapshot-per-tick. Under `costProfile: 'cloud'` the T0.4/#751 demand gate makes ZERO subscribers stretch the poll to a slow reconcile — N≥1 subscribers still share one snapshot-per-tick.

**Phase 3 deferred optimization** — replace the internal poll with worker-side activity hooks pushing events to the daemon over a Temporal signal, OR `client.workflow.handle().describe()` polled at much lower frequency when a subscriber is attached. **Don't design for it now** — pick the bottleneck after metrics. The aggregate abstraction lets that swap happen without API change.

### Per-player drill-in views (deliberately Temporal-direct)

The endpoints `/v1/players/:ensemble/:playerId` and `/v1/messages/:ensemble/:playerId` are intentionally **out of scope** for v1 (see §2). PR-4's player-detail view continues to call `TempoClient.getPlayerMetadata` and `TempoClient.getPlayerMessages` directly against Temporal (today's path at `src/tui/App.tsx:853–863`). This is **by design**:

- Per-player drill-ins are user-invoked (one player open at a time), not background streams. SSE's value — many subscribers, one source — doesn't apply to a 1:1 view.
- Surfacing them through SSE would inflate the aggregate (per-player message history × every ensemble × every connected client) without solving any current problem.
- Future readers should NOT treat the App.tsx direct-Temporal calls as "incomplete migration" — they're the right shape for this access pattern.

If a future use case demands per-player streams (e.g. real-time co-pilot pairing UX), revisit by adding `/v1/events/:ensemble/:playerId` as an additive endpoint — non-breaking, doesn't disturb the rest of the surface.

---

## 11a. Fixture mode (PR-3 of #340)

Two endpoints — `/v1/state/:ensemble` and `/v1/events/:ensemble` — accept an optional `?fixture=<name>` query param. When set to a known fixture name, the daemon returns canned data instead of running live Temporal queries / wiring the aggregate poll loop.

**Why it exists**: dashboard UI work (PR-4 onwards) needs deterministic, reproducible scenarios — a conductor leaving, a broadcast fan-out, a chat-ring overflow, an SSE reconnect. Real ensemble events are flaky for UI-driven testing; fixtures aren't.

**Fixtures shipped in PR-3** (registered in `src/http/fixtures/index.ts`):

| Name | Description |
|---|---|
| `empty-ensemble` | No players, no chat, no schedules. Empty-state UI exercise. |
| `single-conductor` | One conductor, no other players. Lobby state. |
| `eight-player-broadcast` | Conductor + 8 receivers; 8 `chat.appended` share one `broadcastId` (#357 collapse). |
| `conductor-leaving` | Conductor + 1 soloist; conductor `phase_changed → detached → removed` (#358 analog). |
| `sse-reconnect` | Two chat events, then a `gap` event (overflow), then more chat. Tests the dashboard reconnect / re-fetch path. |
| `chat-stress` | 100 `chat.appended` in rapid succession + a `chat.compressed` event. Tests chat virtualisation + ring-overflow banner. |

**Wire shape**:

- `GET /v1/state/:ensemble?fixture=empty-ensemble` → `200 application/json` with the fixture's `EnsembleStateV1` snapshot. The URL ensemble path segment is **ignored** in fixture mode — the snapshot's own `ensemble` field wins.
- `GET /v1/events/:ensemble?fixture=eight-player-broadcast` → `200 text/event-stream` with a `snapshot` prelude followed by the fixture's events, walked at the fixture's `eventCadenceMs` cadence. Connection closes when events are exhausted.
- Unknown `?fixture=<name>` → `404 application/json` `{ "error": "unknown-fixture", "fixture": "<name>" }`.

**Auth posture**: fixture mode honours the existing bearer-auth gate (loopback no-auth, non-loopback bearer required). The fixture endpoint is **NOT a backdoor** — it's an alternate *projection* of an authorised request. A non-loopback caller without a bearer still sees `401 unauthorized` whether `?fixture=` is set or not.

**Type safety**: every fixture file imports its types from `src/http/event-types.ts`. A wire-protocol change here breaks the `tsc` build of every fixture module — the `?fixture=` projection cannot drift from the live wire.

---

## 11b. Write endpoints (PR-7a of #340)

Ten POST routes under `/v1/ensembles/:ensemble/<action>` give the dashboard a bidirectional surface. Each handler is a thin shim over the daemon's existing `TempoClient` method (the same client the daemon uses for snapshots) — **zero new Temporal signals/queries/updates**.

### Routes

| Action | Body shape | Success response | Notes |
|---|---|---|---|
| `cue` | `{ to: string, message: string }` | `202 { ok, ensemble, to }` | Routes through `ensureMaestroSession` + `sendAsMaestro` so the chat row shows `role: 'maestro-out'` (matches the dashboard's "you, the operator" semantic). |
| `pause` | `{}` | `202 { ok, ensemble }` | Pauses the maestro hub + scheduler + every session in the ensemble. |
| `play` | `{ release?: boolean }` | `202 { ok, ensemble, released }` | Unpauses. `release: true` also fans out `releaseHeld` to held sessions. |
| `release` | `{ playerId?: string }` | `200 ReleaseClientResult` | Without `playerId`, fans out across the ensemble; with it, releases just that session. |
| `recruit` | `{ name, workDir, agent?, playerType?, host?, isConductor?, initialMessage?, systemPrompt?, held? }` | `202 { playerId, entryId }` | Mirrors the `recruit` MCP tool. `name` and `workDir` required. |
| `restart` | `{ playerId, reason? }` | `202 RestartClientResult` | Per-player verb (`PR-D` algorithm §8.2). `playerId` required. `reason` accepted for body parity but the underlying `TempoClient.restart` doesn't carry it; safe future-compatible field. |
| `reset` | `{ playerId, reason? }` | `202 ResetClientResult` (`{ playerId, entryId }`) | Per-player D14 clean-wipe — the target starts a FRESH session (no transcript replay). `playerId` required; `reason` forwarded (surfaced to the wiped session + audited). HTTP counterpart of the `reset` MCP tool: ensures the maestro (like `cue`) then enqueues the existing `'reset'` outbox entry (`invokerPlayerId: 'maestro'`, always `fresh: true`). Reuses the shipped reset machinery — no new wire. |
| `destroy` | `{ playerId, reason? }` | `202 { ok, ensemble, playerId }` | Per-player terminal destroy. `playerId` required (the ensemble-scope form lives on the `destroy` MCP tool, not this surface). `reason` is forwarded to the client method. |
| `detach` | `{ playerId, deadlineMs?, reason? }` | `202 { ok, ensemble, playerId }` | Graceful detach — workflow survives in `detached`. `deadlineMs` optional but strictly typed: non-numeric (or non-finite) values fast-fail with `400 invalid-field` instead of falling through to the client default — silent drops are the kind of thing that bites future debugging. |
| `recall` | `{ playerId }` | `200 { ok, ensemble, playerId, messages: number }` | Read-shaped (the underlying `TempoClient.recall` returns the player's `{ received, sent }` timeline) but lives on this route group because the dashboard surfaces it on the same PlayerDetail action row — hence `200` not `202`. The handler projects `received.length + sent.length` into a single `messages` count so the dashboard's `RecallResult` consumer reads a number, not the raw inbox + sent-history arrays. Callers wanting the full timeline use the MCP `recall` tool / `TempoClient.recall()` directly. |

### Validation contract

- `:ensemble` must match `ENSEMBLE_NAME_REGEX`; mismatch → `400 invalid-ensemble-name`.
- `to` / `name` / `playerId` must match `PLAYER_NAME_REGEX` and be ≤ `PLAYER_NAME_MAX` (64) chars; mismatch → `400 invalid-player-name`.
- `playerId` is **required** on `restart` / `reset` / `destroy` / `detach` / `recall`; absent → `400 missing-field` (`field: 'playerId'`).
- `deadlineMs` on `detach` if present must be a finite `number`; mismatch → `400 invalid-field` (`field: 'deadlineMs'`).
- `message` must be ≤ `MESSAGE_MAX` (102 400 chars); over → `413 message-too-long`.
- `agent` if present must be `'claude' | 'copilot'` (or `'mock'` in dev mode); otherwise → `400 invalid-agent`.
- Body parse limit `1 MiB`; over → `413 body-too-large`.
- Malformed JSON → `400 invalid-json`.
- Unknown action under `/v1/ensembles/:e/<x>` → `404 not-found` (deliberately not 405 — the path simply isn't a known endpoint).

### Method gates

| Method | Path | Result |
|---|---|---|
| `POST` | known write path | dispatches to handler |
| `GET` | known write path | `405 method-not-allowed`, `Allow: POST, OPTIONS` |
| `POST` | known read path | `405 method-not-allowed`, `Allow: GET, OPTIONS` |

### Auth posture (3e MD-E)

- Loopback bind + no `Origin` header → no auth (TUI/CLI parity; the TUI already writes via Temporal directly).
- Non-loopback bind OR cross-origin browser → **T2 (admin token) required**. A read token holder gets `403 { error: 'insufficient-tier', detail: '…set AGENT_TEMPO_HTTP_ADMIN_TOKEN' }`. An unauthenticated request gets `401 { error: 'unauthorized' }` (L2 floor, checked before tier enforcement).

### Error mapping

The daemon's TempoClient throws `Error('No session found …')` for missing sessions and `Error('Unknown agent type "x"')` for bad agent-type names. These map to:

- `404 session-not-found` for the session miss
- `400 unknown-agent-type` for the agent miss
- `500 write-failed` for anything else (logged at the dispatcher with the underlying message in `detail`)

---

## 11c. Catalog endpoints (issue #400)

Three endpoints surface on-disk catalog data so the dashboard's CreateEnsemble + Recruit + Loadouts + PlayerTypes wizards can drop the hardcoded fallbacks shipped during PR-E + PR-F. The two GETs read the local filesystem only (no Temporal calls); the POST is a thin orchestration over the existing recruit endpoint.

### Routes

| Method | Path | Body shape | Success response | Notes |
|---|---|---|---|---|
| `GET` | `/v1/agent-types` | — | `200 { agentTypes: [{ name, description?, source }] }` | `source: 'project' \| 'user' \| 'shipped'`. Three-tier dedup (project > user > shipped). On-disk `path` and `nativeResolvable` fields are stripped — privacy contract parity with `HostProfile`. |
| `GET` | `/v1/lineups` | — | `200 { lineups: [{ name, description?, players, source }] }` | `source: 'saved' \| 'shipped'`. Saved (`~/.agent-tempo/ensembles/`) wins over shipped (`<package-root>/examples/ensembles/`). Malformed YAML rows are silently skipped — `loadLineup`'s strict validation runs at recruit time, so the picker only surfaces well-formed entries. |
| `POST` | `/v1/ensembles` | `{ name, lineup?, host?, startMode?, conductorInstructions? }` | `201 { ensemble, conductorPlayerId, lineup, recruitedPlayers, playerErrors? }` | Recruits the conductor (`isConductor: true`), then fans out lineup players if a lineup was supplied. |

### POST `/v1/ensembles` semantics

`startMode` ∈ `{ 'hold', 'release' }`. `hold` passes `held: true` to every recruit; `release` is the default (immediate run). `conductorInstructions` is forwarded as the conductor's `initialMessage`.

**Skipped vs CLI `agent-tempo up` (intentional)**:

- No Temporal-server start: the daemon serving this request already proves Temporal is up.
- No daemon-start / agent-type-install / MCP-register: a browser caller doesn't go through that pre-flight.
- No interactive "ensemble already exists" choice tree: HTTP is stateless; we 409 and let the dashboard surface a useful error.

**Per-player error handling**: errors recruiting individual lineup players are non-fatal — the conductor is already alive, so we collect failures into `playerErrors[]` (each entry `{ player, error }`) and return them in the 201 body. The dashboard surfaces a partial-success toast; the user can re-recruit specific players from the workspace without rolling back the whole ensemble.

### Validation contract

- `name` required, must match `ENSEMBLE_NAME_REGEX`; mismatch → `400 invalid-ensemble-name` or `400 missing-field`.
- `lineup` if specified must resolve via `resolveLineupPath()` (saved → shipped → file path); unknown → `400 invalid-lineup` with the underlying parse error in `message`.
- `host` if specified must match `PLAYER_NAME_REGEX`; mismatch → `400 invalid-host`.
- `startMode` if specified must be `'hold' | 'release'`; mismatch → `400 invalid-start-mode`.
- Body cap `1 MiB`; over → `413 body-too-large`. Malformed JSON → `400 invalid-json`.
- Ensemble already running → `409 ensemble-exists`.
- Conductor recruit fails → `500 conductor-recruit-failed` with the underlying message in `message`.

### Method gates + auth

Same as §11b — POST/GET method-not-allowed surfaces fall through to the standard 405 with `Allow:` header. Loopback bind no-auth; non-loopback or cross-origin → bearer required.

---

## 11d. Coat-check endpoints (#713)

Expose the per-ensemble coat-check store (#318, ADR 0008) over HTTP so the
mission-control **command-center planner** — a Pi extension that drives the
daemon over HTTP and has **no Temporal inbox** — can stash a large plan and hand
off a *ticket* on a cue instead of inlining the whole body. Both routes are thin
shims over `TempoClient.coatCheckPut` / `coatCheckGet` (the `coatCheckPut` /
`coatCheckGet` maestro Updates documented in WIRE-PROTOCOL.md) — **zero new
Temporal signals/queries/updates**.

> **★ Honest framing — this does NOT raise the handoff ceiling.** The coat-check
> entry cap (`COAT_CHECK_CONTENT_MAX` = 32 KiB) is *smaller* than the cue body cap
> (`MESSAGE_MAX` = 100 KB). So coat-check cannot rescue a plan that is too big to
> cue — a >100 KB plan still cannot be handed off. What this buys: (1) the
> inbox-less planner gains an HTTP way to stash artifacts at all, and (2) medium
> plans (~8–32 KiB) keep the cue body lean by riding a ticket. Raising the cap to
> exceed the cue cap is a *separate* decision with Temporal continue-as-new
> state-size implications (coat-check lives on Maestro state) and is deliberately
> out of scope for #713.

### Routes

| Method | Path | Tier | Request | Response |
|---|---|---|---|---|
| `POST` | `/v1/ensembles/:e/coat-check` | T2 | `{ summary, content, contentType?, ttlMs? }` | `200 { ok, ensemble, ticket, expiresAt, slotsUsed, slotsTotal }` |
| `GET` | `/v1/ensembles/:e/coat-check/:ticket` | T2 | — | `200 { ok, ensemble, ticket, found, entry }` (`entry: CoatCheckEntry \| null`) |

### Audit identity

Stashes/redeems are attributed to the operator (`putBy` / `fetchedBy` = `maestro`),
NOT caller-supplied — same anti-spoof posture as the `/cue` + `/ask` routes (which
write as the maestro) and the MCP coat-check tools (audit identity from
`getPlayerId()`, never a request field).

### Validation + error mapping

- Strict body validation before the Temporal layer: missing `summary`/`content` →
  `400`; `content` over the 32 KiB UTF-8 cap → `413` (the HTTP layer caps before
  calling Temporal); over-long `summary`/`contentType` → `400`; non-integer or
  out-of-range `ttlMs` → `400`; bad `:ticket` shape → `400`.
- `CoatCheckSlotsFull` (20-slot saturation) → `409`; `CoatCheckEntryTooLarge`
  (defense-in-depth) → `413`; maestro hub not running → `404`; else `500`.
- The GET redeem returns `200 { found:false, entry:null }` (mirroring the
  `/answer` route) for the common "ticket already gone" case rather than `404`.

### Method gates + auth

`POST` to the 2-segment put path is matched **before** the generic write-action
router (§11b), which would otherwise `404` `coat-check` as an unknown action.
Both routes are **T2 (admin)** — `put` is a write; the GET `get` redeems via a
fetch-audit-**mutating** Update, so it is deliberately NOT the usual T1 read tier.

---

## 12. Open questions (revisit after Phase 3 metrics)

1. **Per-token rate limit on `/v1/events*`** — should reconnect frequency cap a runaway consumer? In v1 the connection cap is the only throttle.
2. **Compression** — SSE supports `Content-Encoding: gzip`. Worth measuring chat-heavy ensembles before enabling.
3. **Resumable snapshots** — for very large ensembles, `/v1/state/:ensemble` could chunk via `application/x-ndjson`. Current ensembles top out ~20 players; out of scope for v1.

---

## Appendix A — Suggested module layout (advisory for Phase 3 implementers)

| File | Responsibility |
|---|---|
| `src/http/server.ts` | `http.createServer`, port-file write to `~/.agent-tempo/daemon.port`, bind/CORS/bearer middleware, route table |
| `src/http/aggregate.ts` | 750 ms poll loop, diff vs last snapshot, emit events to ring buffer |
| `src/http/events.ts` | `EnsembleEventBus`, ring buffer, `Last-Event-ID` replay, throttle/coalesce rules from §6 + §8 |
| `src/http/event-types.ts` | TS interfaces for every event payload + `SSE_EVENT_KINDS` const array (drift detector) |
| `src/client/subscribe.ts` | `TempoClient.subscribe(ensemble, opts)` — AsyncIterable wrapper. Two transports: native `EventSource` when available AND no bearer token (free in-session reconnect via auto-managed `Last-Event-ID`); `fetch().body` parser otherwise (Node 20 or any path needing `Authorization`). See ADR 0010. |
| `test/sse/wire-protocol.test.ts` | Drift detector — every section header in this file maps to a known event kind |

---

## Appendix B — Sources

- **Phase 1 research report** by tempo-researcher (2026-04-26) — SSE-vs-WebSocket evaluation, ink-scroll-view recommendation, 4-PR Phase 3 split estimate (~1,200–1,800 LoC).
- **Phase 2 lock-in answers** by tempo-researcher (2026-04-26) — buffer size 256, 750 ms aggregate cadence, bearer-in-config token storage, gap/throttled/chat.compressed event names, heartbeat 10 s + 8 s suppression rule, hash-diff coalescing on schedules and host profiles.
- **Existing Temporal contracts** — see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) §Per-Ensemble Maestro and §Global Maestro for the underlying queries the SSE layer projects.
- **Architectural decisions** backing this spec: see [`docs/adr/`](adr/).
