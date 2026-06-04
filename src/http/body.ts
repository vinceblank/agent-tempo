/**
 * Shared HTTP body-reading helpers.
 *
 * Extracted from `writes.ts` so catalog/write/dashboard handlers all
 * use the same JSON parser + size cap. The cap is enforced before
 * parsing so a 1 GiB upload can't OOM the daemon.
 *
 * Sentinels (rather than thrown errors) keep the parse path branch-free
 * — handlers compare against `BODY_TOO_LARGE` / `BODY_INVALID_JSON` and
 * map to the appropriate 4xx response.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { AGENT_TYPES, type AgentType } from '../types';
import { isDevMode } from '../config';
import { errorResponse } from './responses';
import { validatePlayerName } from '../utils/validation';

/** Hard cap on incoming JSON body size (1 MiB). */
export const WRITE_BODY_MAX = 1024 * 1024;

/** 3c Tier-2 ingest cap (32 KiB) — the DOS backstop for `/inner/ingest`; the
 *  source already ~2KB-truncates summaries, so real frames are far smaller. */
export const INGEST_BODY_MAX = 32 * 1024;

export const BODY_TOO_LARGE = Symbol('body-too-large');
export const BODY_INVALID_JSON = Symbol('body-invalid-json');

export type ReadJsonBodyResult =
  | Record<string, unknown>
  | typeof BODY_TOO_LARGE
  | typeof BODY_INVALID_JSON;

/**
 * Read the request body up to {@link WRITE_BODY_MAX} bytes and parse
 * as JSON. Returns the parsed object, an empty object for empty
 * bodies, or one of the sentinel symbols for cap / parse failures.
 *
 * Note on the cap path: returning early from this function ends body
 * consumption; Node's HTTP server tears down the upload when the
 * handler ends. Explicit `req.destroy()` would race the response
 * write — left alone.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = WRITE_BODY_MAX,
): Promise<ReadJsonBodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) return BODY_TOO_LARGE;
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

/**
 * Pluck a string field from a parsed JSON body. Returns `undefined`
 * for absent or non-string values; with `requireNonEmpty: true`, also
 * filters empty strings (used by routes that accept optional fields
 * — empty strings shouldn't propagate to downstream Temporal calls
 * as if the user typed something).
 */
export function stringField(
  body: Record<string, unknown>,
  key: string,
  opts: { requireNonEmpty?: boolean } = {},
): string | undefined {
  const v = body[key];
  if (typeof v !== 'string') return undefined;
  if (opts.requireNonEmpty && v.length === 0) return undefined;
  return v;
}

/**
 * Dev-mode-only agent identifiers — must never appear in {@link ALLOWED_AGENTS_PROD}.
 *
 * Currently just `'mock'` (ADR 0014 §7). Listed explicitly so the prod
 * allowlist below is "everything in {@link AGENT_TYPES} minus this set",
 * which keeps the dev-only gate auditable and the derived prod list
 * automatically picks up new adapters as they land in `AGENT_TYPES`
 * (#541 — the drift bug this constant prevents).
 */
const DEV_ONLY_AGENTS: ReadonlySet<AgentType> = new Set(['mock']);

/**
 * Agent allowlists, derived from {@link AGENT_TYPES} (the SSOT in
 * `src/types.ts`).
 *
 * `'mock'` is dev-mode-only — see ADR 0014 §7. Read at request time so
 * toggling `AGENT_TEMPO_DEV_MODE` between requests is picked up without
 * restart (parity with `src/tools/recruit.ts`).
 *
 * Deriving from `AGENT_TYPES` rather than hardcoding the list closes the
 * #541 drift bug: every new adapter (`claude-api`, `opencode`,
 * `claude-code-headless`, …) added to the SSOT is automatically accepted
 * by the HTTP recruit endpoint, instead of being silently rejected by an
 * allowlist that someone forgot to update.
 */
export const ALLOWED_AGENTS_DEV: readonly AgentType[] = AGENT_TYPES;
export const ALLOWED_AGENTS_PROD: readonly AgentType[] = AGENT_TYPES.filter(
  (a) => !DEV_ONLY_AGENTS.has(a),
);

export function allowedAgentsForCurrentMode(): readonly AgentType[] {
  return isDevMode() ? ALLOWED_AGENTS_DEV : ALLOWED_AGENTS_PROD;
}

export function isAllowedAgent(s: string, allowed: readonly AgentType[]): s is AgentType {
  return (allowed as readonly string[]).includes(s);
}

/**
 * Pluck a required `playerId` from a parsed body, validating shape.
 *
 * Returns the `playerId` string on success. On any failure (missing or
 * malformed) writes the appropriate 400 response via `errorResponse` and
 * returns `undefined`. **Callers MUST check the return value and bail
 * out** — a missing `if (!playerId) return;` would silently skip the
 * downstream client call and double-send to the response stream.
 *
 * Shared by every per-player route under `/v1/ensembles/:ensemble/<action>`
 * (restart / destroy / detach / recall — `release` keeps an inline check
 * because its `playerId` field is optional, not required).
 */
export function requirePlayerId(
  res: ServerResponse,
  body: Record<string, unknown>,
): string | undefined {
  const playerId = stringField(body, 'playerId');
  if (!playerId) {
    errorResponse(res, 400, { error: 'missing-field', field: 'playerId' });
    return undefined;
  }
  if (validatePlayerName(playerId) !== null) {
    errorResponse(res, 400, { error: 'invalid-player-name', field: 'playerId' });
    return undefined;
  }
  return playerId;
}
