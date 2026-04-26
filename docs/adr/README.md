# Architectural Decision Records

This directory holds short, dated records of architectural decisions for claude-tempo.

## Format

Each file is named `NNNN-kebab-case-title.md`. The number is monotonic; never reuse, never renumber. Format follows MADR-lite:

- **Title**
- **Status**: Proposed | Accepted | Superseded by NNNN | Deprecated
- **Context**: the forces in play
- **Decision**: what we chose
- **Consequences**: trade-offs accepted
- **Alternatives considered**: what was rejected and why

Keep ADRs short. They're decision *records*, not design documents — link out to design docs (e.g. `docs/SSE-PROTOCOL.md`, `docs/design/*.md`) when the depth lives there.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-sse-vs-websocket-for-tui-streaming.md) | SSE vs WebSocket for TUI streaming | Accepted |
| [0002](0002-daemon-as-event-source.md) | Daemon owns the HTTP/SSE event source | Accepted |
| [0003](0003-snapshot-then-stream-initial-state.md) | Snapshot-then-stream initial state | Accepted |
| [0004](0004-in-memory-aggregate-vs-temporal-history.md) | In-memory aggregate vs Temporal history streaming | Accepted (v1) |
