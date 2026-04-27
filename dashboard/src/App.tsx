/**
 * App — root component. Wires `QueryClientProvider` (TanStack Query)
 * around a `RouterProvider`. Tests pass an alternate router (memory
 * mode) via the optional `router` prop; production builds default to
 * the browser router under `/dashboard`.
 *
 * `logEvent('app-mounted', …)` fires once on mount so the conductor's
 * autonomous validation can confirm the SPA started cleanly via
 * `mcp__claude-in-chrome__read_console_messages`.
 */
import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { createDashboardBrowserRouter } from './router';
import { logEvent } from './lib/log';

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
  useEffect(() => {
    logEvent('app-mounted', { pr: 'pr-4', issue: '#340' });
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={activeRouter} />
      {/*
        Toaster — Sonner mount point, single instance at the root.
        Custom toasts (`toast.custom`) carry their own `data-testid` +
        `role="alert"` (see `lib/toast.tsx`). Sonner v1.x doesn't
        forward arbitrary `data-*` props on its wrapper, so the
        outer `<div data-testid="toaster">` gives the conductor's
        autonomous validator a stable hook into "the toast layer".
      */}
      <div data-testid="toaster">
        <Toaster position="bottom-right" toastOptions={{ unstyled: true }} />
      </div>
    </QueryClientProvider>
  );
}
