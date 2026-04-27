/**
 * MessageInput — text input + send button at the bottom of the chat log.
 *
 * **Placeholder semantics for PR-5**: actual cue/broadcast wires up in
 * PR-7 (safe-write paths). Today the submit button logs
 * `chat.message.placeholder-send` and surfaces a "Coming in v2"
 * tooltip per design §9.2 — no real network call. The form is
 * disabled but visible so the conductor's autonomous validator can
 * still find the testid surface and verify the eventual wiring.
 */
import { useState, type FormEvent } from 'react';
import { logEvent } from '../../lib/log';

interface MessageInputProps {
  ensemble: string;
  /** Optional default target for the placeholder submit log. */
  target?: string;
}

export function MessageInput({ ensemble, target }: MessageInputProps) {
  const [value, setValue] = useState('');

  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    logEvent('chat.message.placeholder-send', {
      ensemble,
      target: target ?? 'conductor',
      length: trimmed.length,
    });
    setValue('');
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
        placeholder="Type a message — sending lands in PR-7 of #340"
        aria-label="Message text"
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
        title="Coming in PR-7 of #340 — safe-write paths"
        disabled={value.trim().length === 0}
        style={{
          padding: '8px 16px',
          background: value.trim() ? 'var(--accent)' : 'var(--bg-3)',
          color: value.trim() ? 'var(--accent-ink)' : 'var(--dim)',
          border: '1px solid var(--rule)',
          borderRadius: 6,
          cursor: value.trim() ? 'pointer' : 'not-allowed',
          fontFamily: 'var(--ff-ui)',
          fontWeight: 500,
        }}
      >
        Send
      </button>
    </form>
  );
}
