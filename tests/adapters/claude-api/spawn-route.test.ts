/**
 * `spawnProcess` switch regression test (#131 PR-fixup).
 *
 * QA on PR #455 caught the load-bearing miss: `agent: 'claude-api'` fell
 * through `spawnProcess`'s `if/else if/else` to the terminal Claude Code
 * spawn path because there was no claude-api branch. The adapter unit
 * tests + typecheck + lint all passed because the integration seam between
 * `spawn.ts` ↔ `outbox.ts` ↔ `session.ts` had no test surface — every
 * component was correct in isolation but the wiring missed.
 *
 * This test pins the routing decision at the boundary: it stubs the three
 * spawn helpers with recording shims and asserts that each `agent` value
 * lands on its expected helper. Adding a new adapter without wiring the
 * spawn switch will fail this test, not silently spawn the wrong process.
 *
 * Source-level rather than runtime because we don't want to actually spawn
 * detached Node processes from a unit test. The check that matters is "the
 * switch routes the right way", and that's a function-shape contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as spawnModule from '../../../src/spawn';
import { createOutboxActivities, type SpawnProcessInput } from '../../../src/activities/outbox';
import type { Config } from '../../../src/config';
import type { Client } from '@temporalio/client';

/**
 * Build a SpawnProcessInput with the minimum fields the activity reads.
 * Only the `agent` discriminant matters for the routing test.
 */
function spawnInput(overrides: Partial<SpawnProcessInput> & { agent: SpawnProcessInput['agent'] }): SpawnProcessInput {
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

describe('spawnProcess — adapter routing switch (#131 PR-fixup)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('agent: "claude-api" routes to spawnClaudeApiAdapter (NOT spawnInTerminal)', async () => {
    // The original PR #455 bug: this case fell through to spawnInTerminal,
    // silently launching an interactive Claude Code session. Pin it.
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter').mockReturnValue({ pid: 9999, logPath: '/tmp/x.log', pidPath: '/tmp/x.pid' });
    const terminalSpy = vi.spyOn(spawnModule, 'spawnInTerminal').mockReturnValue({ pid: 8888 } as ReturnType<typeof spawnModule.spawnInTerminal>);
    const copilotSpy = vi.spyOn(spawnModule, 'spawnCopilotBridge').mockReturnValue({ pid: 7777, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    const result = await activities.spawnProcess(spawnInput({ agent: 'claude-api', model: 'claude-opus-4-7' }));

    expect(result.success).toBe(true);
    expect(claudeApiSpy).toHaveBeenCalledTimes(1);
    expect(terminalSpy).not.toHaveBeenCalled();
    expect(copilotSpy).not.toHaveBeenCalled();
    // Forward the model into the helper so AGENT_TEMPO_API_MODEL gets set.
    expect(claudeApiSpy.mock.calls[0][0]).toMatchObject({
      name: 'tempo-test',
      ensemble: 'test-ensemble',
      model: 'claude-opus-4-7',
    });
  });

  it('agent: "copilot" routes to spawnCopilotBridge', async () => {
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });
    const terminalSpy = vi.spyOn(spawnModule, 'spawnInTerminal').mockReturnValue({ pid: 0 } as ReturnType<typeof spawnModule.spawnInTerminal>);
    const copilotSpy = vi.spyOn(spawnModule, 'spawnCopilotBridge').mockReturnValue({ pid: 7777, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    await activities.spawnProcess(spawnInput({ agent: 'copilot' }));

    expect(copilotSpy).toHaveBeenCalledTimes(1);
    expect(claudeApiSpy).not.toHaveBeenCalled();
    expect(terminalSpy).not.toHaveBeenCalled();
  });

  it('agent: "claude" routes to spawnInTerminal (default Claude Code path)', async () => {
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });
    const terminalSpy = vi.spyOn(spawnModule, 'spawnInTerminal').mockReturnValue({ pid: 8888 } as ReturnType<typeof spawnModule.spawnInTerminal>);
    const copilotSpy = vi.spyOn(spawnModule, 'spawnCopilotBridge').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    await activities.spawnProcess(spawnInput({ agent: 'claude' }));

    expect(terminalSpy).toHaveBeenCalledTimes(1);
    expect(claudeApiSpy).not.toHaveBeenCalled();
    expect(copilotSpy).not.toHaveBeenCalled();
  });

  it('agent: "opencode" routes to spawnOpenCodeAdapter (NOT spawnInTerminal) — #449 Phase C', async () => {
    // Same regression class as the claude-api PR-fixup test above: without
    // a dedicated branch in `spawnProcess`, `agent: 'opencode'` would fall
    // through to spawnInTerminal and silently launch a Claude Code session.
    // Pin the routing decision at the boundary.
    const openCodeSpy = vi.spyOn(spawnModule, 'spawnOpenCodeAdapter').mockReturnValue({ pid: 9999, logPath: '/tmp/oc.log', pidPath: '/tmp/oc.pid' });
    const terminalSpy = vi.spyOn(spawnModule, 'spawnInTerminal').mockReturnValue({ pid: 8888 } as ReturnType<typeof spawnModule.spawnInTerminal>);
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });
    const copilotSpy = vi.spyOn(spawnModule, 'spawnCopilotBridge').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    const result = await activities.spawnProcess(spawnInput({ agent: 'opencode', model: 'anthropic/claude-opus-4-7' }));

    expect(result.success).toBe(true);
    expect(openCodeSpy).toHaveBeenCalledTimes(1);
    expect(terminalSpy).not.toHaveBeenCalled();
    expect(claudeApiSpy).not.toHaveBeenCalled();
    expect(copilotSpy).not.toHaveBeenCalled();
    // Forward the model into the helper so AGENT_TEMPO_OPENCODE_MODEL gets set.
    expect(openCodeSpy.mock.calls[0][0]).toMatchObject({
      name: 'tempo-test',
      ensemble: 'test-ensemble',
      model: 'anthropic/claude-opus-4-7',
    });
  });

  it('agent: "pi" with model routes to spawnPiHeadless and forwards model', async () => {
    // Same regression class: without model in the pi outbox entry, the
    // model arg would be silently dropped and the player would fall back
    // to AGENT_TEMPO_PI_MODEL / Pi default instead of the requested model.
    const piSpy = vi.spyOn(spawnModule, 'spawnPiHeadless').mockReturnValue({ pid: 9999, logPath: '/tmp/pi.log', pidPath: '/tmp/pi.pid' });
    const terminalSpy = vi.spyOn(spawnModule, 'spawnInTerminal').mockReturnValue({ pid: 8888 } as ReturnType<typeof spawnModule.spawnInTerminal>);
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });
    const copilotSpy = vi.spyOn(spawnModule, 'spawnCopilotBridge').mockReturnValue({ pid: 0, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    const result = await activities.spawnProcess(spawnInput({ agent: 'pi', model: 'lmstudio/qwen/qwen3.6-27b' }));

    expect(result.success).toBe(true);
    expect(piSpy).toHaveBeenCalledTimes(1);
    expect(terminalSpy).not.toHaveBeenCalled();
    expect(claudeApiSpy).not.toHaveBeenCalled();
    expect(copilotSpy).not.toHaveBeenCalled();
    // Model must be forwarded so AGENT_TEMPO_PI_MODEL gets set on the subprocess.
    expect(piSpy.mock.calls[0][0]).toMatchObject({
      name: 'tempo-test',
      ensemble: 'test-ensemble',
      model: 'lmstudio/qwen/qwen3.6-27b',
    });
  });

  it('forwards attachmentId/runId/adapterId to spawnClaudeApiAdapter for restart handoff', async () => {
    // PR-D attachment renewal path — restart pre-claims and threads the
    // token through to the spawn so the adapter `startV2Lifecycle`s with
    // the renewal branch.
    const claudeApiSpy = vi.spyOn(spawnModule, 'spawnClaudeApiAdapter').mockReturnValue({ pid: 9999, logPath: '', pidPath: '' });

    const activities = createOutboxActivities(client, config);
    await activities.spawnProcess(spawnInput({
      agent: 'claude-api',
      model: 'claude-opus-4-7',
      attachmentId: 'attach-abc',
      attachmentRunId: 'run-xyz',
      adapterId: 'claude-api',
    }));

    expect(claudeApiSpy.mock.calls[0][0]).toMatchObject({
      attachmentId: 'attach-abc',
      attachmentRunId: 'run-xyz',
      adapterId: 'claude-api',
    });
  });
});
