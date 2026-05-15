# SSE Streaming Research — Issues #94 + #95

- **Author**: tempo-researcher (claude-tempo[bot] ensemble)
- **Date**: 2026-04-26
- **Status**: Phase 1 (research) — superseded by Phase 2 (architect's design spec) when that lands
- **Tracking issues**: #94, #95
- **Phase 2 spec (when available)**: `docs/SSE-PROTOCOL.md` once architect creates it

---

## Current state

- **Polling cadence**: 2000ms loop in `src/tui/App.tsx:778–871`. Notification-stack secondary tick at 500ms (line 1522).
- **What fires per tick on ensemble view**: 5 parallel Temporal RPCs — `getPlayers`, `getSchedules`, `getEnsembleChat`, `isMaestroPaused`, `isAnySessionHeld`. Plus 2 more on player-detail view (`getPlayerMetadata`, `getPlayerMessages`).
- **Hot paths**:
  - **Most frequent**: `discoverEnsembles()` on home view — full Temporal visibility query (`workflow.list`) every 2 s.
  - **Most expensive**: `isAnySessionHeld()` — O(n) fan-out, one `outboxLockedQuery` per non-maestro session per tick. With 8 players that's 8 queries every 2 s = **240 query-RPCs/min just for the held badge**.
  - **State churn driver**: ensemble chat (new maestro/conductor messages) and player phase transitions (`booting → attached → processing → awaiting → detached`).
- **Best streaming candidates** (highest ratio of churn-rate × cost):
  1. **`getEnsembleChat`** — append-only timeline, screams for `event: chat.appended` instead of "fetch last 50 every 2 s."
  2. **Player phase changes** — already published on `ClaudeTempoAttachmentState` search attribute; one event per transition (rare).
  3. **`isAnySessionHeld` / `isMaestroPaused`** — replace the per-tick fan-out with a single `event: ensemble.flags_changed`.
  4. **Schedule list** — only changes on `schedule`/`unschedule`; pure waste to poll.

`getPlayerMessages`, `getPlayerMetadata`, `recall` stay on request/response — they're user-invoked drill-ins, not background streams.

## Transport recommendation

- **Primary: SSE.** Confirmed correct for this use case:
  - Read-mostly, server→client. Client→server already covered by `TempoClient` (Temporal RPC) — no need for full duplex.
  - Browser-native `EventSource`, no library on the dashboard side. Node SSE consumer is ~30 lines (`fetch` + `ReadableStream` text decode + line parser).
  - Built-in `Last-Event-ID` reconnect → matches the durable-execution worldview.
  - Trivial multi-subscriber fan-out (one `res.write(...)` per subscriber).
- **Fallback**: none in v1. WebSocket only justified if we later need bidirectional UI control (collaborative cursors, etc.). Long-poll is unnecessary — corporate proxies that strip SSE also strip WS.
- **Auth/CORS**: localhost-only by default; bearer token from `~/.agent-tempo/config.json` for cross-origin web-dashboard. CORS allowlist via `CLAUDE_TEMPO_CORS_ORIGINS` env var.

## Daemon event source design (sketch)

- **HTTP server**: spin up `http.createServer` inside `src/daemon.ts` after `runDaemonBoot` (port from `CLAUDE_TEMPO_HTTP_PORT`, default `0` → ephemeral, written into `~/.agent-tempo/daemon.port`).
- **Endpoints**:
  - `GET /v1/state/:ensemble` — JSON snapshot (one-shot) for initial render.
  - `GET /v1/events/:ensemble` — SSE stream, optional `?topics=phase,chat,flags,schedules`.
  - `GET /v1/events` (no ensemble) — global feed (ensemble create/destroy).
  - `GET /v1/health` — liveness + connected Temporal namespace.
- **State source**: daemon maintains an in-memory `EnsembleAggregate` per ensemble, fed by **one** internal poll loop (500–1000 ms) that mirrors today's TUI fan-out *once* and diffs vs. last snapshot to emit events. Phase 2 upgrade: replace internal poll with Temporal `WorkflowExecutionUpdated` history streaming + maestro-hub query subscriptions. Start cheap, optimize later.
- **Event types** (versioned, `id` monotonic per ensemble):
  - `ensemble.created` / `ensemble.destroyed`
  - `player.added` / `player.removed` / `player.phase_changed` (carries new phase, lastHeartbeatAt)
  - `chat.appended` (one event per new message — payload mirrors `EnsembleChatResult.messages[i]`)
  - `flags.changed` (paused, held)
  - `schedules.changed` (full list — small, cheap)
  - `host_profile.changed`
  - `heartbeat` (10s keepalive — lets dashboard detect disconnect)
- **Multi-client**: `Map<ensemble, Set<Subscriber>>`. Subscriber object: `{ res, topics, lastEventId }`. Broadcast on event emit. Simple, plenty fast.
- **Reconnect/replay**: per-ensemble ring buffer of last 200 events keyed by id. Client reconnects with `Last-Event-ID: 1234` → server replays buffer slice, then resumes live. **Initial connection** without `Last-Event-ID` should fetch the snapshot from `/v1/state/:ensemble` first (avoid replaying 200 events to a fresh client).
- **Not in scope for v1**: per-player message stream (drill-in), recall, hosts. Those stay request/response.

## TempoClient streaming API (sketch)

```ts
interface TempoClient {
  // ... existing methods stay
  subscribe(ensemble: string, opts?: {
    topics?: SubscribeTopic[];
    signal?: AbortSignal;
  }): AsyncIterable<TempoEvent>;
}
```

- Backed by `EventSource` in browsers, by `fetch(...).body` (web-streams) on Node 20+. Same shape both sides — the TUI eats its own dogfood.
- **Subscription lifecycle**: `for await (const ev of client.subscribe(ens, { signal })) { … }`. Caller controls termination via `AbortController`. Tear-down: `signal.abort()` → server detects close, removes subscriber from set.
- **Initial state convention**: `subscribe()` returns a synthetic `event: snapshot` first (carries the `/v1/state/:ensemble` payload inline) — caller renders, then receives diffs.
- **Backpressure**: SSE has none natively; daemon coalesces high-frequency events (e.g. >10 phase changes/sec on one player) into a single `player.phase_changed` event with the latest value.

## Ink scroll — recommended approach

**Don't fork. Use `ink-scroll-view` + `ink-scroll-list`** — both are already cited in Ink's official README ([PR #838](https://github.com/vadimdemedes/ink/pull/838)), ~50 k combined weekly downloads, MIT.

Evidence:
- Issue [#222 "Scrolling"](https://github.com/vadimdemedes/ink/issues/222) — open since 2019; maintainer's stated direction: scroll lives in userland.
- [PR #764](https://github.com/vadimdemedes/ink/pull/764) (Gemini CLI's full native scroll impl) — closed unmerged Nov 2025 as too opinionated. Future direction in [#765](https://github.com/vadimdemedes/ink/issues/765) is small primitives (`contentOffsetX/Y`, `useBoxMetrics`) — no timeline.
- Both userland packages currently peer `ink: ^5 || ^6`; we're on 6.8 so no immediate blocker. When Ink 7 lands (already shipped 2026-04-08), file a peer-dep bump PR upstream rather than forking.

**Alternatives evaluated and rejected**:
- **Fork Ink** — unnecessary maintenance burden; the userland packages already exist and the upstream primitives in #765 will eventually land.
- **OpenTUI** (sst/opentui) — interesting (Zig core, used by OpenCode) but self-described "not production-ready"; a full TUI rewrite is wildly out of scope.
- **react-blessed** — last published 2022; abandoned.

## Effort estimate

- **Phase 2 (architect design + spec)**: 4–6 h. Lock event payload shapes (versioned), endpoint contracts, auth model, write `docs/SSE-PROTOCOL.md` parallel to `docs/WIRE-PROTOCOL.md` so it's pinned from day 1.
- **Phase 3 implementation** (4 PRs, est. ~1,200–1,800 LoC):
  1. **Daemon HTTP server + aggregate + snapshot endpoint** (~400 LoC src + ~250 LoC test). No SSE yet — get JSON snapshot working, drop the `/v1/state` endpoint, validate the in-memory aggregate against current TUI polls.
  2. **SSE streaming + ring buffer + reconnect** (~300 LoC + ~200 test).
  3. **`TempoClient.subscribe` + AsyncIterable wrapper** (~150 LoC + ~150 test). Both browser + Node code paths.
  4. **TUI cutover + scroll**: replace `App.tsx` poll loop with `subscribe()`, add `ink-scroll-view` for chat history & player list (~200 LoC delta + Ink-package peer-dep bump).
- **Risks**:
  - **Determinism of in-memory aggregate vs. Temporal truth**: daemon restart loses the buffer → clients reconnect, get a fresh snapshot, resume. Buffer is convenience, not authority.
  - **Multi-daemon (multi-host)**: each daemon serves its own port; web dashboard would need to know about all daemons. v1: single-daemon, single-port. v2: a "directory" endpoint that enumerates known daemons via the global maestro's `hostProfiles`.
  - **CORS / auth on first browser dashboard**: easy to under-spec. Bake into Phase 2 design doc, don't defer.
  - **Phase compaction**: the daemon must coalesce churn (heartbeats, processing flips) so the SSE stream isn't worse than the poll. Spec rate caps in Phase 2.
  - **Ink 7 peer-dep on `ink-scroll-view`**: if upstream is slow to merge a bump PR, pin via `overrides` or vendor a 50-line peer.

## Sources

- Ink scroll research: github.com/vadimdemedes/ink — issues #222, #765; PRs #502, #764, #838, #917
- `ink-scroll-view`: github.com/ByteLandTechnology/ink-scroll-view
- MDN SSE: developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- Code traced: `src/tui/App.tsx:778–871`, `src/client/interface.ts`, `src/daemon.ts`, `src/client/index.ts`
