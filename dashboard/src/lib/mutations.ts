/**
 * TanStack Query mutation hooks for the dashboard's safe-write paths
 * (PR-7b of #340). Each hook:
 *
 * 1. Calls the matching `DashboardTempoClient` method
 * 2. Emits `mutation.<action>.{started,succeeded,failed}` log lines
 *    for the conductor's autonomous validator
 * 3. Surfaces a Sonner toast on success/error
 * 4. (cue only) installs an optimistic update on the
 *    `['ensemble', name]` cache slot, with rollback on error and
 *    reconciliation against the SSE `chat.appended` event that lands
 *    ~50ms later.
 *
 * Test seam: every hook accepts an optional `client` override (matches
 * the `useEnsembleList` / `useEnsembleSnapshot` pattern from PR-4).
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { EnsembleStateV1 } from 'claude-tempo/http/event-types';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import type {
  CreateEnsembleOpts,
  CreateEnsembleResult,
  CueResult,
  DashboardTempoClient,
  RecruitOpts,
  RecruitResult,
  ReleaseResult,
} from './client';
import { HttpError } from './client';
import { getDashboardClient } from './client-singleton';
import { logEvent } from './log';
import { ENSEMBLES_QUERY_KEY, ensembleQueryKey } from './queries';
import { toastError, toastSuccess } from './toast';

/** Prefix used on optimistic message ids. */
export const OPTIMISTIC_ID_PREFIX = 'optimistic-';

/** Test-friendly nonce factory; overridden by tests via the `__set*` hook. */
let nonceFn: () => string = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Test escape hatch — replace the nonce factory for deterministic ids. */
export function __setOptimisticNonceFnForTests(fn: (() => string) | null): void {
  nonceFn = fn ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

interface MutationOptions {
  /** Override the client (tests). */
  client?: DashboardTempoClient;
}

// ── cue ──────────────────────────────────────────────────────────────────

export interface CueVars {
  to: string;
  message: string;
}

interface CueMutationContext {
  optimisticId: string;
  previousSnapshot: EnsembleStateV1 | undefined;
}

/**
 * Cue mutation with optimistic update + rollback. Appends an
 * `optimistic-${nonce}` message to the cached snapshot's chat list
 * before the network call resolves; rolls back on error; relies on
 * the SSE `chat.appended` event (which lands ~50ms after success) to
 * replace the optimistic entry with the canonical one.
 */
export function useCueMutation(
  ensemble: string,
  opts: MutationOptions = {},
): UseMutationResult<CueResult, Error, CueVars, CueMutationContext> {
  const qc = useQueryClient();
  const client = opts.client ?? getDashboardClient();
  const queryKey = ensembleQueryKey(ensemble);

  return useMutation<CueResult, Error, CueVars, CueMutationContext>({
    mutationFn: ({ to, message }) => client.cue(ensemble, to, message),
    onMutate: async ({ to, message }): Promise<CueMutationContext> => {
      const optimisticId = `${OPTIMISTIC_ID_PREFIX}${nonceFn()}`;
      logEvent('mutation.cue.started', { ensemble, target: to, optimisticId });

      // Cancel in-flight refetches so they don't stomp the optimistic
      // entry, then snapshot the current state for rollback.
      await qc.cancelQueries({ queryKey });
      const previousSnapshot = qc.getQueryData<EnsembleStateV1>(queryKey);

      const optimisticMessage: EnsembleChatMessage = {
        id: optimisticId,
        from: 'maestro',
        to,
        text: message,
        timestamp: new Date().toISOString(),
        role: 'maestro-out',
      };

      qc.setQueryData<EnsembleStateV1 | undefined>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          chat: {
            ...prev.chat,
            messages: [...prev.chat.messages, optimisticMessage],
            total: prev.chat.total + 1,
          },
        };
      });

      return { optimisticId, previousSnapshot };
    },
    onSuccess: (result, vars, ctx) => {
      logEvent('mutation.cue.succeeded', { ensemble, target: vars.to, optimisticId: ctx?.optimisticId });
      toastSuccess(`Cued ${vars.to}`, {
        description: vars.message.length > 50 ? `${vars.message.slice(0, 47)}…` : vars.message,
      });
      // The SSE chat.appended event will replace the optimistic entry
      // with the canonical one when it arrives (matching by `from` /
      // `to` / `text` / approximate timestamp). Until then the
      // optimistic message stays visible. No invalidation needed —
      // staleTime keeps the cached snapshot fresh.
      void result;
    },
    onError: (err, vars, ctx) => {
      logEvent('mutation.cue.failed', {
        ensemble, target: vars.to,
        error: err instanceof Error ? err.message : String(err),
      }, 'warn');
      // Roll back to the pre-optimistic snapshot.
      if (ctx?.previousSnapshot) {
        qc.setQueryData(queryKey, ctx.previousSnapshot);
      } else if (ctx) {
        // No previous snapshot — strip just the optimistic entry.
        qc.setQueryData<EnsembleStateV1 | undefined>(queryKey, (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            chat: {
              ...prev.chat,
              messages: prev.chat.messages.filter((m) => m.id !== ctx.optimisticId),
              total: Math.max(0, prev.chat.total - 1),
            },
          };
        });
      }
      toastError(`Failed to cue ${vars.to}`, {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });
}

// ── pause / play / release ──────────────────────────────────────────────

export function usePauseMutation(
  ensemble: string,
  opts: MutationOptions = {},
): UseMutationResult<void, Error, void> {
  const client = opts.client ?? getDashboardClient();
  return useMutation<void, Error, void>({
    mutationFn: () => client.pause(ensemble),
    onMutate: () => {
      logEvent('mutation.pause.started', { ensemble });
    },
    onSuccess: () => {
      logEvent('mutation.pause.succeeded', { ensemble });
      toastSuccess(`${ensemble} paused`);
    },
    onError: (err) => {
      logEvent('mutation.pause.failed', { ensemble, error: errMsg(err) }, 'warn');
      toastError(`Failed to pause ${ensemble}`, { description: errMsg(err) });
    },
  });
}

export interface PlayVars {
  release?: boolean;
}

export function usePlayMutation(
  ensemble: string,
  opts: MutationOptions = {},
): UseMutationResult<void, Error, PlayVars | void> {
  const client = opts.client ?? getDashboardClient();
  return useMutation<void, Error, PlayVars | void>({
    mutationFn: (vars) => client.play(ensemble, vars ?? undefined),
    onMutate: (vars) => {
      logEvent('mutation.play.started', { ensemble, release: vars?.release === true });
    },
    onSuccess: (_void, vars) => {
      logEvent('mutation.play.succeeded', { ensemble, release: vars?.release === true });
      toastSuccess(
        vars?.release === true ? `${ensemble} unpaused + released` : `${ensemble} unpaused`,
      );
    },
    onError: (err) => {
      logEvent('mutation.play.failed', { ensemble, error: errMsg(err) }, 'warn');
      toastError(`Failed to unpause ${ensemble}`, { description: errMsg(err) });
    },
  });
}

export interface ReleaseVars {
  /** Optional single-player release. */
  playerId?: string;
}

export function useReleaseMutation(
  ensemble: string,
  opts: MutationOptions = {},
): UseMutationResult<ReleaseResult, Error, ReleaseVars | void> {
  const client = opts.client ?? getDashboardClient();
  return useMutation<ReleaseResult, Error, ReleaseVars | void>({
    mutationFn: (vars) => client.release(ensemble, vars?.playerId),
    onMutate: (vars) => {
      logEvent('mutation.release.started', { ensemble, playerId: vars?.playerId });
    },
    onSuccess: (result, vars) => {
      logEvent('mutation.release.succeeded', {
        ensemble,
        playerId: vars?.playerId,
        released: result.released.length,
      });
      const target = vars?.playerId ?? `${result.released.length} player(s)`;
      toastSuccess(`Released ${target}`);
    },
    onError: (err, vars) => {
      logEvent('mutation.release.failed', {
        ensemble, playerId: vars?.playerId, error: errMsg(err),
      }, 'warn');
      toastError(`Failed to release in ${ensemble}`, { description: errMsg(err) });
    },
  });
}

// ── recruit ──────────────────────────────────────────────────────────────

export function useRecruitMutation(
  ensemble: string,
  opts: MutationOptions = {},
): UseMutationResult<RecruitResult, Error, RecruitOpts> {
  const client = opts.client ?? getDashboardClient();
  return useMutation<RecruitResult, Error, RecruitOpts>({
    mutationFn: (vars) => client.recruit(ensemble, vars),
    onMutate: (vars) => {
      logEvent('mutation.recruit.started', { ensemble, name: vars.name, agent: vars.agent });
    },
    onSuccess: (result, vars) => {
      logEvent('mutation.recruit.succeeded', {
        ensemble, name: vars.name, playerId: result.playerId, entryId: result.entryId,
      });
      toastSuccess(`Recruited ${result.playerId}`, {
        description: `Spawning in ${vars.workDir}`,
      });
    },
    onError: (err, vars) => {
      logEvent('mutation.recruit.failed', {
        ensemble, name: vars.name, error: errMsg(err),
      }, 'warn');
      toastError(`Failed to recruit ${vars.name}`, { description: errMsg(err) });
    },
  });
}

// ── createEnsemble (wire-pending) ────────────────────────────────────────

/**
 * Create a fresh ensemble — POST `/v1/ensembles` (#400). The daemon
 * recruits the conductor + fans out lineup players (parallel). Per-
 * player errors are non-fatal — surfaced via the result's
 * `playerErrors[]` and shown as a partial-success toast so the user
 * can re-recruit specific players from the workspace without rolling
 * back the whole ensemble.
 *
 * Error mapping: 409 (ensemble exists) and 400 (validation) get
 * targeted toast copy so the user can fix the input. Generic 5xx
 * shows the underlying message. The hook does NOT navigate on
 * success — the wizard does that, since only it knows whether the
 * modal should close + where the user came from.
 *
 * On success: invalidates the ensembles list so the new ensemble
 * shows up on Overview without a manual refresh.
 */
export function useEnsembleCreateMutation(
  opts: MutationOptions = {},
): UseMutationResult<CreateEnsembleResult, Error, CreateEnsembleOpts> {
  const qc = useQueryClient();
  const client = opts.client ?? getDashboardClient();
  return useMutation<CreateEnsembleResult, Error, CreateEnsembleOpts>({
    mutationFn: (vars) => client.createEnsemble(vars),
    onMutate: (vars) => {
      logEvent('mutation.createEnsemble.started', {
        name: vars.name, lineup: vars.lineup, startMode: vars.startMode,
      });
    },
    onSuccess: (result, vars) => {
      logEvent('mutation.createEnsemble.succeeded', {
        ensemble: result.ensemble,
        conductorPlayerId: result.conductorPlayerId,
        recruitedPlayers: result.recruitedPlayers,
        playerErrors: result.playerErrors?.length ?? 0,
      });
      const failed = result.playerErrors?.length ?? 0;
      const description = failed > 0
        ? `Conductor active. ${failed} player${failed === 1 ? '' : 's'} failed — re-recruit from Workspace.`
        : vars.lineup
          ? `Lineup: ${vars.lineup}`
          : 'Blank ensemble — recruit players from Workspace.';
      toastSuccess(`Created ${result.ensemble}`, { description });
      void qc.invalidateQueries({ queryKey: ENSEMBLES_QUERY_KEY });
    },
    onError: (err, vars) => {
      const msg = errMsg(err);
      logEvent('mutation.createEnsemble.failed', { name: vars.name, error: msg }, 'warn');
      // 409 / 400 get targeted copy so the user can fix the input;
      // anything else shows the underlying message.
      const status = err instanceof HttpError ? err.status : null;
      if (status === 409) {
        toastError(`Ensemble "${vars.name}" already exists`, {
          description: 'Pick a different name or open the existing one from Overview.',
        });
        return;
      }
      if (status === 400) {
        toastError(`Couldn't create ${vars.name}`, {
          description: `Validation failed: ${msg}`,
        });
        return;
      }
      toastError(`Failed to create ${vars.name}`, { description: msg });
    },
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
