/**
 * MessageInput — text input + send button at the bottom of the chat log.
 *
 * **PR-7b**: wired to {@link useCueMutation} with optimistic updates.
 * Submit appends an `optimistic-${nonce}` message to the cached
 * snapshot's chat list before the network call resolves; the SSE
 * `chat.appended` event ~50ms later replaces it with the canonical
 * one. Network errors roll back + surface a Sonner toast.
 *
 * The submit button is disabled when there's no target (rare — only
 * when the ensemble has zero non-maestro players) or the message is
 * empty.
 */
import { useState, type FormEvent } from 'react';
import { useCueMutation } from '../../lib/mutations';
import { logEvent } from '../../lib/log';

interface MessageInputProps {
  ensemble: string;
  /** Default target (typically the conductor's playerId). */
  target?: string;
}

export function MessageInput({ ensemble, target }: MessageInputProps) {
  const [value, setValue] = useState('');
  const cue = useCueMutation(ensemble);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !!target && !cue.isPending;
  const submitTitle = describeSubmitState(target, cue.isPending, trimmed.length);

  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (!canSubmit || !target) {
      logEvent('chat.message.skipped', {
        ensemble, hasTarget: !!target, length: trimmed.length,
      });
      return;
    }
    cue.mutate(
      { to: target, message: trimmed },
      { onSuccess: () => setValue('') },
    );
  };

  return (
    <form
      data-testid="message-input-form"
      onSubmit={onSubmit}
      style={{
        display: 'flex',
        gap: 8,
        padding: 'var(--density-pad)',
        borderTop: '1px solid var(--rule)',
        background: 'var(--bg-1)',
      }}
    >
      <input
        data-testid="message-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={target ? `Message ${target}…` : 'Recruit a player to start chatting'}
        aria-label="Message text"
        disabled={!target || cue.isPending}
        style={{
          flex: 1,
          padding: '8px 12px',
          background: 'var(--bg-2)',
          color: 'var(--text)',
          border: '1px solid var(--rule)',
          borderRadius: 6,
          fontFamily: 'var(--ff-ui)',
          fontSize: 'var(--density-fs)',
        }}
      />
      <button
        type="submit"
        data-testid="message-submit"
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
        title={submitTitle}
        style={{
          padding: '8px 16px',
          background: canSubmit ? 'var(--accent)' : 'var(--bg-3)',
          color: canSubmit ? 'var(--accent-ink)' : 'var(--dim)',
          border: '1px solid var(--rule)',
          borderRadius: 6,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          fontFamily: 'var(--ff-ui)',
          fontWeight: 500,
        }}
      >
        {cue.isPending ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

/** Lookup-table flat replacement for what was a 4-branch nested ternary. */
function describeSubmitState(target: string | undefined, pending: boolean, length: number): string {
  if (!target) return 'No target — recruit a player first';
  if (pending) return 'Sending…';
  if (length === 0) return 'Type a message to send';
  return 'Send';
}
