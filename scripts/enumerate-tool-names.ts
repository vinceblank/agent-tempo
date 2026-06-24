/**
 * enumerate-tool-names.ts — emit the authoritative MCP tool-name list.
 *
 * Prints a JSON array of every tool name `buildAllTempoTools()` actually
 * registers (conductor-inclusive), to stdout. Consumed by
 * `scripts/check-surface-drift.js` so the surface-drift gate diffs against the
 * REAL registered descriptors rather than a source-regex scrape (#793 §6).
 *
 * Why build-based, not regex: the #793 tool-family merge adds canonical tools
 * plus forwarding aliases. A regex that keys on `name: '...', description:`
 * silently under-counts any alias authored outside that exact shape — a
 * #707-class "scans nothing, reports clean" hazard. Enumerating from the build
 * output is immune to authoring style: if a tool is registered, it's counted.
 *
 * The build factories close over their deps (client / handle / config / …) but
 * never dereference them at CONSTRUCTION — they're only used inside async
 * handlers — so stub deps are safe here. We pass `isConductor: true` to include
 * the conductor-only tools (gate / stage / worktree / evaluate_gate).
 *
 * Run via `npx tsx scripts/enumerate-tool-names.ts`. Determinism note: this is a
 * dev/CI tool, not workflow code — `Date.now()`/etc. are irrelevant here.
 */
import { buildAllTempoTools, type RegisterAllTempoToolsOpts } from '../src/server-tools';

// Minimal stubs — construction-only; handlers (which would use these) never run.
const stubOpts = {
  client: {} as never,
  config: {
    ensemble: 'drift-probe',
    taskQueue: 'drift-probe',
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    defaultAgent: 'claude',
  } as never,
  getPlayerId: () => 'drift-probe',
  setPlayerId: () => { /* no-op */ },
  handle: {} as never,
  workflowId: 'drift-probe',
  ownAgentType: 'claude',
  defaultAgentSource: undefined,
  isConductor: true,
} as unknown as RegisterAllTempoToolsOpts;

const names = buildAllTempoTools(stubOpts).map((t) => t.name);
process.stdout.write(JSON.stringify(names));
