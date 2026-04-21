/**
 * TempoClient — factory implementation and barrel re-exports.
 *
 * Extracted from `src/tui/client.ts` so that non-TUI consumers (CLI, tests,
 * external integrations) can create a TempoClient without depending on Ink/React.
 */
import { hostname as osHostname } from 'os';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { maestroWorkflowId, schedulerWorkflowId, sessionWorkflowId, conductorWorkflowId, GLOBAL_MAESTRO_WORKFLOW_ID } from '../config';
import type {
  AttachmentPhase,
  MaestroPlayerInfo,
  MaestroRelayMessage,
  HistoryEntry,
  Message,
  SentMessage,
  SessionMetadata,
  ScheduleEntry,
  QualityGate,
  StageEntry,
  WorktreeEntry,
  EnsembleChatResult,
  OutboxEntryInput,
} from '../types';
import {
  submitOutboxUpdate,
  attachmentInfoQuery,
  destroyUpdate,
  requestDetachSignal,
  releaseHeldSignal,
  setPausedSignal,
} from '../workflows/signals';
import { resolveSession, scanEnsembleSessions } from '../activities/resolve';
import { restoreOrphansOnce, type RestoreOrphansSummary } from '../reconcile/orphans';
import {
  pauseMaestroAndScheduler,
  unpauseMaestroAndScheduler,
  signalAllSessions,
} from '../utils/ensemble-ops';
import {
  getAttachmentPhase,
  getEnsembleName,
  getIsConductor,
} from '../utils/search-attributes';
import type {
  TempoClient,
  EnsembleSummary,
  EnsembleShutdownSummary,
  EnsembleDestroySummary,
} from './interface';

// Re-export public types for consumers
export type {
  TempoClient,
  EnsembleSummary,
  EnsembleShutdownSummary,
  EnsembleShutdownDetail,
  EnsembleDestroySummary,
  EnsembleDestroyDetail,
} from './interface';

// ── Helpers ──

/** Escape a value for use in Temporal visibility query strings.
 *  Strips characters that could break or inject into the query. */
function sanitizeQueryValue(value: string): string {
  return value.replace(/["\\\n\r]/g, '');
}

/** Shared unknown-error → string helper for summary `error` fields. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Invoke the `claude-tempo` CLI as a child process. Shared by
 * {@link TempoClient.createEnsemble} and {@link TempoClient.spawnConductor}
 * so both entry points share the same process semantics (cwd default,
 * timeout, shell-quoted args).
 */
async function runTempoCli(args: string[], workDir?: string): Promise<void> {
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('claude-tempo', args, {
      cwd: workDir ?? process.cwd(),
      timeout: 60_000,
      shell: true,
    }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message || `claude-tempo ${args[0]} failed`));
      else resolve();
    });
  });
}

// ── Factory ──

export function createTempoClient(client: Client): TempoClient {
  const globalMaestroId = GLOBAL_MAESTRO_WORKFLOW_ID;

  /** Helper: get a workflow handle by ID. */
  function handle(workflowId: string) {
    return client.workflow.getHandle(workflowId);
  }

  return {
    async discoverEnsembles(): Promise<EnsembleSummary[]> {
      // Strategy 1: Global Maestro playersByEnsemble query
      try {
        const h = handle(globalMaestroId);
        const byEnsemble: Record<string, MaestroPlayerInfo[]> = await h.query('maestroPlayersByEnsemble');
        const results = Object.entries(byEnsemble).map(([name, players]) => {
          const conductor = players.find(p => p.isConductor);
          return {
            name,
            playerCount: players.length,
            hasConductor: !!conductor,
            // `conductorStatus` is a public TempoClient API field (EnsembleInfo);
            // its value now carries the attachment-phase string (post-#176 drift).
            conductorStatus: conductor?.phase,
          };
        });
        // Only trust Maestro if it has discovered ensembles; fall through to
        // Strategy 2 when empty — the Maestro may not have refreshed yet.
        if (results.length > 0) return results;
      } catch {
        // Global Maestro not available — fall through
      }

      // Strategy 2: Direct workflow list scan
      try {
        const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
        const ensembleMap = new Map<string, { count: number; hasConductor: boolean; conductorStatus?: string }>();

        for await (const wf of client.workflow.list({ query })) {
          const name = getEnsembleName(wf);
          if (!name) continue;

          const entry = ensembleMap.get(name) || { count: 0, hasConductor: false };
          entry.count++;

          // Preferred: ClaudeTempoIsConductor search attribute (canonical, queryable).
          // Fallback: workflow ID convention — covers the brief window after a
          // conductor spawn before the search attribute is indexed.
          const isConductorFromSA = getIsConductor(wf) === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          if (isConductorFromSA || isConductorFromId) {
            entry.hasConductor = true;
            // Post-#175 the workflow writes `ClaudeTempoAttachmentState` (phase) in
            // place of the removed `ClaudeTempoStatus` search attribute.
            entry.conductorStatus = getAttachmentPhase(wf);
          }

          ensembleMap.set(name, entry);
        }

        return [...ensembleMap.entries()].map(([name, info]) => ({
          name,
          playerCount: info.count,
          hasConductor: info.hasConductor,
          conductorStatus: info.conductorStatus,
        }));
      } catch {
        return [];
      }
    },

    async listEnsembles(): Promise<EnsembleSummary[]> {
      // Direct workflow-list scan — the Global Maestro index only tracks
      // live ensembles, so classifying parked ensembles requires reading
      // the attachment-state search attribute per workflow.
      const LIVE_PHASES = new Set<AttachmentPhase>([
        'attached', 'processing', 'awaiting', 'booting', 'draining',
      ]);
      type Agg = {
        count: number;
        hasConductor: boolean;
        conductorStatus?: string;
        hasLive: boolean;
        hasDetached: boolean;
      };
      const byEnsemble = new Map<string, Agg>();
      try {
        const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
        for await (const wf of client.workflow.list({ query })) {
          const name = getEnsembleName(wf);
          if (!name) continue;
          const phase = getAttachmentPhase(wf) as AttachmentPhase | undefined;
          const entry = byEnsemble.get(name) ?? {
            count: 0, hasConductor: false, hasLive: false, hasDetached: false,
          };
          entry.count++;
          if (phase === 'detached') entry.hasDetached = true;
          else if (phase && LIVE_PHASES.has(phase)) entry.hasLive = true;

          const isConductorFromSA = getIsConductor(wf) === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          if (isConductorFromSA || isConductorFromId) {
            entry.hasConductor = true;
            if (phase) entry.conductorStatus = phase;
          }
          byEnsemble.set(name, entry);
        }
      } catch {
        return [];
      }

      const out: EnsembleSummary[] = [];
      for (const [name, info] of byEnsemble) {
        // Skip ensembles with no non-gone sessions — they're either
        // terminating or fully destroyed.
        if (!info.hasLive && !info.hasDetached) continue;
        out.push({
          name,
          playerCount: info.count,
          hasConductor: info.hasConductor,
          conductorStatus: info.conductorStatus,
          state: info.hasLive ? 'running' : 'parked',
        });
      }
      return out;
    },

    async createEnsemble(opts: { ensemble: string; workDir?: string; lineup?: string }): Promise<void> {
      const args = opts.lineup
        ? ['up', opts.ensemble, '--lineup', opts.lineup]
        : ['up', opts.ensemble];
      await runTempoCli(args, opts.workDir);
    },

    async spawnConductor(opts: { ensemble: string; workDir?: string }): Promise<void> {
      // `claude-tempo up <ensemble>` is idempotent at the workflow layer —
      // re-invoking it on a live ensemble reuses the existing conductor
      // workflow (deterministic workflow ID). Distinct from
      // `createEnsemble` so call sites read as "make sure the conductor
      // terminal is running", not "create a new ensemble".
      await runTempoCli(['up', opts.ensemble], opts.workDir);
    },

    async getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]> {
      // Strategy 1: Global Maestro — filter by ensemble
      try {
        const h = handle(globalMaestroId);
        const byEnsemble: Record<string, MaestroPlayerInfo[]> = await h.query('maestroPlayersByEnsemble');
        if (byEnsemble[ensemble]) return byEnsemble[ensemble];
      } catch {
        // Fall through
      }

      // Strategy 2: Per-ensemble Maestro
      try {
        const h = handle(maestroWorkflowId(ensemble));
        return await h.query('maestroPlayers');
      } catch {
        // Fall through
      }

      // Strategy 3: Direct workflow list
      try {
        const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitizeQueryValue(ensemble)}"`;
        const players: MaestroPlayerInfo[] = [];
        for await (const wf of client.workflow.list({ query })) {
          const sa = wf.searchAttributes || {};
          const playerId = Array.isArray(sa.ClaudeTempoPlayerId) ? String(sa.ClaudeTempoPlayerId[0]) : wf.workflowId;
          // Preferred: ClaudeTempoIsConductor search attribute (canonical, queryable).
          // Fallback: workflow ID convention — covers the brief window after a
          // conductor spawn before the search attribute is indexed.
          const isConductorFromSA = Array.isArray(sa.ClaudeTempoIsConductor) && sa.ClaudeTempoIsConductor[0] === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          players.push({
            playerId,
            ensemble,
            part: '',
            hostname: Array.isArray(sa.ClaudeTempoHostname) ? String(sa.ClaudeTempoHostname[0]) : '',
            workDir: '',
            isConductor: isConductorFromSA || isConductorFromId,
            agentType: 'claude',
            // Attachment phase from `ClaudeTempoAttachmentState` search attr.
            phase: Array.isArray(sa.ClaudeTempoAttachmentState)
              ? (String(sa.ClaudeTempoAttachmentState[0]) as AttachmentPhase)
              : undefined,
          });
        }
        return players;
      } catch {
        return [];
      }
    },

    async getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]> {
      try {
        const h = handle(globalMaestroId);
        const all: MaestroRelayMessage[] = await h.query('maestroRecentMessages');
        const filtered = all.filter(m => m.ensemble === ensemble);
        return limit ? filtered.slice(-limit) : filtered;
      } catch {
        return [];
      }
    },

    async getConductorHistory(ensemble: string): Promise<HistoryEntry[]> {
      try {
        const h = handle(globalMaestroId);
        const result: { success: boolean; history: HistoryEntry[] } = await h.executeUpdate('maestroFetchConductorHistory', {
          args: [{ ensemble }],
        });
        if (result.success) return result.history;
        return [];
      } catch {
        return [];
      }
    },

    async getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>> {
      try {
        const h = handle(globalMaestroId);
        return await h.executeUpdate('maestroFetchPlayerMessages', {
          args: [{ ensemble, playerId }],
        });
      } catch {
        return [];
      }
    },

    async getPlayerMetadata(ensemble: string, playerId: string): Promise<SessionMetadata | null> {
      try {
        // Query the player's workflow directly for metadata
        const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND ClaudeTempoPlayerId = "${sanitizeQueryValue(playerId)}"`;
        for await (const wf of client.workflow.list({ query })) {
          const h = handle(wf.workflowId);
          return await h.query('getMetadata');
        }
        return null;
      } catch {
        return null;
      }
    },

    async sendCommand(ensemble: string, text: string, source: string): Promise<string> {
      // Route commands through Maestro hub → conductor's commandSignal
      let result: string;
      try {
        const h = handle(globalMaestroId);
        result = await h.executeUpdate('maestroGlobalSendCommand', {
          args: [{ ensemble, text, source }],
        });
      } catch {
        const h = handle(maestroWorkflowId(ensemble));
        result = await h.executeUpdate('maestroSendCommand', {
          args: [{ text, source }],
        });
      }
      // Record on maestro workflow for history persistence
      try {
        const maestroId = sessionWorkflowId(ensemble, 'maestro');
        const mh = handle(maestroId);
        await mh.signal('recordSentMessage', { to: 'conductor', text });
      } catch { /* best effort */ }
      return result;
    },

    async sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string> {
      // Direct signal with isMaestro flag — matches web Maestro pattern
      const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND ClaudeTempoPlayerId = "${sanitizeQueryValue(to)}"`;
      let sent = false;
      for await (const wf of client.workflow.list({ query })) {
        const h = handle(wf.workflowId);
        await h.signal('receiveMessage', {
          from: source,
          text,
          isMaestro: true,
        });
        sent = true;
        break;
      }
      if (!sent) {
        // Fallback: try via Maestro hub if direct resolution fails
        try {
          const h = handle(globalMaestroId);
          await h.executeUpdate('maestroSendMessage', {
            args: [{ ensemble, to, text, source }],
          });
        } catch {
          throw new Error(`Player "${to}" not found in ensemble "${ensemble}"`);
        }
      }
      // Record on maestro workflow for history persistence
      try {
        const maestroId = sessionWorkflowId(ensemble, 'maestro');
        const mh = handle(maestroId);
        await mh.signal('recordSentMessage', { to, text });
      } catch { /* best effort */ }
      return `maestro-msg-${Date.now()}`;
    },

    async terminatePlayer(ensemble: string, playerId: string): Promise<void> {
      const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND ClaudeTempoPlayerId = "${sanitizeQueryValue(playerId)}"`;
      for await (const wf of client.workflow.list({ query })) {
        const h = handle(wf.workflowId);
        await h.terminate('terminated via TUI');
        return;
      }
      throw new Error(`Player "${playerId}" not found in ensemble "${ensemble}"`);
    },

    // ── PR-D verbs — enqueue on the TUI-owned maestro session's outbox.
    //   The dispatch loop runs `deliverDetach` / `deliverDestroy` /
    //   `deliverRestart` activities against the target (QA B1/B2/B3).

    async restart(ensemble, playerId, opts = {}) {
      const invokerPlayerId = opts.invokerPlayerId ?? 'cli';
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      const entry: OutboxEntryInput = {
        type: 'restart',
        targetPlayerId: playerId,
        invokerPlayerId,
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
        ...(opts.force !== undefined ? { force: opts.force } : {}),
        ...(opts.contextMessages !== undefined ? { contextMessages: opts.contextMessages } : {}),
      };
      const entryId = await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
      return {
        playerId,
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        entryId,
      };
    },

    async detach(ensemble, playerId, deadlineMs = 5_000) {
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      const entry: OutboxEntryInput = {
        type: 'detach',
        targetPlayerId: playerId,
        reason: 'user-stop',
        deadlineMs,
      };
      await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
    },

    async destroy(ensemble, playerId, reason) {
      // #287: ensemble-scope when `playerId` is omitted. Peer sessions in
      // parallel → scheduler + maestro terminate in parallel → conductor
      // last so it sees every peer teardown. Matches the destroy tool.
      if (playerId === undefined) {
        const destroyReason = reason ?? 'ensemble destroy via TempoClient';
        const conductorWfId = conductorWorkflowId(ensemble);
        const sessions = await scanEnsembleSessions(client, ensemble);

        const peers: typeof sessions = [];
        let conductorPresent = false;
        for (const s of sessions) {
          if (s.workflowId === conductorWfId) conductorPresent = true;
          else peers.push(s);
        }

        const summary: EnsembleDestroySummary = {
          destroyed: 0,
          terminated: 0,
          failed: 0,
          details: [],
        };
        const destroyArgs = { reason: destroyReason, terminatedBy: 'tempo-client' };

        // Peers in parallel.
        const peerResults = await Promise.allSettled(
          peers.map(async (s) => {
            try {
              await handle(s.workflowId).executeUpdate(destroyUpdate, { args: [destroyArgs] });
              return { session: s, outcome: 'destroyed' as const };
            } catch (err) {
              return { session: s, outcome: 'failed' as const, error: errMsg(err) };
            }
          }),
        );
        for (const r of peerResults) {
          if (r.status !== 'fulfilled') continue;
          const v = r.value;
          if (v.outcome === 'destroyed') {
            summary.details.push({ target: v.session.playerId, outcome: 'destroyed' });
            summary.destroyed++;
          } else {
            summary.details.push({ target: v.session.playerId, outcome: 'failed', error: v.error });
            summary.failed++;
          }
        }

        // Scheduler + maestro terminate in parallel. `terminate` rejects on
        // missing workflows; treat as "not present" (don't count as failure).
        const [schedRes, maestroRes] = await Promise.allSettled([
          handle(schedulerWorkflowId(ensemble)).terminate(destroyReason),
          handle(maestroWorkflowId(ensemble)).terminate(destroyReason),
        ]);
        if (schedRes.status === 'fulfilled') {
          summary.details.push({ target: 'scheduler', outcome: 'terminated' });
          summary.terminated++;
        }
        if (maestroRes.status === 'fulfilled') {
          summary.details.push({ target: 'maestro', outcome: 'terminated' });
          summary.terminated++;
        }

        // Conductor last.
        if (conductorPresent) {
          try {
            await handle(conductorWfId).executeUpdate(destroyUpdate, { args: [destroyArgs] });
            summary.details.push({ target: 'conductor', outcome: 'destroyed' });
            summary.destroyed++;
          } catch (err) {
            summary.details.push({ target: 'conductor', outcome: 'failed', error: errMsg(err) });
            summary.failed++;
          }
        }
        return summary;
      }

      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      const entry: OutboxEntryInput = {
        type: 'destroy',
        targetPlayerId: playerId,
        ...(reason !== undefined ? { reason } : {}),
        notifyConductor: true,
      };
      await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
    },

    async pause(ensemble) {
      await Promise.all([
        pauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, setPausedSignal.name, true),
      ]);
    },

    async play(ensemble, opts = {}) {
      const [, unpaused] = await Promise.all([
        unpauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, setPausedSignal.name, false),
      ]);
      if (opts.release === true && unpaused.sent > 0) {
        // Fan out releaseHeld AFTER everyone is unpaused so no session
        // receives `releaseHeld` while still paused.
        await signalAllSessions(client, ensemble, releaseHeldSignal.name, undefined);
      }
    },

    async shutdown(ensemble, opts = {}) {
      const deadlineMs = opts.deadlineMs ?? 5_000;
      const [toggle, fanout] = await Promise.all([
        pauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, requestDetachSignal.name, { reason: 'user-stop', deadlineMs }),
      ]);
      return {
        detached: fanout.sent,
        skipped: fanout.skipped,
        failed: fanout.failed,
        maestroPaused: toggle.maestro,
        schedulerPaused: toggle.scheduler,
        details: fanout.perSession.map((p) =>
          p.outcome === 'sent'
            ? { playerId: p.playerId, outcome: 'detaching' as const }
            : p.outcome === 'failed'
              ? { playerId: p.playerId, outcome: 'failed' as const, error: p.error }
              : { playerId: p.playerId, outcome: 'skipped-self' as const },
        ),
      };
    },

    async restore(ensemble): Promise<RestoreOrphansSummary> {
      // Scope the orphan scan to the requested ensemble (#298 — matches the
      // `ensemble?` filter the CLI/TUI pass through) and unpause maestro +
      // scheduler for the same ensemble in parallel.
      //
      // #306: narrow to `phases: ['detached']`. User-invoked `/restore`
      // revives a parked ensemble — a live attached/processing session is
      // NOT a restorable orphan and must not be flagged as one. The broad
      // live-phase default is reserved for daemon reconcile-on-boot + CLI
      // `up --resume`, which have no PID memory after a crash and must
      // treat every live phase as a presumed orphan. Without this narrowing
      // a healthy conductor gets deliverRestart → requestDetach and is
      // hard-terminated by `drainingDeadline`.
      const [summary] = await Promise.all([
        restoreOrphansOnce(client, {
          hostname: osHostname(),
          invokerPlayerId: 'tempo-client',
          policy: 'auto',
          ensemble,
          phases: ['detached'],
        }),
        unpauseMaestroAndScheduler(client, ensemble),
      ]);
      return summary;
    },

    async migrate(ensemble, playerId, host, opts = {}) {
      if (!host || !host.trim()) {
        throw new Error('`host` is required for migrate. Use `restart` to revive on the current host.');
      }
      return this.restart(ensemble, playerId, { ...opts, host });
    },

    async attachmentInfo(ensemble, playerId) {
      // Read-only query — resolve + query directly (no outbox needed).
      const target = await resolveSession(client, ensemble, playerId);
      if (!target) throw new Error(`No session found with name "${playerId}" in ensemble "${ensemble}".`);
      return target.query(attachmentInfoQuery);
    },

    async listHosts(opts: { force?: boolean } = {}) {
      // Lazy import so this doesn't drag utils/hosts into every
      // consumer of TempoClient at module-load time.
      const { listHosts } = await import('../utils/hosts');
      return listHosts(client, {
        force: Boolean(opts.force),
        namespace: client.options.namespace,
      });
    },

    async recall(ensemble, playerId) {
      // #128: direct session queries, no maestro round-trip. Throws rather
      // than returning empties so the CLI / TUI wrappers can surface a
      // clean "session not found" error instead of rendering a silently
      // empty timeline that looks indistinguishable from "no messages yet."
      const target = await resolveSession(client, ensemble, playerId);
      if (!target) throw new Error(`No session found with name "${playerId}" in ensemble "${ensemble}".`);
      const [received, sent] = await Promise.all([
        target.query<Message[]>('allMessages'),
        target.query<SentMessage[]>('allSentMessages'),
      ]);
      return { received, sent };
    },

    async disbandEnsemble(ensemble: string): Promise<{ terminated: number }> {
      let terminated = 0;

      // Terminate all session workflows in the ensemble
      const sessionQuery = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitizeQueryValue(ensemble)}"`;
      for await (const wf of client.workflow.list({ query: sessionQuery })) {
        try {
          const h = handle(wf.workflowId);
          await h.terminate('disbanded via TUI');
          terminated++;
        } catch { /* already closed */ }
      }

      // Terminate scheduler workflow
      try {
        const h = handle(schedulerWorkflowId(ensemble));
        await h.terminate('disbanded via TUI');
        terminated++;
      } catch { /* no scheduler or already closed */ }

      // Terminate per-ensemble maestro workflow
      try {
        const h = handle(maestroWorkflowId(ensemble));
        await h.terminate('disbanded via TUI');
        terminated++;
      } catch { /* no maestro or already closed */ }

      return { terminated };
    },

    async isConnected(): Promise<boolean> {
      try {
        // Lightweight check: list with limit 1
        const query = 'ExecutionStatus = "Running"';
        for await (const _ of client.workflow.list({ query })) {
          return true;
        }
        return true; // Connected but no workflows
      } catch {
        return false;
      }
    },

    async getSchedules(ensemble: string): Promise<ScheduleEntry[]> {
      try {
        const h = handle(schedulerWorkflowId(ensemble));
        return await h.query('getSchedules');
      } catch {
        return [];
      }
    },

    async cancelSchedule(ensemble: string, name: string): Promise<void> {
      const h = handle(schedulerWorkflowId(ensemble));
      await h.signal('removeSchedule', name);
    },

    async getEnsembleChat(ensemble: string, offset?: number, limit?: number): Promise<EnsembleChatResult> {
      try {
        const h = handle(maestroWorkflowId(ensemble));
        return await h.query('maestroEnsembleChat', { offset, limit });
      } catch {
        return { messages: [], total: 0, hasMore: false, hasConductor: false };
      }
    },

    async getGates(ensemble: string): Promise<QualityGate[]> {
      // Gates are stored on the conductor's workflow
      try {
        const h = handle(conductorWorkflowId(ensemble));
        return await h.query('qualityGates');
      } catch {
        return [];
      }
    },

    async getStages(ensemble: string): Promise<StageEntry[]> {
      try {
        const h = handle(conductorWorkflowId(ensemble));
        return await h.query('stages');
      } catch {
        return [];
      }
    },

    async getWorktrees(ensemble: string): Promise<WorktreeEntry[]> {
      try {
        const h = handle(conductorWorkflowId(ensemble));
        return await h.query('worktrees');
      } catch {
        return [];
      }
    },

    async hasGlobalMaestro(): Promise<boolean> {
      try {
        const h = handle(globalMaestroId);
        const desc = await h.describe();
        return desc.status.name === 'RUNNING';
      } catch {
        return false;
      }
    },

    // ── Maestro session (TUI-owned workflow for two-way messaging) ──

    async ensureMaestroSession(ensemble: string): Promise<string> {
      const workflowId = sessionWorkflowId(ensemble, 'maestro');

      const sessionInput = {
        metadata: {
          playerId: 'maestro',
          ensemble,
          hostname: 'dashboard',
          workDir: process.cwd(),
          isConductor: false,
          agentType: 'claude',
          playerType: 'maestro',
          playerTypeDescription: 'TUI dashboard — human operator interface',
        },
        part: 'Dashboard interface (human operator)',
        disableStaleDetection: true,
      };

      try {
        const wfHandle = await client.workflow.start('claudeSessionWorkflow', {
          workflowId,
          taskQueue: 'claude-tempo',
          args: [sessionInput],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          workflowExecutionTimeout: '24 hours',
          searchAttributes: {
            ClaudeTempoHostname: ['dashboard'],
            ClaudeTempoEnsemble: [ensemble],
            ClaudeTempoPlayerId: ['maestro'],
            ClaudeTempoPlayerType: ['maestro'],
          },
        });
        console.error(`[tui:client] Maestro session started: ${wfHandle.workflowId}`);

        // Also ensure the per-ensemble Maestro hub workflow exists.
        // Without this, getEnsembleChat returns empty when the hub wasn't
        // previously created by a CLI command.
        const maestroHubId = maestroWorkflowId(ensemble);
        try {
          await client.workflow.start('claudeMaestroWorkflow', {
            workflowId: maestroHubId,
            taskQueue: 'claude-tempo',
            args: [{ ensemble }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            searchAttributes: {
              ClaudeTempoEnsemble: [ensemble],
            },
          });
          console.error(`[tui:client] Maestro hub ensured: ${maestroHubId}`);
        } catch {
          // Maestro hub is non-critical — log but don't fail
          console.error(`[tui:client] Maestro hub start skipped (may already exist): ${maestroHubId}`);
        }

        return wfHandle.workflowId;
      } catch (err) {
        console.error('[tui:client] Failed to start maestro session:', err);
        throw err;
      }
    },

    async sendAsMaestro(ensemble: string, targetPlayer: string, text: string): Promise<void> {
      // Resolve target player workflow via search attributes
      const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND ClaudeTempoPlayerId = "${sanitizeQueryValue(targetPlayer)}"`;
      let targetHandle;
      for await (const wf of client.workflow.list({ query })) {
        targetHandle = handle(wf.workflowId);
        break;
      }
      if (!targetHandle) {
        throw new Error(`Player "${targetPlayer}" not found in ensemble "${ensemble}"`);
      }

      // Signal the target with the message
      await targetHandle.signal('receiveMessage', { from: 'maestro', text, isMaestro: true });

      // Record outbound on maestro's own workflow
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      try {
        const maestroHandle = handle(maestroId);
        await maestroHandle.signal('recordSentMessage', { to: targetPlayer, text });
      } catch {
        // Best-effort — maestro workflow may not exist yet
      }
    },

    async getMaestroMessages(ensemble: string): Promise<{ received: Message[]; sent: SentMessage[] }> {
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      try {
        const h = handle(maestroId);

        // Query received messages (allMessages preferred, pendingMessages fallback)
        let received: Message[];
        try {
          received = await h.query('allMessages');
        } catch {
          received = await h.query('pendingMessages');
        }

        // Auto-mark undelivered messages as delivered (maestro has no listener)
        const undeliveredIds = received.filter(m => !m.delivered).map(m => m.id);
        if (undeliveredIds.length > 0) {
          try {
            await h.signal('markDelivered', undeliveredIds);
          } catch {
            // Best-effort
          }
        }

        // Query sent messages
        let sent: SentMessage[];
        try {
          sent = await h.query('allSentMessages');
        } catch {
          sent = [];
        }

        return { received, sent };
      } catch {
        return { received: [], sent: [] };
      }
    },
  };
}
