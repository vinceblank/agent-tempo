/**
 * React Router 7 configuration — initial scaffolding in PR-4, expanded
 * to the full read-only surface in PR-6.
 *
 * The router is mounted at `/dashboard` (basename) so deep-links land
 * correctly when the daemon serves the SPA fallback. Routes:
 *
 *   /                                          → Overview         (PR-4)
 *   /ensemble/:id                              → Workspace        (placeholder, PR-5)
 *   /ensemble/:id/player/:playerId             → PlayerDetail     (placeholder, PR-5)
 *   /create-ensemble                           → CreateEnsemble   (PR-6, submit disabled)
 *   /recruit                                   → Recruit wizard   (PR-6, submit disabled)
 *   /hosts                                     → Hosts            (PR-6)
 *   /schedules                                 → Schedules        (PR-6)
 *   /loadouts                                  → Loadouts         (PR-6, endpoint stub)
 *   /player-types                              → PlayerTypes      (PR-6, endpoint stub)
 *   /settings                                  → SettingsSheet    (PR-6)
 *
 * Architect's deep-linking principle (testability addendum): every URL
 * directly addresses a screen so the conductor's autonomous validation
 * can navigate via `mcp__claude-in-chrome__navigate` without UI clicks.
 *
 * The route table is exported as a value (not a constructed router) so
 * tests can wrap it in `createMemoryRouter` while production wraps it
 * in `createBrowserRouter` — same routes, two transports.
 *
 * Lead's PR-5 fills in the Workspace + PlayerDetail elements; this
 * file's `PlaceholderScreen` rows for those two routes are the
 * coordination point. Whichever PR merges first leaves the other
 * tweaking just those two route entries.
 */
import {
  Outlet,
  Navigate,
  createBrowserRouter,
  createMemoryRouter,
  type RouteObject,
} from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { SettingsSheet } from './components/SettingsSheet';
import { CreateEnsemble } from './screens/CreateEnsemble';
import { Hosts } from './screens/Hosts';
import { Loadouts } from './screens/Loadouts';
import { Overview } from './screens/Overview';
import { Workspace } from './screens/Workspace';
import { PlayerDetail } from './screens/PlayerDetail';
import { PlaceholderScreen } from './screens/Placeholder';
import { PlayerTypes } from './screens/PlayerTypes';
import { Recruit } from './screens/Recruit';
import { Schedules } from './screens/Schedules';

/** Layout shell that hosts the routed content via `<Outlet />`. */
function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/** Route table — shared by the production browser router and the test memory router. */
export const DASHBOARD_ROUTES: RouteObject[] = [
  {
    path: '/',
    element: <ShellLayout />,
    children: [
      { index: true, element: <Overview /> },
      {
        // Workspace renders the chat + roster as a parent route. The
        // nested `/player/:playerId` segment overlays the PlayerDetail
        // panel via React Router's `<Outlet />` so deep-linking
        // straight to the panel still mounts the workspace under it.
        path: 'ensemble/:id',
        element: <Workspace />,
        children: [
          {
            path: 'player/:playerId',
            element: <PlayerDetail />,
          },
        ],
      },
      { path: 'create-ensemble', element: <CreateEnsemble /> },
      { path: 'recruit', element: <Recruit /> },
      { path: 'hosts', element: <Hosts /> },
      { path: 'schedules', element: <Schedules /> },
      { path: 'loadouts', element: <Loadouts /> },
      { path: 'player-types', element: <PlayerTypes /> },
      { path: 'settings', element: <SettingsSheet /> },
      // Catch-all: redirect to overview for unknown paths inside the dashboard.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

/** Production router — mounted under `/dashboard` (the daemon's static path). */
export function createDashboardBrowserRouter() {
  return createBrowserRouter(DASHBOARD_ROUTES, { basename: '/dashboard' });
}

/** Test router — used by component tests that don't have a real `window.location`. */
export function createDashboardMemoryRouter(initialEntries: string[] = ['/']) {
  return createMemoryRouter(DASHBOARD_ROUTES, { initialEntries });
}

/**
 * Pull `playerId` out of a workspace pathname like
 * `/ensemble/:id/player/:playerId`. Centralised so the route shape
 * lives in one place — `<Workspace>` reads its own `useLocation()`
 * pathname and runs this helper to surface the selected row in the
 * sidebar. Returns `undefined` when the path isn't a player drilldown.
 */
export function selectedPlayerIdFromPath(pathname: string): string | undefined {
  const m = /\/ensemble\/[^/]+\/player\/([^/]+)/.exec(pathname);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
