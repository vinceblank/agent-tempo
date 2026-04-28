/**
 * Headless Claude API adapter — SDK class.
 *
 * Issue #131 Phase C. Uses the Anthropic Messages API directly via
 * `@anthropic-ai/sdk` — no terminal, no Claude Code CLI, headless from
 * spawn to detach. Mirrors the Copilot bridge structure: detached Node
 * subprocess, dual-purpose entry point (class import vs `require.main`
 * self-exec), `claimAttachment` + heartbeat lifecycle inherited from
 * `SdkAttachment`.
 *
 * Class hierarchy: `DirectApiAttachment extends SdkAttachment extends BaseAttachment`.
 * Concrete adapter overrides `invokeSdk` (the LLM turn loop), `onSuperseded`
 * (AbortController.abort), and the descriptor; everything else (claim,
 * heartbeat, phase watcher, `processingStart`/`End` pairing, `markDelivered`)
 * is free.
 *
 * **This file ships in commits across the #131 Phase C PR:**
 *   - Commit 1 (this commit): wire scaffold — descriptor + optional-dep
 *     guard + barrel export so the registry can register the descriptor.
 *     The class itself is a thin stub — `run()` throws "not yet
 *     implemented" so commit 1 still type-checks and tests still pass.
 *   - Commits 2–4: MCP bridge, lifecycle, tool-use loop.
 *
 * Design reference: `docs/design/131-claude-api-adapter.md` §0 (TL;DR), §2
 * (adapter precedents), §3 (spawn integration), §6 (cancellation + lifecycle),
 * §8 (engineer-facing skeleton). Verification addendum (2026-04-28) for
 * landmines applied to commit 4.
 */
import type { AdapterDescriptor } from '../../types';
import { SdkAttachment } from '../sdk/base';

/**
 * Descriptor for the claude-api adapter. Kept colocated with the class so
 * `adapter.ts` has no import dependency on `index.ts` (breaks the circular
 * module-graph cycle that QA flagged on copilot's PR-B). `index.ts` re-exports
 * this constant alongside the class.
 *
 * Design reference: docs/design/131-claude-api-adapter.md §2 + ADR 0012.
 */
export const claudeApiDescriptor: AdapterDescriptor = {
  adapterId: 'claude-api',
  adapterClass: 'sdk',
  // messages.create blocks on the LLM turn — processingStart/End pairing is
  // mandatory and provided by SdkAttachment.deliver().
  blocksOnLLMTurn: true,
  // SDK class — 30s cadence per design doc + lifecycle-rebuild-v2 §4.3.
  // Inherited from BaseAttachment's heartbeat loop via the descriptor.
  heartbeatMs: 30_000,
};

// Optional dependency — must be installed separately: npm install @anthropic-ai/sdk
// Mirrors the Copilot pattern: when run as the adapter subprocess entry point,
// print an actionable error and exit. When imported by the registry during
// normal MCP server startup, stay silent — the SDK is optional and non-API
// users should see no noise.
let Anthropic: unknown;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Anthropic = require('@anthropic-ai/sdk').default;
} catch {
  if (require.main === module) {
    console.error(
      'Error: @anthropic-ai/sdk is not installed.\n' +
      'Install it with: npm install @anthropic-ai/sdk\n' +
      'Or recruit with a different agent (claude / copilot).',
    );
    process.exit(1);
  }
}

/**
 * SDK-class adapter for the Anthropic Messages API.
 *
 * Delivery model is pull-based (blocks on LLM turn): the adapter polls the
 * workflow for pending messages, runs a tool-use loop against the Messages
 * API, and acks via `markDelivered`. `processingStart`/`End` are paired
 * around each blocking turn so the workflow's stale detection doesn't
 * misclassify a long tool-call sequence as a dead session.
 *
 * Commit 1 ships only the class identity (descriptor + run() stub). The
 * tool-use loop, in-process MCP bridge, and lifecycle wiring land in
 * commits 2–4 of #131 Phase C.
 */
export class DirectApiAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = claudeApiDescriptor;

  /**
   * Lease-revocation hook — fired by `SdkAttachment` when the base-class
   * phase watcher detects another claimant stole the attachment. Aborts the
   * in-flight `messages.create` via the AbortController wired in
   * `invokeSdk`. Filled in commit 3.
   */
  protected onSuperseded(): void {
    // No active controller in commit 1 — implemented in commit 3.
  }

  /**
   * Subprocess entry point. Filled in commits 2–4 with: in-process MCP
   * bridge boot, `startV2Lifecycle` claim + runId pin, poll loop, tool-use
   * loop, graceful-detach handlers.
   */
  async run(): Promise<void> {
    throw new Error(
      'DirectApiAttachment.run() not yet implemented — commits 2–4 of #131 Phase C wire the lifecycle + tool-use loop.',
    );
  }
}

if (require.main === module) {
  if (!Anthropic) {
    // The optional-dep guard above already exited — this is unreachable in
    // practice but kept for type-narrowing safety on the self-exec path.
    process.exit(1);
  }
  new DirectApiAttachment().run().catch((err) => {
    console.error('[claude-tempo:claude-api]', 'Fatal error:', err);
    process.exit(1);
  });
}
