/**
 * Unit tests for PiWorkflowClient identity + claim wiring (src/pi/workflow-client.ts).
 *
 * Focus (P2-5):
 *   - `handle` getter that backs the D11 lazy proxy.
 *   - `updateSessionId` — persists the active Pi conversation id onto durable
 *     workflow metadata (`metadata.sessionId`), the MUTABLE resume pointer
 *     (separate from the fixed workflowId).
 *   - `claim` — fresh claim vs the restart/migrate handoff (renewal) branch when
 *     an `expectedAttachmentId` is supplied.
 *
 * Pure — a fake Client/handle records signals + updates; no Temporal, no Pi.
 */
import { expect } from 'chai';
import type { Client } from '@temporalio/client';
import type { Config } from '../src/config';
import type { SessionMetadata } from '../src/types';
import { PiWorkflowClient } from '../src/pi/workflow-client';
import { updateMetadataSignal } from '../src/workflows/signals';

interface RecordedSignal { def: unknown; arg: unknown; }
interface RecordedUpdate { def: unknown; args: unknown[]; }
interface Recorder { signals: RecordedSignal[]; updates: RecordedUpdate[]; }

const FAKE_TOKEN = {
  attachmentId: 'att-1',
  runId: 'run-1',
  expiresAt: '2026-01-01T00:01:30.000Z',
  leaseMs: 90_000,
};

/** A fake Client whose workflow.start() yields a handle recording signals + updates. */
function makeFakeClient(rec: Recorder): Client {
  const fakeHandle = {
    async signal(def: unknown, arg: unknown) { rec.signals.push({ def, arg }); },
    async executeUpdate(def: unknown, opts: { args: unknown[] }) {
      rec.updates.push({ def, args: opts.args });
      return FAKE_TOKEN;
    },
  };
  return { workflow: { async start() { return fakeHandle; } } } as unknown as Client;
}

const newRecorder = (): Recorder => ({ signals: [], updates: [] });

const CONFIG = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'agent-tempo',
  ensemble: 'test-ensemble-pi-wfclient',
  defaultAgent: 'claude',
} as Config;

const METADATA: SessionMetadata = {
  playerId: 'pi-tester',
  ensemble: 'test-ensemble-pi-wfclient',
  hostname: 'host',
  workDir: '/tmp',
  isConductor: false,
  agentType: 'claude',
  adapterId: 'pi',
};

describe('PiWorkflowClient — handle getter (D11 lazy-proxy backing)', () => {
  it('is null before ensureSessionWorkflow and the live handle after', async () => {
    const wf = new PiWorkflowClient({ client: makeFakeClient(newRecorder()), config: CONFIG, metadata: METADATA });
    expect(wf.handle).to.equal(null);
    await wf.ensureSessionWorkflow();
    expect(wf.handle).to.not.equal(null);
  });
});

describe('PiWorkflowClient — updateSessionId (P2-5 resume pointer)', () => {
  it('signals updateMetadata with the active Pi sessionId', async () => {
    const rec = newRecorder();
    const wf = new PiWorkflowClient({ client: makeFakeClient(rec), config: CONFIG, metadata: METADATA });
    await wf.ensureSessionWorkflow();
    await wf.updateSessionId('pi-session-abc');
    expect(rec.signals).to.have.length(1);
    expect(rec.signals[0].def).to.equal(updateMetadataSignal);
    expect(rec.signals[0].arg).to.deep.equal({ sessionId: 'pi-session-abc' });
  });

  it('is a no-op when the sessionId is undefined (no signal)', async () => {
    const rec = newRecorder();
    const wf = new PiWorkflowClient({ client: makeFakeClient(rec), config: CONFIG, metadata: METADATA });
    await wf.ensureSessionWorkflow();
    await wf.updateSessionId(undefined);
    expect(rec.signals).to.have.length(0);
  });
});

describe('PiWorkflowClient — claim (fresh vs handoff/renewal)', () => {
  it('fresh claim omits expectedAttachmentId', async () => {
    const rec = newRecorder();
    const wf = new PiWorkflowClient({ client: makeFakeClient(rec), config: CONFIG, metadata: METADATA });
    await wf.ensureSessionWorkflow();
    await wf.claim();
    expect(rec.updates).to.have.length(1);
    const arg = rec.updates[0].args[0] as Record<string, unknown>;
    expect(arg.adapterClass).to.equal('interactive');
    expect(arg.leaseMs).to.equal(90_000);
    expect(arg).to.not.have.property('expectedAttachmentId');
  });

  it('adopts via the renewal branch when a handoff expectedAttachmentId is supplied', async () => {
    const rec = newRecorder();
    const wf = new PiWorkflowClient({
      client: makeFakeClient(rec),
      config: CONFIG,
      metadata: METADATA,
      expectedAttachmentId: 'prior-attachment-xyz',
    });
    await wf.ensureSessionWorkflow();
    await wf.claim();
    const arg = rec.updates[0].args[0] as Record<string, unknown>;
    expect(arg.expectedAttachmentId).to.equal('prior-attachment-xyz');
  });
});
