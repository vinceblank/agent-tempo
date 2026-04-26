/**
 * #258 — adapter post-CAN double-loop silence.
 *
 * Pre-#258 the reconnect-loop pre-check fired `fireTerminal('destroy')` on
 * the FIRST terminal-class error from `unpinned.query(attachmentInfoQuery)`.
 * Because `isTerminalWorkflowError` matches phrasings (`WorkflowNotFound`,
 * `NOT_FOUND`, `"workflow execution already completed"`) that ALSO surface
 * from transient gRPC blips, a single momentary visibility-API hiccup was
 * enough to permanently orphan an otherwise-healthy adapter:
 *
 *   - `terminalFired = true` blocks heartbeat + watcher reschedules.
 *   - `onReconnectStart` (called at the top of `runReconnectLoop`) tore
 *     down the poller before the pre-check even ran.
 *   - The `onTerminal` listener in `claude-code/adapter.ts` fired and
 *     re-stopped the poller permanently.
 *
 * Result: one final `markDelivered` then 11.5 hours of silence — the
 * smoking-gun symptom from the spike on `claude-session-tempo-impl-conductor`
 * run `0d17dc0f-90fb-487a-a068-0c1f1111ebc3`.
 *
 * The fix adds a `describe()` tiebreaker. These tests assert:
 *
 *   1. Pre-check terminal-class error + describe() returns `RUNNING` →
 *      treat as transient, continue loop (DO NOT fire destroy).
 *   2. Pre-check terminal-class error + describe() returns a terminal
 *      status (`COMPLETED`, `TERMINATED`, etc.) → fire destroy.
 *   3. Pre-check terminal-class error + describe() itself throws →
 *      fire destroy (consistent with pre-#258 semantics for ambiguity).
 *   4. Pre-check terminal-class error + describe() exceeds the 3s timeout
 *      → fire destroy (don't hang the reconnect path).
 *   5. Pre-check non-terminal error → still goes through the existing
 *      transient path (sanity check that we didn't break it).
 *
 * Harness pattern: pure unit tests against a mock client + mock handle.
 * No `TestWorkflowEnvironment`. Avoids the cross-test isolation cost of a
 * real Temporal server for behavior that's purely a control-flow decision
 * over the client boundary.
 */
import { expect } from 'chai';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { InteractiveAttachment } from '../src/adapters/claude-code/adapter';
import type { BaseAttachmentOptions } from '../src/adapters/base';
import type { DetachReason, AttachmentToken } from '../src/types';

// ── Test attachment subclass exposing the private reconnect loop ────────

/**
 * Test-only subclass that:
 *   - lets the test populate `client`, `pinnedHandle`, `token` directly
 *     (the production lifecycle would set them via `startV2Lifecycle`,
 *     which we don't want to run for unit tests)
 *   - exposes the private `runReconnectLoop` via a public wrapper
 *   - captures every `fireTerminal` call instead of dispatching listeners,
 *     so assertions can introspect what (if anything) was triggered
 *
 * `as any` accesses are deliberate: we're testing a private method's
 * control flow without changing the production surface. The cast is
 * confined to this one test file and has clear comments at every site.
 */
class TestableAttachment extends InteractiveAttachment {
  readonly descriptor = {
    adapterId: 'claude-code',
    adapterClass: 'interactive' as const,
    blocksOnLLMTurn: false,
    heartbeatMs: 100, // unused in these tests; satisfies the type
  };

  /** Fire history — every `fireTerminal` invocation is recorded here. */
  public readonly terminalFires: DetachReason[] = [];

  constructor(opts: BaseAttachmentOptions) {
    super(opts);
    // Replace the real `fireTerminal` with a capturing stub so the
    // reconnect loop's exit path is observable without listeners running.
    (this as any).fireTerminal = (reason: DetachReason): void => {
      this.terminalFires.push(reason);
      // Mirror the side effects the real fireTerminal performs that the
      // loop reads: terminalFired blocks reschedule, stopped ends the loop.
      (this as any).terminalFired = true;
      (this as any).stopped = true;
    };
  }

  /** Inject pinned handle + token without running the full claim lifecycle. */
  setUpPinnedState(opts: { client: Client; pinnedHandle: WorkflowHandle; token: AttachmentToken; host: string }): void {
    (this as any).client = opts.client;
    (this as any).host = opts.host;
    (this as any).pinnedHandle = opts.pinnedHandle;
    (this as any).token = opts.token;
  }

  /** Public wrapper around the private `runReconnectLoop`. */
  public async triggerReconnect(reason: DetachReason): Promise<void> {
    await (this as any).runReconnectLoop(reason);
  }
}

// ── Mock client + handle factory ────────────────────────────────────────

interface QueryResponse {
  /** When set, query returns this AttachmentInfo. */
  info?: unknown;
  /** When set, query throws this error instead. */
  throwError?: Error;
}

interface DescribeResponse {
  /** When set, describe() returns this status name. */
  statusName?: string;
  /** When set, describe() throws this error instead. */
  throwError?: Error;
  /** When set, describe() resolves only after this many ms — used to test the 3s timeout. */
  delayMs?: number;
}

/**
 * Build a mock Temporal client where:
 *   - `client.workflow.getHandle(workflowId)` returns an unpinned handle
 *     whose `query` and `describe` methods consult the queue parameters.
 *   - Multiple queueable responses let a test simulate "fail once then
 *     succeed" patterns — the production loop iterates, so we need to be
 *     able to feed it a sequence of outcomes.
 *
 * Returns the client plus introspection on call counts. `runReconnectLoop`
 * exits on first terminal-fire or first successful claim, so tests don't
 * usually need more than 1–2 queued responses.
 */
function makeMockClient(opts: {
  queryResponses: QueryResponse[];
  describeResponses: DescribeResponse[];
  /** When set, `executeUpdate(claimAttachment)` throws this error so the loop sees a failed claim and exits via budget exhaustion. Tests usually don't need this — they assert before claim is reached. */
  claimThrows?: Error;
}) {
  const queryQueue = [...opts.queryResponses];
  const describeQueue = [...opts.describeResponses];
  let queryCalls = 0;
  let describeCalls = 0;

  const handle: any = {
    workflowId: 'wf-test',
    async query(_def: unknown) {
      queryCalls++;
      const r = queryQueue.shift();
      if (!r) throw new Error(`no more query responses queued (call #${queryCalls})`);
      if (r.throwError) throw r.throwError;
      return r.info;
    },
    async describe() {
      describeCalls++;
      const r = describeQueue.shift();
      if (!r) throw new Error(`no more describe responses queued (call #${describeCalls})`);
      if (r.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, r.delayMs));
      }
      if (r.throwError) throw r.throwError;
      return { runId: 'wf-test-run', status: { name: r.statusName ?? 'RUNNING' } };
    },
    async executeUpdate(_def: unknown, _opts: { args: unknown[] }) {
      if (opts.claimThrows) throw opts.claimThrows;
      // Successful claim — return a fresh-looking token. The loop will then
      // try to rebuild the pinned handle and call `onReconnected`. For our
      // tests we don't need that path; if a test reaches here, increase
      // pre-check responses to keep it in the loop.
      throw new Error('claim path reached unexpectedly — add more queryResponses');
    },
  };

  const client: any = {
    workflow: {
      getHandle(_workflowId: string) {
        return handle;
      },
    },
  };

  return {
    client: client as Client,
    handle: handle as WorkflowHandle,
    callCounts: {
      query: () => queryCalls,
      describe: () => describeCalls,
    },
  };
}

// ── Common test fixtures ────────────────────────────────────────────────

const NOT_FOUND_ERR = (() => {
  const e = new Error('workflow execution already completed');
  e.name = 'WorkflowNotFoundError';
  return e;
})();

const TRANSIENT_NETWORK_ERR = new Error('UNAVAILABLE: temporary connection failure');

function makeAttachment() {
  // Tight reconnect timing so the loop iterates fast in tests. Production
  // values (10s base, 60s max) would make tests 100× slower for no value.
  const a = new TestableAttachment({
    reconnectTiming: { baseMs: 5, maxMs: 50, budgetMs: 200, backoffFactor: 1.5 },
  });
  return a;
}

function pinnedSetup(adapter: TestableAttachment, mock: ReturnType<typeof makeMockClient>) {
  adapter.setUpPinnedState({
    client: mock.client,
    pinnedHandle: mock.handle,
    token: {
      attachmentId: 'attach-test',
      runId: 'wf-test-run',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseMs: 60_000,
    },
    host: 'test-host',
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('reconnect pre-check describe() tiebreaker (#258)', function () {
  this.timeout(5_000);

  it('terminal-class pre-check + describe() RUNNING → no destroy, loop continues', async function () {
    // Sequence: query throws NOT_FOUND once (transient blip classified as
    // terminal). describe() reports RUNNING. The fix should treat this as
    // transient and continue the loop. The second iteration's query then
    // budget-exhausts (we've fed only 1 response) — the loop exits via
    // `reconnect-exhausted`, NOT via `destroy`.
    const mock = makeMockClient({
      queryResponses: [{ throwError: NOT_FOUND_ERR }],
      describeResponses: [{ statusName: 'RUNNING' }],
    });
    const adapter = makeAttachment();
    pinnedSetup(adapter, mock);

    await adapter.triggerReconnect('heartbeat-timeout');

    // Critical assertion: destroy was NOT fired on the first NOT_FOUND.
    expect(adapter.terminalFires).to.not.include('destroy');
    // Describe was consulted exactly once — the tiebreaker fired.
    expect(mock.callCounts.describe()).to.equal(1);
    // The loop did continue — it exhausted budget and fired the canonical
    // exhaustion terminal (existing path, unchanged).
    expect(adapter.terminalFires).to.include('reconnect-exhausted');
  });

  it('terminal-class pre-check + describe() COMPLETED → destroy fires (existing path preserved)', async function () {
    const mock = makeMockClient({
      queryResponses: [{ throwError: NOT_FOUND_ERR }],
      describeResponses: [{ statusName: 'COMPLETED' }],
    });
    const adapter = makeAttachment();
    pinnedSetup(adapter, mock);

    await adapter.triggerReconnect('heartbeat-timeout');

    // Workflow genuinely terminal — destroy fires.
    expect(adapter.terminalFires).to.deep.equal(['destroy']);
    expect(mock.callCounts.describe()).to.equal(1);
  });

  it('terminal-class pre-check + describe() TERMINATED → destroy fires', async function () {
    const mock = makeMockClient({
      queryResponses: [{ throwError: NOT_FOUND_ERR }],
      describeResponses: [{ statusName: 'TERMINATED' }],
    });
    const adapter = makeAttachment();
    pinnedSetup(adapter, mock);

    await adapter.triggerReconnect('heartbeat-timeout');

    expect(adapter.terminalFires).to.deep.equal(['destroy']);
  });

  it('terminal-class pre-check + describe() throws → destroy fires (degraded but consistent)', async function () {
    const mock = makeMockClient({
      queryResponses: [{ throwError: NOT_FOUND_ERR }],
      describeResponses: [{ throwError: new Error('describe network error') }],
    });
    const adapter = makeAttachment();
    pinnedSetup(adapter, mock);

    await adapter.triggerReconnect('heartbeat-timeout');

    // Describe failure means we can't classify — preserve pre-#258 destroy
    // semantics rather than spinning forever.
    expect(adapter.terminalFires).to.deep.equal(['destroy']);
  });

  it('terminal-class pre-check + describe() times out → destroy fires (no hang)', async function () {
    // describe() takes longer than DESCRIBE_TIMEOUT_MS (3s in production).
    // The base class's race-with-timeout treats this as terminal.
    const mock = makeMockClient({
      queryResponses: [{ throwError: NOT_FOUND_ERR }],
      describeResponses: [{ statusName: 'RUNNING', delayMs: 4_000 }],
    });
    const adapter = makeAttachment();
    pinnedSetup(adapter, mock);

    await adapter.triggerReconnect('heartbeat-timeout');

    // The timeout path fires destroy — preferable to hanging the loop on
    // a stuck visibility-API call.
    expect(adapter.terminalFires).to.deep.equal(['destroy']);
  });

  it('non-terminal pre-check error → existing transient path, describe() NOT consulted', async function () {
    // Sanity: a normal transient error (not classified as terminal by
    // `isTerminalWorkflowError`) should NOT trigger the new tiebreaker.
    // The original transient path (bump backoff, continue) is the only
    // change — we must not have introduced a new RPC for normal errors.
    const mock = makeMockClient({
      queryResponses: [{ throwError: TRANSIENT_NETWORK_ERR }],
      describeResponses: [],
    });
    const adapter = makeAttachment();
    pinnedSetup(adapter, mock);

    await adapter.triggerReconnect('heartbeat-timeout');

    // Describe was never consulted on a non-terminal error.
    expect(mock.callCounts.describe()).to.equal(0);
    // Loop continued through the transient path; eventually budget-exhausted.
    expect(adapter.terminalFires).to.include('reconnect-exhausted');
    expect(adapter.terminalFires).to.not.include('destroy');
  });
});
