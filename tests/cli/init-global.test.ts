/**
 * #818 — `init()` global path: the automated `up` flow must NOT print the stale
 * "Next steps" block, and a failed global MCP registration must SURFACE the captured
 * reason (not silently fall back). Exercises the real `init()` with `./mcp` and the
 * `claude`-path resolver mocked so both branches are deterministic without `claude`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mutable mock state for the MCP module, flipped per test.
const mcpState = {
  globalRegistered: false,
  mcpConfigured: false,
  addResult: { ok: true } as { ok: boolean; error?: string },
};

vi.mock('../../src/cli/mcp', () => ({
  isGlobalMcpRegistered: () => mcpState.globalRegistered,
  isMcpConfigured: () => mcpState.mcpConfigured,
  addGlobalMcp: () => mcpState.addResult,
  removeGlobalMcp: () => true,
}));

// Keep every other spawn export real; only force the claude-path resolver so init()
// does not bail at the "claude binary not found" branch.
vi.mock('../../src/spawn', async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  resolveClaudePath: () => '/fake/path/to/claude',
}));

import { init } from '../../src/cli/commands';

describe('init() global path — #818 suppression + error surfacing', () => {
  let tmpDir: string;
  let logged: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-init-global-818-'));
    logged = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    mcpState.globalRegistered = false;
    mcpState.mcpConfigured = false;
    mcpState.addResult = { ok: true };
  });
  afterEach(() => {
    logSpy.mockRestore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const output = () => logged.join('\n');

  it('Test A: success + suppressNextSteps=true (up path) → NO "Next steps" / no manual text', async () => {
    mcpState.addResult = { ok: true };
    await init({ dir: tmpDir, suppressNextSteps: true });
    expect(output()).toContain('Registered agent-tempo globally');
    expect(output()).not.toContain('Next steps');
    expect(output()).not.toContain('temporal server start-dev');
    expect(output()).not.toContain('agent-tempo conduct');
  });

  it('Test B: success WITHOUT the flag (manual init) → SHOWS "Next steps"', async () => {
    mcpState.addResult = { ok: true };
    await init({ dir: tmpDir });
    expect(output()).toContain('Next steps');
  });

  it('Test F: global registration fails → fallback SURFACES the captured error reason', async () => {
    mcpState.addResult = { ok: false, error: 'user scope config not writable\n(second line ignored)' };
    await init({ dir: tmpDir, suppressNextSteps: true });
    // Fell back to a project .mcp.json...
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(true);
    // ...and the WHY is surfaced (first line), not silently eaten.
    expect(output()).toContain('Failed to register globally');
    expect(output()).toContain('user scope config not writable');
    // Still suppressed in the up path.
    expect(output()).not.toContain('Next steps');
  });

  it('already-registered short-circuit → no add attempt, no "Next steps"', async () => {
    mcpState.globalRegistered = true;
    await init({ dir: tmpDir, suppressNextSteps: true });
    expect(output()).toContain('already registered');
    expect(output()).not.toContain('Next steps');
  });
});

describe('up() → init() call-site — #818 (Test C: flag is wired, breaks on regression)', () => {
  it('the up() MCP-config step calls init with suppressNextSteps: true', () => {
    // A source-level call-site lock: the up() flow has already started Temporal +
    // the conductor, so it MUST pass suppressNextSteps. Asserting on the source keeps
    // this a unit-level guarantee that breaks if the call-site regresses, without
    // standing up the full Temporal/ensureInfra path that up() otherwise requires.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'cli', 'commands.ts'),
      'utf8',
    );
    const callSite = /await\s+init\(\s*\{[^}]*suppressNextSteps:\s*true[^}]*\}\s*\)/;
    expect(callSite.test(src)).toBe(true);
  });
});
