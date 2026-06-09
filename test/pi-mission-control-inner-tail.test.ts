/**
 * openInnerTail token-optional auth (#54). A loopback daemon serves the `/inner`
 * egress tokenless (full-trust short-circuit); a remote / 0.0.0.0 daemon requires
 * the admin token. So the bearer is sent IFF a token is present, and a tokenless
 * 401/403 surfaces an actionable hint via onError. Pure — injected TailFetch.
 */
import { expect } from 'chai';
import { openInnerTail, type TailFetch } from '../src/pi/mission-control/inner-tail';

interface Recorded { url: string; headers: Record<string, string> }

/** A TailFetch that records the request and returns `status` with a null body
 *  (non-200 → openInnerTail short-circuits to onError right after recording). */
function makeTailFetch(status: number): { calls: Recorded[]; fn: TailFetch } {
  const calls: Recorded[] = [];
  const fn: TailFetch = (url, init) => {
    calls.push({ url, headers: init.headers });
    return Promise.resolve({ status, body: null });
  };
  return { calls, fn };
}

async function run(adminToken: string | undefined, status: number): Promise<{ calls: Recorded[]; errors: string[] }> {
  const tf = makeTailFetch(status);
  const errors: string[] = [];
  await openInnerTail({
    baseUrl: 'http://127.0.0.1:8473',
    ...(adminToken ? { adminToken } : {}),
    ensemble: 'ens',
    playerId: 'p1',
    onFrame: () => { /* no frames on a non-200 */ },
    signal: new AbortController().signal,
    fetchFn: tf.fn,
    onError: (m) => errors.push(m),
  });
  return { calls: tf.calls, errors };
}

describe('openInnerTail — token-optional auth (#54)', () => {
  it('no token → NO Authorization header; tokenless 401 → actionable hint', async () => {
    const { calls, errors } = await run(undefined, 401);
    expect(calls).to.have.length(1);
    expect(calls[0].headers.Authorization, 'no Bearer sent tokenless').to.equal(undefined);
    expect(calls[0].headers.Accept).to.equal('text/event-stream');
    expect(errors[0], 'actionable hint on tokenless 401').to.contain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
  });

  it('token present → sends the Bearer header (non-loopback path preserved)', async () => {
    const { calls, errors } = await run('tok', 401);
    expect(calls[0].headers.Authorization).to.equal('Bearer tok');
    // Token-present failure keeps the plain status message (no tokenless hint).
    expect(errors[0]).to.not.contain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
  });
});
