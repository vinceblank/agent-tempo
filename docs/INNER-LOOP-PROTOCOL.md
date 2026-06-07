# Inner-Loop Protocol

> **Status:** Phase 3d (MD-F + MD-G) · **Implemented:** `src/http/inner-loop.ts`, `src/http/inner-loop-routes.ts`, `src/http/gate-registry.ts`, `src/http/gate-routes.ts`, `src/http/gate-audit.ts`, `src/pi/inner-loop-publisher.ts`, `src/pi/inner-loop-client.ts`, `src/pi/gate-client.ts`, `src/pi/tool-capability.ts`
> **Design decision:** MD-F in [docs/design/pi-native-integration.md](design/pi-native-integration.md)
>
> **IMPORTANT:** This is a **daemon-local, ephemeral, per-player side-channel** — it is
> explicitly NOT part of the stable Temporal coordination wire protocol documented in
> [docs/WIRE-PROTOCOL.md](WIRE-PROTOCOL.md). Signal names, event shapes, and transport
> details here carry no stability guarantee and are not subject to the breaking-change rules
> that govern Temporal signals/queries/updates.
>
> **SSE framing** follows the same `event:`/`data:` convention as the coordination stream
> ([docs/SSE-PROTOCOL.md](SSE-PROTOCOL.md)), but the inner endpoint has no ring buffer,
> no `Last-Event-ID` replay, no sequence numbers, and no shared event bus — see
> [Differences from the coordination SSE](#differences-from-the-coordination-sse) below.

---

## Overview

The inner-loop protocol provides **fine-grained per-player observability** for headless Pi players — thinking/text deltas, individual tool calls and results, turn boundaries, and context-pressure — served to operators on demand without flooding the coordination event-bus or Temporal history.

Two tiers:

- **Tier 1 — coarse, always-on.** The current tool name and context-token pressure are piggybacked onto the existing `heartbeat` Temporal signal (~30 s freshness). The aggregate poll diffs this metadata and emits a `player.activity` event on the coordination SSE bus. No new endpoints or auth required. See [docs/SSE-PROTOCOL.md](SSE-PROTOCOL.md#playeractivity).

- **Tier 2 — fine, on-demand.** The `/inner` SSE endpoint streams live `InnerFrame` events. The publisher gates emission behind subscriber presence — zero watchers means zero forwarding, zero extra work in the Pi subprocess. Transport is loopback HTTP between the Pi subprocess and the daemon (not Temporal, not the coordination bus).

---

## Endpoints

### `GET /v1/players/:ensemble/:playerId/inner` — operator SSE stream (Tier 2)

**Auth:** daemon bearer token, `Tier 3` (`adminToken`). Mounted **after** the outer bearer gate.

Streams `InnerFrame` events as SSE. No ring buffer, no `Last-Event-ID`, no sequence numbers — subscribers receive frames from the moment of connection; a disconnect loses in-flight deltas by design.

**Response headers:**
```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**SSE framing:**
```
event: inner.tool_call
data: {"type":"inner.tool_call","tool":"Bash","argsSummary":"ls -la","ts":1717500000000}

:ka

event: compacted
data: {"type":"compacted","dropped":3,"sinceTs":1717500001000}

:closed
```

- `:ka` keepalive comments every 15 s on idle streams.
- `:closed` comment when the player goes away (`closePlayer` drains all subscriptions).
- If the operator's socket write buffer exceeds 1 MiB the connection is dropped (reconnect re-tails live).

---

### `POST /v1/players/:ensemble/:playerId/inner/ingest` — publisher ingest (loopback only)

**Auth:** loopback remote address (`127.0.0.1` / `::1`) **AND** `X-Ingest-Token: <token>` header matching the daemon-minted per-player token. Mounted **before** the outer bearer gate.

The Pi subprocess's `InnerLoopHttpClient` calls this to forward one `InnerFrame`. On success: `204 No Content`. On any gate/shape/oversize failure: uniform `403 {"error":"forbidden"}` (no detail — prevents info leakage about which gate tripped).

**Request body:** a single `InnerFrame` JSON object (no wrapper), max 32 KiB.

---

### `GET /v1/players/:ensemble/:playerId/inner/presence` — publisher presence probe (loopback only)

**Auth:** same as ingest (loopback + `X-Ingest-Token`). This endpoint is publisher-only — the operator must not probe it (leaking "is someone watching X?" is a covert channel).

Returns `200 { "subscribers": <number> }` or `403`.

The publisher polls this (at most once per second, rate-limited) to decide whether to forward fine frames. Zero subscribers → no forwarding → no extra work.

---

## Ingest Auth Model

Each headless Pi player is minted a **per-player, single-use ingest token** at spawn:

- **Mint:** daemon's `IngestTokenRegistry.mint(workflowId)` is called before `spawnPiHeadless`. The token is injected into the subprocess environment as `AGENT_TEMPO_INGEST_TOKEN`.
- **Scope:** the token is bound to the player's `workflowId` (derived from ensemble + playerId). A player presenting its own token for another player's URL is rejected (cross-player-spoof guard).
- **Revoke:** token is revoked on destroy. Detach does **not** revoke (deferred hygiene, security-approved — residual surface is bounded by the next spawn re-minting the token and the destroy-side revoke).
- **Revoke-all:** on daemon shutdown.
- **Not user-set.** `AGENT_TEMPO_INGEST_TOKEN` is a daemon-minted internal credential; operators must not set it manually.

The token is validated timing-safely (constant-time comparison) against the registry. Every failure path returns a uniform `403` with no diagnostic detail.

---

## Event Schema (`InnerFrame`)

All frames carry `"type"` as a discriminant. SSE framing: `event: <type>\ndata: <JSON>\n\n`.

### `inner.thinking`

Coalesced thinking/text delta from the model's stream. Source coalesces deltas over ~100 ms windows OR ~2 KiB of accumulated characters before emitting (whichever comes first), preventing per-token SSE storms. Kind-switches (thinking → text) flush the pending buffer immediately to preserve ordering.

```ts
{ type: 'inner.thinking'; delta: string; kind: 'thinking' | 'text' }
```

### `inner.tool_call`

Pre-execution tool call with a summarized argument body (truncated to ~2 KiB).

```ts
{ type: 'inner.tool_call'; tool: string; argsSummary: string; ts: number }
```

### `inner.tool_result`

Post-execution tool result with a summarized output body (truncated to ~2 KiB). `isError` mirrors the tool's error flag.

```ts
{ type: 'inner.tool_result'; tool: string; resultSummary: string; isError: boolean; ts: number }
```

### `inner.token`

Context-window pressure sampled at `turn_end` via Pi's `getContextUsage()` (pull-only — no per-token streaming). Absent fields mean the value was not available from the model context (e.g. right after `continueAsNew` compaction).

```ts
{ type: 'inner.token'; contextTokens?: number; contextPercent?: number }
```

### `inner.turn`

Turn lifecycle marker.

```ts
{ type: 'inner.turn'; phase: 'start' | 'end'; turnIndex: number; ts: number }
```

### `compacted` (sink-injected, never from publisher)

Backpressure marker injected by the `InnerSubscription` before the next real frame whenever frames were dropped from the bounded queue (drop-oldest, max 256 frames). The publisher never emits this type.

```ts
{ type: 'compacted'; dropped: number; sinceTs: number }
```

`sinceTs` is the epoch-ms timestamp of the first drop in this compaction window.

---

## Differences from the Coordination SSE

| Property | Coordination SSE (`/v1/events/:ensemble`) | Inner-loop SSE (`/v1/players/:e/:p/inner`) |
|---|---|---|
| Ring buffer | 256-event ring; `Last-Event-ID` replay | **None** — live-tail only |
| Sequence numbers | `eventId` on every event | **None** |
| Gap detection | `gap` event on ring overflow | **None** — disconnect loses in-flight deltas |
| Reconnect | Resume from last event id | Re-tail from reconnect moment |
| Auth | Tier 1 read token | Tier 3 admin token |
| Ingest auth | N/A | Loopback + `X-Ingest-Token` (publisher only) |
| On Temporal? | Coordination layer (workflow metadata) | **No** — loopback HTTP between subprocess and daemon |
| Stability guarantee | Stable wire contract (breaking = semver major) | **None** — internal side-channel |
| Event bus | `EnsembleEventBus` (in-process fan-out) | `InnerLoopRegistry` (per-daemon, per-player) |
| Zero-subscriber cost | Always running | Zero forwarding when no subscribers |

---

## Publisher Architecture

```
Pi subprocess                           Daemon
─────────────────                       ─────────────────────────────────────
InnerLoopPublisher                      InnerLoopRegistry
  pi.on('message_update') ──coalesce──▶  InnerSubscription × N
  pi.on('tool_call')      ──gate──────▶    drop-oldest queue (256)
  pi.on('tool_execution_start/end')         compacted marker on drain
  pi.on('turn_start/end') ──truncate──▶  SSE write loop (handleInnerSse)

InnerLoopHttpClient (prod DI)
  publish()  ──POST /inner/ingest──────▶ handleInnerIngest
  subscriberCount() ──GET /presence─────▶ handleInnerPresence (cached, rate-limited)
```

**Source-side gates (publisher):**
- `isPresent()` — rate-limited `subscriberCount` check (cached ≤1/s). Zero → no forwarding, no buffering, no stringify on fine frames.
- Source coalescing — thinking/text deltas buffered up to ~100 ms / ~2 KiB before emit.
- Summary truncation — args + results capped at ~2 KiB with a `…[truncated]` marker.

**Sink-side backpressure (registry):**
- Per-subscriber bounded queue: 256 frames, drop-oldest when full.
- `compacted{dropped,sinceTs}` injected before the next real frame on drain.
- Slow operator socket: connection dropped if write buffer exceeds 1 MiB (reconnect re-tails).

---

## Operator Gate (MD-G, Phase 3d)

An optional live approve/deny gate on headless Pi tool calls. When engaged, non-`low-risk` tools pause before execution so an operator can allow or deny them. The fail posture is **per-request** (`failMode`, #700 P2/G), sourced from the agent's durable `guardrailPolicy`:

- **`open`** (monitored, default) — fail-OPEN: any path that can't reach the daemon (network error, timeout, `auto-allow`) resolves as `allow`. This is the original MD-G posture, unchanged.
- **`closed`** (supervised) — fail-CLOSED: timeout / daemon-down / no-ingest-token resolves as `deny` (`auto-deny`). Opting into supervision means silence ≠ consent.

### Tool Capability Classes

Every tool call is classified before the gate engages:

| Class | Behaviour |
|---|---|
| `exec` | **Hard-blocked at `restricted` access level** (MD-C exec-floor). Blocked regardless of gate armed state. Tools: `bash`, `shell`, `exec`, `sh`, `powershell`, `pwsh`, `cmd`, `run`, `process`, `command`, `run_command`. |
| `high-blast` | Routed to the gate when armed. Tools that write, delete, network-fetch, recruit, or broadly affect ensemble state. Unknown tool names default to `high-blast` (fail-safe). |
| `low-risk` | Always allowed; never routed to the gate. Read-only and read-ensemble tools. |

Classification logic lives in `src/security/tool-capability.ts` (`classify(toolName)`, case-insensitive) — moved from `src/pi/` in #700 P2/G so any autonomous agent (not just Pi) can import the one taxonomy.

### Engagement Model

For a non-`low-risk` tool (exec-class tools are hard-blocked first by the MD-C exec-floor at `restricted` access), the gate engages when EITHER:

1. **Supervised (#700 P2/G)** — `guardrailPolicy === 'supervised'`: SELF-ARMING, engages **regardless of operator arm/presence** (fail-closed must fire precisely when no operator is watching). The frame carries `failMode: 'closed'`. Supervised is the floor — an operator arm can't downgrade it to `open`.
2. **Monitored** — `gateArmed(workflowId)` AND a present subscriber (both read from the cached `/inner/presence` poll, staleness ≤ ~1–2 s post-arm). The frame carries `failMode: 'open'` (today's MD-G, unchanged).

(`guardrailPolicy === 'observe-only'` is a separate NO-ACT axis: ANY non-`low-risk` tool is hard-blocked outright — not gated.)

When engaged, the handler emits an `inner.gate_pending` frame (which simultaneously registers the request in the `GateRegistry` via the `/inner/ingest` side-effect — the "engagement IS registration" path) and calls `GateClient.awaitDecision(requestId, { failMode })`. The decision poll loop returns a `GateEffect` (`'allow'` or `'deny'`); the handler proceeds or throws accordingly.

**#712 — the daemon ENFORCES `failMode` from the durable policy.** The `failMode` the engaging agent stamps on its `gate_pending` frame is **advisory only**: `GateRegistry.open()` derives the authoritative `failMode` from the player's durable `guardrailPolicy` (daemon-read; populated at spawn and lazily resolved via a bounded `getMetadataQuery` on a cache-miss, falling **closed** on timeout/error — no-fail-open). Posture: `monitored`/`autonomous` → `open`; `supervised`/`observe-only`/unknown → `closed`. So an engaging agent can't self-downgrade a `supervised` player by stamping `'open'` — the daemon overrides it to `closed` and writes a neutral-factual `failmode-override` audit record. **Scope:** this protects gate *engagements* only — an agent that SKIPS gate-engagement (runs a tool without emitting `gate_pending`) or bypasses the client-side MD-C exec-block is unaffected; the true boundary is spawn-time tool-restriction (**#715**). *Post-restart:* the in-memory ingest tokens are invalidated on daemon restart, so existing players' engagements are 403'd until re-spawn re-mints; a `supervised` player's gate-client still fail-closes on its own derived deadline in that window (client-side safety holds, not daemon-mediated — the #715 residual).

### Gate Frames on the `/inner` Stream

**`inner.gate_pending`** — emitted by the Pi tool-call handler when the gate engages. The `inner.gate_pending` frame arriving at `/inner/ingest` also calls `gate.open()` atomically (no separate open route).

```ts
{
  type: 'inner.gate_pending';
  requestId: string;          // caller-supplied UUID, unique per tool call
  tool: string;
  argsSummary: string;        // source-truncated ≤ ~2 KiB
  classification: 'exec' | 'high-blast';
  timeoutMs: number;          // open: 45 000 ms (auto-allow window); closed: 300 000 ms (auto-deny window)
  failMode?: 'open' | 'closed'; // #700 P2/G — from guardrailPolicy; absent ⇒ open
  ts: number;
}
```

**`inner.gate_resolved`** — emitted by the `GateRegistry` (via injected `publishToInner` callback) when a decision lands.

```ts
{
  type: 'inner.gate_resolved';
  requestId: string;
  decision: 'allow' | 'deny' | 'auto-allow' | 'auto-deny';
  source: 'operator' | 'timeout';
  ts: number;
}
```

`auto-allow` fires after 45 s on an `open` request with no operator decision (R3, autonomous-first, maintainer-locked). `auto-deny` (#700 P2/G) fires after 300 s on a `closed` (supervised) request — kept distinct from a plain operator `deny` so the audit can tell a timeout from an explicit decision. The registry computes expiry lazily on poll — no daemon timer.

### Gate HTTP Endpoints

#### Operator plane (Tier 3, `adminToken`)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/v1/players/:ensemble/:playerId/gate-arm` | *(none)* | Arm the gate — subsequent non-`low-risk` tool calls engage the gate. |
| `POST` | `/v1/players/:ensemble/:playerId/gate-disarm` | *(none)* | Disarm — new tool calls proceed without gate engagement. In-flight pending requests remain resolvable (or auto-allow). |
| `POST` | `/v1/players/:ensemble/:playerId/gate/:requestId` | `{ "decision": "allow" \| "deny" }` max 4 KiB | Submit an operator decision. `204` on success; `404` unknown request; `409` already decided (idempotency guard). |

#### Source plane (loopback + `X-Ingest-Token`)

| Method | Path | Response | Description |
|---|---|---|---|
| `GET` | `/v1/players/:ensemble/:playerId/gate/:requestId/resolution` | `{ status, decision?, source? }` | Pi subprocess polls here until resolved. `200 { status: "pending" }` while waiting; `200 { status: "resolved", decision, source }` when done; `403` on auth failure; `404` unknown request. |

The source plane reuses the same auth as `/inner/ingest` (loopback remote address + `X-Ingest-Token`).

#### Presence response (extended in 3d)

`GET /inner/presence` now returns `{ subscribers: number; gateArmed: boolean }`. The subprocess reads both engagement inputs from one fetch, avoiding a stale-armed / fresh-present mismatch.

### Timeout posture — Auto-Allow (open) / Auto-Deny (closed)

**`open` (monitored, R3, maintainer-locked):** a pending request with no operator decision after **45 000 ms** resolves to `auto-allow` (`source: 'timeout'`). Autonomous-first — a run with no operator present must never stall. The Pi-side `GateClient.awaitDecision` poll loop bounds itself with `DEFAULT_TIMEOUT_MS = 50 000` ms and honours an `AbortSignal`.

**`closed` (supervised, #700 P2/G):** a pending request with no operator decision after **`GATE_CLOSED_DENY_MS = 300 000` ms** resolves to `auto-deny` (`source: 'timeout'`). The client `closed` deadline is **DERIVED** from `GATE_CLOSED_DENY_MS` (+ buffer, ≥ 310 000 ms; invariant `client_closed > daemon_closed`) so the daemon's *audited* `auto-deny` is received before the client's own fallback fires. Both constants single-home in `src/http/gate-registry.ts`.

Fail posture by `failMode`:

| `GateClient.awaitDecision` return point | `open` | `closed` |
|---|---|---|
| explicit operator `allow`/`deny` | as decided | as decided |
| no ingest token (`!enabled`) | `allow` | **`deny`** (the no-silent-allow backstop) |
| abort (turn cancelled) | `allow` | `allow` (moot — the tool won't run) |
| deadline / daemon-down | `allow` | **`deny`** |
| `pollOnce` decision mapping | `deny`→deny, else allow | `deny` **or `auto-deny`** → deny |

### Gate Audit (R5, Security-Locked)

Every posture change and every decision is appended synchronously to an append-only JSONL file:

```
~/.agent-tempo/gate-audit/<ensemble>/<workflowId>.jsonl
```

Segment characters are whitelisted (`[A-Za-z0-9._-]`) before path construction. I/O errors are swallowed (non-fatal — the gate decision is not blocked on audit write success), but the write is synchronous: durable-before-return when the write does not error.

**`kind: 'arm'` / `kind: 'disarm'` record:**
```json
{ "kind": "arm", "ts": "2026-06-03T12:00:00.000Z", "workflowId": "e/p", "source": "operator", "operatorTokenHint": "…XXXXXX" }
```

**`kind: 'decision'` record:**
```json
{ "kind": "decision", "ts": "2026-06-03T12:00:01.000Z", "workflowId": "e/p", "requestId": "uuid", "tool": "Write", "argsSummary": "…", "decision": "allow", "source": "operator", "operatorTokenHint": "…XXXXXX" }
```

`operatorTokenHint` is the last 6 characters of the bearer token (operator plane); absent on `auto-allow` (source `timeout`). `sessionId` is included when the Pi conversation id is known.

---

## Carry-Items (Phase 4+)

- **Token rotation** — ingest tokens are currently single-issue for the player's lifetime. Periodic rotation is deferred.
- **Per-token rate limiting** — no per-ingest-token rate limit yet.
- **Durable ingest audit** — ingest calls are not logged; deferred.
- **Detach revoke** — detach does not currently revoke the ingest token (bounded risk; destroy-side revoke is in place). Revoke-on-detach is a deferred hygiene item.
- **Gate: cached-`gateArmed` staleness** — there is a ~1–2 s window after arm where the subprocess's presence cache hasn't refreshed yet; a tool call in that window misses the gate (bounded, documented). Shorter-interval refresh or push notification is deferred.
- **Gate: per-token rate limiting** — no per-ingest-token rate limit on gate resolution polls yet.
- **RBAC per tier (MD-E)** — Tier 3 currently uses `adminToken`; 3e will split tokens. The `/inner` endpoint's `requireTier(3)` call and gate operator routes are correct and will stay correct after the split.
