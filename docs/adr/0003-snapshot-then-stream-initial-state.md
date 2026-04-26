# ADR 0003 — Snapshot-then-stream initial state

- **Status**: Accepted
- **Date**: 2026-04-26
- **Authors**: tempo-architect (with research from tempo-researcher Phase 1)
- **Related**: [`docs/SSE-PROTOCOL.md`](../SSE-PROTOCOL.md) §7

## Context

When a consumer connects to `/v1/events/:ensemble`, it needs the current state plus the live tail. Three strategies exist:

1. **Replay-only** — server keeps a complete event log; client replays from the beginning every connection.
2. **Snapshot-only** — every connection re-fetches `/v1/state/:ensemble`; no event log; clients re-sync on every reconnect.
3. **Snapshot-then-stream** — fresh connect emits a synthetic `event: snapshot` first, then resumes live; reconnects with `Last-Event-ID` replay from the ring buffer; gaps emit a `gap` event so the client re-fetches the snapshot atomically.

The decision drives the daemon's memory footprint, the consumer's reconnect cost, and the contract for replay correctness.

## Decision

**Snapshot-then-stream**, with a 256-event ring buffer per ensemble. On reconnect:

- `Last-Event-ID` ≥ `ringStart` → replay `[N+1 … latest]`, then live tail.
- `Last-Event-ID` < `ringStart` → emit `event: gap`, client MUST re-fetch `/v1/state/:ensemble` (which returns its own `lastEventId`) then reconnect with `Last-Event-ID: <that>`.
- Header missing (fresh connect) → emit `event: snapshot`, then live tail.

The snapshot endpoint returns `lastEventId` so the snapshot/stream gap closes atomically.

## Consequences

- **Positive**:
  - Short reconnects (< 256 events of history; ≥ 5 min at p99) are gap-free — pure replay, no full re-fetch.
  - Long reconnects degrade gracefully — an explicit `gap` event lets the client re-sync without ambiguity.
  - The `lastEventId` field on `/v1/state/:ensemble` makes the snapshot/stream handoff race-free. Consumers don't have to invent a "subscribe before fetch" workaround.
  - Memory cost: 256 events × ~500 B × ensemble count → ≤128 KiB per ensemble worst case.
  - Daemon restart drops the buffer → consumers see `gap` and re-fetch. Acceptable: Temporal is the durable store; the daemon is a cache.
- **Negative**:
  - Ring buffer is in-memory and per-process. Cross-host clients connecting to a different daemon get `gap` (no shared event log). Acceptable in v1 — TUI consumers connect to their local daemon.
  - The `gap` event is part of the API surface — adds one more event type for consumers to handle. Mitigated by being a single binary state ("re-sync now"), not a recoverable error.
- **Neutral**:
  - `event: snapshot` payload duplicates `/v1/state/:ensemble` shape (intentional — same TS interface).

## Alternatives considered

- **Replay-only with persistent log**: rejected. Persistent durable log replicates Temporal's job. Bytes-on-disk grow without bound. Operationally fragile (rotate? prune? backup?).
- **Snapshot-only**: rejected. Every reconnect would re-fetch the snapshot — wastes RPCs and is racy: events emitted between fetch and subscribe-start get lost. Researcher's Phase 1 measured this as the primary failure mode of naive long-polling.
- **Larger ring buffer (1000+)**: considered, rejected. 256 covers ≥5 min at p99 with §6 coalescing rules. Larger sizes increase memory cost without improving the common-case reconnect window. Operators can override via `CLAUDE_TEMPO_SSE_BUFFER` in v2 if needed.

## References

- SSE-PROTOCOL.md §7 (reconnect and replay).
- Phase 1 research report — buffer-sizing analysis: 500 B/event × 256 = 128 KiB; 256 is power-of-two.
- Phase 2 lock-in answers — explicit `gap` event vs implicit auto-snapshot.
