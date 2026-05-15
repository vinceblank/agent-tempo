/**
 * PopoutWindow — always-on-top floating window for the popped-out
 * Maestro chat (PR-A2 of #389; canvas v=49 sync — non-modal floating).
 *
 * Renders a fixed-position window with traffic-light dots, a centered
 * title, and an "always on top" pin on the right. Children render below
 * the chrome — typically a chat log + composer pair, but the primitive
 * doesn't enforce that.
 *
 * Semantics: this is a true floating window — workspace beneath stays
 * fully interactive. ARIA `role="region"` (not `dialog`) reflects the
 * non-modal metaphor; the window does not trap focus or block the page.
 *
 * Sourced from `workspace.jsx:464-490` and `components.css` ".popout-*"
 * (canvas v=49 port of `styles.css:1404-1462`). The chrome animates in
 * via the `popout-in` keyframe defined in the canonical CSS and on phone
 * (`@container artboard (max-width: 520px)`) the window fills the
 * viewport — that responsive behaviour lives in CSS, not JSX.
 *
 * The red traffic-light dot is the close affordance; clicking it calls
 * `onClose`. The window itself stops click propagation so events don't
 * leak to the workspace beneath.
 */
import type { ReactNode } from 'react';

interface PopoutWindowProps {
  /** Mono dim subtitle prefix (e.g., "agent-tempo · maestro chat ·"). */
  titlePrefix?: string;
  /** Accent-coloured tail (e.g., "@my-band"). */
  titleAccent?: string;
  /** Right-side hint, defaults to "◈ always on top". */
  alwaysOnTopLabel?: string;
  /** Fires when the user clicks the red traffic-light dot. */
  onClose?: () => void;
  /** Body content — typically `<ChatLog>` + `<Composer>`. */
  children?: ReactNode;
  /** Custom testid; defaults to `popout-window`. */
  testId?: string;
}

export function PopoutWindow({
  titlePrefix = 'agent-tempo · maestro chat',
  titleAccent,
  alwaysOnTopLabel = 'always on top',
  onClose,
  children,
  testId = 'popout-window',
}: PopoutWindowProps) {
  return (
    <div
      className="popout-window"
      data-testid={testId}
      role="region"
      aria-label="Popped-out Maestro chat"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="popout-chrome">
        <div className="popout-dots">
          <button
            type="button"
            className="popout-dot r"
            title="Dock back"
            aria-label="Dock chat back"
            data-testid={`${testId}-close`}
            onClick={onClose}
          />
          <span className="popout-dot y" aria-hidden="true" />
          <span className="popout-dot g" aria-hidden="true" />
        </div>
        <div className="popout-title mono">
          <span className="dim">{titlePrefix}</span>
          {titleAccent && (
            <>
              {' '}
              <span className="accent">{titleAccent}</span>
            </>
          )}
        </div>
        <div className="popout-right mono dim">
          <span className="popout-pin" aria-hidden="true">◈</span>
          {' '}
          {alwaysOnTopLabel}
        </div>
      </div>
      {children}
    </div>
  );
}
