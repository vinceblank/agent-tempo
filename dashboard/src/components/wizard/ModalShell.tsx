/**
 * ModalShell — fixed-position scrim + centered sheet container. PR-E of #389.
 *
 * Owns the chrome (scrim + label badge + esc-to-close + click-outside)
 * around a wizard's `.dialog` content. The dialog itself is the child;
 * ModalShell does not impose width/height.
 *
 * Behaviour:
 *   - Esc → calls `onClose` (no `confirm()` — would block claude-in-chrome
 *     automation per the eslint-modal-rule guard).
 *   - Click on the scrim (outside the dialog) → calls `onClose`.
 *   - On mount: focuses the dialog so keyboard shortcuts route correctly.
 *   - Body scroll locked while the modal is open so the page underneath
 *     doesn't drift on scroll-wheel events that miss the dialog.
 *
 * Source: simplified from
 * `docs/design/dashboard-handoff/project/primitives.jsx:212-235` —
 * the dashboard ModalShell skips the design's "live workspace as
 * dimmed backdrop" decoration.
 */
import { useEffect, useRef, type ReactNode } from 'react';

interface ModalShellProps {
  /** Mono badge above the dialog (e.g. "modal · recruit a player · esc to close"). */
  label?: string;
  /** Called when the user dismisses (esc, click-outside, dedicated close). */
  onClose: () => void;
  /** Test surface — forwarded to the outer container. */
  testId: string;
  children: ReactNode;
}

export function ModalShell({ label, onClose, testId, children }: ModalShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Hold the latest `onClose` in a ref so the mount effect can stay
  // `[]`-dep without going stale. Wizards often pass a fresh arrow per
  // render (`const close = () => navigate(-1)`); without the ref, the
  // mount effect would tear down + rebuild every parent re-render —
  // re-focusing the dialog mid-typing and churning the keydown
  // listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    // Save/restore (rather than blanket-reset) so nested modals or
    // tests rendering multiple modals back-to-back don't leak overflow.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      ref={dialogRef}
      tabIndex={-1}
      onClick={(e) => {
        // Scrim click only — events bubbling up from the dialog itself
        // (where target !== currentTarget) shouldn't dismiss.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 24px 24px',
        background: 'rgba(8, 6, 5, 0.55)',
        backdropFilter: 'blur(2px)',
        zIndex: 100,
      }}
    >
      {label && (
        <div
          style={{
            position: 'absolute',
            top: 18,
            left: 0,
            right: 0,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.16em',
              color: 'rgba(255,255,255,0.55)',
              textTransform: 'uppercase',
              background: 'rgba(0,0,0,0.45)',
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            {label}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
