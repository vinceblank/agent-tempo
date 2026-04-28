/**
 * Daemon HTTP write surface — PR-7a of #340.
 *
 * Adds five POST routes under `/v1/ensembles/:ensemble/{cue, pause,
 * play, release, recruit}`. Each handler is a thin shim over the
 * existing {@link TempoClient} method the daemon already has in scope
 * (the same `ctx.client` used for snapshots).
 *
 * **Why now**: PR-1 → PR-6 of the dashboard shipped a read-only
 * surface; PR-7b wires the dashboard's disabled CTAs to real submit
 * handlers. Those handlers need an HTTP write API — until now the
 * daemon was GET-only by design. See the full background in
 * `docs/SSE-PROTOCOL.md` § 11b.
 *
 * **Auth posture** matches the read side:
 * - Loopback bind + no `Origin` header → no auth (TUI/CLI parity; the
 *   TUI already writes via Temporal directly anyway, so loopback-no-auth
 *   is equivalent risk).
 * - Non-loopback bind OR cross-origin browser → bearer required.
 *
 * **Body validation** is strict — every field shape is checked before
 * the handler reaches the Temporal layer. Bad bodies fast-fail with
 * 400; the underlying Temporal calls aren't asked to validate things
 * the HTTP layer can catch.
 *
 * **Error mapping**: `Error('No session found …')` → 404 not-found;
 * any other thrown `Error` → 500 (logged at the dispatcher).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TempoClient } from '../client/interface';
import type { AgentType } from '../types';
import { isDevMode } from '../config';
import { errorResponse, jsonResponse } from './responses';
import {
  MESSAGE_MAX,
  validateEnsembleName,
  validatePlayerName,
} from '../utils/validation';

/** Hard cap on incoming JSON body size (1 MiB). Generous for chat/cue payloads; smaller than the MCP tool's MESSAGE_MAX. */
export const WRITE_BODY_MAX = 1 * 1024 * 1024;

/** Names of the write actions exposed under `/v1/ensembles/:ensemble/<action>`. */
export const WRITE_ACTIONS = ['cue', 'pause', 'play', 'release', 'recruit'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

/** Type guard — narrows an arbitrary string to a known `WriteAction`. */
export function isWriteAction(s: string): s is WriteAction {
  return (WRITE_ACTIONS as readonly string[]).includes(s);
}

/**
 * Top-level dispatch — called from `server.ts` when the URL matches
 * `/v1/ensembles/:ensemble/<action>` with a known `<action>`. The
 * caller has already bearer/CORS-gated the request; this function
 * trusts the gates and focuses on body parsing + per-action routing.
 */
export async function handleWriteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  action: WriteAction,
): Promise<void> {
  if (validateEnsembleName(ensemble) !== null) {
    return errorResponse(res, 400, { error: 'invalid-ensemble-name', ensemble });
  }

  // `pause` / `play` / `release` / `recruit` accept an empty body or a
  // small JSON object; `cue` requires the `{ to, message }` body.
  // Parse universally so unknown fields surface as clean 400s.
  const body = await readJsonBody(req);
  if (body === BODY_TOO_LARGE) {
    return errorResponse(res, 413, { error: 'body-too-large', limit: WRITE_BODY_MAX });
  }
  if (body === BODY_INVALID_JSON) {
    return errorResponse(res, 400, { error: 'invalid-json' });
  }

  try {
    switch (action) {
      case 'cue':     return await handleCue(res, client, ensemble, body);
      case 'pause':   return await handlePause(res, client, ensemble);
      case 'play':    return await handlePlay(res, client, ensemble, body);
      case 'release': return await handleRelease(res, client, ensemble, body);
      case 'recruit': return await handleRecruit(res, client, ensemble, body);
    }
  } catch (err) {
    return mapWriteError(res, action, ensemble, err);
  }
}

// ── Per-action handlers ──────────────────────────────────────────────────

async function handleCue(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  body: Record<string, unknown>,
): Promise<void> {
  const to = stringField(body, 'to');
  const message = stringField(body, 'message');
  if (!to) return errorResponse(res, 400, { error: 'missing-field', field: 'to' });
  if (!message) return errorResponse(res, 400, { error: 'missing-field', field: 'message' });
  if (validatePlayerName(to) !== null) {
    return errorResponse(res, 400, { error: 'invalid-player-name', field: 'to' });
  }
  if (message.length > MESSAGE_MAX) {
    return errorResponse(res, 413, { error: 'message-too-long', limit: MESSAGE_MAX });
  }
  // `sendAsMaestro` writes through the maestro session's outbox so the
  // chat row shows `role: 'maestro-out'` — matches the dashboard's
  // "you, the operator" semantic. `sendMessage` is conductor-sourced
  // and would mis-label the row.
  await client.ensureMaestroSession(ensemble);
  await client.sendAsMaestro(ensemble, to, message);
  jsonResponse(res, 202, { ok: true, ensemble, to });
}

async function handlePause(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
): Promise<void> {
  await client.pause(ensemble);
  jsonResponse(res, 202, { ok: true, ensemble });
}

async function handlePlay(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  body: Record<string, unknown>,
): Promise<void> {
  // `release` is opt-in; only forward when explicitly true so the client
  // method's optional-prop signature stays meaningful.
  const release = body.release === true;
  const opts = release ? { release: true } : undefined;
  await client.play(ensemble, opts);
  jsonResponse(res, 202, { ok: true, ensemble, released: release });
}

async function handleRelease(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  body: Record<string, unknown>,
): Promise<void> {
  const playerId = stringField(body, 'playerId');
  if (playerId !== undefined && validatePlayerName(playerId) !== null) {
    return errorResponse(res, 400, { error: 'invalid-player-name', field: 'playerId' });
  }
  const result = await client.release(ensemble, playerId);
  jsonResponse(res, 200, result);
}

async function handleRecruit(
  res: ServerResponse,
  client: TempoClient,
  ensemble: string,
  body: Record<string, unknown>,
): Promise<void> {
  const name = stringField(body, 'name');
  const workDir = stringField(body, 'workDir');
  if (!name) return errorResponse(res, 400, { error: 'missing-field', field: 'name' });
  if (!workDir) return errorResponse(res, 400, { error: 'missing-field', field: 'workDir' });
  if (validatePlayerName(name) !== null) {
    return errorResponse(res, 400, { error: 'invalid-player-name', field: 'name' });
  }

  const agent = stringField(body, 'agent');
  // Dev-mode parity with the MCP `recruit` tool: `'mock'` is only valid when
  // `CLAUDE_TEMPO_DEV_MODE=1`. The mock adapter's registry registration is
  // also dev-gated (ADR 0014 §7 gate 2); rejecting here gives a clearer 400
  // than the registry's downstream "Unknown adapter" error.
  const allowed = allowedAgentsForCurrentMode();
  if (agent !== undefined && !isAllowedAgent(agent, allowed)) {
    return errorResponse(res, 400, { error: 'invalid-agent', allowed });
  }

  // Pluck each optional field once so the spread below doesn't run
  // `stringField` twice per key.
  const playerType = stringField(body, 'playerType');
  const host = stringField(body, 'host');
  const initialMessage = stringField(body, 'initialMessage');
  const systemPrompt = stringField(body, 'systemPrompt');

  const result = await client.recruit(ensemble, {
    name,
    workDir,
    ...(agent !== undefined && isAllowedAgent(agent, allowed) ? { agent } : {}),
    ...(playerType !== undefined ? { playerType } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(initialMessage !== undefined ? { initialMessage } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(body.isConductor === true ? { isConductor: true } : {}),
    ...(body.held === true ? { held: true } : {}),
  });
  jsonResponse(res, 202, result);
}

/**
 * Agent allowlists. `'mock'` is dev-mode-only — see ADR 0014 §7. Read at
 * request time so toggling `CLAUDE_TEMPO_DEV_MODE` between requests is
 * picked up without restart (parity with `src/tools/recruit.ts`).
 */
const ALLOWED_AGENTS_PROD: readonly AgentType[] = ['claude', 'copilot'];
const ALLOWED_AGENTS_DEV: readonly AgentType[] = ['claude', 'copilot', 'mock'];

function allowedAgentsForCurrentMode(): readonly AgentType[] {
  return isDevMode() ? ALLOWED_AGENTS_DEV : ALLOWED_AGENTS_PROD;
}

function isAllowedAgent(s: string, allowed: readonly AgentType[]): s is AgentType {
  return (allowed as readonly string[]).includes(s);
}

// ── Helpers ──────────────────────────────────────────────────────────────

const BODY_TOO_LARGE = Symbol('body-too-large');
const BODY_INVALID_JSON = Symbol('body-invalid-json');

/**
 * Read the request body up to {@link WRITE_BODY_MAX} bytes and parse as
 * JSON. Returns the parsed object, an empty object for empty bodies,
 * or one of the sentinel symbols for cap / parse failures.
 */
async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | typeof BODY_TOO_LARGE | typeof BODY_INVALID_JSON> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    // Cap-check: bail before allocating any more buffer. Node's HTTP
    // server tears down the upload when the handler ends without
    // consuming the body, so explicit `req.destroy()` here is
    // unnecessary AND racy — destroying the socket before the 413
    // response is written drops the response on the floor.
    if (total > WRITE_BODY_MAX) return BODY_TOO_LARGE;
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return BODY_INVALID_JSON;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return BODY_INVALID_JSON;
  }
}

/** Pluck a string field from a parsed JSON body; returns `undefined` for absent or non-string. */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Map a thrown error from a TempoClient call to an HTTP response.
 * Recognises the "no session" / "no maestro" / "no ensemble" error
 * messages the existing client throws and surfaces them as 404 so
 * dashboard error UIs can show a meaningful message instead of a 500.
 */
function mapWriteError(
  res: ServerResponse,
  action: WriteAction,
  ensemble: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (/no session found|no maestro|workflow not found/i.test(message)) {
    return errorResponse(res, 404, { error: 'session-not-found', action, ensemble, detail: message });
  }
  if (/Unknown agent type/i.test(message)) {
    return errorResponse(res, 400, { error: 'unknown-agent-type', action, ensemble, detail: message });
  }
  return errorResponse(res, 500, { error: 'write-failed', action, ensemble, detail: message });
}
