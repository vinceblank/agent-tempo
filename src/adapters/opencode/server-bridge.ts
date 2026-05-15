/**
 * Thin HTTP/SSE wrapper around `opencode serve`.
 *
 * Hand-rolled over native `fetch` rather than `@opencode-ai/sdk` per design
 * §8.3 LoC tightening proposal #2 — the SDK is auto-generated from
 * OpenAPI 3.1, so it pulls in OpenAPI runtime + per-endpoint typed clients
 * for ~50 endpoints. Our hot path uses ~5 endpoints + the `/event` SSE
 * stream; the SDK weight isn't worth it. The architectural shape of the
 * adapter is identical either way.
 *
 * The SDK is still listed as an `optionalDependency` and `require.resolve`
 * gates the recruit pre-flight (ADR 0015 §85) — operators install it as
 * the signal that opencode integration is intended on this host. Adapter
 * runtime, however, never imports it.
 *
 * Contract surface (5 methods + 1 generator):
 *   - `waitForHealth(timeoutMs)`
 *   - `getHealth()`
 *   - `createSession()`
 *   - `promptAsync(sessionId, body)`
 *   - `abortSession(sessionId)`
 *   - `deleteSession(sessionId)`
 *   - `subscribeEvents(abortSignal)` — async generator yielding parsed events
 *
 * Design reference: docs/design/449-opencode-adapter.md §5.3, §8.1.
 */

/**
 * Health response shape from `GET /global/health`. Drift-tolerant — only
 * the `version` field is read, everything else is forwarded as `unknown`.
 */
export interface OpenCodeHealth {
  version: string;
}

/**
 * Newly-created session shape from `POST /session`. Drift-tolerant — only
 * the `id` field is read.
 */
export interface OpenCodeSession {
  id: string;
}

/**
 * Body for `POST /session/:id/prompt_async`. The adapter sends the system
 * prompt + the new turn's parts (claude-tempo workflow's pendingMessages
 * flattened into a parts array) plus the model id to use for this turn.
 */
export interface PromptAsyncBody {
  model: string;
  system?: string;
  parts: Array<{ type: 'text'; text: string }>;
}

/**
 * One SSE event from the `/event` stream. OpenCode's event surface is
 * still labeled experimental (ADR 0015 §82) so we model it permissively
 * — `type` is parsed, the rest forwarded as `unknown`. Consumers
 * narrow on `type` and read the fields they need.
 */
export interface OpenCodeEvent {
  type: string;
  [key: string]: unknown;
}

export interface ServerBridgeOpts {
  /** Base URL — `http://127.0.0.1:<port>` per the loopback-only model. */
  baseUrl: string;
  /** Logger — adapter passes its `[agent-tempo:opencode]` prefix here. */
  log?: (...args: unknown[]) => void;
  /**
   * Test seam — defaults to global `fetch`. Tests inject a stub to drive
   * canned responses without standing up a real http server.
   */
  fetchImpl?: typeof fetch;
}

/** Default health-probe poll interval. Tight loop — opencode boots in <1s. */
const HEALTH_POLL_INTERVAL_MS = 200;

export class OpenCodeServerBridge {
  private readonly baseUrl: string;
  private readonly log: (...args: unknown[]) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ServerBridgeOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.log = opts.log ?? ((..._args) => { /* silent default */ });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Poll `GET /global/health` until 200 or `timeoutMs` elapses. Throws on
   * timeout — caller is the adapter `run()` and a missing health probe
   * means opencode didn't boot.
   */
  async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/global/health`);
        if (res.ok) return;
        lastErr = new Error(`/global/health returned ${res.status}`);
      } catch (err) {
        // Connection refused while opencode is still booting — keep polling.
        lastErr = err;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`opencode serve did not become healthy within ${timeoutMs}ms${lastErr ? ` (last error: ${(lastErr as Error)?.message ?? lastErr})` : ''}`);
  }

  /** `GET /global/health` — version + healthy flag. */
  async getHealth(): Promise<OpenCodeHealth> {
    const res = await this.fetchImpl(`${this.baseUrl}/global/health`);
    if (!res.ok) {
      throw new Error(`/global/health returned ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as OpenCodeHealth;
  }

  /** `POST /session` — create a new session; returns the session id + meta. */
  async createSession(): Promise<OpenCodeSession> {
    const res = await this.fetchImpl(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`POST /session returned ${res.status} ${res.statusText}${body ? ': ' + body : ''}`);
    }
    return (await res.json()) as OpenCodeSession;
  }

  /**
   * `POST /session/:id/prompt_async` — send a turn; returns 204 immediately
   * and the turn streams over `/event` SSE. Caller is responsible for
   * subscribing to events first.
   */
  async promptAsync(sessionId: string, body: PromptAsyncBody): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`prompt_async returned ${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
    }
  }

  /**
   * `POST /session/:id/abort` — graceful turn cancellation. The primary
   * cancellation path on lease revocation; subprocess SIGTERM is the
   * fallback only if this hangs.
   *
   * Best-effort — swallows non-2xx so the adapter's superseded path can
   * still fall through to subprocess kill without surfacing an error.
   */
  async abortSession(sessionId: string, opts?: { signal?: AbortSignal }): Promise<void> {
    try {
      await this.fetchImpl(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`,
        { method: 'POST', signal: opts?.signal },
      );
    } catch (err) {
      this.log('abortSession suppressed error:', (err as Error)?.message ?? err);
    }
  }

  /**
   * `DELETE /session/:id` — free server-side session resources. Called on
   * graceful detach. Best-effort — swallows non-2xx.
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.fetchImpl(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/`,
        { method: 'DELETE' },
      );
    } catch (err) {
      this.log('deleteSession suppressed error:', (err as Error)?.message ?? err);
    }
  }

  /**
   * `GET /event` — SSE stream of session events. Returns an async
   * generator that yields parsed `OpenCodeEvent` objects until the
   * abort signal fires or the stream closes.
   *
   * The caller is responsible for filtering events by session id —
   * `/event` is global per `opencode serve` instance, but the v1
   * subprocess-per-player model means there's only ever one session
   * per stream anyway. Phase 2 subprocess-shared optimization would
   * make filtering meaningful.
   */
  async *subscribeEvents(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent, void, void> {
    const res = await this.fetchImpl(`${this.baseUrl}/event`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`/event returned ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        // SSE: events are separated by blank lines (\n\n). One event may
        // span multiple `data:` lines; concatenate and parse as JSON.
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parseSseBlock(block);
          if (event) yield event;
          sep = buffer.indexOf('\n\n');
        }
      }
    } finally {
      // Release the reader so the underlying connection can close.
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

/**
 * Parse one SSE block (the text between two blank-line separators) into
 * an `OpenCodeEvent`. Returns `null` on parse failure or empty `data`.
 *
 * Format per SSE spec:
 *   event: foo       (optional — most OpenCode events use only `data:`)
 *   data: { ... }
 *   data: ...        (continuation of data; concatenated with `\n`)
 */
function parseSseBlock(block: string): OpenCodeEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
    // event: / id: / retry: lines ignored — claude-tempo only consumes data.
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as OpenCodeEvent;
    }
    return null;
  } catch {
    // Non-JSON event — opencode shouldn't emit these; ignore safely.
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
