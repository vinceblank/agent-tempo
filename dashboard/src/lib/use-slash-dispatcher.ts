/**
 * useSlashDispatcher — submit-time slash-command executor for the
 * dashboard Composer (#471/#472).
 *
 * Owns the v1 set of dashboard slash verbs (matches the metadata in
 * `dashboard-commands.ts`):
 *
 *   /help            → returns an info status with the verb list
 *                      (Workspace renders it via `<ComposerStatus>`)
 *   /clear           → wipe the local chat scrollback (cache only).
 *                      Returns `handled: true` with no status — the
 *                      visible chat clear IS the feedback.
 *   /pause           → pause the ensemble (existing usePauseMutation)
 *   /play            → resume the ensemble (existing usePlayMutation)
 *   /release [p]     → release held players (optional player arg)
 *   /recall <p>      → fetch a player's history (existing useRecallMutation)
 *
 * Anything else → returns an error status the consumer can render.
 *
 * **Post-Sonner contract** (PR-2 of the chat-notification port): the
 * dispatcher no longer fires toasts directly. It returns a structured
 * `SlashOutcome` with an optional `status` payload that Workspace
 * routes into the `<ComposerStatus>` banner anchored above the
 * Composer. Successful slash verbs that have a visible state-change
 * effect (`/pause`, `/play`, `/release`, `/clear`, `/recall <p>`)
 * return no status — the UI flag/cache change is the feedback.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EnsembleStateV1 } from 'agent-tempo/http/event-types';
import { ensembleQueryKey } from './queries';
import {
  usePauseMutation,
  usePlayMutation,
  useReleaseMutation,
  useRecallMutation,
} from './mutations';
import { logEvent } from './log';
import { DASHBOARD_COMMANDS } from './dashboard-commands';
import type { ParsedChatInput } from './parse-chat-input';

/**
 * Status payload a consumer (Workspace) renders inline next to the
 * Composer. Optional on every outcome — silent slashes (visible
 * state change is the feedback) leave it undefined.
 */
export interface SlashStatus {
  level: 'error' | 'info';
  message: string;
  description?: string;
}

export type SlashOutcome =
  | { handled: true; verb: string; status?: SlashStatus }
  | { handled: false; reason: 'unknown'; verb: string; status: SlashStatus }
  | {
      handled: false;
      reason: 'invalid-args';
      verb: string;
      usage: string;
      status: SlashStatus;
    };

/**
 * Build the dispatcher for a given ensemble. The returned `dispatch`
 * fans out to the right mutation / cache mutation / toast based on the
 * verb name.
 */
export function useSlashDispatcher(ensemble: string): (parsed: ParsedChatInput & { kind: 'slash' }) => SlashOutcome {
  const qc = useQueryClient();
  const pauseM = usePauseMutation(ensemble);
  const playM = usePlayMutation(ensemble);
  const releaseM = useReleaseMutation(ensemble);
  const recallM = useRecallMutation(ensemble);

  return useCallback(
    (parsed): SlashOutcome => {
      const verb = parsed.name;
      logEvent('slash.dispatched', { ensemble, verb, args: parsed.args.length });

      switch (verb) {
        case 'help': {
          // The verb list isn't transient — surface it as an info
          // banner anchored above the Composer that the user can
          // re-read until they dismiss it. (The previous Sonner toast
          // disappeared after 4 s, which was a known UX wart.)
          const lines = DASHBOARD_COMMANDS.map(
            (c) => `  ${c.usage.padEnd(28)} ${c.description}`,
          );
          return {
            handled: true,
            verb,
            status: {
              level: 'info',
              message: 'Slash commands',
              description: lines.join('\n'),
            },
          };
        }

        case 'clear': {
          // Wipe just the local cached chat — server history is untouched.
          // Mirrors the TUI's `tuiReducer({ type: 'CLEAR' })` semantics:
          // the next snapshot poll will re-populate from the daemon.
          qc.setQueryData<EnsembleStateV1 | undefined>(
            ensembleQueryKey(ensemble),
            (prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                chat: { ...prev.chat, messages: [], total: 0 },
              };
            },
          );
          // Silent — the chat is visibly empty now.
          return { handled: true, verb };
        }

        case 'pause': {
          pauseM.mutate();
          return { handled: true, verb };
        }

        case 'play': {
          playM.mutate();
          return { handled: true, verb };
        }

        case 'release': {
          // Optional positional player — `/release alice` releases alice
          // only; bare `/release` releases everyone held.
          const playerId = parsed.args[0];
          releaseM.mutate(playerId ? { playerId } : undefined);
          return { handled: true, verb };
        }

        case 'recall': {
          const playerId = parsed.args[0];
          if (!playerId) {
            return {
              handled: false,
              reason: 'invalid-args',
              verb,
              usage: '/recall <player>',
              status: {
                level: 'error',
                message: 'Usage: /recall <player>',
                description: 'Pass a player name — e.g. /recall tempo-eng',
              },
            };
          }
          recallM.mutate({ playerId });
          return { handled: true, verb };
        }

        default: {
          return {
            handled: false,
            reason: 'unknown',
            verb,
            status: {
              level: 'error',
              message: `Slash command "/${verb}" not supported in the dashboard`,
              description:
                'Use the Maestro chat to ask the conductor instead, or run it from the TUI / CLI.',
            },
          };
        }
      }
    },
    [ensemble, qc, pauseM, playM, releaseM, recallM],
  );
}
