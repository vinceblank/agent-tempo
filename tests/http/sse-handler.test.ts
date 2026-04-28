/**
 * Unit + integration tests for the SSE handler.
 */
import * as http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConnectionCap,
  DEFAULT_MAX_CONNECTIONS,
  frameSseComment,
  frameSseEvent,
  parseTopicQuery,
} from '../../src/http/sse-handler';
import { EnsembleEventBus } from '../../src/http/event-bus';
import { SeqAllocator } from '../../src/http/event-id';

// ── Pure helpers ────────────────────────────────────────────────────────

describe('frameSseEvent', () => {
  it('emits id / event / data lines terminated with a blank line', () => {
    const buf = frameSseEvent({
      eventId: '1714:0',
      tuple: { epoch: 1714, seq: 0 },
      type: 'player.added',
      payload: { playerId: 'a' },
      emittedAt: 0,
      bufferable: true,
    });
    const text = buf.toString('utf8');
    expect(text).toContain('id: 1714:0\n');
    expect(text).toContain('event: player.added\n');
    expect(text).toContain('data: {"v":1,"eventId":"1714:0","payload":{"playerId":"a"}}');
    // SSE frame terminator
    expect(text.endsWith('\n\n')).toBe(true);
  });
});

describe('frameSseComment', () => {
  it('emits a `:` comment frame', () => {
    expect(frameSseComment('hello').toString('utf8')).toBe(': hello\n\n');
  });
});

describe('parseTopicQuery', () => {
  it('returns undefined for empty input', () => {
    expect(parseTopicQuery(undefined)).toBeUndefined();
    expect(parseTopicQuery('')).toBeUndefined();
  });
  it('returns the recognized topics', () => {
    const r = parseTopicQuery('phase,chat,heartbeat');
    expect(r).toBeInstanceOf(Set);
    expect(r!.has('phase')).toBe(true);
    expect(r!.has('chat')).toBe(true);
    expect(r!.has('heartbeat')).toBe(true);
    expect(r!.size).toBe(3);
  });
  it('drops unknown topics silently', () => {
    const r = parseTopicQuery('chat,bogus,phase');
    expect(r!.has('chat')).toBe(true);
    expect(r!.has('phase')).toBe(true);
    expect(r!.size).toBe(2);
  });
  it('returns undefined when nothing recognized', () => {
    expect(parseTopicQuery('bogus,unknown')).toBeUndefined();
  });
  it('handles array-form headers', () => {
    expect(parseTopicQuery(['chat,phase', 'flags'])?.has('chat')).toBe(true);
  });
});

describe('ConnectionCap', () => {
  it('default cap matches §7.3', () => {
    expect(DEFAULT_MAX_CONNECTIONS).toBe(100);
    expect(new ConnectionCap().limit).toBe(100);
  });
  it('acquire/release tracks current count', () => {
    const c = new ConnectionCap(2);
    expect(c.acquire()).toBe(true);
    expect(c.acquire()).toBe(true);
    expect(c.acquire()).toBe(false);
    expect(c.size()).toBe(2);
    c.release();
    expect(c.acquire()).toBe(true);
  });
  it('release is safe at zero', () => {
    const c = new ConnectionCap(1);
    expect(() => c.release()).not.toThrow();
    expect(c.size()).toBe(0);
  });
});

// ── End-to-end SSE flow ────────────────────────────────────────────────

/**
 * Spin up a tiny HTTP server that delegates to the SSE handler against
 * a real bus. Returns the URL + a teardown.
 */
async function bootSseServer(opts: {
  bus: EnsembleEventBus;
  cap?: ConnectionCap;
  emitSnapshot?: boolean;
  ensemble?: string;
} = { bus: null as unknown as EnsembleEventBus }): Promise<{ url: string; close: () => Promise<void> }> {
  const { handleSseRequest } = await import('../../src/http/sse-handler');
  const cap = opts.cap ?? new ConnectionCap();
  // Stub TempoClient — only needed when emitSnapshot=true.
  const stubClient = {
    async listEnsembles() {
      return [{ name: opts.ensemble ?? 'demo', playerCount: 0, hasConductor: false, state: 'online' as const }];
    },
    async getPlayers() { return []; },
    async getEnsembleChat() { return { messages: [], total: 0, hasMore: false, hasConductor: false }; },
    async getSchedules() { return []; },
    async isMaestroPaused() { return false; },
    async isAnySessionHeld() { return false; },
    async listHosts() { return []; },
    // Issue #399 DB1a wire-extension methods — sentinel defaults
    // matching the soft-fail shape the snapshot builder expects.
    async getEnsembleMeta() {
      return { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] as number[] };
    },
    async getPlayerWireMeta() { return null; },
  } as unknown as import('../../src/client/interface').TempoClient;
  const server = http.createServer((req, res) => {
    handleSseRequest(req, res, {
      client: stubClient,
      bus: opts.bus,
      emitSnapshot: opts.emitSnapshot ?? false,
      ensemble: opts.ensemble,
      cap,
    }).catch(() => { /* ignore for tests */ });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Read raw bytes from an SSE response into chunks separated by `\n\n`.
 * Resolves once `expectChunks` chunks have arrived OR the stream closes.
 */
async function readSseChunks(
  url: string,
  expectChunks: number,
  headers: Record<string, string> = {},
  timeoutMs = 2000,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: string[] = [];
      let buffer = '';
      const tearDown = () => {
        try { req.destroy(); } catch { /* ignore */ }
        try { res.destroy(); } catch { /* ignore */ }
        resolve(chunks);
      };
      const timer = setTimeout(tearDown, timeoutMs);
      timer.unref();
      res.on('data', (b: Buffer) => {
        buffer += b.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          chunks.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (chunks.length >= expectChunks) {
            clearTimeout(timer);
            tearDown();
            return;
          }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(chunks); });
      res.on('error', () => { clearTimeout(timer); resolve(chunks); });
    });
    req.on('error', reject);
  });
}

let booted: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const b of booted) await b.close();
  booted = [];
});

describe('SSE handler — end-to-end', () => {
  // SKIP-REASON: SSE chunk-arrival timing differs on Windows GHA runners — the 50 ms `setTimeout` race against `readSseChunks(..., 3)` is reliable on Linux/macOS CI and dev Windows but flakes on Windows GitHub-Actions runners. Surfaced when PR #335 added Windows CI; not a regression of #339. Investigate timing flakiness separately if it becomes a recurring CI block (eng-3 / SSE backend domain — author of PR #324).
  it.skipIf(process.platform === 'win32' && !!process.env.CI)('emits an opening comment + snapshot then live events on a fresh per-ensemble subscribe', async () => {
    const bus = new EnsembleEventBus({
      scope: 'ensemble:demo',
      allocator: new SeqAllocator(1714),
    });
    const server = await bootSseServer({ bus, emitSnapshot: true, ensemble: 'demo' });
    booted.push(server);

    // Fire-and-forget — emit a player.added shortly after the request lands.
    setTimeout(() => bus.emit('player.added', { playerId: 'a' }), 50);

    const chunks = await readSseChunks(`${server.url}/v1/events/demo`, 3);
    expect(chunks[0]).toMatch(/^: claude-tempo SSE/);
    expect(chunks.find((c) => /event: snapshot/.test(c))).toBeDefined();
    expect(chunks.find((c) => /event: player\.added/.test(c))).toBeDefined();
  });

  it('emits gap with reason=epoch-mismatch when Last-Event-ID epoch differs', async () => {
    const bus = new EnsembleEventBus({ scope: 'ensemble:demo', allocator: new SeqAllocator(2000) });
    const server = await bootSseServer({ bus, emitSnapshot: true, ensemble: 'demo' });
    booted.push(server);

    const chunks = await readSseChunks(
      `${server.url}/v1/events/demo`,
      2,
      { 'Last-Event-ID': '1000:5' },
    );
    const gap = chunks.find((c) => /event: gap/.test(c));
    expect(gap).toBeDefined();
    expect(gap!).toMatch(/"reason":"epoch-mismatch"/);
    // Snapshot is NOT emitted on gap path (client re-fetches /v1/state).
    expect(chunks.find((c) => /event: snapshot/.test(c))).toBeUndefined();
  });

  it('emits gap with reason=overflow when Last-Event-ID seq predates ringStart', async () => {
    const bus = new EnsembleEventBus({
      scope: 'ensemble:demo',
      allocator: new SeqAllocator(2000),
      bufferCapacity: 2,
    });
    // Push 5 events — ring keeps the last 2 (seq 3, 4).
    for (let i = 0; i < 5; i++) bus.emit('player.added', { playerId: `p${i}` });
    expect(bus.oldestSeq()).toBe(3);

    const server = await bootSseServer({ bus, emitSnapshot: true, ensemble: 'demo' });
    booted.push(server);

    // Client claims it last saw seq=0 — predates ringStart=3 → overflow.
    const chunks = await readSseChunks(
      `${server.url}/v1/events/demo`,
      2,
      { 'Last-Event-ID': '2000:0' },
    );
    const gap = chunks.find((c) => /event: gap/.test(c));
    expect(gap).toBeDefined();
    expect(gap!).toMatch(/"reason":"overflow"/);
  });

  it('replays buffered events when Last-Event-ID seq is within the ring', async () => {
    const bus = new EnsembleEventBus({
      scope: 'ensemble:demo',
      allocator: new SeqAllocator(3000),
      bufferCapacity: 8,
    });
    bus.emit('player.added', { playerId: 'a' });
    bus.emit('player.added', { playerId: 'b' });
    bus.emit('player.added', { playerId: 'c' });
    // Client says it has seq 0 — server replays seq 1 + 2.
    const server = await bootSseServer({ bus, emitSnapshot: true, ensemble: 'demo' });
    booted.push(server);

    const chunks = await readSseChunks(
      `${server.url}/v1/events/demo`,
      3,
      { 'Last-Event-ID': '3000:0' },
    );
    const ids = chunks
      .map((c) => /id: (\S+)/.exec(c)?.[1])
      .filter((v): v is string => v !== undefined);
    expect(ids).toContain('3000:1');
    expect(ids).toContain('3000:2');
    expect(ids).not.toContain('3000:0');
  });

  it('returns 503 when the connection cap is exhausted', async () => {
    const bus = new EnsembleEventBus({ scope: 'ensemble:demo', allocator: new SeqAllocator(1) });
    const cap = new ConnectionCap(1);
    cap.acquire(); // pre-fill the cap before the handler runs
    const server = await bootSseServer({ bus, cap, emitSnapshot: false });
    booted.push(server);

    const status = await new Promise<number>((resolve) => {
      const req = http.get(`${server.url}/v1/events`, (res) => {
        res.on('data', () => { /* drain */ });
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(0));
    });
    expect(status).toBe(503);
  });
});
