/**
 * Unit tests for the opencode adapter's `OpenCodeServerBridge`.
 *
 * Exercises the HTTP/SSE wrapper with a stubbed `fetch` so we can pin the
 * bridge's contract (URL shapes, body shapes, error propagation, SSE
 * chunk-boundary handling) without standing up a real `opencode serve`.
 *
 * Companion to `tests/adapters/opencode/config.test.ts` — same shape.
 */
import { describe, it, expect } from 'vitest';
import { OpenCodeServerBridge } from '../../../src/adapters/opencode/server-bridge';

/**
 * Build a minimal stub `fetch` that records each call and returns canned
 * responses indexed by URL+method. Mirrors the simple stubs in
 * `tests/adapters/claude-api/spawn-route.test.ts`.
 */
function stubFetch(responses: Record<string, () => Response>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const key = `${init?.method ?? 'GET'} ${u}`;
    const handler = responses[key] ?? responses[u];
    if (!handler) throw new Error(`stubFetch: no handler for ${key}`);
    return handler();
  }) as typeof fetch;
  return { fn, calls };
}

describe('OpenCodeServerBridge — endpoint contracts', () => {
  it('createSession POSTs /session and returns the parsed session', async () => {
    const { fn, calls } = stubFetch({
      'POST http://127.0.0.1:4096/session': () =>
        new Response(JSON.stringify({ id: 'ses_abc' }), { status: 200 }),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    const out = await bridge.createSession();
    expect(out.id).toBe('ses_abc');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0].init?.body).toBe('{}');
  });

  it('createSession surfaces non-2xx as an error with status', async () => {
    const { fn } = stubFetch({
      'POST http://127.0.0.1:4096/session': () =>
        new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    await expect(bridge.createSession()).rejects.toThrow(/500/);
  });

  it('promptAsync POSTs to /session/:id/prompt_async with the body', async () => {
    const { fn, calls } = stubFetch({
      'POST http://127.0.0.1:4096/session/ses_abc/prompt_async': () =>
        new Response(null, { status: 204 }),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    await bridge.promptAsync('ses_abc', {
      model: 'anthropic/claude-opus-4-7',
      system: 'sys',
      parts: [{ type: 'text', text: 'hi' }],
    });
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.model).toBe('anthropic/claude-opus-4-7');
    expect(body.parts).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('abortSession swallows non-2xx (best-effort cleanup)', async () => {
    const { fn } = stubFetch({
      'POST http://127.0.0.1:4096/session/ses_abc/abort': () =>
        new Response('error', { status: 500 }),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    // Must NOT throw — fallback cleanup paths depend on this.
    await expect(bridge.abortSession('ses_abc')).resolves.toBeUndefined();
  });

  it('deleteSession swallows non-2xx (best-effort cleanup)', async () => {
    const { fn } = stubFetch({
      'DELETE http://127.0.0.1:4096/session/ses_abc/': () =>
        new Response('gone', { status: 404 }),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    await expect(bridge.deleteSession('ses_abc')).resolves.toBeUndefined();
  });

  it('encodes session ids in URL paths (defense against unusual id chars)', async () => {
    const { fn, calls } = stubFetch({
      'POST http://127.0.0.1:4096/session/ses_with%20space/abort': () =>
        new Response(null, { status: 204 }),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    await bridge.abortSession('ses_with space');
    expect(calls[0].url).toContain('ses_with%20space');
  });

  it('strips trailing slash from baseUrl (no double-slash in paths)', async () => {
    const { fn, calls } = stubFetch({
      'POST http://127.0.0.1:4096/session': () =>
        new Response(JSON.stringify({ id: 'ses_x' }), { status: 200 }),
    });
    const bridge = new OpenCodeServerBridge({
      baseUrl: 'http://127.0.0.1:4096/',  // trailing slash
      fetchImpl: fn,
    });
    await bridge.createSession();
    expect(calls[0].url).toBe('http://127.0.0.1:4096/session');  // single slash
  });
});

describe('OpenCodeServerBridge — SSE block parsing', () => {
  /** Build a Response from a string body that streams as SSE chunks. */
  function sseResponse(chunks: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('parses one event per blank-line-separated block', async () => {
    const { fn } = stubFetch({
      'http://127.0.0.1:4096/event': () =>
        sseResponse([
          'data: {"type":"foo","payload":1}\n\n',
          'data: {"type":"bar","payload":2}\n\n',
        ]),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    const events = [];
    for await (const event of bridge.subscribeEvents()) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('foo');
    expect(events[1].type).toBe('bar');
  });

  it('handles events split across multiple chunks (TCP-fragmentation tolerance)', async () => {
    const { fn } = stubFetch({
      'http://127.0.0.1:4096/event': () =>
        sseResponse([
          'data: {"typ',
          'e":"split"',
          ',"x":7}\n',
          '\n',
        ]),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    const events = [];
    for await (const event of bridge.subscribeEvents()) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('split');
    expect(events[0].x).toBe(7);
  });

  it('skips non-JSON / unparseable blocks rather than throwing', async () => {
    const { fn } = stubFetch({
      'http://127.0.0.1:4096/event': () =>
        sseResponse([
          'data: not-json\n\n',
          'data: {"type":"valid"}\n\n',
        ]),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    const events = [];
    for await (const event of bridge.subscribeEvents()) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('valid');
  });

  it('skips events without a `type` string field', async () => {
    const { fn } = stubFetch({
      'http://127.0.0.1:4096/event': () =>
        sseResponse([
          'data: {"no_type":true}\n\n',
          'data: {"type":42}\n\n',  // type must be a string
          'data: {"type":"good"}\n\n',
        ]),
    });
    const bridge = new OpenCodeServerBridge({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: fn });
    const events = [];
    for await (const event of bridge.subscribeEvents()) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('good');
  });
});
