/**
 * HTTP route handlers for the 3c Tier-2 inner-loop side-channel (MD-F).
 * server.ts dispatches to these; the logic lives here so it stays testable.
 *
 * THREE routes, TWO auth planes (security's ingest-auth design):
 *
 *   INGRESS (source → daemon; publisher-only). Mounted in server.ts BEFORE the
 *   outer bearer gate so it works regardless of the daemon's bind address —
 *   authenticated by its OWN gates, not the operator bearer:
 *     - POST /v1/players/:ensemble/:playerId/inner/ingest  → publish a frame
 *     - GET  /v1/players/:ensemble/:playerId/inner/presence → { subscribers }
 *   Both gate on: (1) loopback `req.socket.remoteAddress`; (2) `X-Ingest-Token`
 *   validated against the URL-derived workflowId (cross-player-spoof guard).
 *   Every failure → 403 with no detail (no info leak).
 *
 *   EGRESS (daemon → operator/widget). Mounted AFTER the outer bearer gate with
 *   an explicit `requireTier(3)`:
 *     - GET /v1/players/:ensemble/:playerId/inner  → SSE fine-tail stream
 *
 * MD-F invariants preserved: off-Temporal, off the coordination bus,
 * daemon-LOCAL (loopback ingest = same host), ephemeral (no ring/replay).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { sessionWorkflowId } from '../config';
import { errorResponse, jsonResponse } from './responses';
import { readJsonBody, BODY_TOO_LARGE, BODY_INVALID_JSON, INGEST_BODY_MAX } from './body';
import type { InnerLoopRegistry } from './inner-loop';
import type { IngestTokenRegistry } from './ingest-registry';
import type { InnerFrame } from '../pi/inner-loop-publisher';

/** Loopback remote addresses Node may report for a same-host connection. */
const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Header carrying the per-player ingest token (the source-plane credential). */
export const INGEST_TOKEN_HEADER = 'x-ingest-token';

/** Max bytes buffered to a slow `/inner` SSE socket before we drop the connection. */
const MAX_SSE_WRITE_BUFFER = 1024 * 1024;

/** Keepalive comment cadence on an idle `/inner` stream. */
const INNER_KEEPALIVE_MS = 15_000;

export interface InnerLoopDeps {
  innerLoop: InnerLoopRegistry;
  ingestTokens: IngestTokenRegistry;
}

/** True when the request originates from the same host (loopback). */
export function isLoopbackRemote(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress;
  return addr != null && LOOPBACK_REMOTES.has(addr);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Run the shared INGRESS gate (loopback + ingest-token vs URL workflowId).
 * Returns the resolved workflowId on success, or `null` after having written a
 * uniform `403` (no info leak — callers just `return` on null).
 */
function gateIngress(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InnerLoopDeps,
  ensemble: string,
  playerId: string,
): string | null {
  // Uniform 403 on EVERY failure — never reveal which gate tripped.
  const deny = (): null => {
    errorResponse(res, 403, { error: 'forbidden' });
    return null;
  };
  if (!isLoopbackRemote(req)) return deny();
  const token = headerValue(req.headers[INGEST_TOKEN_HEADER]);
  if (!token) return deny();
  const workflowId = sessionWorkflowId(ensemble, playerId);
  if (!deps.ingestTokens.validate(workflowId, token)) return deny();
  return workflowId;
}

/**
 * POST /v1/players/:e/:p/inner/ingest — the publisher forwards ONE InnerFrame.
 * 204 on success; uniform 403 on any gate/shape/oversize failure (no-leak). The
 * daemon TRUSTS the authenticated publisher's summaries (already ~2KB-truncated
 * at source) — the 32KB cap is purely the DOS backstop; no re-truncation.
 */
export async function handleInnerIngest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InnerLoopDeps,
  ensemble: string,
  playerId: string,
): Promise<void> {
  const workflowId = gateIngress(req, res, deps, ensemble, playerId);
  if (workflowId === null) return;

  const body = await readJsonBody(req, INGEST_BODY_MAX);
  // Oversize / malformed / non-frame → uniform 403 (no-leak; the publisher just
  // drops the frame on any non-204).
  if (body === BODY_TOO_LARGE || body === BODY_INVALID_JSON) {
    return errorResponse(res, 403, { error: 'forbidden' });
  }
  const type = body.type;
  if (typeof type !== 'string' || !type.startsWith('inner.')) {
    return errorResponse(res, 403, { error: 'forbidden' });
  }
  // S1 (security): `type` is interpolated RAW into the operator SSE `event:`
  // line (handleInnerSse) — a CR/LF here would let an authenticated source
  // inject/garble frames in the operator's stream. Reject at the INGRESS
  // boundary so a malformed type never enters the registry. (Every other frame
  // field is JSON.stringify'd into `data:`, which escapes control chars.)
  if (/[\r\n]/.test(type)) {
    return errorResponse(res, 403, { error: 'forbidden' });
  }
  // Trust the authenticated publisher's frame shape (it owns the schema +
  // truncation). Publish to local subscribers and ack with no body.
  deps.innerLoop.publish(workflowId, body as unknown as InnerFrame);
  res.writeHead(204);
  res.end();
}

/**
 * GET /v1/players/:e/:p/inner/presence — publisher-only presence probe.
 * Same gates as ingest (presence is publisher-only; leaking "is someone
 * watching X" would be a covert channel). 200 `{ subscribers }` or 403.
 */
export function handleInnerPresence(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InnerLoopDeps,
  ensemble: string,
  playerId: string,
): void {
  const workflowId = gateIngress(req, res, deps, ensemble, playerId);
  if (workflowId === null) return;
  jsonResponse(res, 200, {
    subscribers: deps.innerLoop.subscriberCount(workflowId),
  });
}

/**
 * GET /v1/players/:e/:p/inner — operator/widget SSE fine-tail stream (EGRESS).
 * server.ts has already applied the outer bearer + `requireTier(3)` gate. Plain
 * `event:`/`data:` framing (fetch-consumable, no EventSource-specific framing);
 * `:ka` keepalive; `:closed` when the player goes away. No ring/seq/replay —
 * ephemeral best-effort tail (a disconnect loses in-flight deltas, by design).
 */
export async function handleInnerSse(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InnerLoopDeps,
  ensemble: string,
  playerId: string,
): Promise<void> {
  const workflowId = sessionWorkflowId(ensemble, playerId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the operator's stream OPENS now, not on the
  // first frame/keepalive — otherwise Node buffers the head until the first
  // body write and a fetch/EventSource client blocks up to INNER_KEEPALIVE_MS.
  // (Mirrors the main SSE handler in sse-handler.ts.)
  res.flushHeaders?.();

  const sub = deps.innerLoop.subscribe(workflowId);
  let cleanedUp = false;
  const keepalive = setInterval(() => {
    try { res.write(':ka\n\n'); } catch { /* socket gone — close handler cleans up */ }
  }, INNER_KEEPALIVE_MS);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(keepalive);
    deps.innerLoop.unsubscribe(workflowId, sub);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  try {
    for await (const frame of sub) {
      res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      // Bound the per-connection write buffer: a slow operator socket must not
      // grow the daemon's memory unboundedly. Drop the connection if it backs up
      // (ephemeral tail — reconnect re-tails live).
      const buffered = res.socket?.writableLength ?? 0;
      if (buffered > MAX_SSE_WRITE_BUFFER) break;
    }
    // Subscription ended (player gone / unsubscribe) — signal a clean close.
    try { res.write(':closed\n\n'); } catch { /* already closed */ }
  } catch {
    /* write-after-close or iterator error — fall through to cleanup */
  } finally {
    cleanup();
    try { res.end(); } catch { /* already ended */ }
  }
}
