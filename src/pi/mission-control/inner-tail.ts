/**
 * Fine inner-loop tail consumer (3f) — the OPERATOR egress side of the 3c
 * side-channel: `GET /v1/players/:e/:p/inner` (SSE, T3 admin bearer). Distinct
 * from `src/pi/inner-loop-client.ts` (the player→daemon INGRESS). Opened on
 * `/tail <player>`, torn down on deselect / shutdown.
 *
 * The SSE-frame parser is pure + unit-tested; the stream pump is injectable
 * (fetch) so the extension wires real `fetch` while tests drive frames directly.
 *
 * NOTE (cross-host): `/inner` is daemon-LOCAL to the player's host. Single-host
 * (Meijer container) uses the local daemon; multi-host should resolve the
 * player's `preferredHost` via `/v1/hosts` and target that daemon — the
 * `baseUrl` option is the seam for that (don't hardcode localhost forever).
 */
import type { InnerFrame } from '../inner-loop-publisher';

/**
 * Parse the `data:` payloads out of one SSE text chunk, returning the decoded
 * InnerFrames + any trailing partial buffer to prepend to the next chunk. Pure.
 * Tolerates keepalive comment lines (`:`) and multi-line frames split on `\n\n`.
 */
export function parseInnerSse(chunk: string, carry = ''): { frames: InnerFrame[]; carry: string } {
  const buf = carry + chunk;
  const parts = buf.split('\n\n');
  const rest = parts.pop() ?? ''; // last element is an incomplete event (or '')
  const frames: InnerFrame[] = [];
  for (const evt of parts) {
    // An SSE event may have multiple lines; collect `data:` lines, ignore `:`/`event:`/`id:`.
    const data = evt
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as { type?: unknown };
      if (parsed && typeof parsed.type === 'string' && parsed.type.startsWith('inner.')) {
        frames.push(parsed as InnerFrame);
      }
    } catch {
      // ignore malformed/non-frame data
    }
  }
  return { frames, carry: rest };
}

export type TailFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; body: AsyncIterable<Uint8Array> | null }>;

export interface OpenInnerTailOptions {
  baseUrl: string;
  /**
   * Admin (T3) token. OPTIONAL (#54): a loopback daemon serves the `/inner`
   * egress tokenless (full-trust short-circuit). When absent, no `Authorization`
   * header is sent and the daemon decides — a remote / `0.0.0.0` daemon 401s
   * (surfaced via `onError`).
   */
  adminToken?: string;
  ensemble: string;
  playerId: string;
  onFrame: (frame: InnerFrame) => void;
  signal: AbortSignal;
  fetchFn: TailFetch;
  /** Called on a non-200 / stream error (e.g. to surface in the widget). */
  onError?: (message: string) => void;
}

/**
 * Open the per-player inner SSE and pump frames to `onFrame` until `signal`
 * aborts. Resolves when the stream ends/aborts; never throws (errors → onError).
 */
export async function openInnerTail(opts: OpenInnerTailOptions): Promise<void> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/players/` +
    `${encodeURIComponent(opts.ensemble)}/${encodeURIComponent(opts.playerId)}/inner`;
  let res;
  try {
    res = await opts.fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        // #54 — bearer ONLY when a token is set; loopback serves tokenless.
        ...(opts.adminToken ? { Authorization: `Bearer ${opts.adminToken}` } : {}),
      },
      signal: opts.signal,
    });
  } catch (err) {
    if (!opts.signal.aborted) opts.onError?.(err instanceof Error ? err.message : String(err));
    return;
  }
  if (res.status !== 200 || !res.body) {
    // #54 — a tokenless 401/403 means a remote / 0.0.0.0 daemon that needs the token.
    const hint = !opts.adminToken && (res.status === 401 || res.status === 403)
      ? ' (set AGENT_TEMPO_HTTP_ADMIN_TOKEN for a remote/0.0.0.0 daemon; loopback needs none)'
      : '';
    opts.onError?.(`inner tail HTTP ${res.status}${hint}`);
    return;
  }
  const decoder = new TextDecoder();
  let carry = '';
  try {
    for await (const chunk of res.body) {
      if (opts.signal.aborted) break;
      const { frames, carry: next } = parseInnerSse(decoder.decode(chunk, { stream: true }), carry);
      carry = next;
      for (const f of frames) opts.onFrame(f);
    }
  } catch (err) {
    if (!opts.signal.aborted) opts.onError?.(err instanceof Error ? err.message : String(err));
  }
}
