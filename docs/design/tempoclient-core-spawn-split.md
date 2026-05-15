# TempoClient — Core / WithSpawn split

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-architect
> **Branch**: `design/tempoclient-core-spawn-split`
> **Tracking**: follow-up to PR #308 review (Recommendation 3 — split TempoClient for headless safety)
> **Audience**: the implementing engineer (when scheduled), conductor for review.

---

## 0. TL;DR

The current `TempoClient` interface has 37 methods. Exactly **two** of them shell out to a local terminal (`createEnsemble`, `spawnConductor`) — both via `runTempoCli('agent-tempo up …')`. The other 35 are pure Temporal RPC and safe in any process.

This is a clean cut. Split the interface into:

- **`TempoClientCore`** — 35 methods, no `child_process` dependency, safe to instantiate in headless contexts (MCP server, daemon, future SSE event source, future SDK consumers).
- **`TempoClientWithSpawn`** — `extends TempoClientCore` with the 2 spawn methods. Required for any TUI/CLI context that needs to launch a conductor terminal.

Migration is **non-breaking**: `TempoClient` becomes an alias for `TempoClientWithSpawn`. Existing imports keep compiling. The factory `createTempoClient(client)` returns `TempoClientWithSpawn` (current behavior preserved). New consumers that want headless safety call a new `createTempoClientCore(client)`.

**Estimated implementation cost**: ~150 LoC (mostly type rewiring + factory split + new tests). One PR.

---

## 1. Why split

Three forces converge:

1. **The SSE event source (#94, #95)** — the new HTTP/SSE daemon endpoint serves a future web dashboard. The aggregate poll loop and per-route handlers will instantiate `TempoClient` to project Temporal state into JSON. A web dashboard host has no TTY; calling `.spawnConductor()` from inside the daemon process would launch a terminal where there's nothing to display it. The current `TempoClient` shape makes that error reachable; a typed split makes it impossible.
2. **The MCP `restore` tool's docstring contract** — `src/tools/restore.ts` already explicitly disclaims spawn: *"Does NOT spawn a conductor terminal — use the CLI for that."* This is a docstring promise, enforced only by reviewer discipline. It belongs in the type system.
3. **Future SDK consumers (#67 if it returns)** — exporting `TempoClient` to external Node consumers (`@agent-tempo/client` npm package) means external code has to either (a) accept the `child_process` dependency, or (b) tree-shake around the spawn methods at runtime. A `TempoClientCore` export sidesteps both.

The boundary aligns with v0.27's three-layer architecture: process layer (TTY-bound) vs Temporal/aggregate layer (process-independent). The split makes the architecture self-enforcing.

---

## 2. Catalog of TempoClient methods

The complete inventory of `src/client/interface.ts` `TempoClient` (as of `main` 2026-04-26):

### 2.1 Core (35 methods — no `child_process`, no filesystem-spawn)

**Discovery**: `discoverEnsembles`, `listEnsembles`, `getPlayers`, `getMessages`, `listHosts`, `hasGlobalMaestro`, `isConnected`

**Per-player reads**: `getPlayerMessages`, `getPlayerMetadata`, `attachmentInfo`, `recall`

**Per-ensemble reads**: `getConductorHistory`, `getEnsembleChat`, `getSchedules`, `getGates`, `getStages`, `getWorktrees`, `isMaestroPaused`, `isAnySessionHeld`

**Outbox-routed mutations** (push entries to maestro session outbox; spawn happens in dispatch loop's `spawnProcess` activity, NOT here):
- `recruit` — `submitOutbox({ type: 'recruit', ... })`
- `restart` — `submitOutbox({ type: 'restart', ... })`
- `detach` — `submitOutbox({ type: 'detach', ... })`
- `release` — `submitOutbox({ type: 'release', ... })`
- `migrate` — sugar for `restart({ host })`
- `destroy` — `submitOutbox({ type: 'destroy', ... })` for single-target; for ensemble-scope, fans out terminate/destroy via `handle.terminate` / `handle.executeUpdate(destroyUpdate)`

**Direct workflow signals/queries** (no outbox, no spawn):
- `cancelSchedule`, `terminatePlayer`, `disbandEnsemble`
- `pause`, `play`, `shutdown`, `restore` — fan-out via `signalAllSessions` + maestro/scheduler hub toggles
- `sendCommand`, `sendMessage`, `sendAsMaestro` — workflow signals to conductor/maestro hubs

**Maestro session helpers**: `ensureMaestroSession`, `getMaestroMessages`

### 2.2 WithSpawn (2 methods — shell out via `runTempoCli`)

| Method | Shells out to | Caller pattern |
|---|---|---|
| `createEnsemble({ ensemble, workDir?, lineup? })` | `agent-tempo up <ensemble> [--lineup <name>]` | TUI "create ensemble" wizard, CLI bootstrap |
| `spawnConductor({ ensemble, workDir? })` | `agent-tempo up <ensemble>` (idempotent at workflow layer) | TUI restore flow, CLI `restore` follow-up |

Both share the same private `runTempoCli(args, workDir?)` helper at `src/client/index.ts:90-102`. The helper imports `child_process` dynamically (lazy import — already a defensive pattern).

### 2.3 Hybrid / boundary-questionable

**None.** This is the surprise. The #306 outbox refactor moved all "spawn-adjacent" verbs (`recruit`, `restart`, etc.) onto pure outbox writes. The dispatch loop's `spawnProcess` activity runs in the daemon worker — out-of-process from the client. So the client never directly spawns for those verbs.

The `restore` tool was the last hybrid candidate; #287's `restore` rewrite explicitly delegated terminal spawning to the CLI, not the client. The MCP `restore` tool docstring (`src/tools/restore.ts:14-15`) records this.

**Conclusion**: the boundary is binary. No method needs to "decide at runtime" whether to spawn.

---

## 3. Consumer catalog

Every callsite of `createTempoClient(client)` or its result, grouped by what the client actually uses:

### 3.1 Core-only consumers (8 sites)

| Site | Methods used | Notes |
|---|---|---|
| `src/cli/commands.ts:1931` | `attachmentInfo` | `attachment-info` CLI command |
| `src/cli/commands.ts:2054` | `recall` | `recall` CLI command |
| `src/cli/commands.ts:2112` | `restore` | `restore` CLI command (delegates spawn to a separate `spawnInTerminal` call, NOT through `TempoClient`) |
| `src/cli/startup.ts:558` | `discoverEnsembles` | bootstrap state machine — TTY spawn done elsewhere via `src/spawn.ts` |
| `src/daemon.ts:435` | `destroy` | cleanup loop |
| `src/reconcile/orphans.ts:428` | `restart` | shared orphan-recovery loop |
| `src/tools/destroy.ts` | `destroy` | MCP `destroy` tool |
| `src/server.ts` (via tools) | various pure-RPC | every MCP tool that uses TempoClient |

**Key insight**: every server-side / headless / non-TTY consumer is Core-only today. The split makes that fact typecheckable.

### 3.2 WithSpawn consumers (3 modules)

| Site | Method | Notes |
|---|---|---|
| `src/tui/App.tsx:1003, 1071, 1086` | `api.createEnsemble(...)` | TUI "create ensemble" handlers |
| `src/tui/commands.ts:1068, 1365` | `ensureConductorSpawned(...)` | TUI `/restore` slash + restore-modal handler |
| `src/tui/App.tsx:1161` | `ensureConductorSpawned(...)` | TUI restore flow |

`ensureConductorSpawned` (`src/client/ensure-conductor-spawned.ts:43`) is the only call site for `client.spawnConductor` — every TUI consumer goes through that helper. The helper itself becomes WithSpawn-tier.

### 3.3 Test consumers

`tests/client/*.test.ts` (`pr-d-verbs`, `direct-routing`, `ensemble-verbs`, `ensemble-state`, `list-ensembles`, `fallback`, `attachment-info`) all use `createTempoClient` against a fake Temporal `Client`. They exercise Core methods exclusively. Switching them to `createTempoClientCore` is a one-line import change per file (or none, if `createTempoClient` keeps its current shape via the alias).

`tests/client/ensure-conductor-spawned.test.ts` is the only test that exercises spawn behavior — it stubs the WithSpawn methods directly and never calls `createTempoClient`. No change needed.

---

## 4. Proposed interface boundary

```ts
// src/client/interface.ts (after split)

export interface TempoClientCore {
  // ── Discovery ──
  discoverEnsembles(): Promise<EnsembleSummary[]>;
  listEnsembles(): Promise<EnsembleSummary[]>;
  listHosts(opts?: { force?: boolean }): Promise<HostInfo[]>;
  hasGlobalMaestro(): Promise<boolean>;
  isConnected(): Promise<boolean>;

  // ── Per-ensemble reads ──
  getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]>;
  getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]>;
  getConductorHistory(ensemble: string): Promise<HistoryEntry[]>;
  getEnsembleChat(ensemble: string, offset?: number, limit?: number): Promise<EnsembleChatResult>;
  getSchedules(ensemble: string): Promise<ScheduleEntry[]>;
  getGates(ensemble: string): Promise<QualityGate[]>;
  getStages(ensemble: string): Promise<StageEntry[]>;
  getWorktrees(ensemble: string): Promise<WorktreeEntry[]>;
  isMaestroPaused(ensemble: string): Promise<boolean>;
  isAnySessionHeld(ensemble: string): Promise<boolean>;

  // ── Per-player reads ──
  getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>>;
  getPlayerMetadata(ensemble: string, playerId: string): Promise<SessionMetadata | null>;
  attachmentInfo(ensemble: string, playerId: string): Promise<AttachmentInfo>;
  recall(ensemble: string, playerId: string): Promise<RecallClientResult>;

  // ── Outbox-routed mutations (spawn happens in dispatch loop activity) ──
  recruit(ensemble: string, opts: RecruitClientOpts): Promise<RecruitClientResult>;
  release(ensemble: string, playerId?: string): Promise<ReleaseClientResult>;
  restart(ensemble: string, playerId: string, opts?: RestartClientOpts): Promise<RestartClientResult>;
  detach(ensemble: string, playerId: string, deadlineMs?: number): Promise<void>;
  destroy(ensemble: string, playerId?: string, reason?: string): Promise<void | EnsembleDestroySummary>;
  migrate(ensemble: string, playerId: string, host: string, opts?: Omit<RestartClientOpts, 'host'>): Promise<RestartClientResult>;

  // ── Ensemble-scope coordination ──
  pause(ensemble: string): Promise<void>;
  play(ensemble: string, opts?: { release?: boolean }): Promise<void>;
  shutdown(ensemble: string, opts?: { deadlineMs?: number; reason?: string }): Promise<EnsembleShutdownSummary>;
  restore(ensemble: string): Promise<RestoreOrphansSummary>;
  disbandEnsemble(ensemble: string): Promise<{ terminated: number }>;

  // ── Direct workflow signals ──
  sendCommand(ensemble: string, text: string, source: string): Promise<string>;
  sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string>;
  terminatePlayer(ensemble: string, playerId: string): Promise<void>;
  cancelSchedule(ensemble: string, name: string): Promise<void>;

  // ── Maestro session (TUI-owned workflow for two-way messaging) ──
  ensureMaestroSession(ensemble: string): Promise<string>;
  sendAsMaestro(ensemble: string, targetPlayer: string, text: string): Promise<void>;
  getMaestroMessages(ensemble: string): Promise<{ received: Message[]; sent: SentMessage[] }>;
}

export interface TempoClientWithSpawn extends TempoClientCore {
  /**
   * Spawn a new conductor terminal for a brand-new ensemble. Shells out to
   * `agent-tempo up <ensemble>`. **Requires a TTY context** — DO NOT call
   * from MCP tools, the daemon, or other headless processes.
   */
  createEnsemble(opts: CreateEnsembleOpts): Promise<void>;

  /**
   * Spawn a conductor terminal for an existing ensemble (the restore-after-
   * shutdown path). **Requires a TTY context** — DO NOT call from headless
   * processes. Idempotent at the workflow layer; safe to call concurrently.
   */
  spawnConductor(opts: { ensemble: string; workDir?: string }): Promise<void>;
}

/**
 * Backwards-compatible alias. Existing code that imports `TempoClient`
 * keeps the full surface (Core + spawn). New consumers that want
 * headless safety should import `TempoClientCore` directly.
 */
export type TempoClient = TempoClientWithSpawn;
```

---

## 5. Module layout

```
src/client/
├── interface.ts              # TempoClientCore + TempoClientWithSpawn + TempoClient alias + shared types (CreateEnsembleOpts, RecruitClientOpts, etc.)
├── core.ts                   # createTempoClientCore(client) — implementation of the 35 Core methods
├── with-spawn.ts             # createTempoClientWithSpawn(client) — composes Core + adds the 2 spawn methods
├── ensure-conductor-spawned.ts   # unchanged — still imports TempoClientWithSpawn (was TempoClient)
└── index.ts                  # barrel — re-exports everything; `createTempoClient` is an alias for `createTempoClientWithSpawn`
```

Key design choices:

- **`createTempoClientCore` and `createTempoClientWithSpawn` are separate factories**, not a single factory with a flag. Type-narrows naturally at the call site; no runtime branching; tests for each tier are independent.
- **`createTempoClient` (existing factory) is preserved** as an alias for `createTempoClientWithSpawn`. Every existing consumer (`createTempoClient(client)`) keeps the same return type. **No codemod required.**
- **The `runTempoCli` helper moves to `src/client/with-spawn.ts`** — it's the only thing that makes WithSpawn TTY-bound. Core never imports `child_process`.
- **`ensure-conductor-spawned.ts` continues to depend on `TempoClientWithSpawn`** — it's already typed against the spawn-capable interface implicitly; the import becomes explicit.

---

## 6. Migration plan (when implementation is scheduled)

Single PR, ~150 LoC. Order of operations:

1. **Split `interface.ts`** — define `TempoClientCore` and `TempoClientWithSpawn` per §4. Add `TempoClient = TempoClientWithSpawn` alias.
2. **Split `index.ts`** into `core.ts` + `with-spawn.ts` + `index.ts` per §5. Keep `createTempoClient` as a function that calls `createTempoClientWithSpawn` (one-line wrapper). Export both factories.
3. **Update `ensure-conductor-spawned.ts`** to type its parameter as `TempoClientWithSpawn` explicitly (was `TempoClient`).
4. **Migrate headless callers to `createTempoClientCore`** (optional, cosmetic — non-breaking either way). Targets: `src/daemon.ts:435`, `src/reconcile/orphans.ts:428`, `src/tools/destroy.ts`, `src/server.ts` MCP tool wirings, `src/cli/commands.ts:1931, 2054, 2112`, `src/cli/startup.ts:558`. These all already use Core-only methods; switching the factory locks in the boundary.
5. **No TUI changes required** — TUI continues to call `createTempoClient`, which still returns `TempoClientWithSpawn`.
6. **Tests**: a new `tests/client/core-shape.test.ts` asserts that a `TempoClientCore` instance does NOT have `createEnsemble` or `spawnConductor` properties (compile-time + runtime check). Existing tests don't change.

**Compatibility matrix**:

| Consumer pattern | Before | After | Change required |
|---|---|---|---|
| `import { TempoClient } from '../client'` | full surface | full surface (alias) | none |
| `import { createTempoClient } from '../client'` | returns full surface | returns full surface (WithSpawn) | none |
| `client.spawnConductor(...)` | works | works | none |
| New: `import { TempoClientCore } from '../client'` | n/a | new export | new code only |
| New: `createTempoClientCore(client)` | n/a | new factory | new code only |

---

## 7. Test strategy

| Test file | Scope after split | Status |
|---|---|---|
| `tests/client/pr-d-verbs.test.ts` | Core (recruit/restart/detach outbox shapes) | unchanged |
| `tests/client/direct-routing.test.ts` | Core (recruit/release direct routing) | unchanged |
| `tests/client/ensemble-verbs.test.ts` | Core (pause/play/shutdown/restore fan-out) | unchanged |
| `tests/client/ensemble-state.test.ts` | Core (listEnsembles classification) | unchanged |
| `tests/client/list-ensembles.test.ts` | Core | unchanged |
| `tests/client/fallback.test.ts` | Core | unchanged |
| `tests/client/attachment-info.test.ts` | Core | unchanged |
| `tests/client/ensure-conductor-spawned.test.ts` | WithSpawn (already isolated) | unchanged |
| **NEW** `tests/client/core-shape.test.ts` | Core surface assertion | new — ~30 LoC |

The new shape-assertion test:

```ts
// tests/client/core-shape.test.ts
import { describe, it, expect } from 'vitest';
import { createTempoClientCore } from '../../src/client/core';

describe('TempoClientCore — surface boundary', () => {
  it('does NOT expose createEnsemble or spawnConductor', () => {
    const tempo = createTempoClientCore({} as any);
    expect((tempo as any).createEnsemble).toBeUndefined();
    expect((tempo as any).spawnConductor).toBeUndefined();
  });
  it('DOES expose every Core method documented in §2.1 of the design doc', () => {
    const tempo = createTempoClientCore({} as any);
    for (const method of CORE_METHOD_NAMES) {
      expect(typeof (tempo as any)[method]).toBe('function');
    }
  });
});

const CORE_METHOD_NAMES = [
  'discoverEnsembles', 'listEnsembles', /* ... full list per §2.1 */
] as const;
```

The constant array doubles as a drift detector: adding a Core method requires updating it; removing one fails the test.

---

## 8. Alternatives considered

### 8.1 Single class, throw-on-no-TTY at runtime

Detect TTY at construction time; throw from `createEnsemble`/`spawnConductor` if not available.

**Rejected**: pushes the constraint from compile time to runtime. The daemon process would crash at the wrong layer when the SSE event source accidentally triggers a spawn. The whole point of the split is moving this check earlier.

### 8.2 Runtime feature flag (`createTempoClient(client, { enableSpawn: true })`)

A single factory that returns objects with optional spawn methods based on a flag.

**Rejected**: the return type is then `TempoClient | TempoClientWithSpawn` which the consumer has to narrow. That's worse ergonomics than two distinct factories. Also conflates "this consumer cares about TTY" (compile-time concern) with runtime configuration.

### 8.3 Three tiers — `Read`, `Write`, `Spawn`

Carve out read-only methods into a `TempoClientRead` interface separate from outbox/signal mutations.

**Rejected for v1**: no current consumer wants read-only-only access. Future SSE event source could benefit, but the daemon's aggregate poll uses ~6 read methods and no writes today; not worth a third tier yet. **Revisit when a consumer materializes that needs it** (note in ADR's forward-looking section).

### 8.4 Keep current shape; document spawn methods as "TTY-only" in JSDoc

Status quo plus comments.

**Rejected**: the `restore` tool's docstring already does this and a reviewer caught a near-violation in #308. The type system is the right place to enforce.

---

## 9. Open questions (none blocking)

1. **`createTempoClient` deprecation timeline** — keep the alias indefinitely, or sunset in v0.30+ with a codemod? Recommendation: keep indefinitely; aliases are free.
2. **`@agent-tempo/client` npm package** — if/when the SDK story revives (#67), `TempoClientCore` is the natural export. Out of scope for this spike.
3. **`TempoClientReadOnly` future tier** — file as a follow-up issue if the SSE aggregate ever wants it. Not now.

---

## 10. Implementation footprint

| File | Δ LoC |
|---|---|
| `src/client/interface.ts` | +30 / −0 (split + alias) |
| `src/client/core.ts` | new, ~600 LoC moved from `index.ts` |
| `src/client/with-spawn.ts` | new, ~80 LoC (the 2 spawn methods + `runTempoCli`) |
| `src/client/index.ts` | barrel, ~15 LoC re-exports |
| `src/client/ensure-conductor-spawned.ts` | type annotation tightening, +1 / −1 |
| `tests/client/core-shape.test.ts` | new, ~50 LoC |
| `docs/SSE-PROTOCOL.md` (Phase 3 PR-1) | update to import `TempoClientCore` for the aggregate's read paths |

**Net**: the bulk is moving existing code from `index.ts` to `core.ts` (mechanical). The genuinely new code is ~150 LoC across factory wiring, type definitions, and the shape assertion test.

---

## 11. Sources

- PR #308 review (2026-04-21) — original recommendation 3.
- PR #306 outbox refactor — moved `recruit` / `release` to outbox-routed; eliminated the apparent "spawn methods" that turned out to be pure RPC.
- PR #316 — `docs/SSE-PROTOCOL.md` design that establishes the daemon as a future Core-only consumer (web dashboard via SSE).
- `src/client/interface.ts` (main, 2026-04-26) — current TempoClient interface.
- `src/client/index.ts` (main, 2026-04-26) — current factory implementation.
- `src/client/ensure-conductor-spawned.ts` — TTY-bound helper, unchanged by this design.
