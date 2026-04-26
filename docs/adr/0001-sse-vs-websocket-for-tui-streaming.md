# ADR 0001 — SSE vs WebSocket for TUI streaming

- **Status**: Accepted
- **Date**: 2026-04-26
- **Authors**: tempo-architect (with research from tempo-researcher Phase 1)
- **Related**: [`docs/SSE-PROTOCOL.md`](../SSE-PROTOCOL.md), issue #94, issue #95

## Context

The TUI currently polls Temporal directly via `TempoClient` every ~2 s, fanning out 5 RPCs per tick (`listEnsembles`, `getPlayers`, `getEnsembleChat`, `isMaestroPaused`, `isAnySessionHeld`). With 5 open TUIs the load is 25 RPCs/2 s on shared task queues. A near-future web dashboard would multiply this further. We need a push transport so subscriber count decouples from Temporal RPC volume.

Three transport options were evaluated by tempo-researcher in Phase 1:

1. **WebSocket** — bidirectional, binary-capable, framed
2. **Server-Sent Events** — server-push only, plain HTTP, native `EventSource`
3. **HTTP long-poll** — repeated `GET` with hanging response

## Decision

**Server-Sent Events.** All streaming endpoints under `/v1/events*` use `text/event-stream`. Commands continue to flow over MCP/Temporal — never over the HTTP surface.

## Consequences

- **Positive**:
  - Native browser support (`EventSource`) — no library for the future web dashboard.
  - Plain HTTP — works with reverse proxies, load balancers, and supervisord probes without protocol upgrade dance.
  - Last-Event-ID is built into the spec — replay/reconnect semantics are framework-level, not app-level.
  - Easy to implement with `node:http` alone — no extra dependency.
  - Connection lifecycle is debuggable with `curl`.
- **Negative**:
  - One-way only — but the daemon never needs client-to-server push (commands go via MCP).
  - Per-connection state lives on the daemon — see ADR 0002 for why this is fine.
  - Some HTTP/2 multiplexers reorder events under load — mitigated by per-connection ordering and explicit `id:` lines.
- **Neutral**:
  - Must implement the SSE framer ourselves (about 30 LoC); chosen over a library to avoid a new dep.

## Alternatives considered

- **WebSocket**: rejected. Bidirectional flow is unnecessary; commands are the durable concern and belong in Temporal's outbox layer. WebSocket would also drag in `ws` (or similar) and force a custom reconnect/replay protocol since Last-Event-ID has no analog.
- **HTTP long-poll**: rejected. Hides reconnect semantics behind app code and adds latency on every event (request setup overhead per emit).
- **gRPC server-streaming**: rejected. Unnecessary complexity for a local-first daemon; no native browser support kills the future-web-dashboard use case.

## References

- Phase 1 research report by tempo-researcher (2026-04-26).
- [WHATWG Server-Sent Events spec](https://html.spec.whatwg.org/multipage/server-sent-events.html).
