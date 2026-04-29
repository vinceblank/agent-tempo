/**
 * useSlashDispatcher — submit-time slash-command executor for the
 * dashboard Composer (#471/#472).
 *
 * Owns the v1 set of dashboard slash verbs (matches the metadata in
 * `dashboard-commands.ts`):
 *
 *   /help            → show available verbs as a system message
 *   /clear           → wipe the local chat scrollback (cache only)
 *   /pause           → pause the ensemble (existing usePauseMutation)
 *   /play            → resume the ensemble (existing usePlayMutation)
 *   /release [p]     → release held players (optional player arg)
 *   /recall <p>      → fetch a player's history (existing useRecallMutation)
 *
 * Anything else → toast "command not yet supported in dashboard —
 * delegate to conductor" so the user has a clear next step.
 *
 * **Why a hook, not a class?** Every operation reaches for React Query
 * mutations + cache + the Sonner toast surface. Wrapping as a hook keeps
 * the call sites tiny (Workspace just calls `dispatch(parsed)`) without
 * threading a half-dozen mutation handles through props.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EnsembleStateV1 } from 'claude-tempo/http/event-types';
import { ensembleQueryKey } from './queries';
import {
  usePauseMutation,
  usePlayMutation,
  useReleaseMutation,
  useRecallMutation,
} from './mutations';
import { toastInfo, toastError } from './toast';
import { logEvent } from './log';
import { DASHBOARD_COMMANDS } from './dashboard-commands';
import type { ParsedChatInput } from './parse-chat-input';

export type SlashOutcome =
  | { handled: true; verb: string }
  | { handled: false; reason: 'unknown'; verb: string }
  | { handled: false; reason: 'invalid-args'; verb: string; usage: string };

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
          const lines = DASHBOARD_COMMANDS.map(
            (c) => `  ${c.usage.padEnd(28)} ${c.description}`,
          );
          toastInfo('Slash commands', {
            description: lines.join('\n'),
          });
          return { handled: true, verb };
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
          toastInfo('Chat cleared', {
            description: 'Local view only — server history is untouched.',
          });
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
            toastError('Usage: /recall <player>', {
              description: 'Pass a player name — e.g. /recall tempo-eng',
            });
            return { handled: false, reason: 'invalid-args', verb, usage: '/recall <player>' };
          }
          recallM.mutate({ playerId });
          return { handled: true, verb };
        }

        default: {
          toastError(`Slash command "/${verb}" not supported in the dashboard`, {
            description:
              'Use the Maestro chat to ask the conductor instead, or run it from the TUI / CLI.',
          });
          return { handled: false, reason: 'unknown', verb };
        }
      }
    },
    [ensemble, qc, pauseM, playM, releaseM, recallM],
  );
}
