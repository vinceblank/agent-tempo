/**
 * Mission-control action client (3f) — DRIVE = HTTP (decision 1). Operator
 * controls POST to the daemon's write surface (T2) + gate endpoints (T3), the
 * SAME surface the dashboard uses — NOT in-Pi MCP tools. The widget holds the
 * ADMIN token (T3) and presents it as a bearer.
 *
 * Injected fetch / readPort / token so it's unit-testable without a daemon.
 */
import { readPortFile } from '../../http/port-file';

/** Env var holding the daemon admin (T3) token (writes + gate + inner tail). */
export const ADMIN_TOKEN_ENV = 'AGENT_TEMPO_HTTP_ADMIN_TOKEN';
const DEFAULT_PORT = 8473;

export type ActionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export type ActionResult = { ok: true; status: number } | { ok: false; error: string };

export interface MissionControlActionsOptions {
  ensemble: string;
  /** Admin (T3) token. Defaults to `process.env[ADMIN_TOKEN_ENV]`. */
  adminToken?: string;
  /** Daemon base URL. Defaults to `http://127.0.0.1:${readPortFile() ?? 8473}`. */
  baseUrl?: string;
  /** HTTP transport. Defaults to global `fetch`. */
  fetchFn?: ActionFetch;
}

function resolveFetch(): ActionFetch | null {
  const g = (globalThis as { fetch?: unknown }).fetch;
  return typeof g === 'function' ? (g as unknown as ActionFetch) : null;
}

/** HTTP client for the daemon operator-action surface. All calls bearer-authed. */
export class MissionControlActions {
  private readonly ensemble: string;
  private readonly adminToken: string | undefined;
  private readonly baseUrlOverride: string | undefined;
  private readonly fetchFn: ActionFetch | null;

  constructor(opts: MissionControlActionsOptions) {
    this.ensemble = opts.ensemble;
    this.adminToken = opts.adminToken ?? process.env[ADMIN_TOKEN_ENV];
    this.baseUrlOverride = opts.baseUrl;
    this.fetchFn = opts.fetchFn ?? resolveFetch();
  }

  /** Whether the client is usable (token + transport present). */
  get ready(): boolean {
    return Boolean(this.adminToken) && this.fetchFn !== null;
  }

  private baseUrl(): string | null {
    if (this.baseUrlOverride) return this.baseUrlOverride.replace(/\/$/, '');
    const port = readPortFile() ?? DEFAULT_PORT;
    return `http://127.0.0.1:${port}`;
  }

  private async post(pathSuffix: string, body: unknown): Promise<ActionResult> {
    if (!this.adminToken) return { ok: false, error: `no admin token (set ${ADMIN_TOKEN_ENV})` };
    if (!this.fetchFn) return { ok: false, error: 'no fetch transport available' };
    const base = this.baseUrl();
    if (base === null) return { ok: false, error: 'daemon HTTP not reachable (no port)' };
    try {
      const res = await this.fetchFn(`${base}${pathSuffix}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private ens(): string {
    return encodeURIComponent(this.ensemble);
  }
  private player(p: string): string {
    return `${this.ens()}/${encodeURIComponent(p)}`;
  }

  // ── Ensemble write surface (T2) ──
  cue(to: string, message: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/cue`, { to, message });
  }
  pause(): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/pause`, {});
  }
  play(release?: boolean): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/play`, release ? { release } : {});
  }
  restart(playerId: string, reason?: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/restart`, { playerId, ...(reason ? { reason } : {}) });
  }
  destroy(playerId: string, reason?: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/destroy`, { playerId, ...(reason ? { reason } : {}) });
  }
  reset(playerId: string, reason?: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/reset`, { playerId, ...(reason ? { reason } : {}) });
  }

  // ── Bootstrap surface (#700 P1) ──
  /**
   * Create a fresh ensemble via `POST /v1/ensembles` (the catalog route, NOT
   * ensemble-scoped). Defaults `name` to this client's bound ensemble — the one
   * the command-center board observes. `conductorAgent` lets `/ensemble-up`
   * default the conductor to a headless Pi (design §3).
   */
  createEnsemble(opts: {
    name?: string;
    lineup?: string;
    host?: string;
    startMode?: 'hold' | 'release';
    conductorInstructions?: string;
    conductorAgent?: string;
  } = {}): Promise<ActionResult> {
    const { name, ...rest } = opts;
    return this.post('/v1/ensembles', { name: name ?? this.ensemble, ...rest });
  }

  /** Recruit a player into the bound ensemble (`POST /v1/ensembles/:e/recruit`). */
  recruit(opts: {
    name: string;
    workDir: string;
    playerType?: string;
    host?: string;
    agent?: string;
  }): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/recruit`, opts);
  }

  /**
   * Tear down the bound ensemble (`POST /v1/ensembles/:e/shutdown`). Graceful by
   * default (detach + pause, survives in `detached`); `destroy: true` escalates
   * to ensemble-scope destroy (terminate).
   */
  shutdownEnsemble(destroy?: boolean): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/shutdown`, destroy ? { destroy: true } : {});
  }

  // ── Operator gate plane (T3) ──
  gateArm(playerId: string): Promise<ActionResult> {
    return this.post(`/v1/players/${this.player(playerId)}/gate-arm`, {});
  }
  gateDisarm(playerId: string): Promise<ActionResult> {
    return this.post(`/v1/players/${this.player(playerId)}/gate-disarm`, {});
  }
  gateDecide(playerId: string, requestId: string, decision: 'allow' | 'deny'): Promise<ActionResult> {
    return this.post(`/v1/players/${this.player(playerId)}/gate/${encodeURIComponent(requestId)}`, { decision });
  }
}
