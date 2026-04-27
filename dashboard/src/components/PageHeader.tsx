/**
 * PageHeader — title bar that crowns each screen. PR-2 ships only the
 * top-level chrome (title + theme/density controls); per-page content
 * lands in PR-4/PR-5.
 */
import { usePrefs, type Density } from '../store/prefs';

interface PageHeaderProps {
  title?: string;
  subtitle?: string;
}

const DENSITY_VALUES: Density[] = [4, 5, 6, 7, 8, 9];

export function PageHeader({ title = 'Maestro', subtitle }: PageHeaderProps) {
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const toggleTheme = usePrefs((s) => s.toggleTheme);
  const setDensity = usePrefs((s) => s.setDensity);
  return (
    <header
      data-testid="page-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--density-pad) calc(var(--density-pad) * 1.6)',
        borderBottom: '1px solid var(--rule)',
        background: 'var(--bg)',
      }}
    >
      <div>
        <h1 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 22, fontWeight: 400 }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ margin: 0, color: 'var(--dim)', fontSize: 'var(--density-fs-sm)' }}>{subtitle}</p>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--density-gap)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dim)' }}>
          <span style={{ fontSize: 'var(--density-fs-sm)' }}>Density</span>
          <input
            type="range"
            min={4}
            max={9}
            step={1}
            value={density}
            data-testid="settings-density-slider"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (DENSITY_VALUES.includes(next as Density)) setDensity(next as Density);
            }}
          />
          <span className="num" style={{ minWidth: 14, textAlign: 'right' }}>
            {density}
          </span>
        </label>
        <button
          type="button"
          data-testid="settings-theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          style={{
            padding: 'var(--density-pad-y) var(--density-pad)',
            background: 'var(--bg-2)',
            color: 'var(--text)',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            cursor: 'pointer',
            fontFamily: 'var(--ff-ui)',
            fontSize: 'var(--density-fs-sm)',
          }}
        >
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </div>
    </header>
  );
}
