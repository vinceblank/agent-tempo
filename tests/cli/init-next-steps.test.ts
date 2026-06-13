/**
 * #818 — the automated `up` flow printed a stale "Next steps" block (start
 * Temporal / start conductor) even though `up` had ALREADY started Temporal and
 * launched the conductor. `initProject` (and `init`) now take a `suppressNextSteps`
 * flag that `up` sets true; the manual `agent-tempo init` verb leaves it unset so
 * the guidance still shows.
 *
 * `initProject` only touches the filesystem + stdout (no `claude` shell-out), so
 * the gate is unit-testable directly by capturing console.log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initProject } from '../../src/cli/commands';

describe('initProject — #818 suppressNextSteps gate', () => {
  let tmpDir: string;
  let logged: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-init-818-'));
    logged = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const output = () => logged.join('\n');

  it('still creates .mcp.json regardless of the flag', () => {
    initProject(tmpDir, true);
    const mcpPath = path.join(tmpDir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(cfg.mcpServers['agent-tempo']).toEqual({ command: 'agent-tempo-server' });
  });

  it('suppressNextSteps=true (the `up` path) → NO "Next steps" block', () => {
    initProject(tmpDir, true);
    expect(output()).not.toContain('Next steps');
    expect(output()).not.toContain('agent-tempo conduct');
  });

  it('suppressNextSteps=false → SHOWS the "Next steps" block (manual setup)', () => {
    initProject(tmpDir, false);
    expect(output()).toContain('Next steps');
    expect(output()).toContain('agent-tempo conduct');
  });

  it('omitted flag (the manual `init` verb default) → SHOWS "Next steps"', () => {
    initProject(tmpDir);
    expect(output()).toContain('Next steps');
  });
});
