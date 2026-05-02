/**
 * App — root component. Wires `QueryClientProvider` (TanStack Query)
 * around a `RouterProvider`. Tests pass an alternate router (memory
 * mode) via the optional `router` prop; production builds default to
 * the browser router under `/dashboard`.
 *
 * `logEvent('app-mounted', …)` fires once on mount so the conductor's
 * autonomous validation can confirm the SPA started cleanly via
 * `mcp__claude-in-chrome__read_console_messages`.
 *
 * Notification surfaces:
 *   - Incoming chat from non-active ensembles renders as a toast
 *     stack via `<NotificationProvider>` mounted inside the router
 *     tree (see `router.tsx`'s `ShellLayout`).
 *   - Per-action mutation feedback lives inline next to where the
 *     action originated — `<ComposerStatus>` above the chat composer
 *     for cue / slash failures, the `<CreateEnsembleError>` row in
 *     the wizard's review step for create failures, etc. The PR-2
 *     Sonner removal retired the generic toast layer this component
 *     previously hosted.
 */
import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { createDashboardBrowserRouter } from './router';
import { logEvent } from './lib/log';
import { usePairTokenConsume } from './lib/pair';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export interface AppProps {
  /** Override the router (tests use a memory router). */
  router?: ReturnType<typeof createBrowserRouter>;
}

export function App({ router }: AppProps = {}) {
  const activeRouter = useMemo(() => router ?? createDashboardBrowserRouter(), [router]);
  // PR-8 of #340: the consume hook runs once on mount. When `?pair=`
  // is present in the URL it strips the token (replaceState BEFORE
  // bearer storage — risk #16) and exchanges it for a daemon bearer
  // via `GET /dashboard/api/pair/:token`. Idle no-op when the URL
  // has no token, so the call is safe to leave unconditionally
  // mounted at the top of the tree.
  usePairTokenConsume();
  useEffect(() => {
    logEvent('app-mounted', { pr: 'pr-8', issue: '#340' });
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={activeRouter} />
    </QueryClientProvider>
  );
}
