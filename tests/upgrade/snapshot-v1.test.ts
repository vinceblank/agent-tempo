/**
 * Unit coverage for the `upgrade-to-2` snapshot schema + persistence
 * (issue #785). This module is the cross-release INTERFACE consumed by the
 * 2.0-side `up --from-upgrade` (#786), so the contract — version pinning,
 * round-trip fidelity, atomic writes, and the validation guards that protect
 * the 2.0 reader from a corrupt continuity file — is tested directly.
 *
 * Pure: fs round-trips happen in an isolated `os.tmpdir()` sandbox; no
 * Temporal, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  UPGRADE_SNAPSHOT_VERSION,
  SNAPSHOT_FILENAME,
  UPGRADE_PHASES,
  phaseRank,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
  stampPhase,
  validateSnapshot,
  SnapshotValidationError,
  type UpgradeSnapshot,
} from '../../src/upgrade/snapshot-v1';

/** A minimal, valid snapshot for round-trip + mutation tests. */
function sampleSnapshot(overrides: Partial<UpgradeSnapshot> = {}): UpgradeSnapshot {
  return {
    version: UPGRADE_SNAPSHOT_VERSION,
    createdAt: '2026-06-12T00:00:00.000Z',
    cliVersion: '1.8.0',
    phase: 'snapshot',
    ensembles: [
      {
        name: 'default',
        description: 'the main ensemble',
        schedules: [
          {
            name: 'standup',
            message: 'daily standup',
            target: 'conductor',
            createdBy: 'operator',
            type: 'cron',
            nextFireAt: '2026-06-13T09:00:00.000Z',
            cronExpression: '0 9 * * 1-5',
            timezone: 'America/New_York',
          },
        ],
        players: [
          {
            playerId: 'tempo-lead',
            playerType: 'tempo-soloist',
            agentType: 'claude',
            part: 'building the upgrade verb',
            workDir: '/repo',
            hostname: 'box-1',
            gitRoot: '/repo',
            sessionId: 'sess-abc',
            model: 'anthropic/claude-opus-4-7',
            isConductor: false,
            stateSlots: { handoff: 'pick up at phase 4' },
            undeliveredMessages: [
              {
                id: 'm1',
                from: 'tempo-qa',
                text: 'please rebase',
                timestamp: '2026-06-12T00:00:00.000Z',
                isMaestro: false,
                attachmentTicket: 'tkt-1',
              },
            ],
          },
        ],
        droppedCoatCheckCount: 2,
      },
    ],
    ...overrides,
  };
}

describe('snapshot-v1 — constants + phase ordering', () => {
  it('pins the schema version + canonical filename', () => {
    expect(UPGRADE_SNAPSHOT_VERSION).toBe(1);
    expect(SNAPSHOT_FILENAME).toBe('upgrade-snapshot-v1.json');
  });

  it('orders the six phases preflight→done', () => {
    expect(UPGRADE_PHASES).toEqual([
      'preflight', 'pause', 'drain', 'snapshot', 'destroy', 'done',
    ]);
  });

  it('phaseRank is monotonic and supports resume comparisons', () => {
    expect(phaseRank('preflight')).toBe(0);
    expect(phaseRank('snapshot')).toBeLessThan(phaseRank('destroy'));
    expect(phaseRank('destroy')).toBeLessThan(phaseRank('done'));
    // Unknown phase → -1 (used by validateSnapshot to reject).
    expect(phaseRank('bogus' as never)).toBe(-1);
  });
});

describe('snapshot-v1 — persistence round-trip', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tempo-upgrade-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('snapshotPath joins home + canonical filename', () => {
    expect(snapshotPath(home)).toBe(join(home, SNAPSHOT_FILENAME));
  });

  it('readSnapshot returns null when no file exists', () => {
    expect(readSnapshot(home)).toBeNull();
  });

  it('write then read returns a deep-equal snapshot', () => {
    const snap = sampleSnapshot();
    writeSnapshot(home, snap);
    expect(existsSync(snapshotPath(home))).toBe(true);
    expect(readSnapshot(home)).toEqual(snap);
  });

  it('writeSnapshot creates the home dir if missing', () => {
    const nested = join(home, 'a', 'b');
    writeSnapshot(nested, sampleSnapshot());
    expect(readSnapshot(nested)).toEqual(sampleSnapshot());
  });

  it('writeSnapshot leaves no .tmp sibling behind (atomic rename)', () => {
    writeSnapshot(home, sampleSnapshot());
    expect(existsSync(`${snapshotPath(home)}.tmp`)).toBe(false);
  });

  it('persists newline-terminated pretty JSON', () => {
    writeSnapshot(home, sampleSnapshot());
    const raw = readFileSync(snapshotPath(home), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  '); // 2-space indent
  });
});

describe('snapshot-v1 — stampPhase', () => {
  it('returns a copy with the advanced phase, leaving the original intact', () => {
    const snap = sampleSnapshot({ phase: 'snapshot' });
    const stamped = stampPhase(snap, 'destroy');
    expect(stamped.phase).toBe('destroy');
    expect(snap.phase).toBe('snapshot'); // pure — original unmutated
    // Everything else preserved by reference-spread.
    expect(stamped.ensembles).toBe(snap.ensembles);
  });
});

describe('snapshot-v1 — validateSnapshot guards', () => {
  it('accepts a well-formed snapshot and returns it', () => {
    const snap = sampleSnapshot();
    expect(validateSnapshot(snap)).toBe(snap);
  });

  it('rejects a non-object', () => {
    expect(() => validateSnapshot(null)).toThrow(SnapshotValidationError);
    expect(() => validateSnapshot(42)).toThrow(/not an object/);
  });

  it('rejects an unknown version (the 2.0 reader must refuse loudly)', () => {
    expect(() => validateSnapshot(sampleSnapshot({ version: 2 as never })))
      .toThrow(/unsupported version/);
  });

  it('rejects a missing/unknown phase', () => {
    expect(() => validateSnapshot(sampleSnapshot({ phase: 'mid-air' as never })))
      .toThrow(/phase/);
  });

  it('rejects when ensembles is not an array', () => {
    expect(() => validateSnapshot(sampleSnapshot({ ensembles: {} as never })))
      .toThrow(/ensembles/);
  });

  it('rejects an ensemble missing its name', () => {
    const bad = sampleSnapshot();
    delete (bad.ensembles[0] as Record<string, unknown>).name;
    expect(() => validateSnapshot(bad)).toThrow(/ensembles\[0\]\.name/);
  });

  it('rejects a player missing stateSlots', () => {
    const bad = sampleSnapshot();
    delete (bad.ensembles[0].players[0] as Record<string, unknown>).stateSlots;
    expect(() => validateSnapshot(bad)).toThrow(/stateSlots/);
  });

  it('rejects a player whose undeliveredMessages is not an array', () => {
    const bad = sampleSnapshot();
    (bad.ensembles[0].players[0] as Record<string, unknown>).undeliveredMessages = null;
    expect(() => validateSnapshot(bad)).toThrow(/undeliveredMessages/);
  });
});

describe('snapshot-v1 — readSnapshot error surfacing', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tempo-upgrade-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('throws SnapshotValidationError on non-JSON content', () => {
    writeFileSync(snapshotPath(home), 'not json at all', 'utf8');
    expect(() => readSnapshot(home)).toThrow(/not valid JSON/);
  });

  it('throws SnapshotValidationError on a structurally invalid file', () => {
    writeFileSync(snapshotPath(home), JSON.stringify({ version: 1 }), 'utf8');
    expect(() => readSnapshot(home)).toThrow(SnapshotValidationError);
  });

  it('error message includes the file path as the source', () => {
    writeFileSync(snapshotPath(home), JSON.stringify({ version: 99 }), 'utf8');
    expect(() => readSnapshot(home)).toThrow(new RegExp(SNAPSHOT_FILENAME.replace('.', '\\.')));
  });
});
