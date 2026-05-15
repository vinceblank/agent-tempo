/**
 * `spawnProcess` switch regression test for the claude-code-headless
 * adapter. Mirrors `tests/adapters/claude-api/spawn-route.test.ts`
 * (#131 PR-fixup) — the same load-bearing wiring miss that bit
 * claude-api would silently fall through `spawnProcess`'s switch and
 * launch a terminal Claude Code session if PR-2 missed adding the
 * branch. Pin the routing decision at the boundary.
 *
 * Source-level rather than runtime: the actual spawn helper is mocked
 * so unit tests don't fork detached Node processes. The check that
 * matters is "the switch routes the right way", which is a pure
 * function-shape contract.
 *
 * Issue #520 PR-2.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as spawnModule from '../../../src/spawn';
import { createOutboxActivities, type SpawnProcessInput } from '../../../src/activities/outbox';
import type { Config } from '../../../src/config';
import type { Client } from '@temporalio/client';

function spawnInput(
  overrides: Partial<SpawnProcessInput> & { agent: SpawnProcessInput['agent'] },
): SpawnProcessInput {
  return {
    targetName: 'tempo-test',
    workDir: '/tmp/test',
    isConductor: false,
    ensemble: 'test-ensemble',
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    ...overrides,
  };
}

const config = {
  ensemble: 'test-ensemble',
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'agent-tempo-test',
} as unknown as Config;

const client = {} as Client;

describe('spawnProcess — claude-code-headless routing (#520 PR-2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('agent: "claude-code-headless" routes to spawnClaudeCodeHeadlessAdapter (NOT spawnInTerminal)', async () => {
    const cchSpy = vi.spyOn(spawnModule, 'spawnClaudeCodeHeadlessAdapter')
      .mockReturnValue({ pid: 9999, logPath: '/tmp/x.log', pidPath: '/tmp/x.pid' });
    const terminalSpy = vi.spyOn(spawnModule, 'spawnInTerminal')
      .mockReturnValue({ pid: 8888 } as ReturnType<typeof spawnModule.spawnInTerminal>);
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter')
      .mockReturnValue({ pid: 0, logPath: '', pidPath: '' });
    const opencodeSpy = vi.spyOn(spawnModule, 'spawnOpenCodeAdapter')
      .mockReturnValue({ pid: 0, logPath: '', pidPath: '' });
    const copilotSpy = vi.spyOn(spawnModule, 'spawnCopilotBridge')
      .mockReturnValue({ pid: 0, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    const result = await activities.spawnProcess(spawnInput({ agent: 'claude-code-headless' }));

    expect(result.success).toBe(true);
    expect(cchSpy).toHaveBeenCalledTimes(1);
    expect(terminalSpy).not.toHaveBeenCalled();
    expect(claudeApiSpy).not.toHaveBeenCalled();
    expect(opencodeSpy).not.toHaveBeenCalled();
    expect(copilotSpy).not.toHaveBeenCalled();
    expect(cchSpy.mock.calls[0][0]).toMatchObject({
      name: 'tempo-test',
      ensemble: 'test-ensemble',
    });
  });

  it('forwards permissionMode through the spawn helper', async () => {
    const cchSpy = vi.spyOn(spawnModule, 'spawnClaudeCodeHeadlessAdapter')
      .mockReturnValue({ pid: 9999, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    await activities.spawnProcess(spawnInput({
      agent: 'claude-code-headless',
      permissionMode: 'bypassPermissions',
    }));

    expect(cchSpy.mock.calls[0][0]).toMatchObject({
      permissionMode: 'bypassPermissions',
    });
  });

  it('forwards dangerouslySkipPermissions through the spawn helper', async () => {
    const cchSpy = vi.spyOn(spawnModule, 'spawnClaudeCodeHeadlessAdapter')
      .mockReturnValue({ pid: 9999, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    await activities.spawnProcess(spawnInput({
      agent: 'claude-code-headless',
      dangerouslySkipPermissions: true,
    }));

    expect(cchSpy.mock.calls[0][0]).toMatchObject({
      dangerouslySkipPermissions: true,
    });
  });

  it('forwards attachmentId/runId/adapterId for restart handoff', async () => {
    const cchSpy = vi.spyOn(spawnModule, 'spawnClaudeCodeHeadlessAdapter')
      .mockReturnValue({ pid: 9999, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    await activities.spawnProcess(spawnInput({
      agent: 'claude-code-headless',
      attachmentId: 'attach-cch-abc',
      attachmentRunId: 'run-cch-xyz',
      adapterId: 'claude-code-headless',
    }));

    expect(cchSpy.mock.calls[0][0]).toMatchObject({
      attachmentId: 'attach-cch-abc',
      attachmentRunId: 'run-cch-xyz',
      adapterId: 'claude-code-headless',
    });
  });

  it('warns and continues when allowedTools is set (claude-code-headless ignores per-tool allowlists)', async () => {
    // Mirror the claude-api/opencode adapters' behavior — claude-code-headless
    // inherits the full Claude Code tool surface; per-recruit allowedTools
    // would imply gating that this adapter doesn't perform. Log + skip.
    const cchSpy = vi.spyOn(spawnModule, 'spawnClaudeCodeHeadlessAdapter')
      .mockReturnValue({ pid: 9999, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    const result = await activities.spawnProcess(spawnInput({
      agent: 'claude-code-headless',
      allowedTools: ['Bash', 'Read'],
    }));

    expect(result.success).toBe(true);
    expect(cchSpy).toHaveBeenCalledTimes(1);
  });
});
