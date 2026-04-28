/**
 * AppShell — the persistent outer chrome. PR-C1 of #389.
 *
 * Layout (per audit, components.css `.app-shell` rules):
 *
 *   ┌──────────────────────────────────────────────────────┐  ← .artboard-body
 *   │ ┌────────┬───────────────────────────────────────┐  │     (container)
 *   │ │Sidebar │ PhoneAppBar (≤520px only)             │  │
 *   │ │  244px │ ─────────────────────────────────────  │  │
 *   │ │  →64px │ <main> rendering routed <Outlet />     │  │
 *   │ │  →hide │                                        │  │
 *   │ │        │ ─────────────────────────────────────  │  │
 *   │ │        │ PhoneTabBar (≤520px only)             │  │
 *   │ └────────┴───────────────────────────────────────┘  │
 *   └──────────────────────────────────────────────────────┘
 *
 * The outermost `.artboard-body` element is what the `@container artboard
 * (max-width: …)` rules in components.css are scoped against.
 *
 * Header policy:
 * - Workspace (`/ensemble/:id`) renders its own composite PageHeader inside
 *   `<main>` — see `screens/Workspace.tsx`. This shell suppresses the
 *   default PageHeader on those routes so we don't double-stack a
 *   "Maestro" title above the workspace's `ensemble / @name` breadcrumb.
 *   The `app-shell--workspace` class is also applied so the phone
 *   breakpoint's `.app-shell--workspace .page-header { display: none }`
 *   rule (components.css line 1264-1267) targets the right element.
 * - All other routes get the default PageHeader (Overview, Settings,
 *   Hosts, etc.) — keeps the operator chrome (density slider + theme
 *   toggle in PageHeader's DefaultActions) reachable until SettingsSheet
 *   becomes its sole home in PR-G.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { PageHeader } from './PageHeader';
import { PhoneAppBar } from './PhoneAppBar';
import { PhoneTabBar } from './PhoneTabBar';

interface AppShellProps {
  children?: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const isWorkspace = location.pathname.startsWith('/ensemble/');
  return (
    <div className="artboard-body">
      <div
        className={'app-shell' + (isWorkspace ? ' app-shell--workspace' : '')}
        data-testid="app-shell"
      >
        <Sidebar />
        <PhoneAppBar />
        <main className="main" data-testid="app-shell-main">
          {isWorkspace ? (
            // Workspace renders its own composite PageHeader + page-tempo +
            // workspace grid. AppShell stays out of the way.
            children
          ) : (
            <>
              <PageHeader title="Maestro" />
              <div
                className="page-pad scroll"
                data-testid="app-shell-content"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--density-gap)',
                }}
              >
                {children}
              </div>
            </>
          )}
        </main>
        <PhoneTabBar />
      </div>
    </div>
  );
}
