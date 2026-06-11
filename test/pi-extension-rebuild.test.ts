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
import type {
  ExtensionAPI,
  PiOutboundMessage,
  PiCustomMessageOptions,
  PiCommandOptions,
  PiCommandContext,
} from '../src/pi/pi-types';
import piExtension, {
  createPiExtension,
  __setPiClientFactoryForTests,
  __resetPiRuntimesForTests,
  __getPiRuntimeForTests,
} from '../src/pi/extension';
import {
  claimAttachmentUpdate,
  adapterExitedSignal,
  pendingMessagesQuery,
  pendingResetQuery,
  pendingIntakeQuery,
  markDeliveredSignal,
} from '../src/workflows/signals';
import type { Message } from '../src/types';
import { ENV, getConfig, sessionWorkflowId } from '../src/config';
import { buildServerInstructions, type BuildServerInstructionsOpts } from '../src/server-tools';

interface Recorded { def: unknown; arg: unknown; }
interface Recorder { updates: Recorded[]; signals: Recorded[]; }

const TOKEN = { attachmentId: 'att-1', runId: 'run-1', expiresAt: '2026-01-01T00:01:30.000Z', leaseMs: 90_000 };

/** A mutable cue queue the fake workflow serves to the cue pump's `fetchPending`. */
interface PendingBox { cues: Message[]; }

function makeFakeClient(rec: Recorder, pendingBox: PendingBox = { cues: [] }): Client {
  const fakeHandle = {
    async executeUpdate(def: unknown, opts: { args: unknown[] }) {
      rec.updates.push({ def, arg: opts.args[0] });
      return TOKEN;
    },
    async signal(def: unknown, arg: unknown) {
      rec.signals.push({ def, arg });
      // markDelivered → the workflow stops re-serving those cues.
      if (def === markDeliveredSignal) pendingBox.cues = [];
    },
    async query(def: unknown) {
      if (def === pendingMessagesQuery) return pendingBox.cues;
      if (def === pendingResetQuery) return null;
      // T0.3 (#750) — the extension's pump now reads the combined intake.
      if (def === pendingIntakeQuery) return { messages: pendingBox.cues, pendingReset: null };
      return undefined;
    },
  };
  return { workflow: { async start() { return fakeHandle; } } } as unknown as Client;
}

interface FakePi {
  pi: ExtensionAPI;
  fire: (event: string, payload: unknown) => unknown;
  /** Recorded pi.sendMessage(msg, opts) calls (the #677 primary cue route). */
  sent: Array<{ msg: PiOutboundMessage; opts?: PiCustomMessageOptions }>;
  /** Recorded pi.sendUserMessage(content) calls (the #677 escalation route). */
  userSent: string[];
  /** Event names this instance has an `on(...)` handler for. */
  registered: () => string[];
  /** Registered slash commands by name (#677 PART B — /tempo-reset). */
  commands: Map<string, PiCommandOptions>;
}

/** Fake ExtensionAPI capturing on-handlers + the #677 send/command surface; `fire` invokes a handler. */
function makeFakePi(): FakePi {
  const handlers = new Map<string, (p: unknown) => unknown>();
  const commands = new Map<string, PiCommandOptions>();
  const sent: Array<{ msg: PiOutboundMessage; opts?: PiCustomMessageOptions }> = [];
  const userSent: string[] = [];
  const pi = {
    on: (event: string, h: (p: unknown) => unknown) => { handlers.set(event, h); },
    registerTool: () => { /* no-op */ },
    registerCommand: (name: string, options: PiCommandOptions) => { commands.set(name, options); },
    sendMessage: (msg: PiOutboundMessage, opts?: PiCustomMessageOptions) => { sent.push({ msg, opts }); },
    sendUserMessage: (content: string) => { userSent.push(content); },
  } as unknown as ExtensionAPI;
  return { pi, fire: (event, payload) => handlers.get(event)?.(payload), sent, userSent, registered: () => [...handlers.keys()], commands };
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

describe('Pi extension — #677 post-switch tick uses the NEW pi (cue inject + inner-loop)', () => {
  const PLAYER = 'pi-rebind-inject-test';
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = PLAYER; });
  afterEach(() => { __resetPiRuntimesForTests(); delete process.env[ENV.PLAYER_NAME]; });

  const mkCue = (over: Partial<Message> = {}): Message => ({
    id: 'c1', from: 'tempo-lead', text: 'status?', timestamp: '2026-01-01T00:00:00.000Z',
    delivered: false, ...over,
  });

  it('after a rebind, the cue pump injects through pi2 AND the InnerLoopPublisher rebound to pi2', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    const pendingBox: PendingBox = { cues: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec, pendingBox));

    // Instance #1 — first attach. ROOT-CAUSE shape: interactive session_start
    // carries NO `session` field (Pi 0.78.1) — the cue pump must NOT depend on it.
    const pi1 = makeFakePi();
    piExtension(pi1.pi);
    await pi1.fire('session_start', { reason: 'new' });
    expect(claimCount(rec)).to.equal(1);

    // Pi rebuilds the instance on a session switch → fresh piExtension(pi2) + session_start.
    const pi2 = makeFakePi();
    piExtension(pi2.pi);
    await pi2.fire('session_start', { reason: 'fork' });
    expect(claimCount(rec), 'rebind, not re-claim').to.equal(1);

    const workflowId = sessionWorkflowId(getConfig().ensemble, PLAYER);
    const rt = __getPiRuntimeForTests(workflowId);
    expect(rt, 'runtime survived the rebuild').to.not.equal(undefined);

    // (A) rt.pi repointed to the NEW instance's pi.
    expect(rt!.pi, 'runtime pi repointed to pi2').to.equal(pi2.pi);

    // (B) InnerLoopPublisher rebound to pi2 — pub.start(pi2) re-registered its
    // observers on the new instance (message_update is a publisher-only handler).
    expect(pi2.registered(), 'publisher rebound onto pi2').to.include('message_update');

    // (C) A post-switch cue-pump TICK injects through pi2, NOT the stale pi1.
    pendingBox.cues = [mkCue({ text: 'after switch' })];
    await rt!.pump.tick();
    expect(pi2.sent.map((s) => s.msg.content), 'cue injected via pi2.sendMessage')
      .to.deep.equal(['[cue from tempo-lead] after switch']);
    expect(pi1.sent, 'stale pi1 never used after the switch').to.have.length(0);
    // Operator-vs-peer D10 semantics preserved on the pi.sendMessage route.
    expect(pi2.sent[0].opts).to.deep.equal({ deliverAs: 'followUp', triggerTurn: true });
  });
});

describe('Pi extension — /tempo-reset command (#677 PART B)', () => {
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = 'pi-reset-cmd-test'; });
  afterEach(() => { __resetPiRuntimesForTests(); delete process.env[ENV.PLAYER_NAME]; });

  it('interactive registers /tempo-reset whose handler clean-wipes via ctx.newSession()', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const p = makeFakePi();
    createPiExtension({ mode: 'interactive' })(p.pi);

    const cmd = p.commands.get('tempo-reset');
    expect(cmd, 'tempo-reset registered in interactive mode').to.not.equal(undefined);

    let newSessionCalls = 0;
    const ctx: PiCommandContext = {
      newSession: async () => { newSessionCalls += 1; return { cancelled: false }; },
    };
    await cmd!.handler('', ctx);
    expect(newSessionCalls, 'handler clean-wipes via ctx.newSession()').to.equal(1);
  });

  it('headless does NOT register /tempo-reset (no operator command surface)', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const p = makeFakePi();
    createPiExtension({ mode: 'headless' })(p.pi);
    expect(p.commands.has('tempo-reset')).to.equal(false);
  });
});

describe('Pi extension — Option-C reason-discriminated teardown', () => {
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = 'pi-teardown-test'; });
  afterEach(() => { __resetPiRuntimesForTests(); delete process.env[ENV.PLAYER_NAME]; });

  it("session_shutdown reason='quit' → graceful detach (adapterExited alone)", async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    await a.fire('session_shutdown', { reason: 'quit' });

    // adapterExited alone collapses any live phase → detached (no requestDetach
    // needed for a self-exit; matches BaseAttachment.stopV2Lifecycle).
    expect(signalCount(rec, adapterExitedSignal)).to.equal(1);
  });

  it("session_shutdown reason='new' (switch) → NO detach", async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    await a.fire('session_shutdown', { reason: 'new' });

    expect(signalCount(rec, adapterExitedSignal)).to.equal(0);
  });

  it('session_shutdown with an UNKNOWN reason → NO detach (allowlist default)', async () => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const a = makeFakePi();
    piExtension(a.pi);
    await a.fire('session_start', { session: { id: 's1' }, reason: 'new' });
    await a.fire('session_shutdown', { reason: 'some-future-reason' });

    expect(signalCount(rec, adapterExitedSignal)).to.equal(0);
  });
});

describe('Pi extension — no tool_call permission handler (full tool surface)', () => {
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = 'pi-gate-test'; });
  afterEach(() => { __resetPiRuntimesForTests(); delete process.env[ENV.PLAYER_NAME]; });

  // Both Pi permission layers (MD-C toolAccess + MD-G operator gate) were
  // REMOVED (docs/design/pi-streamline-gate-removal-cc.md): a headless Pi player
  // runs the full tool surface — incl. shell — like every other adapter. This
  // locks the absence: no tool_call handler is registered in either mode.
  function fireFor(mode: 'headless' | 'interactive') {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const p = makeFakePi();
    createPiExtension({ mode })(p.pi);
    return async (toolName: string): Promise<{ block?: boolean } | undefined> =>
      (await p.fire('tool_call', { toolName })) as { block?: boolean } | undefined;
  }

  it('headless: installs NO tool_call handler — bash/shell are not blocked', async () => {
    const fire = fireFor('headless');
    for (const t of ['bash', 'shell', 'exec', 'powershell', 'read', 'write', 'cue']) {
      expect(await fire(t), `tool=${t}`).to.equal(undefined); // no handler registered
    }
  });

  it('interactive: installs NO tool_call handler', async () => {
    const fire = fireFor('interactive');
    expect(await fire('bash')).to.equal(undefined); // no handler registered
  });
});

describe('Pi extension — #698 before_agent_start FULL server-instruction preamble', () => {
  const PLAYER = 'pi-preamble-test';
  beforeEach(() => { process.env[ENV.PLAYER_NAME] = PLAYER; });
  afterEach(() => {
    __resetPiRuntimesForTests();
    delete process.env[ENV.PLAYER_NAME];
    delete process.env[ENV.CONDUCTOR];
    delete process.env[ENV.PLAYER_TYPE];
  });

  /**
   * Mirror of extension.ts `piInstructionOpts()` — used by the single-source
   * containment lock to call the canonical builder with the SAME opts the handler
   * builds per-fire. PLAYER_NAME is set in beforeEach (no set_name) so playerId =
   * PLAYER and hasRequestedName = true.
   */
  const optsFor = (isConductor: boolean): BuildServerInstructionsOpts => ({
    ensemble: getConfig().ensemble,
    playerId: PLAYER,
    isConductor,
    playerType: process.env[ENV.PLAYER_TYPE] || undefined,
    hasRequestedName: Boolean(process.env[ENV.PLAYER_NAME]),
  });

  /** Build the extension, fire before_agent_start, return the resulting systemPrompt. */
  const fireBefore = (mode: 'interactive' | 'headless', base?: string): string => {
    const rec: Recorder = { updates: [], signals: [] };
    __setPiClientFactoryForTests(async () => makeFakeClient(rec));
    const p = makeFakePi();
    createPiExtension({ mode })(p.pi);
    const payload = base === undefined ? {} : { systemPrompt: base };
    const result = p.fire('before_agent_start', payload) as { systemPrompt: string };
    return result.systemPrompt;
  };

  it('appends the FULL preamble (identity + ensemble + playerId + guidance); base preserved', () => {
    const out = fireBefore('interactive', 'BASE PROMPT');
    expect(out).to.contain('BASE PROMPT');                  // base kept
    expect(out).to.contain('You are part of the');          // identity framing
    expect(out).to.contain(getConfig().ensemble);           // ensemble name
    expect(out).to.contain(PLAYER);                         // playerId
    expect(out).to.contain('cue');                          // cue/report/recruit guidance
    expect(out).to.contain('report');
    expect(out).to.contain('recruit');
    expect(out).to.contain('Communication discipline');
    // Yield-norms STILL present — they live INSIDE buildServerInstructions now (#695 S1).
    expect(out).to.contain('there is nothing to poll');
  });

  it('non-conductor → "Player rules" branch (CONDUCTOR unset)', () => {
    const out = fireBefore('interactive', 'BASE');
    expect(out).to.contain('Player rules');
    expect(out).to.not.contain('Operational rules');
  });

  it('conductor → "Operational rules" branch (CONDUCTOR=1)', () => {
    process.env[ENV.CONDUCTOR] = '1';
    const out = fireBefore('interactive', 'BASE');
    expect(out).to.contain('Operational rules');
    expect(out).to.not.contain('Player rules');
  });

  it('handles a missing systemPrompt + applies to headless too', () => {
    const out = fireBefore('headless', undefined);
    expect(out).to.contain('You are part of the');
    expect(out).to.contain('Communication discipline');
  });

  it('SINGLE-SOURCE: appended content CONTAINS buildServerInstructions(sameOpts) verbatim', () => {
    // The anti-drift lock (the point of #698): Pi injects the canonical builder
    // output, not a copy. Assert containment for BOTH role branches.
    const outPlayer = fireBefore('interactive', 'BASE PROMPT');
    expect(outPlayer).to.contain(buildServerInstructions(optsFor(false)));

    process.env[ENV.CONDUCTOR] = '1';
    const outConductor = fireBefore('interactive', 'BASE PROMPT');
    expect(outConductor).to.contain(buildServerInstructions(optsFor(true)));
  });
});
