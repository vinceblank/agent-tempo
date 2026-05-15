# ADR 0007 — TempoClient Core / WithSpawn split

- **Status**: Accepted (design — implementation deferred to a separate workstream)
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/design/tempoclient-core-spawn-split.md`](../design/tempoclient-core-spawn-split.md), PR #308 review (Recommendation 3), PRs #94 / #95 (SSE event source)

## Context

`TempoClient` (37 methods) is the canonical Node-side abstraction over Temporal for agent-tempo. Of those 37 methods, exactly two — `createEnsemble` and `spawnConductor` — shell out to a local terminal via `runTempoCli('agent-tempo up …')`. The other 35 are pure Temporal RPC.

Three forces motivate splitting the type now:

1. The new SSE event source (#94/#95) puts the daemon in the position of instantiating `TempoClient` to project Temporal state into JSON. The daemon has no TTY; calling `.spawnConductor()` from the daemon would launch a terminal nothing can render.
2. The MCP `restore` tool's docstring (`src/tools/restore.ts:14-15`) already disclaims spawn responsibility — a docstring promise enforced only by reviewer discipline. A near-violation surfaced during PR #308 review.
3. Future SDK consumers (#67 if revived) would otherwise inherit a `child_process` dependency they don't need.

The boundary is **clean by construction** because of #306's outbox refactor: the apparent "spawn methods" (`recruit`, `restart`, etc.) push entries to the maestro session outbox; the actual spawn happens in the dispatch loop's `spawnProcess` activity (out-of-process from the client). The client never directly spawns for those verbs.

## Decision

Split `TempoClient` into two interfaces:

- **`TempoClientCore`** — the 35 RPC-only methods. Safe in any process.
- **`TempoClientWithSpawn extends TempoClientCore`** — adds `createEnsemble` and `spawnConductor`. Required for TTY contexts.

Add a backwards-compatible type alias `type TempoClient = TempoClientWithSpawn` so every existing consumer keeps compiling. Add a new factory `createTempoClientCore(client)` for headless contexts; preserve `createTempoClient(client)` as an alias for `createTempoClientWithSpawn`.

Module layout:

```
src/client/
├── interface.ts       # both interfaces + alias
├── core.ts            # createTempoClientCore — 35 methods
├── with-spawn.ts      # createTempoClientWithSpawn — composes Core + 2 spawn methods + runTempoCli
├── ensure-conductor-spawned.ts   # unchanged; type-tightened to TempoClientWithSpawn
└── index.ts           # barrel
```

The full design document — boundary tables, consumer catalog, migration plan, test strategy — lives at [`docs/design/tempoclient-core-spawn-split.md`](../design/tempoclient-core-spawn-split.md). This ADR records the decision; that doc records the design.

## Consequences

- **Positive**:
  - Headless-safety becomes typecheckable. The daemon (`src/daemon.ts:435`), MCP tools (`src/server.ts`), reconcile loop (`src/reconcile/orphans.ts:428`), and CLI commands (`src/cli/commands.ts:1931, 2054, 2112`) — all already Core-only in practice — become Core-only in type. A future maintainer can't accidentally introduce a TTY dependency in the daemon by calling `spawnConductor`; the type forbids it.
  - The `restore` tool docstring's "DOES NOT spawn" promise is now enforced by the type system, not reviewer discipline.
  - The SSE event source (#94/#95) gets a clean import target — `createTempoClientCore` for the aggregate's read paths.
  - Future `@agent-tempo/client` SDK exports `TempoClientCore` without dragging in `child_process`.
  - **Migration is non-breaking** — `TempoClient` alias preserves every existing import.
- **Negative**:
  - Two factories instead of one — minor surface increase. Mitigated by the alias preserving the canonical `createTempoClient` name.
  - One additional file (`core.ts`) on top of the existing `index.ts` split. Net code movement, not creation.
  - Implementation cost ~150 LoC (mostly mechanical move from `index.ts` to `core.ts`).
- **Neutral**:
  - The boundary stays binary — no runtime branching. No method needs to "decide if it's spawning at runtime."

## Alternatives considered

- **Single class with runtime TTY detection** (throw from spawn methods if no TTY) — rejected. Pushes the constraint from compile time to runtime; the daemon would crash at the wrong layer when SSE accidentally triggered a spawn.
- **Runtime feature flag on `createTempoClient(client, { enableSpawn: true })`** — rejected. Return type becomes a union the caller must narrow; conflates compile-time concern with runtime config; worse ergonomics than two factories.
- **Three tiers — `Read`, `Write`, `Spawn`** — rejected for v1. No consumer currently demands read-only-only. Re-evaluate if the SSE aggregate or external SDK calls for it; non-blocking to add later (additive, doesn't disturb the binary split shipping now).
- **Status quo + JSDoc warnings** — rejected. The `restore` tool's docstring did this and a near-violation surfaced in #308 review. Type system is the correct enforcement layer.

## Forward-looking notes

- A `TempoClientReadOnly` interface (subset of Core: just queries, no signals/updates) is the natural next split if/when an aggressive caching consumer materializes (e.g. SSE event source's per-tick poll loop). Tracked as a follow-up. Not in scope for the current split.
- The `createTempoClient` alias is intentionally permanent — aliases are free, and removing it later would force a codemod for no architectural benefit.
- If/when the `@agent-tempo/client` SDK is published to npm (#67), `TempoClientCore` is the canonical export; `TempoClientWithSpawn` stays internal to the monorepo (TUI/CLI only).

## References

- [`docs/design/tempoclient-core-spawn-split.md`](../design/tempoclient-core-spawn-split.md) — full design (catalog, consumer inventory, migration plan, test strategy).
- PR #308 (2026-04-21) — original recommendation surfaced in architectural review.
- PR #306 (#285) — the outbox refactor that made the boundary binary.
- PRs #94 / #95 — SSE event source motivating the typecheckable boundary.
- `src/client/interface.ts`, `src/client/index.ts`, `src/client/ensure-conductor-spawned.ts` — current shape.
