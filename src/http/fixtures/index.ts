/**
 * Test-fixture mode for the daemon HTTP/SSE surface — PR-3 of #340.
 *
 * Adds a `?fixture=<name>` query param to `/v1/state/:ensemble` and
 * `/v1/events/:ensemble`. When set to a known fixture, the daemon
 * returns canned data instead of running live Temporal queries / wiring
 * the aggregate poll loop.
 *
 * **Why this exists**: PR-4 onwards (dashboard SPA work) needs
 * deterministic, reproducible scenarios — a conductor leaving, a
 * broadcast fan-out, a chat-ring overflow, an SSE reconnect. Real
 * ensemble events are flaky for UI-driven testing; fixtures aren't.
 *
 * **Auth posture**: fixture mode honours the existing bearer-auth gate
 * (loopback no-auth, non-loopback bearer required). The fixture
 * endpoint is NOT a backdoor — it's an alternate *projection* of an
 * authorised request. See `docs/SSE-PROTOCOL.md` § 11a.
 *
 * **Type safety**: fixture data imports its types from
 * {@link ../event-types} so a wire-protocol change here breaks the
 * `tsc` build of every fixture module. Don't redeclare shapes inside
 * fixture files.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { errorResponse, jsonResponse } from '../responses';
import { frameSseEventData, openSseResponse } from '../sse-handler';
import type { TempoEvent, EnsembleStateV1 } from '../event-types';
import { emptyEnsemble } from './empty-ensemble';
import { singleConductor } from './single-conductor';
import { eightPlayerBroadcast } from './eight-player-broadcast';
import { conductorLeaving } from './conductor-leaving';
import { sseReconnect } from './sse-reconnect';
import { chatStress } from './chat-stress';

export interface FixtureScenario {
  name: string;
  description: string;
  /** Returned by `/v1/state/:ensemble?fixture=<name>` verbatim. */
  snapshot: EnsembleStateV1;
  /** Walked in order by `/v1/events/:ensemble?fixture=<name>` after the snapshot prelude. */
  events: TempoEvent[];
  /** Delay between events in ms. `0` (default) ⇒ flush all at once. */
  eventCadenceMs?: number;
}

const FIXTURES: Record<string, FixtureScenario> = {
  [emptyEnsemble.name]: emptyEnsemble,
  [singleConductor.name]: singleConductor,
  [eightPlayerBroadcast.name]: eightPlayerBroadcast,
  [conductorLeaving.name]: conductorLeaving,
  [sseReconnect.name]: sseReconnect,
  [chatStress.name]: chatStress,
};

/** Lookup by name. Returns `null` for unknown fixtures. */
export function getFixture(name: string): FixtureScenario | null {
  return FIXTURES[name] ?? null;
}

/** Listing for diagnostics — used by potential future `/v1/fixtures` listing. */
export function listFixtures(): { name: string; description: string }[] {
  return Object.values(FIXTURES).map((f) => ({ name: f.name, description: f.description }));
}

/** Handler for `GET /v1/state/:ensemble?fixture=<name>`. */
export function handleFixtureSnapshot(res: ServerResponse, fixtureName: string): void {
  const fixture = getFixture(fixtureName);
  if (!fixture) {
    return errorResponse(res, 404, { error: 'unknown-fixture', fixture: fixtureName });
  }
  jsonResponse(res, 200, fixture.snapshot);
}

/**
 * Handler for `GET /v1/events/:ensemble?fixture=<name>`. Streams the
 * fixture's snapshot prelude followed by its event list, with optional
 * inter-event delays. Closes the connection when all events have been
 * delivered (or sooner if the client disconnects).
 *
 * The snapshot prelude reuses the fixture's `lastEventId` so a consumer
 * comparing `Last-Event-ID` against subsequent events sees the
 * snapshot ordered before the live events.
 */
export async function handleFixtureSse(
  req: IncomingMessage,
  res: ServerResponse,
  fixtureName: string,
): Promise<void> {
  const fixture = getFixture(fixtureName);
  if (!fixture) {
    return errorResponse(res, 404, { error: 'unknown-fixture', fixture: fixtureName });
  }

  openSseResponse(res, 'claude-tempo SSE (fixture)');

  // AbortController is the single source of truth for "client disconnected".
  // Fires on TCP drop, abort, or natural end-of-events. `once()` ensures
  // each underlying close event registers exactly one tick, and the
  // `finally` cleanup detaches the listeners regardless of how we exit.
  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.once('close', onClose);
  res.once('close', onClose);

  try {
    if (abort.signal.aborted) return;
    res.write(frameSseEventData(fixture.snapshot.lastEventId, 'snapshot', fixture.snapshot));

    const cadence = fixture.eventCadenceMs ?? 0;
    for (let i = 0; i < fixture.events.length; i++) {
      if (abort.signal.aborted) return;
      const ev = fixture.events[i];
      res.write(frameSseEventData(ev.eventId, ev.type, ev.payload));
      if (cadence > 0 && i < fixture.events.length - 1) {
        const ok = await delay(cadence, abort.signal);
        if (!ok) return;
      }
    }
  } finally {
    req.removeListener('close', onClose);
    res.removeListener('close', onClose);
    if (!res.writableEnded) {
      try { res.end(); } catch { /* socket already gone */ }
    }
  }
}

/**
 * Sleep for `ms` milliseconds, returning `false` if the abort signal
 * fires first. Lets the event loop unblock the moment the client
 * disconnects rather than running out the cadence timer.
 */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
