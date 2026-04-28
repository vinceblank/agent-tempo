/**
 * PhoneTabBar — bottom 4-tab navigation shown at viewports ≤520px.
 * PR-A1m of #389.
 *
 * Tabs: Now / Ensembles / Library / Settings. Each tab has an SVG icon
 * + mono label. The active tab gets a terracotta indicator above it.
 *
 * Active state mirrors the URL through a route → tab map:
 *   - `/ensemble/:id`                                      → Now
 *   - `/`                                                  → Ensembles
 *   - `/loadouts`, `/player-types`, `/schedules`, `/hosts` → Library
 *   - `/settings`                                          → Settings
 *
 * Tab clicks navigate to a single landing route per tab (Library always
 * lands on `/loadouts`, etc.). The "Now" tab's landing depends on the
 * current URL: if the user is already inside `/ensemble/:id`, it sticks
 * to that ensemble; otherwise it falls back to Overview (`/`) — the
 * design assumes a workspace context, but in this rebuild we don't pin
 * a "default ensemble" so falling to Overview is the conservative no-op.
 *
 * Hidden above 520px; the sidebar takes over there.
 */
import type { ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

type PhoneTabKey = 'workspace' | 'overview' | 'library' | 'settings';

interface PhoneTab {
  k: PhoneTabKey;
  label: string;
  icon: ReactNode;
}

const TAB_ICONS: Record<PhoneTabKey, ReactNode> = {
  workspace: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h10M4 18h16" />
    </svg>
  ),
  overview: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="3" y="15" width="7" height="6" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
    </svg>
  ),
  library: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5v14M9 5v14M14 5l5 14M19 5l-5 14" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  ),
};

const TABS: ReadonlyArray<PhoneTab> = [
  { k: 'workspace', label: 'Now', icon: TAB_ICONS.workspace },
  { k: 'overview', label: 'Ensembles', icon: TAB_ICONS.overview },
  { k: 'library', label: 'Library', icon: TAB_ICONS.library },
  { k: 'settings', label: 'Settings', icon: TAB_ICONS.settings },
] as const;

const LIBRARY_PREFIXES = ['/loadouts', '/player-types', '/schedules', '/hosts'] as const;

/** Map current URL → active tab key. Mirrors workspace.jsx:23 `navToTab`. */
function activeTabFromPath(pathname: string, hasEnsembleParam: boolean): PhoneTabKey {
  if (hasEnsembleParam) return 'workspace';
  if (pathname.startsWith('/settings')) return 'settings';
  if (LIBRARY_PREFIXES.some((p) => pathname.startsWith(p))) return 'library';
  // Everything else (`/`, `/create-ensemble`, `/recruit`) groups under Ensembles.
  return 'overview';
}

export function PhoneTabBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: ensembleId } = useParams<{ id?: string }>();
  const activeTab = activeTabFromPath(location.pathname, Boolean(ensembleId));

  const onTab = (k: PhoneTabKey) => {
    switch (k) {
      case 'workspace':
        // Sticks to the current ensemble if one is open; otherwise falls
        // back to Overview (the rebuild has no "default ensemble" yet).
        navigate(ensembleId ? `/ensemble/${encodeURIComponent(ensembleId)}` : '/');
        return;
      case 'overview':
        navigate('/');
        return;
      case 'library':
        navigate('/loadouts');
        return;
      case 'settings':
        navigate('/settings');
        return;
    }
  };

  return (
    <nav className="phone-tabbar" data-testid="phone-tabbar" role="navigation" aria-label="Mobile primary navigation">
      {TABS.map((t) => {
        const isActive = t.k === activeTab;
        return (
          <button
            key={t.k}
            type="button"
            className={'phone-tab' + (isActive ? ' is-active' : '')}
            data-testid={`phone-tab-${t.k}`}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onTab(t.k)}
          >
            <span className="phone-tab-icon">{t.icon}</span>
            <span className="phone-tab-label">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
