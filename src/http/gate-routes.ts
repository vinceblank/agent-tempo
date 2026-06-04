/**
 * HTTP route handlers for the 3d operator gate (MD-G). server.ts dispatches to
 * these; logic lives here so it stays testable.
 *
 * FOUR routes, TWO auth planes (mirrors the 3c inner-loop split):
 *
 *   OPERATOR plane (operator/dashboard → daemon). Mounted AFTER the outer bearer
 *   gate with an explicit `requireTier(3)` (the highest RBAC tier, MD-E) — only
 *   an admin-token holder may arm/disarm or decide:
 *     - POST /v1/players/:e/:p/gate-arm           → arm the gate
 *     - POST /v1/players/:e/:p/gate-disarm        → disarm the gate
 *     - POST /v1/players/:e/:p/gate/:requestId    → decide { decision:'allow'|'deny' }
 *
 *   SOURCE plane (Pi subprocess → daemon; publisher-only). Same INGRESS gate as
 *   the inner-loop ingest — loopback `remoteAddress` + `X-Ingest-Token` validated
 *   against the URL-derived workflowId (cross-player-spoof guard), uniform 403:
 *     - GET /v1/players/:e/:p/gate/:requestId/resolution → poll { status, … }
 *
 * The Pi subprocess's awaited `tool_call` handler polls the resolution route
 * until it gets a non-`pending` answer (operator decision OR the registry's lazy
 * 45s auto-allow) or its own bounded/ctx.signal-cancelled deadline.
 *
 * Daemon-side ONLY (loopback boundary, off Temporal). Not imported by workflows.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { sessionWorkflowId } from '../config';
import { errorResponse, jsonResponse } from './responses';
import { readJsonBody, BODY_TOO_LARGE, BODY_INVALID_JSON } from './body';
import { isLoopbackRemote, INGEST_TOKEN_HEADER } from './inner-loop-routes';
import type { GateRegistry } from './gate-registry';
import type { IngestTokenRegistry } from './ingest-registry';

/** Decision body cap — the payload is a tiny `{decision}`; this is the DOS backstop. */
const GATE_BODY_MAX = 4 * 1024;

export interface GateDeps {
  gate: GateRegistry;
  ingestTokens: IngestTokenRegistry;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * SOURCE-plane INGRESS gate (loopback + ingest-token vs URL workflowId), shared
 * with the inner-loop ingest contract. Returns the workflowId on success, or
 * `null` after writing a uniform 403 (no info leak — callers just `return`).
 */
function gateIngress(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GateDeps,
  ensemble: string,
  playerId: string,
): string | null {
  const deny = (): null => { errorResponse(res, 403, { error: 'forbidden' }); return null; };
  if (!isLoopbackRemote(req)) return deny();
  const token = headerValue(req.headers[INGEST_TOKEN_HEADER]);
  if (!token) return deny();
  const workflowId = sessionWorkflowId(ensemble, playerId);
  if (!deps.ingestTokens.validate(workflowId, token)) return deny();
  return workflowId;
}

/**
 * Best-effort short audit hint from the operator's bearer (last 6 chars) — never
 * the full token. Absent on a loopback-trust request with no Authorization.
 */
function operatorTokenHint(req: IncomingMessage): string | undefined {
  const auth = headerValue(req.headers.authorization);
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const tok = m?.[1];
  return tok && tok.length >= 6 ? `…${tok.slice(-6)}` : undefined;
}

// ── OPERATOR plane (server.ts applies requireTier(3) before dispatch) ──────────

/** POST /gate-arm — arm the operator gate for a player. 204. */
export function handleGateArm(
  req: IncomingMessage, res: ServerResponse, deps: GateDeps, ensemble: string, playerId: string,
): void {
  const workflowId = sessionWorkflowId(ensemble, playerId);
  deps.gate.arm(workflowId, operatorTokenHint(req));
  res.writeHead(204); res.end();
}

/** POST /gate-disarm — disarm the operator gate for a player. 204. */
export function handleGateDisarm(
  req: IncomingMessage, res: ServerResponse, deps: GateDeps, ensemble: string, playerId: string,
): void {
  const workflowId = sessionWorkflowId(ensemble, playerId);
  deps.gate.disarm(workflowId, operatorTokenHint(req));
  res.writeHead(204); res.end();
}

/**
 * POST /gate/:requestId — operator decision on a pending gated tool call.
 * Body `{ decision: 'allow' | 'deny' }`. 204 on success; 404 unknown requestId;
 * 409 already-decided (idempotency — a double-POST or post-timeout race can't
 * flip a recorded answer); 400 malformed body / bad decision value.
 */
export async function handleGateDecide(
  req: IncomingMessage, res: ServerResponse, deps: GateDeps,
  ensemble: string, playerId: string, requestId: string,
): Promise<void> {
  const workflowId = sessionWorkflowId(ensemble, playerId);
  const body = await readJsonBody(req, GATE_BODY_MAX);
  if (body === BODY_TOO_LARGE || body === BODY_INVALID_JSON) {
    return errorResponse(res, 400, { error: 'bad-request' });
  }
  const decision = (body as { decision?: unknown }).decision;
  if (decision !== 'allow' && decision !== 'deny') {
    return errorResponse(res, 400, { error: 'bad-request', detail: "decision must be 'allow' or 'deny'" });
  }
  const result = deps.gate.decide(workflowId, requestId, decision, operatorTokenHint(req));
  if (result.ok) { res.writeHead(204); res.end(); return; }
  if (result.reason === 'not-found') return errorResponse(res, 404, { error: 'not-found' });
  return errorResponse(res, 409, { error: 'already-decided' });
}

// ── SOURCE plane (ingest-token; Pi subprocess polls) ───────────────────────────

/**
 * GET /gate/:requestId/resolution — the Pi subprocess polls for the decision.
 * 200 `{ status:'pending' }` | `{ status:'resolved', decision, source }`; 404 for
 * an unknown requestId; uniform 403 on any INGRESS gate failure (no leak).
 */
export function handleGateResolution(
  req: IncomingMessage, res: ServerResponse, deps: GateDeps,
  ensemble: string, playerId: string, requestId: string,
): void {
  const workflowId = gateIngress(req, res, deps, ensemble, playerId);
  if (workflowId === null) return;
  const resolution = deps.gate.getResolution(workflowId, requestId);
  if (resolution === null) return errorResponse(res, 404, { error: 'not-found' });
  return jsonResponse(res, 200, resolution);
}
