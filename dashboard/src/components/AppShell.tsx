/**
 * AppShell — the persistent outer chrome. PR-A1 of #389.
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
 * (max-width: …)` rules in components.css are scoped against. Putting it
 * here (rather than at `<html>`) keeps the dashboard's responsive grid
 * driven by its own width rather than the viewport's, so future
 * embedding scenarios (split-pane dev tooling, picture-in-picture)
 * flow correctly.
 *
 * Mobile primitives (PhoneAppBar / PhoneTabBar) are stubbed in PR-A1 —
 * they render their className wrappers so the grid template
 * `auto 1fr 64px` lays out correctly when the ≤520px breakpoint fires.
 * PR-A1m fills in the actual content (switcher, status row, tabs).
 *
 * The hardcoded PageHeader at the top of `<main>` is the operator
 * chrome — its default-actions slot supplies the density slider + theme
 * toggle. Per audit lines 893-894 ("primitive upgrades that the screens
 * see incrementally"), individual screens (Workspace, Overview, etc.)
 * will pass their own composite `prefix`/`accent`/`pills`/`actions` in
 * later PRs (PR-B, PR-C1) — for now this AppShell-level header sits
 * above the routed content as a stable surface.
 */
import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { PageHeader } from './PageHeader';
import { PhoneAppBar } from './PhoneAppBar';
import { PhoneTabBar } from './PhoneTabBar';

interface AppShellProps {
  children?: ReactNode;
  /** Passed through to the workspace-shell modifier so the phone
   * breakpoint hides the page header inside `/ensemble/:id` (per
   * components.css line 1264-1267). Default false; the Workspace
   * screen flips this to `true` when it adopts AppShell wrapping in
   * PR-C1. */
  isWorkspace?: boolean;
}

export function AppShell({ children, isWorkspace = false }: AppShellProps) {
  return (
    <div className="artboard-body">
      <div
        className={'app-shell' + (isWorkspace ? ' app-shell--workspace' : '')}
        data-testid="app-shell"
      >
        <Sidebar />
        <PhoneAppBar />
        <main className="main" data-testid="app-shell-main">
          <PageHeader title="Maestro" />
          <div
            className="page-pad scroll"
            data-testid="app-shell-content"
            style={{
              // The `.page-pad.scroll` selector handles padding and
              // overflow at every density step; the inline `display:flex`
              // is purely so screens that render their own grids/sections
              // get a vertical stacking context.
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--density-gap)',
            }}
          >
            {children}
          </div>
        </main>
        <PhoneTabBar />
      </div>
    </div>
  );
}
