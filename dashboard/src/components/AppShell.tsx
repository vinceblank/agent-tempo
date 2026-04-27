/**
 * AppShell — the persistent outer chrome. Sidebar on the left, the live
 * content area on the right (header + scroll viewport). The only thing
 * PR-2 renders inside the content area is a placeholder scaffold pane;
 * PR-4 swaps in the routed `<Outlet />` from React Router.
 */
import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { PageHeader } from './PageHeader';

interface AppShellProps {
  children?: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div
      data-testid="app-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        height: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <Sidebar />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <PageHeader title="Maestro" subtitle="Dashboard scaffold (PR-2 of #340)" />
        <main
          data-testid="app-shell-main"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 'var(--density-pad) calc(var(--density-pad) * 1.6)',
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
