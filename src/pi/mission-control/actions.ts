/**
 * Mission-control action client (3f) — DRIVE = HTTP (decision 1). Operator
 * controls POST to the daemon's write surface (T2), the SAME surface the
 * dashboard uses — NOT in-Pi MCP tools. The widget holds the ADMIN token (T3)
 * and presents it as a bearer.
 *
 * Injected fetch / readPort / token so it's unit-testable without a daemon.
 */
import { readPortFile } from '../../http/port-file';
import type { AnswerEntry, HostInfo, AttachmentInfo, ScheduleEntry, Message, SentMessage } from '../../types';
import type { EnsembleSummary } from '../../client/interface';

/** Env var holding the daemon admin (T3) token (writes + inner tail). */
export const ADMIN_TOKEN_ENV = 'AGENT_TEMPO_HTTP_ADMIN_TOKEN';
const DEFAULT_PORT = 8473;

export type ActionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * #822 — optional deliverability hint folded into a successful result by the
 * maestro-outbox write endpoints (cue / ask / reset / handoff-via-cue). `delivery
 * === 'queued'` means the target has no live adapter (phase `detached`/`gone`) so
 * the message durably queued but isn't delivered now — the board renders `⚠`
 * instead of `✓`. Absent on endpoints that don't enqueue to a player.
 */
export interface DeliverabilityHint {
  delivery?: 'queued' | 'live';
  phase?: string;
  warning?: string;
}

export type ActionResult =
  | ({ ok: true; status: number } & DeliverabilityHint)
  | { ok: false; error: string };

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
  /** Mutable since #790 — `/ensemble <name>` re-binds the client in place. */
  private ensemble: string;
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
    // #834 — the daemon returns a structured `player-not-found` 404 (a cue/ask to
    // a destroyed / never-existed player). Surface a clean operator string rather
    // than leaking the raw JSON blob the user saw. The `⚠ cue <name> — ` prefix
    // is the extension footer formatter's job; actions.ts just stops leaking JSON.
    let parsedError: string | undefined;
    let parsedDetail: string | undefined;
    try {
      const j = JSON.parse(detail) as { error?: unknown; detail?: unknown };
      if (typeof j.error === 'string') parsedError = j.error;
      if (typeof j.detail === 'string') parsedDetail = j.detail;
    } catch {
      /* not JSON (or truncated past the 200-char slice) — fall back to raw match */
    }
    if (parsedError === 'player-not-found' || /"player-not-found"/.test(detail)) {
      // Handles both the unescaped parsed detail (`Player "bob" ...`) and the raw
      // JSON body where the quotes are escaped (`Player \"bob\" ...`).
      const who = /Player \\?"([^"\\]+)\\?"/.exec(parsedDetail ?? detail)?.[1];
      return who ? `no such player "${who}"` : 'no such player';
    }
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

  /**
   * #822 — POST and, on 2xx, fold the maestro-outbox endpoint's deliverability
   * hint (`{ delivery, phase, warning }` / legacy `queued`) into the result so
   * the board can render `⚠ queued` vs `✓`. Identical to {@link post} on the
   * error path. Tolerant: an empty / non-JSON / hint-less 2xx body yields a plain
   * `{ ok, status }` (older daemons, or endpoints that didn't run the preflight).
   */
  private async postWithDeliverability(pathSuffix: string, body: unknown): Promise<ActionResult> {
    if (!this.fetchFn) return { ok: false, error: 'no fetch transport available' };
    const base = this.baseUrl();
    if (base === null) return { ok: false, error: 'daemon HTTP not reachable (no port)' };
    try {
      const res = await this.fetchFn(`${base}${pathSuffix}`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body ?? {}),
      });
      if (res.status >= 200 && res.status < 300) {
        const text = await res.text().catch(() => '');
        return { ok: true, status: res.status, ...parseDeliveryHint(text) };
      }
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

  /**
   * #790 — re-point every ensemble-scoped route at a new ensemble (the
   * `/ensemble <name>` re-bind). The token/baseUrl/transport stay — only the
   * URL segment changes.
   */
  setEnsemble(ensemble: string): void {
    this.ensemble = ensemble;
  }

  // ── Multi-ensemble home (#790) ──
  /**
   * List all known ensembles (`GET /v1/ensembles`, Tier-1 read). Visibility-
   * backed (#673: eventually consistent — a just-created ensemble may lag by
   * seconds), so callers offering a bind-validation should leave an escape
   * hatch for the lag window.
   */
  async listEnsembles(): Promise<{ ok: true; ensembles: EnsembleSummary[] } | { ok: false; error: string }> {
    const res = await this.getJson<EnsembleSummary[]>('/v1/ensembles');
    return res.ok ? { ok: true, ensembles: res.data } : res;
  }

  // ── Read surface: hosts (#742 gap 5) ──
  /**
   * List connected hosts (`GET /v1/hosts`, Tier-1 read) — the cluster host
   * registry + freshness + capability profile, the same payload the dashboard
   * `/hosts` view and the CLI `agent-tempo hosts` consume. NOT ensemble-scoped
   * (the host registry is cluster-global), so it ignores the bound ensemble.
   */
  async listHosts(): Promise<{ ok: true; hosts: HostInfo[] } | { ok: false; error: string }> {
    const res = await this.getJson<HostInfo[]>('/v1/hosts');
    return res.ok ? { ok: true, hosts: res.data } : res;
  }

  // ── Read surface: attachment-info (#742 gap — /attachment-info) ──
  /**
   * A player's V2 attachment-lifecycle snapshot (`GET /v1/ensembles/:e/attachment-info`,
   * Tier-1 read). Thin shim over `client.attachmentInfo` — the same payload the
   * MCP `attachment_info` tool and CLI `attachment-info` render via the shared
   * `formatAttachmentInfoForDisplay`. The player is a `?playerId=` query param.
   */
  async attachmentInfo(
    playerId: string,
  ): Promise<{ ok: true; info: AttachmentInfo } | { ok: false; error: string }> {
    const res = await this.getJson<AttachmentInfo>(
      `/v1/ensembles/${this.ens()}/attachment-info?playerId=${encodeURIComponent(playerId)}`,
    );
    return res.ok ? { ok: true, info: res.data } : res;
  }

  // ── Read surface: recall (#742 gap — /recall) ──
  /**
   * A player's full message timeline (received + sent). Hits the existing
   * `POST /v1/ensembles/:e/recall` route with `{ full: true }` so the daemon
   * returns the raw `{ received, sent }` arrays (the default count-only shape
   * stays for the dashboard). Thin shim over `client.recall`; the caller feeds
   * the result through the shared `buildTimeline`/`formatRecall` helpers. POST
   * (not GET) because recall groups with the per-player action surface (T2).
   */
  async recall(
    playerId: string,
  ): Promise<{ ok: true; received: Message[]; sent: SentMessage[] } | { ok: false; error: string }> {
    const res = await this.postJson<{ received: Message[]; sent: SentMessage[] }>(
      `/v1/ensembles/${this.ens()}/recall`,
      { playerId, full: true },
    );
    return res.ok ? { ok: true, received: res.data.received, sent: res.data.sent } : res;
  }

  // ── Read surface: schedules (#742 gap — /schedule list) ──
  /**
   * Active schedules for the bound ensemble (`GET /v1/ensembles/:e/schedules`,
   * Tier-1 read). Thin shim over `client.getSchedules` — the same `ScheduleEntry[]`
   * the MCP `schedules` tool and CLI render. Empty when no scheduler is running.
   */
  async listSchedules(): Promise<{ ok: true; schedules: ScheduleEntry[] } | { ok: false; error: string }> {
    const res = await this.getJson<ScheduleEntry[]>(`/v1/ensembles/${this.ens()}/schedules`);
    return res.ok ? { ok: true, schedules: res.data } : res;
  }

  // ── Ensemble write surface (T2) ──
  cue(to: string, message: string): Promise<ActionResult> {
    // #822 — parse the deliverability hint so the board warns on a detached/gone
    // target instead of a bare ✓.
    return this.postWithDeliverability(`/v1/ensembles/${this.ens()}/cue`, { to, message });
  }
  pause(): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/pause`, {});
  }
  play(release?: boolean): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/play`, release ? { release } : {});
  }
  /**
   * Free HELD players via the dedicated `POST /v1/ensembles/:e/release` route
   * (#742 gap 8 — `/go`). Optional `playerId` releases ONE held player; omitted
   * releases all held in the ensemble. Distinct from `play(release:true)`, which
   * ALSO clears the PAUSE axis — `/go` frees holds without touching pause.
   */
  release(playerId?: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/release`, playerId ? { playerId } : {});
  }
  /**
   * Cancel a named schedule (`POST /v1/ensembles/:e/unschedule`, #742 gap —
   * `/unschedule` & `/schedule delete`). Thin shim over `client.cancelSchedule`.
   */
  unschedule(name: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/unschedule`, { name });
  }
  restart(playerId: string, reason?: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/restart`, { playerId, ...(reason ? { reason } : {}) });
  }
  destroy(playerId: string, reason?: string): Promise<ActionResult> {
    return this.post(`/v1/ensembles/${this.ens()}/destroy`, { playerId, ...(reason ? { reason } : {}) });
  }
  reset(playerId: string, reason?: string): Promise<ActionResult> {
    // #822 — reset funnels through the maestro outbox too; carry the hint.
    return this.postWithDeliverability(`/v1/ensembles/${this.ens()}/reset`, { playerId, ...(reason ? { reason } : {}) });
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
    // #822 — `ask` cues the target through the maestro outbox; carry the hint so
    // the planner/operator learns up front that a detached target won't answer.
    return this.postWithDeliverability(`/v1/ensembles/${this.ens()}/ask`, opts);
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
}

/**
 * #822 — extract the deliverability hint from a maestro-outbox endpoint's 2xx
 * body. Reads the daemon's `{ delivery, phase, warning }` fields (with a legacy
 * `queued: true` fallback → `delivery: 'queued'`). Tolerant: empty / non-JSON /
 * hint-less bodies yield `{}`, so an older daemon (or a non-enqueue endpoint)
 * degrades to a plain success with no warning.
 */
export function parseDeliveryHint(text: string): DeliverabilityHint {
  if (!text) return {};
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof j !== 'object' || j === null) return {};
  const o = j as { delivery?: unknown; phase?: unknown; warning?: unknown; queued?: unknown };
  const out: DeliverabilityHint = {};
  if (o.delivery === 'queued' || o.delivery === 'live') out.delivery = o.delivery;
  else if (o.queued === true) out.delivery = 'queued';
  if (typeof o.phase === 'string') out.phase = o.phase;
  if (typeof o.warning === 'string') out.warning = o.warning;
  return out;
}
