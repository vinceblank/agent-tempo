# Inner-Loop Protocol

> **Status:** Stub / Placeholder · **Author:** TBD · **Created:** 2026-06-03
> **Design decision:** MD-F in [docs/design/pi-native-integration.md](design/pi-native-integration.md)
>
> **IMPORTANT:** This is a **daemon-local, ephemeral, per-player side-channel** — it is
> explicitly NOT part of the stable Temporal coordination wire protocol documented in
> [docs/WIRE-PROTOCOL.md](WIRE-PROTOCOL.md). Signal names, event shapes, and transport
> details here carry no stability guarantee and are not subject to the breaking-change rules
> that govern Temporal signals/queries/updates.

---

## Overview

The inner-loop protocol defines the `GET /v1/players/:ensemble/:player/inner` SSE endpoint
and its event shape. It exists to expose **fine-grained per-player observability** (token
deltas, individual tool calls, turn boundaries) to human operators on demand — without
flooding the coordination event-bus or Temporal history.

This document is a stub. Full content follows Phase 3+ implementation (MD-F).

---

## Design constraints (from MD-F)

- **No ring buffer, no replay, no sequence numbers.** Subscribers receive events from the
  moment of subscription only; there is no Last-Event-ID catch-up.
- **NOT on the coordination SSE bus** (`/v1/events/:ensemble`). The inner loop is a separate
  endpoint. Adding inner-loop events to `SSE_EVENT_KINDS` is explicitly rejected.
- **Tier 1 — coarse, always-on.** Busy/idle state, tool-call name, token-count deltas.
  Mostly already surfaced via `player.phase_changed` + `activityCount` on the coordination
  bus; the inner endpoint aggregates these cheaply.
- **Tier 2 — fine, on-demand.** Full token streaming, tool input/output bodies. Activated by
  subscription presence (first subscriber = start; last unsubscribe = stop). The Pi extension
  gates fine emission behind `hasInnerSubscribers()`.
- **Bounded queue + compaction.** Per-subscriber queue is bounded; a slow subscriber receives
  a `compacted` marker with `dropped: N` rather than unbounded backpressure.
- **Token-delta coalescing.** Source coalesces token deltas over ~100 ms windows before
  emitting, preventing per-token SSE storms.

---

## Planned sections (TBD)

- Transport details (SSE framing, auth, reconnect behavior)
- Event schema (`InnerLoopEvent` union type)
- `compacted` marker shape
- Tier-1 vs Tier-2 event inventory
- Extension integration (Pi `onUpdate` → inner-loop emit)
- Gate request/response events (MD-G integration)
- RBAC tier required (MD-E: inner-tail tier or higher)
