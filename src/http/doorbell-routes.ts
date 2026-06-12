/**
 * HTTP route handler for the cue doorbell (T1.1 PR-1,
 * docs/design/t11-cue-doorbell.md §2.3).
 *
 *   GET /doorbell/:ensemble/:playerId        (SSE; loopback + X-Ingest-Token)
 *
 * Adapter-facing INGRESS auth plane (the inner-loop model — loopback
 * `socket.remoteAddress` + per-player ingest token vs the URL-derived
 * workflowId, uniform 403 on every failure), even though the data flows
 * daemon→adapter: the doorbell is part of the source/adapter contract, not
 * the versioned `/v1` observer contract (architect ruling — no RBAC tiers,
 * no SSE envelope, no Last-Event-ID/replay here, deliberately).
 *
 * Events are content-free `ding`s. No event ids, no replay — a ding that
 * doesn't reach a listener was, by the §1 invariant, never sent; the
 * adapter's fallback poll is the delivery guarantee.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { gateIngress } from './inner-loop-routes';
import type { DoorbellRegistry } from './doorbell';
import type { IngestTokenRegistry } from './ingest-registry';

/** Max bytes buffered to a slow doorbell SSE socket before we drop the connection. */
const MAX_SSE_WRITE_BUFFER = 64 * 1024;

/** Keepalive comment cadence on an idle doorbell stream. */
const DOORBELL_KEEPALIVE_MS = 15_000;

export interface DoorbellRouteDeps {
  doorbells: DoorbellRegistry;
  ingestTokens: IngestTokenRegistry;
}

/**
 * GET /doorbell/:e/:p — adapter SSE doorbell stream. One `event: ding` line
 * per coalesced ring; `:ka` keepalives; `:closed` when the player's
 * subscriptions are closed (destroy / daemon shutdown). A slow socket is
 * dropped rather than buffered (the adapter's reconnect loop + fallback poll
 * cover the gap — §5).
 */
export async function handleDoorbellSse(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DoorbellRouteDeps,
  ensemble: string,
  playerId: string,
): Promise<void> {
  const workflowId = gateIngress(req, res, deps, ensemble, playerId);
  if (workflowId === null) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately so the adapter's stream OPENS now, not on the
  // first ding/keepalive (mirrors handleInnerSse).
  res.flushHeaders?.();

  const sub = deps.doorbells.subscribe(workflowId);
  let cleanedUp = false;
  const keepalive = setInterval(() => {
    try { res.write(':ka\n\n'); } catch { /* socket gone — close handler cleans up */ }
  }, DOORBELL_KEEPALIVE_MS);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(keepalive);
    deps.doorbells.unsubscribe(workflowId, sub);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  try {
    for await (const _ding of sub) {
      void _ding;
      res.write('event: ding\ndata: {}\n\n');
      const buffered = res.socket?.writableLength ?? 0;
      if (buffered > MAX_SSE_WRITE_BUFFER) break;
    }
    // Subscription closed (player destroyed / shutdown) — signal a clean end.
    try { res.write(':closed\n\n'); } catch { /* already closed */ }
  } catch {
    /* write-after-close or iterator error — fall through to cleanup */
  } finally {
    cleanup();
    try { res.end(); } catch { /* already ended */ }
  }
}
