# `src/adapters/` — session adapter registry

Every session adapter — the code that runs *inside* a player process and bridges the Temporal session workflow to the underlying agent (Claude Code CLI, Copilot CLI, headless SDKs, …) — lives in its own directory under this one.

This directory landed in **PR-B of the v0.25 rebuild ladder** as a structural lift-and-shift:

- `src/channel.ts` → `src/adapters/claude-code/adapter.ts`
- `src/copilot-bridge.ts` → `src/adapters/copilot/adapter.ts`

The design contract for adapters is **§4 of `docs/design/session-lifecycle-rebuild-v2.md`**. This README is the quick-start; the design doc is the source of truth.

> **PR-B disclaimer.** `BaseAttachment` / `SdkAttachment` are *skeletons* in this PR — the full lifecycle contract (heartbeat loop, lease renewal, `claimAttachment` + `forceDetach` integration, `WorkflowNotFound` handling, split-brain cancellation) lands in **PR-C**. Today adapters still call the legacy wire surface (`markDelivered`, `updateMetadata({ status })`), which the PR-A compat shim in `src/workflows/session.ts` translates onto the attachment phase machine. Everything below describes the PR-B surface.

## Directory layout

```
src/adapters/
├── base.ts           # BaseAttachment abstract + AdapterRegistry
├── index.ts          # singleton `registry` — registers all shipped adapters at import
├── README.md         # ← you are here
├── sdk/
│   └── base.ts       # SdkAttachment abstract (extends BaseAttachment)
├── claude-code/
│   ├── adapter.ts    # InteractiveAttachment extends BaseAttachment
│   └── index.ts      # exports `claudeCodeDescriptor`
└── copilot/
    ├── adapter.ts    # CopilotSdkAttachment extends SdkAttachment (dual entry point)
    └── index.ts      # exports `copilotDescriptor`
```

## Adapter classes

Two classes today (design §3.1, §4.1):

| Class         | Delivery model | Example adapters             | Base class          |
| ------------- | -------------- | ---------------------------- | ------------------- |
| `interactive` | push (MCP notification; doesn't block on LLM) | Claude Code CLI              | `BaseAttachment`    |
| `sdk`         | pull (blocks on LLM turn; pairs `processingStart`/`End`) | Copilot CLI, future headless-claude | `SdkAttachment`     |

Pick the class whose delivery model matches your agent's behavior. If the agent blocks on an LLM turn inside `deliver()`, you want `sdk` and `SdkAttachment` (PR-C centralizes the `processingStart`/`End` wrapping there).

## Reconnect opt-in (`shouldReconnect`)

**Added in #205 (v0.26).** `BaseAttachment` includes a built-in reconnect loop that fires when the phase watcher detects `phase=detached, currentAttachment=undefined` (lease revoked by the workflow — e.g. heartbeat-timeout after a laptop sleep). By default the loop is **disabled**; adapters opt in by overriding `shouldReconnect()`:

```ts
protected shouldReconnect(reason: DetachReason): boolean {
  // Return true to attempt re-claim instead of shutting down immediately.
  return reason === 'superseded' || reason === 'heartbeat-timeout';
}
```

**Shipped opt-ins:**
- `InteractiveAttachment` opts in for `'superseded'` and `'heartbeat-timeout'`.
- `CopilotSdkAttachment` (SDK adapters generally) does **not** opt in — pull adapters own their own session lifecycle.

**Budget and behaviour:** The loop retries with exponential back-off for up to **15 minutes** of elapsed wall time. On each attempt it calls `attachmentInfo` to verify the session isn't `'gone'` before attempting `claimAttachment`. If the budget expires or the workflow is `gone`, the adapter emits `DetachReason: 'reconnect-exhausted'` and shuts down cleanly.

Adapter authors should only opt in if the adapter can meaningfully re-establish state after a lease gap (i.e., the agent process is still alive and can resume work).

## Adding a new adapter

1. **Create a directory** under `src/adapters/<your-adapter>/` with `adapter.ts` and `index.ts`.

2. **Extend the right base class** in `adapter.ts`:

   ```ts
   import { BaseAttachment } from '../base';
   import type { AdapterDescriptor } from '../../types';
   import { myAdapterDescriptor } from './index';

   export class MyAttachment extends BaseAttachment {
     readonly descriptor: AdapterDescriptor = myAdapterDescriptor;
     // ... adapter-specific lifecycle
   }
   ```

   Use `SdkAttachment` instead of `BaseAttachment` if your adapter blocks on the LLM turn.

3. **Declare the descriptor** in `index.ts`:

   ```ts
   import type { AdapterDescriptor } from '../../types';

   export const myAdapterDescriptor: AdapterDescriptor = {
     adapterId: 'my-adapter',          // stable id — used in SessionMetadata.adapterId
     adapterClass: 'interactive',      // or 'sdk'
     blocksOnLLMTurn: false,           // true only if deliver() blocks on LLM turn
     heartbeatMs: 60_000,              // 60s for interactive; 30s for sdk per design §4.3
   };

   export { MyAttachment } from './adapter';
   ```

4. **Register with the registry** in `src/adapters/index.ts`:

   ```ts
   import { myAdapterDescriptor } from './my-adapter';
   registry.register(myAdapterDescriptor);
   ```

   One-line add. No workflow, no tool-surface, no server changes.

5. **Wire up recruit** if your adapter is selectable via the `agent:` field on `recruit`:

   - Extend `AgentType` in `src/types.ts` if needed (PR-D opens this up to an open string type bounded by the registry per design §4.7).
   - Extend `AdapterRegistry.resolveFromAgentType()` in `src/adapters/base.ts` to map your `agent:` value → `adapterId`.

6. **Run the test suite**: `npm test`. Existing 628 + 69 tests must stay green. PR-G adds the conformance suite (`test/adapter-conformance.test.ts`) that parameterizes over every registered descriptor — once that lands, your adapter needs to pass the nine conformance cases (design §4.5).

## Invariants

- **Never** add public methods to an adapter that `src/server.ts`, the workflow, or the MCP tools call directly. All cross-layer communication goes through the attachment wire protocol (PR-C) or — until PR-C — through the PR-A compat shim.
- **Never** resolve a workflow handle by ID alone — always pin `runId` (prevents the #102 zombie-resurrection hazard). PR-C centralizes this in `BaseAttachment`; until then, follow the pattern in `src/adapters/copilot/adapter.ts` (grep `pinnedRunId`).
- **Never** hardcode `'claude-code'` or `'copilot'` outside this directory. Callers resolve via `registry.get(metadata.adapterId ?? registry.resolveFromAgentType(metadata.agentType))`.

## What still sits outside this directory (and why)

- `src/spawn.ts` — cross-platform process spawning. Shipping adapters call into it. Future: a `descriptor.factory(ctx)` (design §4.2) lets the registry own this dispatch; PR-C+ territory.
- `src/workflows/session.ts` — the state machine that every adapter attaches to. Adapter code never lives in here; workflows are determinism-constrained.
- `src/tools/recruit.ts`, `src/tools/agent-types.ts` — MCP tool surface. These use the registry to *validate* and *list* descriptors; adapters don't add tools of their own.

## Design references

- `docs/design/session-lifecycle-rebuild-v2.md` §4 (adapter extensibility contract), §4.2 (locked-down interface + descriptor), §4.3 (lifecycle guarantees the base class owns), §4.5 (conformance suite), §4.6 (worked example: headless Claude SDK adapter).
- `docs/design/session-lifecycle-rebuild-v2-sequencing.md` §3 PR-B (this PR), §3 PR-C (lifecycle wiring).
