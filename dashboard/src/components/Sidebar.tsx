/**
 * Sidebar — left navigation rail. PR-A1 of #389.
 *
 * Per audit rev 4 C5 (width = 244px LOCKED, `components.css` `.app-shell`
 * grid template). Two stacked sections + maestro identity + connection
 * footer:
 *
 *   - Brandmark slot (sidebar-brand)
 *   - ENSEMBLES section (sidebar-section): live ensemble list +
 *     "+ New ensemble…" row. Active row mirrors the URL `/ensemble/:id`.
 *   - LIBRARY section (sidebar-section): 6 NavLink rows
 *     (Overview / Loadouts / Player types / Schedules / Hosts / Settings).
 *   - Maestro identity row (sidebar-maestro): MaestroMark + operator label.
 *   - Footer (sidebar-footer): connection status + version.
 *
 * Tablet collapse (≤900px): brand-word, kicker, footer text, ensemble
 * meta, trailing `↵` glyph, and library labels all hide via the
 * `.app-shell { grid-template-columns: 64px 1fr }` rule + sibling
 * display:none rules in components.css. Only the brandmark icon, the
 * `.er-dot` per ensemble, nav-icons, and maestro mark stay visible.
 * (The `.er-initial` 32×32 letter-tile + presence-dot enhancement is a
 * v2/v3 bundle addition not yet in the canonical handoff stylesheet —
 * deferred to a future components.css re-sync.)
 *
 * Phone (≤520px): the sidebar is hidden via `.sidebar { display: none }`;
 * `PhoneAppBar` + `PhoneTabBar` take over (stubbed in PR-A1, fleshed
 * out in PR-A1m).
 *
 * Source: `workspace.jsx:122-195` (Sidebar JSX) + `screens.jsx:8`
 * (callsite) + components.css `.sidebar*` / `.ensemble-row*` /
 * `.nav-row*` / `.sidebar-footer` / `.sidebar-maestro`.
 */
import { Link, NavLink, useLocation, useParams } from 'react-router-dom';
import { Brandmark } from './Brandmark';
import { MaestroMark } from './MaestroMark';
import { useEnsembleList } from '../lib/queries';

interface NavItem {
  id: 'overview' | 'loadouts' | 'types' | 'schedules' | 'hosts' | 'settings';
  /** Mono glyph used as the row's icon — readable when the rail collapses. */
  icon: string;
  label: string;
  /** Path inside the dashboard router (basename `/dashboard`). */
  to: string;
}

/** Library section nav items, in display order. Ids match audit; paths
 * match `src/router.tsx`. Glyphs come from `workspace.jsx:160-165`. */
const LIBRARY_NAV: ReadonlyArray<NavItem> = [
  { id: 'overview', icon: '◇', label: 'Overview', to: '/' },
  { id: 'loadouts', icon: '≡', label: 'Loadouts', to: '/loadouts' },
  { id: 'types', icon: '♪', label: 'Player types', to: '/player-types' },
  { id: 'schedules', icon: '⧗', label: 'Schedules', to: '/schedules' },
  { id: 'hosts', icon: '⌂', label: 'Hosts', to: '/hosts' },
  { id: 'settings', icon: '⚙', label: 'Settings', to: '/settings' },
] as const;

export function Sidebar() {
  const list = useEnsembleList();
  const ensembles = list.data ?? [];
  // The active ensemble is the one in the current URL: `/ensemble/:id`.
  // `useParams()` resolves only matched params; outside `/ensemble/:id`
  // it returns `{}`, so `activeEnsemble` is `undefined` and no row gets
  // `.is-active`.
  const { id } = useParams<{ id?: string }>();
  const activeEnsemble = id;
  const location = useLocation();
  const onWorkspaceRoute = location.pathname.startsWith('/ensemble/');
  // Per design: Ensembles kicker shows "running" count = ensembles with
  // ≥1 player, NOT the total count.
  const runningCount = ensembles.filter((e) => e.playerCount > 0).length;

  return (
    <aside className="sidebar" data-testid="sidebar" aria-label="Main navigation">
      <div className="sidebar-brand">
        <Brandmark size="md" running={false} />
      </div>

      <div className="sidebar-section" data-testid="sidebar-section-ensembles">
        <div className="sidebar-kicker">
          <span>Ensembles</span>
          <span className="count">{runningCount} running</span>
        </div>
        {ensembles.length === 0 ? (
          <div
            className="dim"
            data-testid="sidebar-ensembles-empty"
            style={{
              padding: '6px 12px',
              fontFamily: 'var(--ff-mono)',
              fontSize: 11,
            }}
          >
            No ensembles
          </div>
        ) : (
          ensembles.map((e) => (
            <Link
              key={e.name}
              to={`/ensemble/${encodeURIComponent(e.name)}`}
              data-testid={`sidebar-ensemble-${e.name}`}
              className={[
                'ensemble-row',
                activeEnsemble === e.name ? 'is-active' : '',
                e.playerCount > 0 ? 'has-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ textDecoration: 'none' }}
            >
              <span className="er-dot" />
              <span className="col" style={{ gap: 0 }}>
                <span className="er-name">{e.name}</span>
                <span className="er-meta mono">
                  {e.playerCount} {e.playerCount === 1 ? 'player' : 'players'}
                </span>
              </span>
              <span className="mono dim" style={{ fontSize: 10 }}>
                ↵
              </span>
            </Link>
          ))
        )}
        <Link
          to="/create-ensemble"
          data-testid="sidebar-new-ensemble"
          className="ensemble-row ensemble-row--new"
          style={{ marginTop: 4, color: 'var(--accent)', textDecoration: 'none' }}
        >
          <span className="icon-g" style={{ color: 'var(--accent)' }}>
            +
          </span>
          <span className="er-name">New ensemble…</span>
          <span />
        </Link>
      </div>

      <div className="sidebar-section" data-testid="sidebar-section-library">
        <div className="sidebar-kicker">
          <span>Library</span>
        </div>
        {LIBRARY_NAV.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            end={item.to === '/'}
            data-testid={`nav-${item.id}`}
            className={({ isActive }) => {
              // Suppress Overview's "active" highlight while inside a
              // workspace route — Overview's `to="/"` with `end` already
              // handles this, but double-belt for safety.
              const lit = isActive && !(item.id === 'overview' && onWorkspaceRoute);
              return 'nav-row' + (lit ? ' is-active' : '');
            }}
            style={{ textDecoration: 'none' }}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidebar-maestro" title="You — the maestro">
        <MaestroMark size={18} />
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            lineHeight: 1.15,
            marginLeft: 8,
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ fontFamily: 'var(--ff-display)', fontSize: 14, color: 'var(--text)' }}>
            maestro
          </span>
          <span className="mono dim" style={{ fontSize: 10 }}>
            operator
          </span>
        </span>
      </div>

      <div className="sidebar-footer">
        <span>
          <span className="conn-ok">●</span> localhost:7233
        </span>
        <span data-testid="sidebar-version">v0.28</span>
      </div>
    </aside>
  );
}
