/**
 * #672 regression: spawnCopilotBridge must set AGENT_TEMPO_NO_PPID_WATCHDOG=1 in
 * the detached bridge's env ONLY when the spawner is the transient CLI conductor
 * (noPpidWatchdog: true) — so the bridge skips the ppid-poll that would self-kill
 * it when the short-lived `up` CLI exits. The daemon-recruit spawn (no opt) must
 * NOT set it, preserving the #604 anti-leak ppid-poll for recruited players.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { spawnCopilotBridge } from '../../../src/spawn';
import { ENV } from '../../../src/config';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fakeChild = () => ({
  pid: 4321,
  unref: () => {},
  stderr: { on: () => {} },
  stdout: { on: () => {} },
});

/** The env handed to the (mocked) child_process.spawn on the most recent call. */
function spawnedEnv(): Record<string, string> {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0][2].env as Record<string, string>;
}

const baseOpts = () => ({
  name: 'copilot-c',
  ensemble: 'demo',
  temporalAddress: 'localhost:7233',
  workDir: mkdtempSync(join(tmpdir(), 'ct-672-')),
});

describe('spawnCopilotBridge — #672 ppid-poll flag', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });

  it('SETS AGENT_TEMPO_NO_PPID_WATCHDOG=1 for a transientSpawner CLI spawn (conductor OR lineup player)', () => {
    spawnCopilotBridge({ ...baseOpts(), isConductor: true, transientSpawner: true });
    expect(spawnedEnv()[ENV.NO_PPID_WATCHDOG]).toBe('1');
  });

  it('SETS the flag for a transientSpawner lineup-PLAYER spawn (#672 matrix gap — isConductor:false)', () => {
    spawnCopilotBridge({ ...baseOpts(), isConductor: false, transientSpawner: true });
    expect(spawnedEnv()[ENV.NO_PPID_WATCHDOG]).toBe('1');
  });

  it('does NOT set the flag for a daemon-recruit spawn (no transientSpawner) — keeps #604 ppid-poll', () => {
    spawnCopilotBridge({ ...baseOpts(), isConductor: false });
    expect(spawnedEnv()[ENV.NO_PPID_WATCHDOG]).toBeUndefined();
  });
});
