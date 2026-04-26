# ADR 0002 — Daemon owns the HTTP/SSE event source

- **Status**: Accepted
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/SSE-PROTOCOL.md`](../SSE-PROTOCOL.md), [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), issue #94

## Context

The HTTP/SSE event source needs a host process. Three candidates exist:

1. **The daemon** (`src/daemon.ts`) — already a long-lived background process running Temporal workers, the global maestro ensure-loop, and the reconcile/cleanup loops.
2. **A new sidecar process** — independently scaled, separate failure domain.
3. **An MCP tool surface** — surface streaming through `@modelcontextprotocol/sdk`.

We need to pick one before Phase 3 implementation begins.

## Decision

**The daemon hosts the HTTP/SSE event source.** A new module `src/http/server.ts` runs alongside the workers, sharing the daemon's process and Temporal client connections.

## Consequences

- **Positive**:
  - Zero new processes — operators already manage daemon lifecycle (`claude-tempo daemon start/stop/status`).
  - Shared Temporal client → the aggregate poll loop reuses the connection that's already paying TLS/heartbeat costs.
  - Daemon failure → clients reconnect on daemon restart (same way they reconnect on TCP drop). No partial-failure modes where workers run but the event source is dead.
  - Existing per-host task-queue model means each host runs one daemon → one HTTP source per host. Cross-host clients hit the appropriate daemon directly (or the global one for cluster events).
  - Aligns with the v0.27 three-layer model: process layer (daemon) hosts process-layer concerns (HTTP, port file, CORS).
- **Negative**:
  - Workers and HTTP share a Node event loop. A wedged HTTP handler could starve worker activity polling. Mitigation: HTTP routes do **only** in-memory aggregate reads; no Temporal queries on the request path. Aggregate is updated by a separate poll loop.
  - Daemon shutdown must drain SSE connections gracefully. Mitigation: 5 s drain on `SIGTERM`; existing 15 s `hardExit` safety net covers the worst case.
- **Neutral**:
  - Bind defaults to loopback (`127.0.0.1:8473`); operators opt into network exposure via `CLAUDE_TEMPO_HTTP_BIND` (which forces token mode — see SSE-PROTOCOL.md §3).

## Alternatives considered

- **Sidecar process**: rejected for v1. Would double the operator burden (`claude-tempo http start/stop/status`) without solving any current problem. The daemon already has the right lifecycle, the right connections, and the right capability profile to advertise.
- **MCP tool surface**: rejected. MCP is a request/response protocol for tool calls; bolting streaming onto stdio would require a custom event protocol over the existing transport, which is exactly what SSE solves over HTTP. MCP also has no story for a future browser-hosted web dashboard.

## Forward-looking notes

If the daemon outgrows a single Node process — e.g. CPU-bound aggregate diffing for 100+ ensembles — the SSE layer can be **extracted to a sidecar** without API change because the aggregate's interface is already a clean abstraction (see ADR 0004). Don't pre-optimize for that until metrics justify it.

## References

- `src/daemon.ts` — current daemon entry point, lifecycle, signal handling.
- ADR 0001 for transport choice.
- ADR 0004 for the aggregate abstraction.
