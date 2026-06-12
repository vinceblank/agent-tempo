# Inner-Loop Protocol

> **Status:** Phase 3c (MD-F) · **Implemented:** `src/http/inner-loop.ts`, `src/http/inner-loop-routes.ts`, `src/pi/inner-loop-publisher.ts`, `src/pi/inner-loop-client.ts`
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

---

## Doorbell

> **T1.1 — Cue Doorbell** (PRs #776/#783/#803, Refs #747). Design: `docs/design/t11-cue-doorbell.md`.

The doorbell is a **content-free latency hint** on the same source plane as the inner-loop: an in-process ring fires after each `deliverCue`/`deliverReset` activity so subscribed adapters poll immediately instead of waiting for their next backoff tick. It is _not_ a delivery channel — polling via Temporal (`pendingMessages` / `pendingIntake`) remains the guaranteed delivery path.

### `GET /doorbell/:ensemble/:playerId` — adapter delivery hint (loopback only)

**Auth:** loopback remote address (`127.0.0.1` / `::1`) **AND** `X-Ingest-Token: <token>` header — identical to the inner-loop INGRESS model. Mounted before the outer bearer gate. Uniform `403` on any failure (no diagnostic detail).

**Not** under `/v1/`: this endpoint is not part of the versioned observer contract (deliberate architect ruling — see design doc §2.3).

**SSE framing:**
```
event: ding
data: {}

:ka

:closed
```

- Each `event: ding` is a content-free hint; `data: {}` is a minimal valid SSE payload with no semantic content.
- `:ka` keepalive comments every **15 s** on idle streams.
- `:closed` comment when the player is destroyed (`closePlayer` closes all doorbell streams alongside token revocation).
- No event IDs. No `Last-Event-ID` header support. No ring-buffer replay — by design: replayed doorbells would violate the invariant (a persisted doorbell ≈ a delivery guarantee the invariant forbids).

**What the adapter does on ding:**
1. `pollBackoff.reset()` — snaps the T0.2 `IdleBackoff` back to the 2s base.
2. `WakeableSleep.wake()` — cancels the parked backoff sleep, triggering an immediate poll tick.

**Failure behavior:** every failure row (no token, port missing, 403/404/5xx, refused, stream drop) degrades to **silent disconnected polling** at the T0.2 30s ceiling — indistinguishable from doorbell-never-connected.

**Idle ceiling knob:** `SDK_POLL_DOORBELL_MAX_MS` (default 60 000 ms; `AGENT_TEMPO_SDK_POLL_DOORBELL_MAX_MS` env override, clamped ≥ base). Only active when the client is connected; disconnected ceiling automatically reverts to the T0.2 30s floor.

**A doorbell is NOT demand** (hard rule protecting T0.4/T0.1): doorbell connections register on `DoorbellRegistry`, not the `EnsembleEventBus`. `totalSubscriberCount()` never sees them; rings never `wake()` the aggregate demand gate. Enforced structurally and by `tests/conformance/doorbell-not-demand.test.ts`.

**Ingest-token scope:** as of T1.1, the per-player ingest token (see Ingest Auth Model below) is minted for **all SDK-family adapter spawns** (copilot, claude-api, opencode, claude-code-headless, mock, pi) — extended from Pi-only by PR-1. Interactive terminal spawns (`spawnInTerminal`) are excluded (no doorbell client on the interactive adapter).

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

> **Removed (2026-06, Pi permission-layer removal):** the MD-G operator gate
> (gate-arm/disarm/decide routes, gate frames, gate audit, `gateArmed` presence
> field, `GATE_AUTO_ALLOW_MS`/`GATE_CLOSED_DENY_MS`) and the MD-C
> `toolAccess`/tool-capability classification were removed along with the
> `guardrailPolicy` postures — headless Pi players run the full tool surface
> like every other adapter. See
> [docs/design/pi-streamline-gate-removal-cc.md](design/pi-streamline-gate-removal-cc.md).

## Carry-Items (Phase 4+)

- **Token rotation** — ingest tokens are currently single-issue for the player's lifetime. Periodic rotation is deferred.
- **Per-token rate limiting** — no per-ingest-token rate limit yet.
- **Durable ingest audit** — ingest calls are not logged; deferred.
- **Detach revoke** — detach does not currently revoke the ingest token (bounded risk; destroy-side revoke is in place). Revoke-on-detach is a deferred hygiene item.
- **RBAC per tier (MD-E)** — Tier 3 currently uses `adminToken`; 3e will split tokens. The `/inner` endpoint's `requireTier(3)` call is correct and will stay correct after the split.
