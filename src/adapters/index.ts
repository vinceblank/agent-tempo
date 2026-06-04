/**
 * Adapter registry bootstrap + barrel exports.
 *
 * Import side effect: registers every shipped adapter descriptor with the
 * singleton {@link registry}. Callers should:
 *
 * ```ts
 * import { registry } from './adapters';
 * const descriptor = registry.get(metadata.adapterId ?? registry.resolveFromAgentType(metadata.agentType));
 * ```
 *
 * Adding a new adapter is one line — import its descriptor here and call
 * `registry.register(...)`. See `src/adapters/README.md`.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§4.1–4.2.
 * Sequencing memo: §3 PR-B.
 */
import { AdapterRegistry } from './base';
import { claudeCodeDescriptor } from './claude-code';
import { copilotDescriptor } from './copilot';
import { claudeApiDescriptor } from './claude-api';
import { opencodeDescriptor } from './opencode';
import { claudeCodeHeadlessDescriptor } from './claude-code-headless';
import { piDescriptor } from './pi';
import { isDevMode } from '../config';

export const registry = new AdapterRegistry();

registry.register(claudeCodeDescriptor);
registry.register(copilotDescriptor);
// #131 Phase C — headless Claude API adapter. Always-registered (the optional
// `@anthropic-ai/sdk` dependency only matters at adapter spawn time; the
// descriptor itself has no SDK dependency, so the registry can list and
// resolve it even on hosts that haven't installed the SDK).
registry.register(claudeApiDescriptor);
// #449 Phase C — headless multi-provider OpenCode adapter. Always-registered
// for the same reason as claude-api: the optional `@opencode-ai/sdk` and the
// `opencode` binary only matter at adapter spawn time. The recruit pre-flight
// gates on both being available (or `force: true` to bypass).
registry.register(opencodeDescriptor);
// #520 — headless Claude Code adapter. Spawns the host's installed `claude`
// CLI as a per-turn subprocess; uses the operator's existing OAuth login so
// turns bill against subscription extra-usage credits (the only ToS-clean
// path to that pool for a third-party tool). Always-registered — the
// `claude` binary is a system binary, not an npm dep; recruit pre-flight
// probes for installation + login state via `pre-flight.ts`.
registry.register(claudeCodeHeadlessDescriptor);
// Phase 3a — headless Pi runtime. Registry/identity descriptor ONLY: the Pi
// extension singleton (Phase 2) owns the lifecycle, not a BaseAttachment driver
// (MD-D). Always-registered — the optional `@earendil-works/pi-coding-agent` SDK
// only matters at spawn time; recruit pre-flight gates on it (or `force: true`).
registry.register(piDescriptor);

/**
 * Canonical list of production adapters registered at module-import time.
 *
 * SSOT for the conformance test asserting every shipped adapter is present
 * in the registry (#486). Adding a new adapter is two adjacent touches in
 * this file: a `registry.register(...)` call above AND a new entry below.
 * The test (`test/conformance/registry.test.ts`) imports this constant and
 * compares it against `registry.all()`, so it catches BOTH "registered but
 * not declared canonical" AND "declared canonical but not registered"
 * drift. Mirrors the `AGENT_TYPES` tripwire in `src/types.ts`.
 *
 * Mock adapter is intentionally excluded — it's dev-mode-only and stripped
 * from the npm tarball at prepack time (ADR 0014 §7 gate 1).
 */
export const CANONICAL_ADAPTER_IDS = [
  'claude-code',
  'copilot',
  'claude-api',
  'opencode',
  'claude-code-headless',
  'pi',
] as const;

// ADR 0014 §7 gate 2 — import-time registration gate. The mock adapter's
// descriptor only enters the registry when `isDevMode()` is true.
//
// Synchronous (require) is intentional: the registry is the resolution
// surface every recruit / spawn / restart path consults, and they consult
// it inside the same Node.js tick the MCP server boots in. Doing this with
// dynamic `import()` would leave a window where `registry.get('mock')`
// throws "Unknown adapter" until the promise lands. Tests that want to
// flip dev mode mid-process can re-require this module after mutating
// `process.env.AGENT_TEMPO_DEV_MODE`.
//
// In production tarballs `dist/adapters/mock/` is excluded via the root
// `.npmignore` (gate 1). If a malicious / hand-edited install somehow has
// the file present AND `AGENT_TEMPO_DEV_MODE=1`, recruit-time rejection
// (gate 3) is the next line of defence.
if (isDevMode()) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mockDescriptor } = require('./mock') as typeof import('./mock');
    registry.register(mockDescriptor);
    console.error('[agent-tempo] DEV MODE: mock adapter registered');
  } catch (err) {
    // ADR 0014 §7 gate 1 strips `dist/adapters/mock/` from the published
    // tarball. If a user then sets `AGENT_TEMPO_DEV_MODE=1` against an
    // npm-installed agent-tempo, the require above fails — and that's
    // exactly the safety property we want. Log + continue so the rest of
    // the daemon boots normally; gate 3 (recruit-time rejection) catches
    // any later `agent: 'mock'` request with a clearer message.
    console.error(
      '[agent-tempo] DEV MODE: mock adapter unavailable in this build —',
      err instanceof Error ? err.message : err,
    );
  }
}

export { BaseAttachment, AdapterRegistry } from './base';
export { SdkAttachment } from './sdk/base';
export { InteractiveAttachment } from './claude-code';
export { CopilotSdkAttachment } from './copilot';
export { DirectApiAttachment } from './claude-api';
export { OpenCodeAttachment } from './opencode';
export { ClaudeCodeHeadlessAttachment } from './claude-code-headless';
export type { AdapterClass, AdapterDescriptor } from '../types';
