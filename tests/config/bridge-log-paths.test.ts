/**
 * Unit tests for #690 central bridge-log relocation — bridgeLogPaths /
 * bridgeLogsRoot / resolveAdapterPidFile (src/config.ts). The load-bearing
 * property: the SPAWNER and the READERS compute the SAME pid path, and the
 * ADAPTER writes the spawner-passed path (ENV.PID_FILE) rather than re-deriving
 * its own — so no split-brain orphan.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import {
  AGENT_TEMPO_HOME,
  ENV,
  bridgeLogPaths,
  bridgeLogsRoot,
  resolveAdapterPidFile,
} from '../../src/config';
import { isSecretKey } from '../../src/utils/secrets';

afterEach(() => { delete process.env[ENV.PID_FILE]; });

describe('bridgeLogPaths (#690)', () => {
  it('defaults to the CENTRAL ~/.agent-tempo/logs/<ensemble>/<player>.{log,pid}', () => {
    const r = bridgeLogPaths('pitest', 'tempo-eng');
    expect(r.dir).toBe(join(AGENT_TEMPO_HOME, 'logs', 'pitest'));
    expect(r.logPath).toBe(join(r.dir, 'tempo-eng.log'));
    expect(r.pidPath).toBe(join(r.dir, 'tempo-eng.pid'));
  });

  it('overrideDir wins over the central default (the per-spawn logDir escape hatch)', () => {
    const r = bridgeLogPaths('pitest', 'tempo-eng', '/custom/logdir');
    expect(r.dir).toBe('/custom/logdir');
    expect(r.pidPath).toBe(join('/custom/logdir', 'tempo-eng.pid'));
  });

  it('bridgeLogsRoot is the parent of every ensemble dir (single source for the "logs" segment)', () => {
    expect(bridgeLogsRoot()).toBe(join(AGENT_TEMPO_HOME, 'logs'));
    expect(bridgeLogPaths('e', 'p').dir).toBe(join(bridgeLogsRoot(), 'e'));
  });

  it('rejects path-traversal in ensemble or player (defensive guard)', () => {
    for (const bad of ['../etc', 'a/b', 'a\\b', '..']) {
      expect(() => bridgeLogPaths(bad, 'p'), `ensemble="${bad}"`).toThrow();
      expect(() => bridgeLogPaths('e', bad), `player="${bad}"`).toThrow();
    }
  });
});

describe('resolveAdapterPidFile — split-brain killed by construction (#690)', () => {
  it('returns ENV.PID_FILE verbatim when set, IGNORING the fallback id (the headline guard)', () => {
    // Spawner computed this path for player "tempo-eng" and passed it via the env.
    const spawnerPidPath = bridgeLogPaths('pitest', 'tempo-eng').pidPath;
    process.env[ENV.PID_FILE] = spawnerPidPath;
    // Adapter calls with a DIVERGENT fallback ("copilot-12345" — the old split-brain
    // identifier). It MUST still write the spawner's path, not re-derive its own.
    const adapterPidPath = resolveAdapterPidFile('pitest', 'copilot-12345');
    expect(adapterPidPath).toBe(spawnerPidPath);
  });

  it('falls back to bridgeLogPaths only when ENV.PID_FILE is unset (manual launch)', () => {
    delete process.env[ENV.PID_FILE];
    expect(resolveAdapterPidFile('pitest', 'tempo-eng')).toBe(
      bridgeLogPaths('pitest', 'tempo-eng').pidPath,
    );
  });

  it('writer (spawner) pidPath === reader pidPath for the same (ensemble, player)', () => {
    // The spawner writes bridgeLogPaths(e,p).pidPath; getBridgePidInfo / hard-terminate
    // read bridgeLogPaths(e,p).pidPath — identical by construction (single helper).
    const writer = bridgeLogPaths('pitest', 'tempo-eng').pidPath;
    const reader = bridgeLogPaths('pitest', 'tempo-eng').pidPath;
    expect(reader).toBe(writer);
  });
});

describe('ENV.PID_FILE is PLAIN, not a secret (#689/#690 partition guard)', () => {
  it('isSecretKey(AGENT_TEMPO_PID_FILE) is false — stays inline, never routed to the secret file', () => {
    expect(ENV.PID_FILE).toBe('AGENT_TEMPO_PID_FILE');
    expect(isSecretKey(ENV.PID_FILE)).toBe(false);
  });
});
