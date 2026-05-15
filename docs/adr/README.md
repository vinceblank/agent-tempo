# Architectural Decision Records

This directory holds short, dated records of architectural decisions for agent-tempo.

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
| [0005](0005-ink-scroll-via-userland-package.md) | Use `ink-scroll-view`; don't fork Ink | Accepted |
| [0006](0006-test-hooks-naming.md) | Test-hooks naming convention | Accepted |
| [0007](0007-tempoclient-core-withspawn-split.md) | TempoClient Core / WithSpawn split | Accepted (design — implementation deferred) |
| [0008](0008-coat-check-pattern.md) | Coat-check pattern for large cues | Accepted (design — implementation deferred) |
| [0009](0009-protobuf-migration-strategy.md) | Full protobuf payload migration strategy | Accepted (design — implementation deferred to post-#318) |
| [0010](0010-drop-caller-controllable-event-cursor.md) | Drop caller-controllable event cursor from `subscribe` API | Accepted |
| [0011](0011-player-saveable-state.md) | Player-saveable state primitive | Accepted (design — implementation deferred) |
| [0012](0012-claude-api-adapter.md) | Headless Claude API adapter (Phase 1, no advisor) | Accepted (design — implementation deferred) |
| [0013](0013-web-dashboard.md) | Packaged web dashboard via `agent-tempo dashboard` | Accepted (design — implementation deferred) |
