/**
 * Mission-control action client (3f) — DRIVE = HTTP (decision 1). Operator
 * controls POST to the daemon's write surface (T2) + gate endpoints (T3), the
 * SAME surface the dashboard uses — NOT in-Pi MCP tools. The widget holds the
 * ADMIN token (T3) and presents it as a bearer.
 *
 * Injected fetch / readPort / token so it's unit-testable without a daemon.
 */
import { readPortFile } from '../../http/port-file';
import type { AnswerEntry } from '../../types';

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

  /**
   * Whether the client has a usable transport. (#54) NO LONGER gates on the admin
   * token: a loopback daemon grants full trust tokenless, so token presence does
   * NOT determine usability — the daemon decides per request. Token-required is
   * enforced by the daemon (it 401s a remote/0.0.0.0 caller), not pre-empted here.
   */
  get ready(): boolean {
    return this.fetchFn !== null;
  }

  private baseUrl(): string | null {
    if (this.baseUrlOverride) return this.baseUrlOverride.replace(/\/$/, '');
    const port = readPortFile() ?? DEFAULT_PORT;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Request headers — include the admin bearer ONLY when a token is set (#54). A
   * loopback daemon grants full trust tokenless (it short-circuits all tiers), so
   * we attempt tokenless and never send a literal "Bearer undefined". Mirrors how
   * `createSubscribe` already spreads its token only when present.
   */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...(this.adminToken ? { Authorization: `Bearer ${this.adminToken}` } : {}) };
  }

  /**
   * Map a non-2xx daemon response to an error string (#54). When NO token was sent
   * and the daemon rejected on auth (401/403) or admin-unset (503), the cause is a
   * remote / `0.0.0.0` daemon that requires the admin token — surface that
   * actionably (a local loopback daemon needs none). Token-present failures keep
   * the daemon's own body detail (it already returns good 403/503 hints).
   */
  private httpError(status: number, detail: string): string {
    if (!this.adminToken && (status === 401 || status === 403 || status === 503)) {
      return (
        `HTTP ${status}: operator actions need ${ADMIN_TOKEN_ENV} for a remote / 0.0.0.0 daemon ` +
        `(a local loopback daemon needs none)${detail ? ` — ${detail}` : ''}`
      );
    }
    return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }

  private async post(pathSuffix: string, body: unknown): Promise<ActionResult> {
    // #54 — do NOT pre-block on a missing token: attempt the request and let the
    // daemon decide (loopback grants full trust tokenless; remote/0.0.0.0 401s).
    if (!this.fetchFn) return { ok: false, error: 'no fetch transport available' };
    const base = this.baseUrl();
    if (base === null) return { ok: false, error: 'daemon HTTP not reachable (no port)' };
    try {
      const res = await this.fetchFn(`${base}${pathSuffix}`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body ?? {}),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, error: this.httpError(res.status, detail) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** POST and parse a JSON response body. Used when the caller needs the response
   *  payload, not just success — e.g. the coat-check ticket. Bearer iff token set (#54). */
  private async postJson<T>(pathSuffix: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    if (!this.fetchFn) return { ok: false, error: 'no fetch transport available' };
    const base = this.baseUrl();
    if (base === null) return { ok: false, error: 'daemon HTTP not reachable (no port)' };
    try {
      const res = await this.fetchFn(`${base}${pathSuffix}`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text().catch(() => '');
      if (res.status < 200 || res.status >= 300) return { ok: false, error: this.httpError(res.status, text.slice(0, 200)) };
      return { ok: true, data: JSON.parse(text) as T };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GET a JSON body from the daemon. Used by the read surface (#700 readAnswer).
   *  Bearer iff token set (#54). */
  private async getJson<T>(pathSuffix: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    if (!this.fetchFn) return { ok: false, error: 'no fetch transport available' };
    const base = this.baseUrl();
    if (base === null) return { ok: false, error: 'daemon HTTP not reachable (no port)' };
    try {
      const res = await this.fetchFn(`${base}${pathSuffix}`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      const text = await res.text().catch(() => '');
      if (res.status < 200 || res.status >= 300) return { ok: false, error: this.httpError(res.status, text.slice(0, 200)) };
      return { ok: true, data: JSON.parse(text) as T };
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

  // ── Q&A surface (#700 P2) ──
  /**
   * Ask a player a correlated question (`POST /v1/ensembles/:e/ask`). The daemon
   * cues the target with a `[Q questionId]` marker; the answer lands on the
   * maestro mailbox and is read back via {@link readAnswer} (or the SSE wake).
   */
  ask(opts: { target: string; question: string; questionId: string }): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/ask`, opts);
  }

  /**
   * Read a parked answer by `questionId` (`GET .../answer/:questionId`). Returns
   * the {@link AnswerEntry} when present, or `null` (not answered yet / expired /
   * transport error) — the caller polls or waits for the SSE `answer` wake.
   */
  async readAnswer(questionId: string): Promise<AnswerEntry | null> {
    const res = await this.getJson<{ answer: AnswerEntry | null }>(
      `/v1/ensembles/${this.ens()}/answer/${encodeURIComponent(questionId)}`,
    );
    return res.ok ? (res.data.answer ?? null) : null;
  }

  // ── Coat-check surface (#713) ──
  /**
   * Stash a content body on the ensemble coat-check (`POST /v1/ensembles/:e/coat-check`)
   * and return the ticket. Lets the inbox-less planner park a large plan and hand
   * off a ticket instead of inlining it on a cue. NOTE (#713): the coat-check entry
   * cap (32 KiB) is BELOW the 100 KB cue cap, so this keeps cues lean — it does NOT
   * raise the handoff ceiling.
   */
  async coatCheckPut(opts: {
    summary: string;
    content: string;
    contentType?: string;
    ttlMs?: number;
  }): Promise<{ ok: true; ticket: string } | { ok: false; error: string }> {
    const res = await this.postJson<{ ticket: string }>(`/v1/ensembles/${this.ens()}/coat-check`, opts);
    return res.ok ? { ok: true, ticket: res.data.ticket } : res;
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
