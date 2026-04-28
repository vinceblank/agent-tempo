/**
 * PhoneAppBar — top app bar shown at viewports ≤520px. STUBBED in PR-A1.
 *
 * The full mobile shell mechanics (switch-ensemble menu, status row,
 * action button toggling roster slide-in) ship in PR-A1m (eng's PR).
 * This stub renders the className wrapper so the AppShell layout grid
 * places it correctly when components.css's phone-breakpoint rules
 * fire. Until A1m fills it in, the bar shows the brandmark only.
 *
 * Hidden by default on desktop/tablet (components.css line 1070-1071):
 *   `.phone-appbar, .phone-tabbar { display: none; }`
 * — so this stub is an inert no-op above 520px.
 *
 * Source: `workspace.jsx:43-76` (full PhoneAppBar to be implemented in A1m).
 */

interface PhoneAppBarProps {
  /** Active ensemble name (used as the centered title). PR-A1m wires the
   * full kicker + status row + menu/action buttons. */
  ensemble?: string;
}

export function PhoneAppBar({ ensemble }: PhoneAppBarProps) {
  return (
    <header className="phone-appbar" data-testid="phone-appbar" aria-label="Mobile top bar">
      <div className="phone-appbar-row">
        <div className="phone-appbar-title">
          {ensemble ? (
            <span className="phone-appbar-name">
              <span className="at">@</span>
              {ensemble}
            </span>
          ) : (
            // No-op title slot until PR-A1m wires the switcher menu +
            // ensemble kicker. We deliberately don't render Brandmark
            // here — the canonical brandmark placement is in Sidebar
            // and the testid-coverage test asserts a single instance.
            <span className="phone-appbar-name dim" aria-hidden="true">
              &nbsp;
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
