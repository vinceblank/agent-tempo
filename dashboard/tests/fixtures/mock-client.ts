/**
 * Mock {@link DashboardTempoClient} for the dashboard's vitest suite.
 *
 * Tests inject a `MockDashboardClient` via the per-hook `client` opt
 * (queries.ts / sse.ts) so the production path stays untouched. Both
 * `state` and `subscribe` are programmable from the test — set
 * `mock.snapshot = ...` then call the hook, or call `mock.emit(event)`
 * to push an SSE event into a live subscription.
 */
import type {
  EnsembleStateV1,
  EnsembleSummary,
  HealthV1,
  TempoEvent,
} from 'claude-tempo/http/event-types';
import type { HostInfo } from 'claude-tempo/types';
import type {
  AgentTypeRow,
  CreateEnsembleOpts,
  CreateEnsembleResult,
  CueResult,
  DashboardTempoClient,
  DestroyOpts,
  DestroyResult,
  DetachOpts,
  DetachResult,
  LineupRow,
  RecallOpts,
  RecallResult,
  RecruitOpts,
  RecruitResult,
  ReleaseResult,
  RestartOpts,
  RestartResult,
} from '../../src/lib/client';

// Default catalog rows seeded into every `MockDashboardClient` so the
// wizard tests don't have to reach into `static-catalog.ts` themselves.
// Re-exported from production rather than duplicated — drift between
// production fallback and test fixture would be a bug, not a feature.
import { SHIPPED_PLAYER_TYPES, SHIPPED_LINEUPS } from '../../src/lib/static-catalog';

export interface MockBehavior {
  ensembles?: EnsembleSummary[];
  ensemblesError?: Error;
  snapshot?: EnsembleStateV1;
  snapshotError?: Error;
  hosts?: HostInfo[];
  hostsError?: Error;
  agentTypes?: AgentTypeRow[];
  agentTypesError?: Error;
  lineups?: LineupRow[];
  lineupsError?: Error;
  /** Per-mutation error injection. Keyed by action name. */
  mutationErrors?: Partial<Record<MutationCall['method'], Error>>;
}

export interface MutationCall {
  method:
    | 'cue'
    | 'pause'
    | 'play'
    | 'release'
    | 'recruit'
    | 'createEnsemble'
    | 'restart'
    | 'destroy'
    | 'detach'
    | 'recall';
  args: unknown[];
}

export class MockDashboardClient implements DashboardTempoClient {
  public ensembles: EnsembleSummary[] = [];
  public ensemblesError: Error | null = null;
  public snapshot: EnsembleStateV1 | null = null;
  public snapshotError: Error | null = null;
  public hostList: HostInfo[] = [];
  public hostsError: Error | null = null;
  // Default to the shipped catalog so wizard tests don't need to seed
  // every mock by hand. Tests that specifically exercise empty /
  // error / sparse catalogs override via the constructor opts.
  public agentTypeList: ReadonlyArray<AgentTypeRow> = SHIPPED_PLAYER_TYPES;
  public agentTypesError: Error | null = null;
  public lineupList: ReadonlyArray<LineupRow> = SHIPPED_LINEUPS;
  public lineupsError: Error | null = null;
  /** Records every mutation call so tests can assert. */
  public mutationCalls: MutationCall[] = [];
  /** Per-mutation error injection. Keyed by action name. */
  public mutationErrors: NonNullable<MockBehavior['mutationErrors']> = {};
  /** Per-mutation result override. */
  public recruitResult: RecruitResult = { playerId: 'tempo-eng', entryId: 'entry-1' };
  public releaseResult: ReleaseResult = { released: [], errors: [] };
  public createEnsembleResult: CreateEnsembleResult = { ensemble: 'new-ensemble' };
  /** Pending push channels for live subscriptions, keyed by ensemble. */
  private pushers = new Map<string, ((ev: TempoEvent | null) => void)[]>();

  constructor(initial: MockBehavior = {}) {
    if (initial.ensembles) this.ensembles = initial.ensembles;
    if (initial.ensemblesError) this.ensemblesError = initial.ensemblesError;
    if (initial.snapshot) this.snapshot = initial.snapshot;
    if (initial.snapshotError) this.snapshotError = initial.snapshotError;
    if (initial.hosts) this.hostList = initial.hosts;
    if (initial.hostsError) this.hostsError = initial.hostsError;
    if (initial.agentTypes) this.agentTypeList = initial.agentTypes;
    if (initial.agentTypesError) this.agentTypesError = initial.agentTypesError;
    if (initial.lineups) this.lineupList = initial.lineups;
    if (initial.lineupsError) this.lineupsError = initial.lineupsError;
    if (initial.mutationErrors) this.mutationErrors = initial.mutationErrors;
  }

  async health(): Promise<HealthV1> {
    return {
      ok: true,
      namespace: 'default',
      version: '0.0.0-test',
      uptimeMs: 0,
      ensembleCount: 0,
      subscriberCount: 0,
    };
  }

  async listEnsembles(): Promise<EnsembleSummary[]> {
    if (this.ensemblesError) throw this.ensemblesError;
    return this.ensembles;
  }

  async state(_ensemble: string): Promise<EnsembleStateV1> {
    if (this.snapshotError) throw this.snapshotError;
    if (!this.snapshot) throw new Error(`mock client has no snapshot for ${_ensemble}`);
    return this.snapshot;
  }

  async hosts(): Promise<HostInfo[]> {
    if (this.hostsError) throw this.hostsError;
    return this.hostList;
  }

  async agentTypes(): Promise<AgentTypeRow[]> {
    if (this.agentTypesError) throw this.agentTypesError;
    return [...this.agentTypeList];
  }

  async lineups(): Promise<LineupRow[]> {
    if (this.lineupsError) throw this.lineupsError;
    return [...this.lineupList];
  }

  subscribe(ensemble: string): AsyncIterable<TempoEvent> {
    const buffer: TempoEvent[] = [];
    let resolveNext: ((v: IteratorResult<TempoEvent>) => void) | null = null;
    let closed = false;
    const pushers = this.pushers.get(ensemble) ?? [];
    const push = (ev: TempoEvent | null) => {
      if (closed) return;
      if (ev === null) {
        closed = true;
        if (resolveNext) {
          resolveNext({ value: undefined as never, done: true });
          resolveNext = null;
        }
        return;
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        buffer.push(ev);
      }
    };
    pushers.push(push);
    this.pushers.set(ensemble, pushers);

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<TempoEvent>> {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift() as TempoEvent, done: false });
            }
            if (closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => { resolveNext = resolve; });
          },
          return(): Promise<IteratorResult<TempoEvent>> {
            closed = true;
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  // ── Mutations (PR-7b) ──────────────────────────────────────────

  async cue(ensemble: string, to: string, message: string): Promise<CueResult> {
    this.mutationCalls.push({ method: 'cue', args: [ensemble, to, message] });
    if (this.mutationErrors.cue) throw this.mutationErrors.cue;
    return { ok: true, ensemble, to };
  }

  async pause(ensemble: string): Promise<void> {
    this.mutationCalls.push({ method: 'pause', args: [ensemble] });
    if (this.mutationErrors.pause) throw this.mutationErrors.pause;
  }

  async play(ensemble: string, opts?: { release?: boolean }): Promise<void> {
    this.mutationCalls.push({ method: 'play', args: [ensemble, opts] });
    if (this.mutationErrors.play) throw this.mutationErrors.play;
  }

  async release(ensemble: string, playerId?: string): Promise<ReleaseResult> {
    this.mutationCalls.push({ method: 'release', args: [ensemble, playerId] });
    if (this.mutationErrors.release) throw this.mutationErrors.release;
    return this.releaseResult;
  }

  async recruit(ensemble: string, opts: RecruitOpts): Promise<RecruitResult> {
    this.mutationCalls.push({ method: 'recruit', args: [ensemble, opts] });
    if (this.mutationErrors.recruit) throw this.mutationErrors.recruit;
    return this.recruitResult;
  }

  async createEnsemble(opts: CreateEnsembleOpts): Promise<CreateEnsembleResult> {
    this.mutationCalls.push({ method: 'createEnsemble', args: [opts] });
    if (this.mutationErrors.createEnsemble) throw this.mutationErrors.createEnsemble;
    return { ...this.createEnsembleResult, ensemble: opts.name };
  }

  // ── PR-7 destructive actions ────────────────────────────────────
  // Each method records the call + honours the `mutationErrors`
  // injection lane, mirroring the cue/recruit/createEnsemble pattern.
  // The default success result is a minimal `{ ok: true, playerId }`
  // shape — tests asserting on richer fields override the result via
  // the public mutation-result props.

  public restartResult: RestartResult = { ok: true, playerId: 'tempo-eng' };
  public destroyResult: DestroyResult = { ok: true, playerId: 'tempo-eng' };
  public detachResult: DetachResult = { ok: true, playerId: 'tempo-eng' };
  public recallResult: RecallResult = { ok: true, playerId: 'tempo-eng', messages: 0 };

  async restart(ensemble: string, opts: RestartOpts): Promise<RestartResult> {
    this.mutationCalls.push({ method: 'restart', args: [ensemble, opts] });
    if (this.mutationErrors.restart) throw this.mutationErrors.restart;
    return this.restartResult;
  }

  async destroy(ensemble: string, opts: DestroyOpts): Promise<DestroyResult> {
    this.mutationCalls.push({ method: 'destroy', args: [ensemble, opts] });
    if (this.mutationErrors.destroy) throw this.mutationErrors.destroy;
    return this.destroyResult;
  }

  async detach(ensemble: string, opts: DetachOpts): Promise<DetachResult> {
    this.mutationCalls.push({ method: 'detach', args: [ensemble, opts] });
    if (this.mutationErrors.detach) throw this.mutationErrors.detach;
    return this.detachResult;
  }

  async recall(ensemble: string, opts: RecallOpts): Promise<RecallResult> {
    this.mutationCalls.push({ method: 'recall', args: [ensemble, opts] });
    if (this.mutationErrors.recall) throw this.mutationErrors.recall;
    return this.recallResult;
  }

  /** Push a fake SSE event into every live subscription for `ensemble`. */
  emit(ensemble: string, event: TempoEvent): void {
    const pushers = this.pushers.get(ensemble);
    if (!pushers) return;
    for (const p of pushers) p(event);
  }

  /** Close every live subscription for `ensemble`. */
  closeStream(ensemble: string): void {
    const pushers = this.pushers.get(ensemble);
    if (!pushers) return;
    for (const p of pushers) p(null);
    this.pushers.delete(ensemble);
  }
}

/** Build a tiny but type-correct snapshot for tests. */
export function makeSnapshot(overrides: Partial<EnsembleStateV1> = {}): EnsembleStateV1 {
  return {
    v: 1,
    ensemble: 'demo',
    capturedAt: '2026-04-27T00:00:00.000Z',
    lastEventId: '1735000000000:0',
    state: 'online',
    hasConductor: false,
    flags: { paused: false, held: false },
    players: [],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
    // Issue #399 wire extensions — sentinel defaults matching the
    // soft-fail shape of `buildEnsembleSnapshot`. Override per-test
    // when a scenario needs a populated description / bpm / etc.
    description: '',
    startedAt: '',
    currentBpm: 0,
    tempoSeries: [],
    ...overrides,
  };
}
