# ADR 0004 — In-memory aggregate vs Temporal history streaming

- **Status**: Accepted (v1)
- **Date**: 2026-04-26
- **Authors**: tempo-architect (with research from tempo-researcher Phase 1)
- **Related**: [`docs/SSE-PROTOCOL.md`](../SSE-PROTOCOL.md) §11

## Context

The HTTP/SSE event source needs a state model that:

- Reflects the current ensemble shape (players, phases, chat, schedules, host profiles, flags).
- Emits events on change.
- Doesn't blow up Temporal RPC volume when many subscribers attach.

Two architectural shapes exist:

1. **In-memory aggregate fed by polling** — the daemon polls maestro queries on a fixed cadence, diffs against the last snapshot, emits events.
2. **Temporal history streaming** — the daemon subscribes to Temporal workflow history events directly (e.g. `WorkflowExecutionUpdatedEvent` for search-attribute changes) and projects them to SSE events.

## Decision

**v1 uses the in-memory aggregate**, fed by a single internal poll loop at **750 ms cadence**.

Each tick fans out the same Temporal queries the TUI runs today (one `workflow.list` + per-ensemble `maestroPlayersByEnsemble` + `maestroEnsembleChat` + `getSchedules`), diffs vs the previous snapshot, emits events to the ring buffer.

## Consequences

- **Positive**:
  - Subscriber count has zero impact on Temporal RPC volume — five TUIs and one web dashboard read from one snapshot per tick.
  - Trivially testable — the aggregate is a pure function of `(previousSnapshot, freshSnapshot) → events`.
  - Reuses well-understood maestro queries — no new Temporal-side code paths.
  - 750 ms cadence is faster than the current TUI's effective freshness (2 s), giving better UX in the common case.
- **Negative**:
  - Per-tick latency floor of 750 ms for any change to land. For chat-style traffic this is fine; for fast phase chatter it's masked by the 250 ms debounce in §6 anyway.
  - Aggregate must be initialized on daemon boot before HTTP starts accepting subscribe requests. Mitigated: first tick fires synchronously during boot; HTTP listener is registered after.
- **Neutral**:
  - The aggregate becomes a **public abstraction** that the SSE layer talks to. If we later swap implementations (workflow-side push, Temporal history streaming), the SSE contract stays stable.

## Alternatives considered

- **Temporal history streaming**: rejected for v1. Temporal SDK has no broad "subscribe to namespace events" API. The realistic shape is per-workflow `getHistoryEvents` polling, which scales worse than visibility-query polling once you're tracking 50+ workflows. The tooling and observability stories aren't built either — debugging a "stuck history projection" is harder than debugging "stale snapshot."
- **Worker-side push via Temporal signal**: deferred. Adds workflow-side complexity (every state change must signal the daemon) and inverts the dependency (workflows depend on a daemon endpoint). Worth measuring as a v2 optimization once we have metrics on aggregate cost.
- **Sub-second polling (e.g. 100 ms)**: rejected. Doubles RPC cost without meaningful UX improvement; Temporal visibility queries are not free.

## Forward-looking notes (v2 upgrade path)

When metrics show the 750 ms poll loop is the bottleneck (e.g. namespace > 100 ensembles, RPC quota pressure), two upgrade paths exist:

1. **On-demand polling** — only run the per-ensemble poll for ensembles with active subscribers. Ensembles with zero subscribers fall back to `client.workflow.handle().describe()` at low frequency (e.g. 30 s). Implementation cost: ~50 LoC; aggregate API unchanged.
2. **Workflow-side push** — extend the maestro workflows to signal the daemon's HTTP endpoint on state changes. Requires a new Temporal activity per emit. Implementation cost: ~200 LoC; aggregate API unchanged.

Both paths preserve the SSE contract — clients see no difference. **Don't pre-optimize.** Pick the path after seeing real numbers.

### Interaction with the bootEpoch event-id format

Both v2 paths must preserve the `<bootEpoch>:<seq>` event-id contract from SSE-PROTOCOL.md §5.

- The bootEpoch is the **daemon process boot time**, not the aggregate process or workflow run id. It's frozen for the daemon's lifetime regardless of which aggregate strategy is active. Switching from polling to workflow-side push does not bump the epoch.
- The `seq` counter is owned by the daemon's `EnsembleEventBus` (see Appendix A in SSE-PROTOCOL.md). Both v2 paths funnel events through the same bus, so the seq stays monotonic per `(bootEpoch, ensemble)` regardless of which producer fed the bus.
- Only a **daemon process restart** advances the epoch. Workers restarting (e.g. Temporal connection reset) do not — the daemon process is the unit of identity for the event log.

Consumers reconnecting across a daemon restart see `event: gap` with `reason: 'epoch-mismatch'` regardless of which aggregate strategy is active. The recovery path (re-fetch `/v1/state/:ensemble`, reconnect with the snapshot's `lastEventId`) is identical. Implementer guidance: when prototyping v2, write the bus-emitter shim first and keep the `EnsembleEventBus` interface frozen — that preserves the wire contract through the upgrade.

## References

- SSE-PROTOCOL.md §11 (state source).
- `src/workflows/maestro.ts` — existing maestro polling cadence (5 s).
- Phase 1 research report — visibility-query polling vs Temporal-history-streaming evaluation.
- Phase 2 lock-in answers — 750 ms cadence rationale.
