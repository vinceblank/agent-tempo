/**
 * Daemon HTTP catalog routes — issue #400.
 *
 * Three endpoints exposing on-disk catalog data so the dashboard's
 * Recruit + CreateEnsemble + Loadouts + PlayerTypes wizards can drop
 * the hardcoded fallbacks shipped during PR-E + PR-F:
 *
 *   - GET  /v1/agent-types  → `listAgentTypes()` from ensemble/agent-types.ts
 *   - GET  /v1/lineups      → `listLineups()` from ensemble/loader.ts
 *   - POST /v1/ensembles    → recruit a conductor (+ lineup players)
 *
 * Auth + CORS gating happens in `server.ts` before the dispatcher
 * reaches these handlers; no per-handler bearer check needed.
 *
 * Response shapes match the issue #400 wire spec; see also
 * `docs/WIRE-PROTOCOL.md` for the full HTTP catalog.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { TempoClient } from '../client/interface';
import type { AgentType } from '../types';
import { errorResponse, jsonResponse } from './responses';
import { listAgentTypes } from '../ensemble/agent-types';
import { resolveLineupPath, loadLineup } from '../ensemble/loader';
import { listAllLineups } from '../ensemble/saver';
import { validateEnsembleName, validatePlayerName } from '../utils/validation';
import {
  readJsonBody,
  BODY_TOO_LARGE,
  BODY_INVALID_JSON,
  WRITE_BODY_MAX,
  stringField,
  allowedAgentsForCurrentMode,
  isAllowedAgent,
} from './body';

// ── GET /v1/agent-types ─────────────────────────────────────────────────────

export interface AgentTypeRow {
  name: string;
  description?: string;
  source: 'project' | 'user' | 'shipped';
}

/**
 * `listAgentTypes()` returns rows with `path` + `nativeResolvable` +
 * optional `allowedTools` — the dashboard only needs name/description/
 * source. Strip the rest so we don't leak filesystem paths over the
 * wire (loopback bind is the common case but the API is also reachable
 * over LAN behind bearer auth — same privacy contract as `HostProfile`
 * stripping in `src/types.ts`).
 */
export function handleListAgentTypes(res: ServerResponse): void {
  const types = listAgentTypes();
  const rows: AgentTypeRow[] = types.map((t) => ({
    name: t.name,
    ...(t.description !== undefined && { description: t.description }),
    source: t.source,
  }));
  jsonResponse(res, 200, { agentTypes: rows });
}

// ── GET /v1/lineups ─────────────────────────────────────────────────────────

export interface LineupRow {
  name: string;
  description?: string;
  players: number;
  source: 'saved' | 'shipped';
}

export function handleListLineups(res: ServerResponse): void {
  // `listAllLineups()` returns a richer shape (`path` + parsed
  // `description` / `players`); strip `path` before serving over the
  // wire — privacy contract parity with the agent-types handler above.
  const rows: LineupRow[] = listAllLineups().map((l) => ({
    name: l.name,
    ...(l.description !== undefined && { description: l.description }),
    players: l.players,
    source: l.source,
  }));
  jsonResponse(res, 200, { lineups: rows });
}

// ── POST /v1/ensembles ──────────────────────────────────────────────────────

const ALLOWED_START_MODES = ['hold', 'release'] as const;
type StartMode = (typeof ALLOWED_START_MODES)[number];

interface CreateEnsembleBody {
  name: string;
  lineup?: string;
  host?: string;
  startMode?: StartMode;
  conductorInstructions?: string;
}

/**
 * POST `/v1/ensembles` — create a fresh ensemble.
 *
 * The bootstrap path is the daemon-side equivalent of the CLI's
 * `agent-tempo up` codepath, but trimmed to the actions the daemon
 * can run for a browser caller:
 *
 *   1. Validate the body (name regex, lineup exists if specified,
 *      startMode in {hold, release}).
 *   2. Reject 409 if an ensemble with that name is already live.
 *   3. Recruit the conductor (`isConductor: true`) — this bootstraps
 *      the maestro + scheduler + conductor-session workflows.
 *   4. Recruit each lineup player. Inherits `host` + `held` from the
 *      top-level body when the lineup row doesn't specify its own.
 *   5. Return 201 + the ensemble summary so the dashboard can
 *      navigate to `/ensemble/:name` without a follow-up snapshot
 *      fetch.
 *
 * Skipped vs CLI `up` (intentional):
 *   - No Temporal-server start: the daemon serving this request
 *     already proves Temporal is up.
 *   - No daemon start / agent-type install / MCP register: a browser
 *     caller doesn't go through that pre-flight.
 *   - No interactive "ensemble already exists" choice tree: HTTP is
 *     stateless; we 409 and let the dashboard surface a useful error.
 */
export async function handleCreateEnsemble(
  req: IncomingMessage,
  res: ServerResponse,
  client: TempoClient,
): Promise<void> {
  const body = await readJsonBody(req);
  if (body === BODY_TOO_LARGE) {
    return errorResponse(res, 413, { error: 'body-too-large', limit: WRITE_BODY_MAX });
  }
  if (body === BODY_INVALID_JSON) {
    return errorResponse(res, 400, { error: 'invalid-json' });
  }

  const parsed = parseBody(body);
  if ('error' in parsed) return errorResponse(res, 400, parsed.error);
  const { name, lineup, host, startMode, conductorInstructions } = parsed.body;

  // 409 — ensemble already exists. `listEnsembles()` returns live
  // ensembles by Temporal workflow; matches what the dashboard's
  // `/v1/ensembles` GET sees. Note: TOCTOU between this read and the
  // recruit below — two concurrent POSTs with the same name could both
  // pass and both recruit. Acceptable for the browser-driven flow
  // (user-paced); the proper guard is recruit-side idempotency, not
  // here.
  const existing = await client.listEnsembles();
  if (existing.some((e) => e.name === name)) {
    return errorResponse(res, 409, { error: 'ensemble-exists', ensemble: name });
  }

  // Resolve lineup if specified. We `loadLineup` here (not at recruit
  // time) so the caller gets a clean 400 for malformed lineups instead
  // of a half-bootstrapped ensemble with the conductor already alive.
  let resolved: ReturnType<typeof loadLineup> | null = null;
  if (lineup) {
    try {
      const path = resolveLineupPath(lineup).path;
      resolved = loadLineup(path);
    } catch (err) {
      return errorResponse(res, 400, {
        error: 'invalid-lineup',
        lineup,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const held = startMode === 'hold';
  const allowed = allowedAgentsForCurrentMode();

  // 0. Bootstrap the maestro session + hub workflow for this ensemble.
  // `client.recruit()` submits an outbox entry on the maestro workflow —
  // it must exist before we can signal it. The CLI's `agent-tempo up` path
  // pre-creates the conductor workflow which bootstraps the maestro, but
  // the dashboard create-ensemble flow goes directly through the client.
  try {
    await client.ensureMaestroSession(name);
  } catch (err) {
    return errorResponse(res, 500, {
      error: 'maestro-bootstrap-failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 1. Recruit the conductor — lineup's `conductor` block (if present)
  // wins on name + agent + part; the top-level `host` is the conductor's
  // spawn target either way.
  const conductorBlock = resolved?.conductor;
  const conductorName = conductorBlock?.name ?? 'conductor';
  const conductorAgent = pickAgent(conductorBlock?.agent, allowed);
  try {
    await client.recruit(name, {
      name: conductorName,
      workDir: process.cwd(),
      isConductor: true,
      ...(conductorAgent !== undefined && { agent: conductorAgent }),
      ...(host !== undefined && { host }),
      ...(held && { held: true }),
      ...(conductorInstructions !== undefined && { initialMessage: conductorInstructions }),
    });
  } catch (err) {
    return errorResponse(res, 500, {
      error: 'conductor-recruit-failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Recruit each lineup player. Errors here are non-fatal — the
  // ensemble is already alive (conductor is running); we collect
  // failures and return them in the 201 body so the dashboard can
  // surface a partial-success toast without rolling back the
  // conductor. Parallel fan-out keeps a 5+ player ensemble from
  // stacking N sequential Temporal round-trips on the client.
  const lineupPlayers = resolved?.players ?? [];
  const playerErrors: Array<{ player: string; error: string }> = [];
  const settled = await Promise.allSettled(
    lineupPlayers.map((player) => {
      const playerAgent = pickAgent(player.agent, allowed);
      return client.recruit(name, {
        name: player.name,
        workDir: player.workDir ?? process.cwd(),
        ...(playerAgent !== undefined && { agent: playerAgent }),
        ...(player.type !== undefined && { playerType: player.type }),
        ...(host !== undefined && { host }),
        ...(held && { held: true }),
        ...(player.instructions !== undefined && { systemPrompt: player.instructions }),
      });
    }),
  );
  settled.forEach((result, i) => {
    if (result.status === 'rejected') {
      playerErrors.push({
        player: lineupPlayers[i].name,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  jsonResponse(res, 201, {
    ensemble: name,
    conductorPlayerId: conductorName,
    lineup: lineup ?? null,
    recruitedPlayers: lineupPlayers.length - playerErrors.length,
    ...(playerErrors.length > 0 && { playerErrors }),
  });
}

interface ParseError {
  error: { error: string; field?: string; allowed?: readonly string[]; message?: string };
}
interface ParseOk {
  body: CreateEnsembleBody;
}

function parseBody(body: Record<string, unknown>): ParseError | ParseOk {
  // `requireNonEmpty` filters whitespace-zero strings — empty lineup /
  // host / instructions shouldn't propagate as if the user typed
  // something.
  const name = stringField(body, 'name', { requireNonEmpty: true });
  if (!name) return { error: { error: 'missing-field', field: 'name' } };
  if (validateEnsembleName(name) !== null) {
    return { error: { error: 'invalid-ensemble-name', field: 'name' } };
  }

  const lineup = stringField(body, 'lineup', { requireNonEmpty: true });
  const host = stringField(body, 'host', { requireNonEmpty: true });
  const startMode = stringField(body, 'startMode', { requireNonEmpty: true });
  if (startMode !== undefined && !isStartMode(startMode)) {
    return { error: { error: 'invalid-start-mode', allowed: ALLOWED_START_MODES } };
  }
  const conductorInstructions = stringField(body, 'conductorInstructions', { requireNonEmpty: true });

  // Lightweight host-name shape check (matches the daemon's existing
  // hostname rules used by recruit). Skips when omitted.
  if (host !== undefined && validatePlayerName(host) !== null) {
    return { error: { error: 'invalid-host', field: 'host' } };
  }

  return {
    body: {
      name,
      ...(lineup !== undefined && { lineup }),
      ...(host !== undefined && { host }),
      ...(startMode !== undefined && { startMode: startMode as StartMode }),
      ...(conductorInstructions !== undefined && { conductorInstructions }),
    },
  };
}

function isStartMode(s: string): s is StartMode {
  return (ALLOWED_START_MODES as readonly string[]).includes(s);
}

function pickAgent(
  candidate: string | undefined,
  allowed: readonly AgentType[],
): AgentType | undefined {
  if (candidate === undefined) return undefined;
  return isAllowedAgent(candidate, allowed) ? candidate : undefined;
}
