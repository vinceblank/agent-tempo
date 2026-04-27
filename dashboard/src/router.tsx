/**
 * React Router 7 configuration — PR-4 of #340.
 *
 * The router is mounted at `/dashboard` (basename) so deep-links land
 * correctly when the daemon serves the SPA fallback. Routes:
 *
 *   /                                          → Overview (real, PR-4)
 *   /ensemble/:id                              → Workspace (placeholder, PR-5)
 *   /ensemble/:id/player/:playerId             → PlayerDetail (placeholder, PR-5)
 *   /hosts                                     → Hosts (placeholder, PR-6)
 *   /loadouts                                  → Loadouts (placeholder, PR-6)
 *   /player-types                              → PlayerTypes (placeholder, PR-6)
 *
 * Architect's deep-linking principle (testability addendum): every URL
 * directly addresses a screen so the conductor's autonomous validation
 * can navigate via `mcp__claude-in-chrome__navigate` without UI clicks.
 *
 * The route table is exported as a value (not a constructed router) so
 * tests can wrap it in `createMemoryRouter` while production wraps it
 * in `createBrowserRouter` — same routes, two transports.
 */
import {
  Outlet,
  Navigate,
  createBrowserRouter,
  createMemoryRouter,
  type RouteObject,
} from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Overview } from './screens/Overview';
import { PlaceholderScreen } from './screens/Placeholder';

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
      {
        path: 'hosts',
        element: <PlaceholderScreen testId="screen-hosts" title="Hosts" arrivingIn="PR-6" />,
      },
      {
        path: 'loadouts',
        element: <PlaceholderScreen testId="screen-loadouts" title="Loadouts" arrivingIn="PR-6" />,
      },
      {
        path: 'player-types',
        element: (
          <PlaceholderScreen testId="screen-player-types" title="Player Types" arrivingIn="PR-6" />
        ),
      },
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
