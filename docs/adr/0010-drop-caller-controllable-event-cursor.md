# ADR 0010 — Drop caller-controllable event cursor from `subscribe` API

- **Status**: Accepted
- **Date**: 2026-04-26
- **Authors**: tempo-architect (with implementation feedback from tempo-eng-4 on PR #325)
- **Related**: [`docs/SSE-PROTOCOL.md`](../SSE-PROTOCOL.md) §6.1, §7.5; ADR [0001](0001-sse-vs-websocket-for-tui-streaming.md), [0003](0003-snapshot-then-stream-initial-state.md)

## Context

ADR 0001 chose Server-Sent Events as the streaming transport. ADR 0003 chose snapshot-then-stream as the initial-state pattern: `event: snapshot` on fresh connect, `Last-Event-ID` for in-session reconnect, `event: gap` triggers a state re-fetch.

The first cut of §6.1 also exposed `opts.lastEventId` on `TempoClient.subscribe` — a caller-controllable cursor letting consumers resume across **process boundaries** (e.g. a TUI restart picks up where it left off without re-fetching the snapshot). Implementing PR-3 (#325) revealed the cost:

- Native browser `EventSource` cannot set custom request headers on the **initial** connect — `Authorization` and `Last-Event-ID` are both unavailable. The wrapper would have to fall back to `fetch().body` for any path that supplies `opts.lastEventId`. The first PR-3 implementation collapsed dual transport into fetch-only on this basis.
- The benefit being purchased: skip one HTTP `GET /v1/state/:ensemble` in a narrow window — daemon hasn't restarted (epoch matches) AND the cursor is still inside the 256-event ring (§7.1). In every other case the consumer falls back to a snapshot fetch via `event: gap` anyway, which is the same recovery path snapshot-then-stream already provides.

The cost (forced fetch-only transport, larger code surface, public API surface to maintain) bought a marginal optimisation for a narrow case.

## Decision

**Drop `opts.lastEventId` from the public `SubscribeOptions` API.** `SubscribeOptions` exposes `signal` and `topics` only.

In-session reconnect still uses `Last-Event-ID` under the hood — auto-managed by native `EventSource` on browser, tracked manually by the fetch wrapper on Node. The cursor is no longer caller-controllable; it lives entirely inside one `subscribe(...)` invocation.

## Consequences

- **Positive**:
  - Native `EventSource` becomes usable on browser when no bearer is required (loopback dev). The browser gets free auto-reconnect with `Last-Event-ID` for in-session drops.
  - PR-3 wrapper shrinks: ~580 LoC → ~480 LoC (delta is the EventSource path replacing parts of the manual reconnect logic).
  - Smaller public API surface to maintain. No behaviour to document for the snapshot/cursor edge cases.
  - Snapshot-then-stream remains the bootstrap pattern in every case — uniform behaviour across cold start, restart, and reconnect.
- **Negative**:
  - Cross-session resume (e.g. a TUI restart) costs one extra HTTP `GET /v1/state/:ensemble` per reconnect. Acceptable: the snapshot endpoint is cheap and was already going to be hit on `event: gap`.
  - If a future use case demands caller-controlled cursor resume (e.g. an offline replay tool), the API can add `opts.lastEventId` back additively without breaking — non-breaking surface.
- **Neutral**:
  - The `lastEventId` field on `EnsembleStateV1` (§4.3) stays — it's still useful as the snapshot/stream bridge for in-process subscribers and as the documented value of the SSE event id format (§5).
  - The fetch transport keeps its manual reconnect logic; that's still required for Node 20 (no global `EventSource`) and for any path that uses bearer auth (which native `EventSource` can't service).

## Alternatives considered

- **Keep `opts.lastEventId`** (rejected): retains the optimisation but forces fetch-only on browser, which precludes the simplest browser path (native `EventSource`). The architectural cost outweighed the marginal RTT savings.
- **Custom `?lastEventId=` query-param convention** (rejected): same value calculation as the header version, different mechanism. Adds spec surface (a non-standard query-param shadow of an existing standard header) without solving the underlying problem — the consumer still pays HTTP fetch costs in the common case.
- **Document `EventSource` limitation and let callers branch** (rejected): leaks the transport choice into the public API. Consumers shouldn't have to know which transport is in use; the AsyncIterable contract should be transport-agnostic.

## References

- SSE-PROTOCOL.md §6.1 (`SubscribeOptions`), §7.5 (transport reconnect parity).
- ADR 0001 (SSE transport), ADR 0003 (snapshot-then-stream initial state).
- PR #325 — initial PR-3 implementation that surfaced the EventSource-vs-bearer tension.
