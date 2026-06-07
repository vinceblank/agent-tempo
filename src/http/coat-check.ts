/**
 * Daemon coat-check routes (#713 / #42) — HTTP surface over the per-ensemble
 * coat-check store (#318, ADR 0008).
 *
 *   POST /v1/ensembles/:e/coat-check          { summary, content, contentType?, ttlMs? } → 200 { ticket, … }
 *   GET  /v1/ensembles/:e/coat-check/:ticket                                              → 200 { found, entry }
 *
 * **Why**: `coat_check_put` was MCP/Temporal-only, so the command-center planner
 * (a mission-control Pi extension with NO Temporal inbox — it drives the daemon
 * over HTTP) could only hand off plans INLINE on a cue. This route lets the
 * planner park a plan and hand off a ticket instead, keeping the cue body lean.
 *
 * **Audit identity** is stamped by this layer as the operator (`maestro`) — the
 * HTTP caller cannot supply `putBy` / `fetchedBy` (same anti-spoof posture as the
 * MCP tools, where audit identity comes from `getPlayerId()`, never a caller arg).
 *
 * **Auth** (gated by the caller in server.ts):
 * - `put` is a WRITE → Tier 2 (admin), consistent with `/ask` and the write surface.
 * - `get` REDEEMS via a maestro Update that bumps fetch-audit counters — it is NOT
 *   a pure read, so it is also gated at Tier 2.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TempoClient } from '../client/interface';
import { errorResponse, jsonResponse } from './responses';
import {
  readJsonBody,
  BODY_TOO_LARGE,
  BODY_INVALID_JSON,
  WRITE_BODY_MAX,
  stringField,
} from './body';
import { validateEnsembleName } from '../utils/validation';
import {
  COAT_CHECK_CONTENT_MAX,
  COAT_CHECK_SUMMARY_MAX,
  COAT_CHECK_CONTENT_TYPE_MAX,
  COAT_CHECK_TICKET_MAX,
  COAT_CHECK_TICKET_REGEX,
  COAT_CHECK_TTL_MIN_MS,
  COAT_CHECK_TTL_MAX_MS,
} from '../utils/validation';

/**
 * Operator audit identity for HTTP-sourced coat-check ops. The command-center
 * planner has no player id; like the `/cue` + `/ask` routes (which write as the
 * maestro), stashes/redeems are attributed to the maestro. NOT caller-supplied —
 * a fixed constant so the HTTP surface can't spoof a peer's audit identity.
 */
export const HTTP_COAT_CHECK_IDENTITY = 'maestro';

/** A ticket is non-empty, ≤ cap, and URL/path-safe (it rides a GET path segment). */
export function isValidTicket(t: string | undefined): t is string {
  return typeof t === 'string' && t.length > 0 && t.length <= COAT_CHECK_TICKET_MAX && COAT_CHECK_TICKET_REGEX.test(t);
}

/** POST /v1/ensembles/:e/coat-check — stash a content body, return a ticket. */
export async function handleCoatCheckPut(
  req: IncomingMessage,
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
): Promise<void> {
  if (validateEnsembleName(ensemble) !== null) {
    return errorResponse(res, 400, { error: 'invalid-ensemble-name', ensemble });
  }
  const body = await readJsonBody(req);
  if (body === BODY_TOO_LARGE) return errorResponse(res, 413, { error: 'body-too-large', limit: WRITE_BODY_MAX });
  if (body === BODY_INVALID_JSON) return errorResponse(res, 400, { error: 'invalid-json' });

  const summary = stringField(body, 'summary');
  const content = stringField(body, 'content');
  if (!summary) return errorResponse(res, 400, { error: 'missing-field', field: 'summary' });
  if (!content) return errorResponse(res, 400, { error: 'missing-field', field: 'content' });
  if (summary.length > COAT_CHECK_SUMMARY_MAX) {
    return errorResponse(res, 400, { error: 'summary-too-long', limit: COAT_CHECK_SUMMARY_MAX });
  }
  // Byte length, not char length — the workflow validator caps on UTF-8 bytes.
  if (Buffer.byteLength(content, 'utf8') > COAT_CHECK_CONTENT_MAX) {
    return errorResponse(res, 413, { error: 'content-too-large', limit: COAT_CHECK_CONTENT_MAX });
  }

  const contentType = stringField(body, 'contentType');
  if (contentType !== undefined && contentType.length > COAT_CHECK_CONTENT_TYPE_MAX) {
    return errorResponse(res, 400, { error: 'content-type-too-long', limit: COAT_CHECK_CONTENT_TYPE_MAX });
  }
  let ttlMs: number | undefined;
  if (body.ttlMs !== undefined) {
    if (
      typeof body.ttlMs !== 'number' ||
      !Number.isInteger(body.ttlMs) ||
      body.ttlMs < COAT_CHECK_TTL_MIN_MS ||
      body.ttlMs > COAT_CHECK_TTL_MAX_MS
    ) {
      return errorResponse(res, 400, {
        error: 'invalid-field', field: 'ttlMs', min: COAT_CHECK_TTL_MIN_MS, max: COAT_CHECK_TTL_MAX_MS,
      });
    }
    ttlMs = body.ttlMs;
  }

  try {
    const result = await client.coatCheckPut(ensemble, {
      summary,
      content,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      putBy: HTTP_COAT_CHECK_IDENTITY,
    });
    jsonResponse(res, 200, { ok: true, ensemble, ...result });
  } catch (err) {
    return mapCoatCheckError(res, ensemble, err);
  }
}

/** GET /v1/ensembles/:e/coat-check/:ticket — redeem a ticket + pull the content. */
export async function handleCoatCheckGet(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  ticket: string,
): Promise<void> {
  if (validateEnsembleName(ensemble) !== null) {
    return errorResponse(res, 400, { error: 'invalid-ensemble-name', ensemble });
  }
  if (!isValidTicket(ticket)) {
    return errorResponse(res, 400, { error: 'invalid-ticket', ticket });
  }
  try {
    const entry = await client.coatCheckGet(ensemble, { ticket, fetchedBy: HTTP_COAT_CHECK_IDENTITY });
    // Mirror the sibling `/answer` route: 200 + `found:false` for the common
    // "ticket already gone" case (missing / expired / evicted), rather than 404.
    jsonResponse(res, 200, { ok: true, ensemble, ticket, found: entry !== null, entry });
  } catch (err) {
    return mapCoatCheckError(res, ensemble, err);
  }
}

/**
 * Map a thrown coat-check error to an HTTP response. Recognises the maestro
 * hub-not-running errors (→ 404) and the workflow's structured saturation /
 * oversize ApplicationFailures (→ 409 / 413); anything else → 500.
 */
function mapCoatCheckError(res: ServerResponse, ensemble: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (/no session found|no maestro|workflow not found/i.test(message)) {
    return errorResponse(res, 404, { error: 'session-not-found', ensemble, detail: message });
  }
  if (/CoatCheckSlotsFull/i.test(message)) {
    return errorResponse(res, 409, { error: 'coat-check-slots-full', ensemble, detail: message });
  }
  if (/CoatCheckEntryTooLarge/i.test(message)) {
    return errorResponse(res, 413, { error: 'coat-check-entry-too-large', ensemble, detail: message });
  }
  return errorResponse(res, 500, { error: 'coat-check-failed', ensemble, detail: message });
}
