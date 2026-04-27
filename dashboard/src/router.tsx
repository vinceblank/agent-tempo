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
        path: 'ensemble/:id',
        element: (
          <PlaceholderScreen testId="screen-workspace" title="Workspace" arrivingIn="PR-5" />
        ),
      },
      {
        path: 'ensemble/:id/player/:playerId',
        element: (
          <PlaceholderScreen
            testId="screen-player-detail"
            title="Player Detail"
            arrivingIn="PR-5"
          />
        ),
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
