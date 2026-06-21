/**
 * #786 — unit tests for `up --from-upgrade` recreation logic.
 *
 * `planRecreation` / `collectUndeliveredCues` / `archiveSnapshot` are pure;
 * `runFromUpgrade` is exercised against a fake Temporal client (a `start` spy)
 * and a temp home dir so no Temporal test environment is needed.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowIdConflictPolicy } from '@temporalio/client';
import {
  planRecreation,
  collectUndeliveredCues,
  archiveSnapshot,
  runFromUpgrade,
  CONSUMED_SNAPSHOT_FILENAME,
} from '../src/upgrade/from-upgrade';
import {
  writeSnapshot,
  snapshotPath,
  UPGRADE_SNAPSHOT_VERSION,
  type UpgradeSnapshot,
} from '../src/upgrade/snapshot-v1';
import {
  conductorWorkflowId,
  sessionWorkflowId,
  maestroWorkflowId,
} from '../src/config';
import { PROTOCOL_VERSION } from '../src/constants';
import { MEMO_KEYS } from '../src/utils/search-attributes';

function sampleSnapshot(): UpgradeSnapshot {
  return {
    version: UPGRADE_SNAPSHOT_VERSION,
    createdAt: '2026-06-20T00:00:00.000Z',
    cliVersion: '1.7.0',
    phase: 'done',
    ensembles: [
      {
        name: 'team',
        schedules: [],
        players: [
          {
            playerId: 'conductor',
            agentType: 'claude',
            part: 'Conductor session',
            workDir: '/w/c',
            hostname: 'h1',
            isConductor: true,
            stateSlots: {},
            undeliveredMessages: [],
          },
          {
            playerId: 'alice',
            playerType: 'tempo-soloist',
            agentType: 'claude',
            part: 'Engineer',
            workDir: '/w/a',
            hostname: 'h1',
            gitRoot: '/w/a',
            // Continuity fields that MUST NOT be seeded by the MVP:
            sessionId: 'sess-xyz',
            model: 'claude-opus-4-7',
            stateSlots: { foo: 'bar' },
            undeliveredMessages: [
              { id: 'm1', from: 'conductor', text: 'do the thing', timestamp: '2026-06-20T00:00:00.000Z' },
            ],
            isConductor: false,
          },
        ],
      },
    ],
  };
}

const planOpts = {
  hostname: 'h1',
  taskQueue: 'agent-tempo',
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
};

describe('#786 up --from-upgrade — planRecreation', () => {
  it('recreates a maestro + one session per roster player', () => {
    const specs = planRecreation(sampleSnapshot(), planOpts);
    const ids = specs.map((s) => s.workflowId);
    expect(ids).to.include(maestroWorkflowId('team'));
    expect(ids).to.include(conductorWorkflowId('team'));
    expect(ids).to.include(sessionWorkflowId('team', 'alice'));
    expect(specs).to.have.lengthOf(3);
  });

  it('routes the conductor to the conductor workflow id with isConductor memo', () => {
    const specs = planRecreation(sampleSnapshot(), planOpts);
    const cond = specs.find((s) => s.workflowId === conductorWorkflowId('team'))!;
    expect(cond.workflowType).to.equal('agentSessionWorkflow');
    expect(cond.memo[MEMO_KEYS.isConductor]).to.equal(true);
  });

  it('stamps protocol-2 in the memo of every recreated workflow', () => {
    const specs = planRecreation(sampleSnapshot(), planOpts);
    for (const s of specs) {
      expect(s.memo[MEMO_KEYS.protocol]).to.equal(PROTOCOL_VERSION);
    }
  });

  it('sets ensemble/playerId search attributes on sessions', () => {
    const specs = planRecreation(sampleSnapshot(), planOpts);
    const alice = specs.find((s) => s.workflowId === sessionWorkflowId('team', 'alice'))!;
    expect(alice.searchAttributes.AgentTempoEnsemble).to.deep.equal(['team']);
    expect(alice.searchAttributes.AgentTempoPlayerId).to.deep.equal(['alice']);
  });

  it('does NOT seed continuity (sessionId / model / state slots) — that is the fast-follow', () => {
    const specs = planRecreation(sampleSnapshot(), planOpts);
    const alice = specs.find((s) => s.workflowId === sessionWorkflowId('team', 'alice'))!;
    const input = (alice.args as unknown as [{ metadata: Record<string, unknown> }])[0];
    expect(input.metadata.sessionId, 'sessionId must not be seeded').to.equal(undefined);
    expect(input.metadata.model, 'model must not be seeded').to.equal(undefined);
    // No state-slot content leaks into the spec memo.
    expect(JSON.stringify(alice.memo)).to.not.contain('bar');
  });
});

describe('#786 up --from-upgrade — collectUndeliveredCues', () => {
  it('surfaces undelivered cues flattened across the roster', () => {
    const cues = collectUndeliveredCues(sampleSnapshot());
    expect(cues).to.have.lengthOf(1);
    expect(cues[0]).to.deep.include({ ensemble: 'team', playerId: 'alice', from: 'conductor' });
  });
});

describe('#786 up --from-upgrade — archive + runFromUpgrade', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fromupg-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('archiveSnapshot renames the snapshot to .consumed.json', () => {
    writeSnapshot(home, sampleSnapshot());
    expect(fs.existsSync(snapshotPath(home))).to.equal(true);
    const archived = archiveSnapshot(home);
    expect(fs.existsSync(snapshotPath(home))).to.equal(false);
    expect(fs.existsSync(archived)).to.equal(true);
    expect(path.basename(archived)).to.equal(CONSUMED_SNAPSHOT_FILENAME);
  });

  it('recreates every workflow and archives on full success', async () => {
    writeSnapshot(home, sampleSnapshot());
    const starts: { type: string; conflict: unknown }[] = [];
    const fakeClient = {
      workflow: {
        start: async (type: string, opts: { workflowIdConflictPolicy: unknown }) => {
          starts.push({ type, conflict: opts.workflowIdConflictPolicy });
        },
      },
    } as never;

    const res = await runFromUpgrade(fakeClient, { home, ...planOpts });

    expect(res.ok).to.equal(true);
    expect(res.snapshotFound).to.equal(true);
    expect(res.workflowsCreated).to.equal(3);
    expect(res.ensemblesRecreated).to.equal(1);
    expect(res.undeliveredCues).to.have.lengthOf(1);
    expect(res.archived).to.equal(true);
    expect(starts).to.have.lengthOf(3);
    // Idempotent re-run posture.
    expect(starts.every((s) => s.conflict === WorkflowIdConflictPolicy.USE_EXISTING)).to.equal(true);
    // Snapshot was archived, not left in place.
    expect(fs.existsSync(snapshotPath(home))).to.equal(false);
    expect(fs.existsSync(path.join(home, CONSUMED_SNAPSHOT_FILENAME))).to.equal(true);
  });

  it('leaves the snapshot PRISTINE on partial failure', async () => {
    writeSnapshot(home, sampleSnapshot());
    let n = 0;
    const fakeClient = {
      workflow: {
        start: async () => {
          n++;
          if (n === 2) throw new Error('temporal flap');
        },
      },
    } as never;

    const res = await runFromUpgrade(fakeClient, { home, ...planOpts });

    expect(res.ok).to.equal(false);
    expect(res.failures.length).to.be.greaterThan(0);
    expect(res.archived).to.equal(false);
    // Snapshot still present for retry.
    expect(fs.existsSync(snapshotPath(home))).to.equal(true);
    expect(fs.existsSync(path.join(home, CONSUMED_SNAPSHOT_FILENAME))).to.equal(false);
  });

  it('reports snapshotFound=false when there is no snapshot', async () => {
    const fakeClient = { workflow: { start: async () => {} } } as never;
    const res = await runFromUpgrade(fakeClient, { home, ...planOpts });
    expect(res.snapshotFound).to.equal(false);
    expect(res.ok).to.equal(false);
    expect(res.workflowsCreated).to.equal(0);
  });
});
