/**
 * UnreadBadge — numeric unread pill rendered in the sidebar's
 * `.ensemble-row`. Ported from the Claude Design canvas
 * (`notifications.jsx:160-173`).
 *
 * Two variants:
 *   - default: render a numeric pill ("3", "12", "99+") when count > 0.
 *   - dotOnly: render a small `.notif-dot` for the "new but no count"
 *     case (currently unused in PR-1's sidebar wiring; kept on the
 *     surface for the eventual #notification-center follow-up that
 *     wants a dot-only "fresh activity" indicator).
 *
 * Returns `null` (renders nothing) when there is no signal to surface
 * — `count === 0 && !dotOnly` is the no-op, which Sidebar relies on
 * to decorate every row uniformly without conditional JSX.
 */

interface UnreadBadgeProps {
  count: number;
  /** Render a soft dot when count is 0 instead of returning null. */
  dotOnly?: boolean;
}

export function UnreadBadge({ count, dotOnly = false }: UnreadBadgeProps) {
  // No signal at all → render nothing.
  if (!count && !dotOnly) return null;

  // dotOnly + zero count → render the soft dot.
  if (!count && dotOnly) {
    return (
      <span
        className="notif-dot"
        data-testid="unread-badge"
        aria-label="unread"
      />
    );
  }

  // Numeric pill — clamp display at "99+" so the pill stays compact
  // on chatty rooms.
  const display = count > 99 ? '99+' : String(count);
  return (
    <span
      className="notif-badge"
      data-testid="unread-badge"
      aria-label={`${count} unread`}
    >
      {display}
    </span>
  );
}
