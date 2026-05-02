/**
 * ToastStack — bottom-right column of live notification toasts.
 *
 * Ported from the Claude Design canvas (`notifications.jsx:179-204`).
 * Visual layout:
 *   - Position: viewport-relative `position: fixed` (production mode —
 *     the canvas was `position: absolute` because it was scoped to a
 *     single artboard; production stacks toasts at the viewport edge).
 *   - Stack order: newest at the bottom of the stack (closest to the
 *     screen edge), older toasts pile up above with reduced opacity +
 *     scale via the `data-stack-index` CSS rules. The flex container
 *     uses `column-reverse`, so we render newest-first in the DOM and
 *     CSS handles the visual flip.
 *   - Cap: at most `MAX_VISIBLE_TOASTS` (3) cards rendered. When the
 *     queue exceeds the cap, a `+N more` overflow chip surfaces the
 *     hidden count without rendering full cards.
 *
 * Consumers pass `onOpen(ensembleId)` — a router navigate closure — so
 * a click on a toast (or its Reply button) routes to that ensemble's
 * chat. The provider's `setActiveEnsemble` effect (URL-driven) then
 * fires the side effects (clear unread, drop pending toasts FROM that
 * ensemble), so this component only owns the UI.
 *
 * Returns `null` when the queue is empty so AppShell doesn't mount an
 * empty `<div>` 24/7.
 */
import { Toast } from './Toast';
import { MAX_VISIBLE_TOASTS, useNotifications } from '../../lib/notifications';

interface ToastStackProps {
  /** Called with the toast's ensembleId when the user opens / replies. */
  onOpen: (ensembleId: string) => void;
}

export function ToastStack({ onOpen }: ToastStackProps) {
  const { toasts, dismissToast } = useNotifications();
  if (!toasts.length) return null;

  // The provider stores toasts oldest-first. Reverse so the newest is
  // first in the DOM — flex `column-reverse` then renders it at the
  // bottom of the stack (closest to the screen edge), with older
  // toasts piling up above with depth-stack CSS treatment.
  const ordered = [...toasts].reverse();
  const visible = ordered.slice(0, MAX_VISIBLE_TOASTS);
  const hidden = ordered.length - visible.length;

  return (
    <div
      className="toast-stack"
      data-testid="toast-stack"
      role="region"
      aria-label="Notifications"
    >
      {hidden > 0 && (
        <div className="toast-overflow mono" data-testid="toast-overflow">
          +{hidden} more
        </div>
      )}
      {visible.map((t, i) => (
        <Toast
          key={t.id}
          toast={t}
          stackIndex={i}
          onDismiss={() => dismissToast(t.id)}
          onOpen={() => {
            onOpen(t.ensembleId);
            // Drop the toast immediately on open — the user is now
            // navigating to that chat; the toast would be
            // suppressed/dropped by the provider's URL-sync effect
            // anyway, but doing it inline keeps the UI tidy if
            // navigation is briefly delayed.
            dismissToast(t.id);
          }}
        />
      ))}
    </div>
  );
}
