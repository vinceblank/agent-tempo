/**
 * ChatStub — placeholder shown in the workspace when the Maestro chat
 * has been popped out into a {@link PopoutWindow} (PR-A2 of #389).
 *
 * Click anywhere on the stub to dock the chat back. Mirrors the
 * canonical surface from `workspace.jsx:325-331` and the CSS hook
 * `.chat-stub` / `.chat-stub-inner` / `.chat-stub-icon` /
 * `.chat-stub-title` / `.chat-stub-sub` ported in PR-0.
 *
 * Carries the `panel chat` classes so it slots into the same workspace
 * grid cell that the live chat panel occupies.
 */
interface ChatStubProps {
  /** Headline shown in the stub centre. */
  title?: string;
  /** Sub-text (mono dim). */
  subtitle?: string;
  /** Fires when the stub is clicked (typically dock-the-chat-back). */
  onClick?: () => void;
  /** Custom testid; defaults to `chat-stub`. */
  testId?: string;
}

export function ChatStub({
  title = 'Maestro chat is popped out',
  subtitle = 'Click anywhere here, or close the floating window, to dock it back.',
  onClick,
  testId = 'chat-stub',
}: ChatStubProps) {
  return (
    <div
      className="panel chat chat-stub"
      data-testid={testId}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      aria-label="Dock chat back"
    >
      <div className="chat-stub-inner">
        <div className="chat-stub-icon" aria-hidden="true">↗</div>
        <div className="chat-stub-title">{title}</div>
        <div className="chat-stub-sub mono dim">{subtitle}</div>
      </div>
    </div>
  );
}
