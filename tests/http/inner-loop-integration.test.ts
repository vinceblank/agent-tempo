/**
 * Integration test for the 3c Tier-2 inner-loop SEAM (Parts 3b/4/5/6b).
 *
 * Exercises the full off-wire fine-tail path end-to-end over a REAL loopback
 * HTTP socket, with the production pieces wired exactly as the daemon wires them:
 *
 *   InnerLoopPublisher (6b, source observer)
 *     → InnerLoopHttpClient (Part 5, loopback-HTTP registry impl)
 *       → POST /inner/ingest (Part 4 route, ingest-token auth)
 *         → InnerLoopRegistry (Part 1 sink; the daemon singleton from Part 3b)
 *           → GET /inner operator SSE (Part 4 EGRESS) → operator sees the frame.
 *
 * Presence is primed the same way the publisher gates in production: the client's
 * `subscriberCount` reads `GET /inner/presence`, which only returns >0 once the
 * operator SSE has subscribed. The live-Pi recruit half (pi-ai optional dep, real
 * createAgentSession) is a devops smoke — out of scope here; this covers every
 * NEW seam below that boundary.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import { InnerLoopRegistry } from '../../src/http/inner-loop';
import { IngestTokenRegistry } from '../../src/http/ingest-registry';
import { InnerLoopHttpClient, type InnerLoopFetch } from '../../src/pi/inner-loop-client';
import { InnerLoopPublisher } from '../../src/pi/inner-loop-publisher';
import { sessionWorkflowId } from '../../src/config';
import type { TempoClient } from '../../src/client/interface';

const E = 'demo';
const P = 'tempo-pi';
const WF = sessionWorkflowId(E, P);

function makeFakeClient(): TempoClient {
  const base: Partial<TempoClient> = {
    async listEnsembles() { return []; },
    async listHosts() { return []; },
  };
  return new Proxy(base, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${prop}`); };
    },
  }) as unknown as TempoClient;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tmpDir: string;
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-inner-integ-')); });
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

let booted: HttpServerHandle[] = [];
afterEach(async () => {
  for (const h of booted) { try { await h.close(); } catch { /* ignore */ } }
  booted = [];
});

async function boot(
  innerLoop: InnerLoopRegistry,
  ingestTokens: IngestTokenRegistry,
  opts: { readToken?: string; adminToken?: string; allowedOrigins?: string[] } = {},
): Promise<HttpServerHandle> {
  const handle = await startHttpServer({
    client: makeFakeClient(),
    namespace: 'default',
    taskQueue: 'agent-tempo-test',
    version: '0.28.0-test',
    bindAddr: '127.0.0.1',
    port: 0,
    // Isolate the port file — do NOT clobber a real daemon's ~/.agent-tempo/daemon.port.
    portFilePath: path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`),
    innerLoop,
    ingestTokens,
    readToken: opts.readToken,
    adminToken: opts.adminToken,
    allowedOrigins: opts.allowedOrigins,
  });
  booted.push(handle);
  return handle;
}

/**
 * Read the operator SSE reader until a frame matching `type` arrives, or the
 * deadline elapses. Each `reader.read()` is raced against a timeout so a parked
 * read can't hang the test (the read is abandoned; the caller cancels after).
 */
async function readForFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown> | undefined> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  const TIMED_OUT = Symbol('timeout');
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const res = await Promise.race([
      reader.read(),
      delay(remaining).then(() => TIMED_OUT),
    ]);
    if (res === TIMED_OUT) break;
    const { done, value } = res as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    if (value) buf += decoder.decode(value, { stream: true });
    for (const chunk of buf.split('\n\n')) {
      if (!chunk.trim() || chunk.startsWith(':')) continue; // skip :ka / :closed
      let evType: string | undefined;
      let data: Record<string, unknown> | undefined;
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) evType = line.slice(7);
        else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6));
      }
      if (evType === type && data) return data;
    }
  }
  return undefined;
}

describe('inner-loop integration — publisher → client → ingest → registry → operator SSE', () => {
  it('an operator tailing /inner sees a frame the publisher forwards', async () => {
    const innerLoop = new InnerLoopRegistry();
    const ingestTokens = new IngestTokenRegistry();
    const token = ingestTokens.mint(WF);
    const server = await boot(innerLoop, ingestTokens);
    const port = server.port;

    // ── Operator side: open the EGRESS SSE (loopback + no Origin → tier-3 ok) ──
    const ac = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${port}/v1/players/${E}/${P}/inner`, { signal: ac.signal });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const ingestUrl = `http://127.0.0.1:${port}/v1/players/${E}/${P}/inner/ingest`;

    try {
      // ── Probe: a DIRECT authenticated ingest POST reaches the operator SSE ──
      // (isolates the server INGRESS→registry→EGRESS path from the client/publisher).
      const probeRes = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'X-Ingest-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'inner.turn', phase: 'start', turnIndex: 0, ts: 1 }),
      });
      expect(probeRes.status).toBe(204);
      const probeFrame = await readForFrame(reader, 'inner.turn');
      expect(probeFrame).toMatchObject({ type: 'inner.turn', phase: 'start' });

      // ── Source side: the production client + publisher, wired as the daemon does ──
      const client = new InnerLoopHttpClient({
        ensemble: E,
        playerId: P,
        ingestToken: token,
        readPort: () => port,
        presencePollMs: 0, // re-fetch presence on every check (deterministic priming)
      });
      const pub = new InnerLoopPublisher({ workflowId: WF, registry: client, presencePollMs: 0 });

      // Prime the client's cached presence: it goes >0 only once the operator SSE
      // has actually subscribed on the server (the same gate the publisher uses).
      let present = 0;
      for (let i = 0; i < 100 && present === 0; i++) {
        present = client.subscriberCount(WF);
        if (present === 0) await delay(20);
      }
      expect(present).toBe(1);

      // Drive a real Pi event through the publisher → it forwards a fine frame.
      pub.handleToolCall({ toolName: 'bash', input: { cmd: 'ls -la' } });

      const frame = await readForFrame(reader, 'inner.tool_call');
      expect(frame).toBeDefined();
      expect(frame).toMatchObject({ type: 'inner.tool_call', tool: 'bash' });
      expect(typeof (frame as { argsSummary?: unknown }).argsSummary).toBe('string');
    } finally {
      ac.abort();
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  }, 10000);

  // 3e ruling #3 — the /inner operator-SSE tier denial must carry requireTier's
  // actionable hint (this was the QA-caught gap: the GET /inner site used the bare
  // errorResponse form and dropped `detail`). Bearer mode is forced via a
  // non-loopback Origin so the tier guard actually runs (loopback → PASS).
  describe('tier-denial hint on GET /inner (ruling #3 surface-wide consistency)', () => {
    const ORIGIN = 'https://dash.example.com';

    it('read token on the admin-only inner tail → 403 with the admin-token hint', async () => {
      const server = await boot(new InnerLoopRegistry(), new IngestTokenRegistry(), {
        readToken: 'read-token',
        adminToken: 'admin-token',
        allowedOrigins: [ORIGIN],
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/players/${E}/${P}/inner`, {
        headers: { origin: ORIGIN, authorization: 'Bearer read-token' },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('insufficient-tier');
      expect(body.detail).toContain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
    });

    it('admin unset → 503 with the admin-token hint', async () => {
      const server = await boot(new InnerLoopRegistry(), new IngestTokenRegistry(), {
        readToken: 'read-token',
        allowedOrigins: [ORIGIN],
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/players/${E}/${P}/inner`, {
        headers: { origin: ORIGIN, authorization: 'Bearer read-token' },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('admin-token-not-configured');
      expect(body.detail).toContain('AGENT_TEMPO_HTTP_ADMIN_TOKEN');
    });
  });

  it('PRESENCE GATE: with zero operators the publisher never POSTs an ingest frame', async () => {
    // Pure source-side seam with a spy transport — no operator ever subscribes, so
    // presence is 0 and the publisher must drop the frame BEFORE any HTTP call.
    const ingest: string[] = [];
    const spyFetch: InnerLoopFetch = async (url, init) => {
      if (url.endsWith('/presence')) {
        return { status: 200, async json() { return { subscribers: 0 }; } };
      }
      ingest.push(init.body ?? ''); // record any ingest POST (there must be none)
      return { status: 204, async json() { return {}; } };
    };
    const client = new InnerLoopHttpClient({
      ensemble: E, playerId: P, ingestToken: 'tok', readPort: () => 1, fetchFn: spyFetch, presencePollMs: 0,
    });
    const pub = new InnerLoopPublisher({ workflowId: WF, registry: client, presencePollMs: 0 });

    // Prime presence (resolves to 0) then drive several events.
    for (let i = 0; i < 5; i++) { client.subscriberCount(WF); await delay(5); }
    pub.handleToolCall({ toolName: 'bash', input: { cmd: 'rm -rf /' } });
    pub.handleTurnStart({ turnIndex: 0 });
    await delay(20);

    expect(ingest).toHaveLength(0);
  });
});
