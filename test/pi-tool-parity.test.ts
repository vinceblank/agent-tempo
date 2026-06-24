/**
 * CI parity test (MD-B, Phase 1) — mirrors the wire-protocol drift detector.
 *
 * Asserts the MCP front-end (`renderToMcp`) and the Pi front-end (`renderToPi`)
 * register the IDENTICAL tool set, with identical required params, from the one
 * source of truth (`buildAllTempoTools`). Catches:
 *   (a) a tool that lands on only one front-end (drift),
 *   (b) a param required on one surface but not the other,
 *   (c) the zod→TypeBox converter hitting an unsupported construct (D1).
 *
 * Pure: deps are stubbed, handlers are NEVER invoked — only schema +
 * registration are captured. No Temporal, no Pi runtime, no network.
 *
 * Fidelity of the two complex conversions (evaluate_gate's nested
 * array-of-object, restart's scalar-union) is covered by the converter's own
 * unit tests (test/pi-zod-to-typebox.test.ts), per the architect's parity
 * scope — this test verifies name + required-level cross-front-end parity.
 */
import { expect } from 'chai';
import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { Config } from '../src/config';
import { buildAllTempoTools, type RegisterAllTempoToolsOpts } from '../src/server-tools';
import { renderToMcp } from '../src/tools/descriptor';
import { renderToPi } from '../src/pi/render-tools';
import type { ExtensionAPI, PiToolDefinition } from '../src/pi/pi-types';

/**
 * Stub opts. The `build*Tool` factories only CLOSE OVER these — they don't call
 * them at construction, and the parity test never invokes a handler. Conductor
 * = true so the 7 conductor-gated tools are included (full surface coverage).
 */
const STUB_OPTS: RegisterAllTempoToolsOpts = {
  client: {} as Client,
  config: {
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    taskQueue: 'agent-tempo',
    ensemble: 'test-ensemble-parity',
    defaultAgent: 'claude',
  } as Config,
  getPlayerId: () => 'test-player',
  setPlayerId: () => { /* no-op */ },
  handle: {} as WorkflowHandle,
  workflowId: 'agent-session-test-ensemble-parity-test-player',
  ownAgentType: 'claude',
  isConductor: true,
};

const CONDUCTOR_ONLY = [
  // #793 — `gate` is the canonical conductor-only tool; `quality_gate`/`gates`
  // are its forwarding aliases (also conductor-only).
  'gate', 'quality_gate', 'evaluate_gate', 'gates', 'worktree', 'stage', 'stages', 'cancel_stage',
];

/** Capture (name → zod param shape) from the MCP renderer via a fake server. */
function captureMcp(descriptors: ReturnType<typeof buildAllTempoTools>): Map<string, z.ZodRawShape> {
  const recorded = new Map<string, z.ZodRawShape>();
  const fakeServer = {
    tool: (name: string, _desc: unknown, params: z.ZodRawShape) => { recorded.set(name, params); },
  } as unknown as McpServer;
  renderToMcp(fakeServer, descriptors);
  return recorded;
}

/** Capture (name → TypeBox schema) from the Pi renderer via a fake ExtensionAPI. */
function capturePi(descriptors: ReturnType<typeof buildAllTempoTools>): {
  recorded: Map<string, { required?: string[] }>;
  converterError: unknown;
} {
  const recorded = new Map<string, { required?: string[] }>();
  let converterError: unknown = null;
  const fakePi = {
    on: () => { /* no-op */ },
    registerTool: (def: PiToolDefinition) => { recorded.set(def.name, def.parameters as { required?: string[] }); },
  } as unknown as ExtensionAPI;
  try {
    renderToPi(fakePi, descriptors);
  } catch (err) {
    converterError = err;
  }
  return { recorded, converterError };
}

/** Required param names from a zod shape = keys WITHOUT `.optional()`. */
function requiredFromZod(shape: z.ZodRawShape): string[] {
  return Object.keys(shape).filter((k) => !shape[k].isOptional()).sort();
}

/** Required param names from a TypeBox object schema = its `required` array. */
function requiredFromTypeBox(schema: { required?: string[] }): string[] {
  return [...(schema.required ?? [])].sort();
}

describe('Pi ↔ MCP tool front-end parity (MD-B)', () => {
  const descriptors = buildAllTempoTools(STUB_OPTS);
  const mcp = captureMcp(descriptors);
  const { recorded: pi, converterError } = capturePi(descriptors);

  it('zod→TypeBox converter raised no UnsupportedZodFeatureError on any tool', () => {
    // Re-throw so the failure message carries the offending `tool.field`.
    if (converterError) throw converterError;
    expect(converterError).to.equal(null);
  });

  it('builds the full tool surface (sanity floor)', () => {
    expect(descriptors.length).to.be.greaterThan(30);
    // No duplicate tool names in the descriptor list.
    const names = descriptors.map((d) => d.name);
    expect(new Set(names).size).to.equal(names.length);
  });

  it('MCP tool set ≡ Pi tool set (names)', () => {
    expect([...pi.keys()].sort()).to.deep.equal([...mcp.keys()].sort());
  });

  it('every descriptor is registered on BOTH front-ends', () => {
    for (const d of descriptors) {
      expect(mcp.has(d.name), `MCP missing tool: ${d.name}`).to.equal(true);
      expect(pi.has(d.name), `Pi missing tool: ${d.name}`).to.equal(true);
    }
  });

  it('required-param names match between zod (MCP) and TypeBox (Pi) per tool', () => {
    for (const d of descriptors) {
      const zodRequired = requiredFromZod(mcp.get(d.name)!);
      const tbRequired = requiredFromTypeBox(pi.get(d.name)!);
      expect(tbRequired, `required-param mismatch for "${d.name}"`).to.deep.equal(zodRequired);
    }
  });

  it('conductor-gated tools are excluded for non-conductor (gating parity)', () => {
    const nonConductor = buildAllTempoTools({ ...STUB_OPTS, isConductor: false });
    const names = new Set(nonConductor.map((d) => d.name));
    for (const gated of CONDUCTOR_ONLY) {
      expect(names.has(gated), `${gated} must be conductor-only`).to.equal(false);
    }
    // And conductor build DOES include them.
    const condNames = new Set(descriptors.map((d) => d.name));
    for (const gated of CONDUCTOR_ONLY) {
      expect(condNames.has(gated), `${gated} missing from conductor build`).to.equal(true);
    }
  });
});
