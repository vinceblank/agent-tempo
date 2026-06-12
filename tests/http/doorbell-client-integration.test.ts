/**
 * T1.1 PR-2 — real-wire integration: the adapter-side {@link DoorbellClient}
 * against PR-1's actual route handler over a real loopback HTTP server.
 *
 * Proves the two halves speak the same protocol end-to-end: loopback +
 * X-Ingest-Token auth (real IngestTokenRegistry mint), real SSE framing
 * (ding events, keepalive comments), registry ring → client onDing, and
 * destroy (`closePlayer`) → clean stream end → disconnected transition.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { handleDoorbellSse } from '../../src/http/doorbell-routes';
import { DoorbellRegistry } from '../../src/http/doorbell';
import { IngestTokenRegistry } from '../../src/http/ingest-registry';
import { DoorbellClient } from '../../src/adapters/sdk/doorbell-client';
import { sessionWorkflowId } from '../../src/config';

const E = 'demo';
const P = 'tempo-worker';
const WF = sessionWorkflowId(E, P);

/** Poll until `cond` is true or `ms` elapses. */
async function until(cond: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

describe('DoorbellClient ↔ doorbell route (real HTTP, loopback)', () => {
  let server: http.Server;
  let port: number;
  let doorbells: DoorbellRegistry;
  let ingestTokens: IngestTokenRegistry;
  let token: string;
  let client: DoorbellClient | null = null;

  beforeEach(async () => {
    doorbells = new DoorbellRegistry();
    ingestTokens = new IngestTokenRegistry();
    token = ingestTokens.mint(WF);
    server = http.createServer((req, res) => {
      const m = /^\/doorbell\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
      if (!m) {
        res.writeHead(404).end();
        return;
      }
      void handleDoorbellSse(
        req,
        res,
        { doorbells, ingestTokens },
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2]),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    doorbells.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('connects, receives rings as dings, and sees destroy as a clean disconnect', async () => {
    const dings: number[] = [];
    const transitions: boolean[] = [];
    client = new DoorbellClient({
      ensemble: E,
      playerId: P,
      ingestToken: token,
      readPort: () => port,
      log: () => {},
      onDing: () => dings.push(Date.now()),
      onConnectionChange: (c) => transitions.push(c),
    });
    client.start();

    expect(await until(() => client!.isConnected)).toBe(true);
    expect(await until(() => doorbells.subscriberCount(WF) === 1)).toBe(true);

    doorbells.ring(E, P);
    expect(await until(() => dings.length >= 1)).toBe(true);

    doorbells.ring(E, P);
    expect(await until(() => dings.length >= 2)).toBe(true);

    // Destroy: registry closes the player's streams → client transitions to
    // disconnected (and would re-subscribe with backoff; we stop first).
    doorbells.closePlayer(E, P);
    expect(await until(() => !client!.isConnected)).toBe(true);
    expect(transitions[0]).toBe(true);
    expect(transitions[transitions.length - 1]).toBe(false);
  });

  it('a wrong token is silently rejected — no connection, no dings, no escalation', async () => {
    const dings: number[] = [];
    const transitions: boolean[] = [];
    let attempts = 0;
    client = new DoorbellClient({
      ensemble: E,
      playerId: P,
      ingestToken: 'not-the-token',
      readPort: () => port,
      sleep: async () => { attempts++; await new Promise((r) => setTimeout(r, 5)); },
      log: () => {},
      onDing: () => dings.push(Date.now()),
      onConnectionChange: (c) => transitions.push(c),
    });
    client.start();

    expect(await until(() => attempts >= 2)).toBe(true); // it keeps retrying quietly
    expect(client.isConnected).toBe(false);
    expect(dings).toEqual([]);
    expect(transitions).toEqual([]);
    expect(doorbells.subscriberCount(WF)).toBe(0);
  });
});
