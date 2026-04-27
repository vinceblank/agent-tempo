/**
 * Sidebar — navigation rail. PR-2 ships placeholder rows; the live
 * navigation (with `react-router` `<NavLink>` and active-state styling)
 * lands in PR-4 alongside the routes config and the read-only screens
 * in PR-5.
 */
import { Brandmark } from './Brandmark';

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'players', label: 'Players' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'lineups', label: 'Lineups' },
  { id: 'hosts', label: 'Hosts' },
  { id: 'settings', label: 'Settings' },
] as const;

export function Sidebar() {
  return (
    <nav
      data-testid="sidebar"
      aria-label="Main navigation"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--density-gap)',
        padding: 'var(--density-pad)',
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--rule)',
        minWidth: 220,
      }}
    >
      <div style={{ paddingBottom: 'var(--density-pad-y)', borderBottom: '1px solid var(--rule)' }}>
        <Brandmark size="md" />
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              data-testid={`nav-${item.id}`}
              disabled
              title="Navigation lights up in PR-4 of #340"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: 'var(--density-pad-y) var(--density-pad)',
                background: 'transparent',
                color: 'var(--dim)',
                border: 0,
                borderRadius: 6,
                fontFamily: 'var(--ff-ui)',
                fontSize: 'var(--density-fs)',
                cursor: 'not-allowed',
              }}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
