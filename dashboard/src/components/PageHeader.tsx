/**
 * PageHeader — title bar that crowns each screen. PR-A1 of #389.
 *
 * Per audit rev 4 C4 (italic discipline corrected). Composite layout:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ <prefix mono>/  <title display>@accent  <pills…>   <actions>│
 *   │ <subtitle dim>                                               │
 *   └─────────────────────────────────────────────────────────────┘
 *
 *   - `.page-title` is **serif display NON-italic** (audit C4).
 *   - Wrap a single accent word in `<em>` for italic emphasis when a
 *     hero verb is desired (e.g. `@my-band is <em>listening</em>`).
 *     Never italicize the whole title.
 *   - `prefix` (e.g. "ensemble /") renders mono-tinted.
 *   - `accent` (e.g. "@my-band") renders inside the title with terracotta `@`.
 *   - `pills` slot inside `.page-pills` for status chips.
 *   - `actions` slot inside `.page-actions` (right-aligned).
 *   - When `actions` is omitted, render the operator chrome (theme +
 *     density controls) so the testid-coverage test (which expects
 *     `settings-density-slider` + `settings-theme-toggle` in the AppShell
 *     render) keeps passing. Screens that supply their own `actions`
 *     get those instead — the operator chrome moves to the Settings page
 *     route in PR-G.
 *
 * Source: `workspace.jsx:273-314` (Workspace's PageHeader composition) +
 * `screens.jsx:11-27` (Overview's PageHeader composition) +
 * components.css `.page-header` / `.page-title*` / `.page-pills*` /
 * `.page-pill*` / `.page-actions` / `.page-subtitle`.
 */
import type { ReactNode } from 'react';
import { usePrefs, type Density } from '../store/prefs';

interface PageHeaderProps {
  /** Display-serif title text. NON-italic per audit C4. */
  title?: ReactNode;
  /** Mono prefix (e.g. "ensemble /") rendered before the title. */
  prefix?: ReactNode;
  /** Accent fragment shown inside the title (e.g. "@my-band"). The
   * leading `@` is rendered in terracotta via `.page-title .at`. */
  accent?: string;
  /** Status pills slot — typically `<StatusPill … />` instances. */
  pills?: ReactNode;
  /** Right-aligned actions slot (buttons, toggles). */
  actions?: ReactNode;
  /** Subtitle row below the title (display-serif paragraph). */
  subtitle?: ReactNode;
}

const DENSITY_VALUES: ReadonlyArray<Density> = [4, 5, 6, 7, 8, 9];

export function PageHeader({
  title = 'Maestro',
  prefix,
  accent,
  pills,
  actions,
  subtitle,
}: PageHeaderProps) {
  return (
    <header className="page-header" data-testid="page-header">
      <div>
        <div className="page-title-row">
          <h1 className="page-title">
            {prefix && <span className="prefix mono">{prefix}</span>}
            {title}
            {accent && (
              <>
                <span className="at">@</span>
                {accent.startsWith('@') ? accent.slice(1) : accent}
              </>
            )}
          </h1>
          {pills && <div className="page-pills">{pills}</div>}
        </div>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      <div className="page-actions">{actions ?? <DefaultActions />}</div>
    </header>
  );
}

/**
 * Default page-actions slot: density slider + theme toggle.
 *
 * Carries `data-testid="settings-density-slider"` +
 * `data-testid="settings-theme-toggle"` because the testid-coverage
 * test (`tests/testid-coverage.test.tsx:73-74`) expects both to be
 * findable in the AppShell render. Screens that supply their own
 * `actions` prop replace this slot and the operator controls move
 * to the Settings page route — which is the destination per Q5
 * (Settings = sidebar route in PR-G).
 */
function DefaultActions() {
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const toggleTheme = usePrefs((s) => s.toggleTheme);
  const setDensity = usePrefs((s) => s.setDensity);
  return (
    <>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--dim)',
          fontSize: 'var(--density-fs-sm)',
        }}
      >
        <span>Density</span>
        <input
          type="range"
          min={4}
          max={9}
          step={1}
          value={density}
          data-testid="settings-density-slider"
          aria-label="Density"
          onChange={(e) => {
            const next = Number(e.target.value);
            if (DENSITY_VALUES.includes(next as Density)) setDensity(next as Density);
          }}
        />
        <span className="num mono" style={{ minWidth: 14, textAlign: 'right' }}>
          {density}
        </span>
      </label>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        data-testid="settings-theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '☀ Light' : '☾ Dark'}
      </button>
    </>
  );
}
