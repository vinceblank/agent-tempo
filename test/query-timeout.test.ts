/**
 * Unit coverage for `queryHandleWithTimeout` (#433).
 *
 * Surfaces under test:
 *   1. Resolves to the underlying value when the query is fast.
 *   2. Throws `QueryTimeoutError` when the query exceeds `timeoutMs`.
 *   3. Dedupes concurrent calls against the same `(workflowId, queryName)`
 *      so we don't pile up dangling promises against hung workflows.
 *   4. Cleans up the dedup table when the underlying RPC settles (success
 *      and failure both clear).
 *   5. The timeout's `setTimeout` is cleared when the underlying RPC wins
 *      the race — no leaked timers.
 */
import { expect } from 'chai';
import { defineQuery } from '@temporalio/workflow';
import {
  queryHandleWithTimeout,
  QueryTimeoutError,
  __resetInflightQueriesForTests,
  DEFAULT_QUERY_TIMEOUT_MS,
} from '../src/utils/query-timeout';

const fastQuery = defineQuery<string>('fastQuery');
const slowQuery = defineQuery<string>('slowQuery');
const failQuery = defineQuery<string>('failQuery');

/** Mock handle whose `query()` returns a controllable promise. */
function makeMockHandle(workflowId: string, behavior: {
  fastQuery?: () => Promise<string>;
  slowQuery?: () => Promise<string>;
  failQuery?: () => Promise<string>;
}) {
  const calls: string[] = [];
  return {
    workflowId,
    calls,
    async query(def: { name: string }): Promise<string> {
      calls.push(def.name);
      const handler = (behavior as Record<string, () => Promise<string>>)[def.name];
      if (!handler) throw new Error(`no handler for ${def.name}`);
      return handler();
    },
  };
}

describe('queryHandleWithTimeout (#433)', function () {
  beforeEach(() => __resetInflightQueriesForTests());

  it('resolves with the underlying value when the query returns fast', async function () {
    const h = makeMockHandle('wf-1', { fastQuery: async () => 'hello' });
    const result = await queryHandleWithTimeout(h as never, fastQuery, { timeoutMs: 100 });
    expect(result).to.equal('hello');
    expect(h.calls).to.deep.equal(['fastQuery']);
  });

  it('throws QueryTimeoutError when the query exceeds timeoutMs', async function () {
    const h = makeMockHandle('wf-2', {
      slowQuery: () => new Promise(() => {}), // never resolves
    });
    let caught: unknown;
    try {
      await queryHandleWithTimeout(h as never, slowQuery, { timeoutMs: 50 });
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(QueryTimeoutError);
    expect((caught as QueryTimeoutError).workflowId).to.equal('wf-2');
    expect((caught as QueryTimeoutError).queryName).to.equal('slowQuery');
    expect((caught as QueryTimeoutError).timeoutMs).to.equal(50);
    // Verifies the QueryTimeoutError name override sticks — defensive
    // string-match callers (`err.name === 'QueryTimeoutError'`) work.
    expect((caught as Error).name).to.equal('QueryTimeoutError');
  });

  it('propagates the underlying rejection when the query fails fast', async function () {
    const h = makeMockHandle('wf-3', {
      failQuery: async () => { throw new Error('worker said no'); },
    });
    let caught: unknown;
    try {
      await queryHandleWithTimeout(h as never, failQuery, { timeoutMs: 100 });
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('worker said no');
    expect(caught).not.to.be.instanceOf(QueryTimeoutError);
  });

  it('dedupes concurrent calls against the same (workflowId, queryName)', async function () {
    let resolveSlow: ((v: string) => void) | undefined;
    const h = makeMockHandle('wf-4', {
      slowQuery: () => new Promise<string>((resolve) => { resolveSlow = resolve; }),
    });

    // Fire 5 calls in parallel — only one underlying `query()` should run.
    // All 5 callers race against their own timeoutMs; here we let them all
    // wait long enough that none hit timeout.
    const racers = Array.from({ length: 5 }, () =>
      queryHandleWithTimeout(h as never, slowQuery, { timeoutMs: 5000 }),
    );

    // Underlying handler must have run exactly once.
    expect(h.calls).to.deep.equal(['slowQuery']);

    // Resolve the underlying — all 5 racers get the same value.
    resolveSlow!('shared-result');
    const results = await Promise.all(racers);
    expect(results).to.deep.equal(['shared-result', 'shared-result', 'shared-result', 'shared-result', 'shared-result']);
  });

  it('frees the dedup slot once the underlying RPC settles (success path)', async function () {
    let resolveCall: ((v: string) => void) | undefined;
    const h = makeMockHandle('wf-5', {
      slowQuery: () => new Promise<string>((resolve) => { resolveCall = resolve; }),
    });
    const first = queryHandleWithTimeout(h as never, slowQuery, { timeoutMs: 5000 });
    expect(h.calls).to.have.length(1);
    resolveCall!('first');
    expect(await first).to.equal('first');

    // After settle, a fresh call should issue a NEW underlying RPC, not
    // return the cached prior value.
    const h2 = { ...h, calls: [...h.calls] };  // snapshot
    let resolveCall2: ((v: string) => void) | undefined;
    h.query = async (def: { name: string }): Promise<string> => {
      h.calls.push(def.name);
      return new Promise<string>((resolve) => { resolveCall2 = resolve; });
    };
    const second = queryHandleWithTimeout(h as never, slowQuery, { timeoutMs: 5000 });
    expect(h.calls.length).to.be.greaterThan(h2.calls.length); // new call issued
    resolveCall2!('second');
    expect(await second).to.equal('second');
  });

  it('frees the dedup slot when the underlying RPC rejects', async function () {
    let rejectCall: ((e: Error) => void) | undefined;
    const h = makeMockHandle('wf-6', {
      slowQuery: () => new Promise<string>((_, reject) => { rejectCall = reject; }),
    });
    const first = queryHandleWithTimeout(h as never, slowQuery, { timeoutMs: 5000 });
    rejectCall!(new Error('worker died mid-query'));
    let firstErr: unknown;
    try { await first; } catch (e) { firstErr = e; }
    expect((firstErr as Error).message).to.equal('worker died mid-query');

    // After the rejection settles the dedup table, a fresh call should
    // issue a new underlying RPC (not see the cached rejection).
    const callsBefore = h.calls.length;
    let resolveSecond: ((v: string) => void) | undefined;
    h.query = async (def: { name: string }): Promise<string> => {
      h.calls.push(def.name);
      return new Promise<string>((resolve) => { resolveSecond = resolve; });
    };
    const second = queryHandleWithTimeout(h as never, slowQuery, { timeoutMs: 5000 });
    expect(h.calls.length).to.be.greaterThan(callsBefore);
    resolveSecond!('recovered');
    expect(await second).to.equal('recovered');
  });

  it('different workflowIds do NOT share a dedup slot', async function () {
    const h1 = makeMockHandle('wf-A', {
      slowQuery: () => new Promise<string>((resolve) => setTimeout(() => resolve('A'), 1)),
    });
    const h2 = makeMockHandle('wf-B', {
      slowQuery: () => new Promise<string>((resolve) => setTimeout(() => resolve('B'), 1)),
    });
    const [a, b] = await Promise.all([
      queryHandleWithTimeout(h1 as never, slowQuery, { timeoutMs: 100 }),
      queryHandleWithTimeout(h2 as never, slowQuery, { timeoutMs: 100 }),
    ]);
    expect(a).to.equal('A');
    expect(b).to.equal('B');
    expect(h1.calls).to.deep.equal(['slowQuery']);
    expect(h2.calls).to.deep.equal(['slowQuery']);
  });

  it('uses DEFAULT_QUERY_TIMEOUT_MS when opts.timeoutMs is omitted', async function () {
    expect(DEFAULT_QUERY_TIMEOUT_MS).to.equal(2000);
    // Smoke — we don't actually wait 2s here, but make sure the absence
    // of opts.timeoutMs takes the default path without throwing.
    const h = makeMockHandle('wf-default', {
      fastQuery: async () => 'ok',
    });
    const result = await queryHandleWithTimeout(h as never, fastQuery);
    expect(result).to.equal('ok');
  });

  it('does not leave the timeout timer running after the RPC wins the race', async function () {
    // Indirect signal: if the timer is leaked, it will fire after our
    // assertion completes and throw an unhandled rejection. Mocha's
    // unhandled-rejection guard would surface that. We just need the
    // happy path to NOT leak.
    const h = makeMockHandle('wf-cleanup', { fastQuery: async () => 'done' });
    await queryHandleWithTimeout(h as never, fastQuery, { timeoutMs: 100 });
    // Wait past the timeout window; if the timer leaked, the process
    // would emit an unhandled rejection here.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});
