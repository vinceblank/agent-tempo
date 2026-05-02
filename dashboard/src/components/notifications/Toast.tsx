/**
 * Toast — single notification card.
 *
 * Ported from the Claude Design canvas (`notifications.jsx:206-268`).
 * Layout: avatar | body (head + message + Reply/Dismiss actions) | ×.
 *
 * Click semantics:
 *   - Click anywhere on the card (except a button) → routes to the
 *     ensemble's chat via `onOpen`.
 *   - Reply → also calls `onOpen` (stopPropagation prevents double-fire).
 *   - Dismiss (ghost) and × → call `onDismiss` only.
 *
 * Accessibility:
 *   - The card carries `role="alert"` so screen readers announce on
 *     mount.
 *   - The × button uses `aria-label="Close"` to disambiguate from the
 *     ghost "Dismiss" button (same action, distinct name avoids the
 *     "two buttons with the same accessible name in one card" pitfall).
 *
 * Testability:
 *   - `data-testid="toast-${id}"` on the root (per architect spec).
 *   - Stable `toast` class also present for class-based queries.
 *   - `data-testid="toast-reply"` on Reply; `"toast-dismiss"` on BOTH
 *     × and the ghost button (architect: same-action surface, two
 *     entry points).
 *   - `data-stack-index` drives the depth-stack CSS treatment.
 *
 * Avatar hue: derived from `senderType` via `hueForType()`. When the
 * sender's player type isn't known, `hueForType(undefined)` returns
 * a neutral steel hue (200) — degrades gracefully. The SSE wiring
 * (commit 3) doesn't have a senderType source on `chat.appended`
 * payloads, so most production toasts will land on neutral until a
 * snapshot-driven lookup is added. Keeping the lookup out of this
 * presentational component matches the dashboard's `FeedMessage`
 * convention — data flows in via props.
 */
import { hueForType } from '../../lib/tempo-helpers';
import type { NotificationToast } from '../../lib/notifications';

interface ToastProps {
  toast: NotificationToast;
  /** 0 = front of stack; 1, 2 fade + shrink per the depth-stack CSS. */
  stackIndex: number;
  /** Called when the user clicks the card or the Reply button. */
  onOpen: () => void;
  /** Called when the user clicks ×, Dismiss, or after `onOpen` from the body. */
  onDismiss: () => void;
}

export function Toast({ toast, stackIndex, onOpen, onDismiss }: ToastProps) {
  const { id, ensembleName, sender, senderType, body, count } = toast;
  const hue = hueForType(senderType);
  const initial = (sender || '?').charAt(0).toUpperCase();
  // Toast TTL is < 6 s — anything more nuanced than "just now" is
  // dishonest at this resolution. The label keeps the head row's shape
  // consistent with the canvas reference.
  const timeAgo = 'just now';

  return (
    <div
      className="toast"
      data-testid={`toast-${id}`}
      data-stack-index={stackIndex}
      role="alert"
      onClick={(e) => {
        // Defensive: if a child button forgets to stopPropagation, this
        // catches a bubbled click on the close button so we don't open
        // and dismiss simultaneously.
        if ((e.target as HTMLElement).closest('.toast-close')) return;
        onOpen();
      }}
    >
      <div
        className="toast-avatar"
        style={{
          background: `oklch(0.62 0.13 ${hue})`,
          color: '#0F1117',
        }}
        aria-hidden="true"
      >
        {initial}
      </div>
      <div className="toast-body">
        <div className="toast-head">
          <span className="toast-sender mono">@{sender}</span>
          <span className="toast-divider">·</span>
          <span className="toast-ensemble">{ensembleName}</span>
          {count > 1 && <span className="toast-count mono">{count}</span>}
          <span className="toast-time mono">{timeAgo}</span>
        </div>
        <div className="toast-message">{body}</div>
        <div className="toast-actions">
          <button
            type="button"
            className="toast-action"
            data-testid="toast-reply"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            Reply →
          </button>
          <button
            type="button"
            className="toast-action toast-action--ghost"
            data-testid="toast-dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
      <button
        type="button"
        className="toast-close"
        data-testid="toast-dismiss"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        ×
      </button>
    </div>
  );
}
