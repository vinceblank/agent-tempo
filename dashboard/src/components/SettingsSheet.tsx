/**
 * SettingsSheet — flat settings surface routed at `/dashboard/settings`.
 *
 * **Why a "Sheet" name when this PR ships a plain page**: the architect's
 * design (`docs/design/340-web-dashboard.md` § 6) names this Screen J
 * "Settings" and lists shadcn `Sheet` (a slide-over drawer) as the
 * eventual presentation. PR-6 ships a routable page with the
 * design-token bindings; PR-7+ swaps in the shadcn `Sheet` component
 * once shadcn lands (architect decided shadcn install ships with the
 * first PR that needs Dialog/Sheet/Toast — likely PR-7's safe-write
 * confirmations). The component name reserves the slot.
 *
 * Bindings: theme toggle, density 4–9 slider, accent picker. All wired
 * to the existing Zustand `usePrefs` store from PR-2 — Sidebar and
 * PageHeader keep their inline mini-controls; this is the full surface.
 */
import { usePrefs, type Accent, type Density, type Theme } from '../store/prefs';

// The prefs store (`src/store/prefs.ts`) already emits
// `prefs-theme-set` / `prefs-density-set` / `prefs-accent-set` log
// lines on every mutation. SettingsSheet doesn't double-log here —
// the conductor's autonomous validation greps `prefs-*-set` for
// settings telemetry.

const ACCENT_LABELS: Record<Accent, string> = {
  terracotta: 'Terracotta',
  sage: 'Sage',
  plum: 'Plum',
};

const DENSITY_VALUES: Density[] = [4, 5, 6, 7, 8, 9];

export function SettingsSheet() {
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const accent = usePrefs((s) => s.accent);
  const setTheme = usePrefs((s) => s.setTheme);
  const setDensity = usePrefs((s) => s.setDensity);
  const setAccent = usePrefs((s) => s.setAccent);

  return (
    <section
      data-testid="settings-sheet"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        padding: 'var(--density-pad)',
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
        maxWidth: 480,
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--ff-display)',
            fontSize: 22,
            fontWeight: 400,
          }}
        >
          Settings
        </h1>
        <p className="dim" style={{ marginTop: 4, fontSize: 13 }}>
          Theme, density, and accent persist to <code>localStorage</code>.
        </p>
      </header>

      <SettingRow label="Theme" htmlFor="settings-theme">
        <select
          id="settings-theme"
          data-testid="settings-theme-select"
          value={theme}
          onChange={(e) => setTheme(e.target.value as Theme)}
          style={selectStyle}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </SettingRow>

      <SettingRow label={`Density: ${density}`} htmlFor="settings-density">
        <input
          id="settings-density"
          data-testid="settings-density-range"
          type="range"
          min={DENSITY_VALUES[0]}
          max={DENSITY_VALUES[DENSITY_VALUES.length - 1]}
          step={1}
          value={density}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (next >= 4 && next <= 9) setDensity(next as Density);
          }}
        />
      </SettingRow>

      <SettingRow label="Accent" htmlFor="settings-accent">
        <select
          id="settings-accent"
          data-testid="settings-accent-select"
          value={accent}
          onChange={(e) => setAccent(e.target.value as Accent)}
          style={selectStyle}
        >
          {(Object.keys(ACCENT_LABELS) as Accent[]).map((a) => (
            <option key={a} value={a}>{ACCENT_LABELS[a]}</option>
          ))}
        </select>
      </SettingRow>
    </section>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  color: 'var(--text)',
  border: '1px solid var(--rule)',
  borderRadius: 6,
  padding: '6px 10px',
  fontFamily: 'var(--ff-display)',
  fontSize: 14,
  minWidth: 160,
};

interface SettingRowProps {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}

function SettingRow({ label, htmlFor, children }: SettingRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <label htmlFor={htmlFor} style={{ fontFamily: 'var(--ff-display)', fontSize: 14 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
