/**
 * Tests the module-scope singleton invariant (Phase 2): Pi rebuilds the
 * extension INSTANCE on every SessionManager switch, so the attachment + lease +
 * heartbeat must SURVIVE the rebuild in the module-scope runtime map — a switch
 * RE-BINDS, it must NOT re-claim or duplicate the heartbeat.
 *
 * Also covers the Option-C reason-discriminated teardown: detach only on a clean
 * `quit`; switch reasons (and unknown reasons) do NOT detach.
 *
 * Pure — a fake Client/handle + fake ExtensionAPI; the connection factory is
 * injected via the test hook. No Temporal, no Pi.
 */
import { expect } from 'chai';
import type { Client } from '@temporalio/client';
import type { ExtensionAPI } from '../src/pi/pi-types';
import piExtension, {
  __setPiClientFactoryForTests,
  __resetPiRuntimesForTests,
} from '../src/pi/extension';
import {
  claimAttachmentUpdate,
  requestDetachSignal,
  adapterExitedSignal,
} from '../src/workflows/signals';
import { ENV } from '../src/config';

interface Recorded { def: unknown; arg: unknown; }
interface Recorder { updates: Recorded[]; signals: Recorded[]; }

const TOKEN = { attachmentId: 'att-1', runId: 'run-1', expiresAt: '2026-01-01T00:01:30.000Z', leaseMs: 90_000 };

function makeFakeClient(rec: Recorder): Client {
  const fakeHandle = {
    async executeUpdate(def: unknown, opts: { args: unknown[] }) {
      rec.updates.push({ def, arg: opts.args[0] });
      return TOKEN;
    },
    async signal(def: unknown, arg: unknown) { rec.signals.push({ def, arg }); },
  };
  return { workflow: { async start() { return fakeHandle; } } } as unknown as Client;
}

/** Fake ExtensionAPI capturing on-handlers; `fire` invokes one and returns its (possibly async) result. */
function makeFakePi(): { pi: ExtensionAPI; fire: (event: string, payload: unknown) => unknown } {
  const handlers = new Map<string, (p: unknown) => unknown>();
  const pi = {
    on: (event: string, h: (p: unknown) => unknown) => { handlers.set(event, h); },
    registerTool: () => { /* no-op */ },
  } as unknown as ExtensionAPI;
  return { pi, fire: (event, payload) => handlers.get(event)?.(payload) };
}

const claimCount = (rec: Recorder): number =>
  rec.updates.filter((u) => u.def === claimAttachmentUpdate).length;
const signalCount = (rec: Recorder, def: unknown): number =>
  rec.signals.filter((s) => s.def === def).length;

describe('Pi extension — module-scope singleton survives instance rebuild', () => {
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = 'pi-rebuild-test'; });
  afterEach(() => { __resetPiRuntimesForTests(); delete process.env[ENV.PLAYER_NAME]; });

  it('a second session_start (instance rebuild) RE-BINDS — exactly ONE claim, no re-claim', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));

    // Instance #1 — first attach.
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    expect(claimCount(rec)).to.equal(1); // claimed once

    // Pi rebuilds the instance on a switch → a fresh piExtension(pi2) + session_start.
    const b = makeFakePi();
    piExtension(b.pi);
    await b.fire('session_start', { session: { id: 's2' }, reason: 'fork' });

    // THE invariant: the rebuild re-bound to the surviving runtime — NO second claim.
    expect(claimCount(rec)).to.equal(1);
  });

  it('refreshes the resume pointer (metadata.sessionId) across the rebind, but never re-claims', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));

    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });

    const b = makeFakePi();
    piExtension(b.pi);
    await b.fire('session_start', { session: { id: 's2' }, reason: 'resume' });

    // sessionId persisted for BOTH conversations (resume pointer follows the switch)…
    expect(rec.signals.length).to.be.greaterThan(0);
    // …but still only one attachment claim total.
    expect(claimCount(rec)).to.equal(1);
  });
});

describe('Pi extension — Option-C reason-discriminated teardown', () => {
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = 'pi-teardown-test'; });
  afterEach(() => { __resetPiRuntimesForTests(); delete process.env[ENV.PLAYER_NAME]; });

  it("session_shutdown reason='quit' → graceful detach (requestDetach + adapterExited)", async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    await a.fire('session_shutdown', { reason: 'quit' });

    expect(signalCount(rec, requestDetachSignal)).to.equal(1);
    expect(signalCount(rec, adapterExitedSignal)).to.equal(1);
  });

  it("session_shutdown reason='new' (switch) → NO detach", async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    await a.fire('session_shutdown', { reason: 'new' });

    expect(signalCount(rec, requestDetachSignal)).to.equal(0);
    expect(signalCount(rec, adapterExitedSignal)).to.equal(0);
  });

  it('session_shutdown with an UNKNOWN reason → NO detach (allowlist default)', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    await a.fire('session_shutdown', { reason: 'some-future-reason' });

    expect(signalCount(rec, requestDetachSignal)).to.equal(0);
    expect(signalCount(rec, adapterExitedSignal)).to.equal(0);
  });
});
