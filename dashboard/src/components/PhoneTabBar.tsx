/**
 * PhoneTabBar — bottom 4-tab navigation shown at viewports ≤520px.
 * STUBBED in PR-A1.
 *
 * Full implementation lands in PR-A1m: 4 tabs (Now / Ensembles / Library /
 * Settings) with SVG icons, mono labels, accent indicator above the
 * active tab. This stub renders the className wrapper + label-only tabs
 * so AppShell's mobile grid template (`auto 1fr 64px`) has its third row.
 *
 * Hidden by default on desktop/tablet (components.css line 1070-1071):
 *   `.phone-appbar, .phone-tabbar { display: none; }`
 * — so the stub is an inert no-op above 520px.
 *
 * Source: `workspace.jsx:14-41` (full PhoneTabBar with NavLink wiring +
 * navToTab mapping ships in A1m).
 */
import { NavLink } from 'react-router-dom';

const TABS = [
  { k: 'workspace', label: 'Now', to: '/' },
  { k: 'overview', label: 'Ensembles', to: '/' },
  { k: 'library', label: 'Library', to: '/loadouts' },
  { k: 'settings', label: 'Settings', to: '/settings' },
] as const;

export function PhoneTabBar() {
  return (
    <nav className="phone-tabbar" data-testid="phone-tabbar" aria-label="Mobile primary navigation">
      {TABS.map((t) => (
        <NavLink
          key={t.k}
          to={t.to}
          end={t.to === '/'}
          className={({ isActive }) => 'phone-tab' + (isActive ? ' is-active' : '')}
          data-testid={`phone-tab-${t.k}`}
        >
          <span className="phone-tab-label">{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
