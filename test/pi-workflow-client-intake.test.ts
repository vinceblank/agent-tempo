/**
 * PiWorkflowClient combined intake + pre-#750 fallback (T0.3 of #747, #750) —
 * unit tests with a stubbed Temporal client (no live server).
 *
 * Locks the compatibility contract (#750 constraint 4):
 *   - new pump + new workflow → ONE `pendingIntake` query per fetch;
 *   - new pump + OLD workflow (handler not registered) → falls back to the
 *     legacy `pendingMessages` + `pendingReset` pair, and CACHES the verdict
 *     so the failed probe is paid once, not per tick;
 *   - genuine failures (anything not query-not-registered) propagate.
 */
import { expect } from 'chai';
import { QueryNotRegisteredError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import { PiWorkflowClient, isQueryNotRegisteredError } from '../src/pi/workflow-client';
import type { Config } from '../src/config';
import type { Message, SessionMetadata } from '../src/types';

const TEST_MSG: Message = {
  id: 'm1', from: 'alice', text: 'hi', timestamp: '2026-06-11T00:00:00Z', delivered: false,
};

/** Build the SDK's typed rejection. `3` = gRPC INVALID_ARGUMENT (the status the
 * server returns for an unknown queryType); cast because the enum type lives in
 * the SDK's private grpc dependency. */
const queryNotRegistered = (msg: string) => new QueryNotRegisteredError(msg, 3 as never);

/**
 * Stub client whose started workflow handle dispatches queries by name.
 * `behavior.pendingIntake` controls the combined-query response:
 *   'ok' → returns the combined shape; 'unregistered' → throws the SDK's
 *   QueryNotRegisteredError; 'boom' → throws a generic error.
 */
function stubClient(behavior: { pendingIntake: 'ok' | 'unregistered' | 'boom' }) {
  const counts = { pendingIntake: 0, pendingMessages: 0, pendingReset: 0 };
  const handle = {
    workflowId: 'wf-test',
    query: async (queryDef: unknown) => {
      const name = typeof queryDef === 'string' ? queryDef : (queryDef as { name: string }).name;
      switch (name) {
        case 'pendingIntake':
          counts.pendingIntake += 1;
          if (behavior.pendingIntake === 'unregistered') {
            throw queryNotRegistered(
              'Query handler for pendingIntake is not registered on this workflow');
          }
          if (behavior.pendingIntake === 'boom') throw new Error('connection reset');
          return { messages: [TEST_MSG], pendingReset: null };
        case 'pendingMessages':
          counts.pendingMessages += 1;
          return [TEST_MSG];
        case 'pendingReset':
          counts.pendingReset += 1;
          return { resetId: 'r1', fresh: true, requestedAt: '2026-06-11T00:00:00Z' };
        default:
          throw new Error(`unexpected query ${name}`);
      }
    },
  };
  const client = { workflow: { start: async () => handle } } as unknown as Client;
  return { client, counts };
}

async function buildClient(client: Client): Promise<PiWorkflowClient> {
  const wf = new PiWorkflowClient({
    client,
    config: { taskQueue: 'test-queue' } as Config,
    metadata: {
      ensemble: 'test-ensemble',
      playerId: 'pi-player',
      hostname: 'test-host',
      workDir: '/tmp',
      isConductor: false,
      agentType: 'pi',
    } as SessionMetadata,
  });
  await wf.ensureSessionWorkflow();
  return wf;
}

describe('PiWorkflowClient.fetchIntake (#750)', () => {
  it('new workflow → one combined query, zero legacy queries', async () => {
    const { client, counts } = stubClient({ pendingIntake: 'ok' });
    const wf = await buildClient(client);

    const intake = await wf.fetchIntake();
    expect(intake.messages).to.deep.equal([TEST_MSG]);
    expect(intake.pendingReset).to.equal(null);
    expect(counts).to.deep.equal({ pendingIntake: 1, pendingMessages: 0, pendingReset: 0 });
  });

  it('pre-#750 workflow → falls back to the legacy pair and CACHES the verdict', async () => {
    const { client, counts } = stubClient({ pendingIntake: 'unregistered' });
    const wf = await buildClient(client);

    const first = await wf.fetchIntake();
    expect(first.messages).to.deep.equal([TEST_MSG]);
    expect(first.pendingReset?.resetId).to.equal('r1');
    expect(counts.pendingIntake).to.equal(1); // probed once…

    await wf.fetchIntake();
    await wf.fetchIntake();
    expect(counts.pendingIntake).to.equal(1); // …and never again
    expect(counts.pendingMessages).to.equal(3);
    expect(counts.pendingReset).to.equal(3);
  });

  it('genuine failures propagate (no silent fallback on transport errors)', async () => {
    const { client, counts } = stubClient({ pendingIntake: 'boom' });
    const wf = await buildClient(client);

    let err: unknown = null;
    await wf.fetchIntake().catch((e) => { err = e; });
    expect((err as Error)?.message).to.equal('connection reset');
    // No fallback fired — a transport error is not "handler missing".
    expect(counts.pendingMessages).to.equal(0);
    expect(counts.pendingReset).to.equal(0);
  });
});

describe('isQueryNotRegisteredError (#750)', () => {
  it('matches the SDK class, the name, and the message shapes', () => {
    expect(isQueryNotRegisteredError(queryNotRegistered('x'))).to.equal(true);
    const named = new Error('whatever'); named.name = 'QueryNotRegisteredError';
    expect(isQueryNotRegisteredError(named)).to.equal(true);
    expect(isQueryNotRegisteredError(new Error('unknown queryType pendingIntake. KnownQueryTypes=[...]'))).to.equal(true);
    expect(isQueryNotRegisteredError(new Error('Query handler for pendingIntake is not registered'))).to.equal(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isQueryNotRegisteredError(new Error('connection reset'))).to.equal(false);
    expect(isQueryNotRegisteredError(new Error('Workflow not found'))).to.equal(false);
    expect(isQueryNotRegisteredError(undefined)).to.equal(false);
    expect(isQueryNotRegisteredError('string error')).to.equal(false);
  });
});
