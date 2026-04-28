/**
 * AppShell PageHeader override slot tests — PR-B of #389.
 *
 * `useScreenPageHeader(renderFn)` lets a routed screen replace the
 * AppShell's default operator chrome with its own PageHeader. This
 * suite asserts the slot's lifecycle directly via probe components,
 * since `overview.test.tsx` renders Overview standalone (no AppShell
 * wrapper) and the hook silently no-ops in that context.
 *
 * The slot must:
 *   - render the override when a screen is mounted with the hook
 *   - restore the default when that screen unmounts
 *   - bail out cleanly when the same render fn is pushed again
 *     (StrictMode double-fire safe — the bail-out is the reason
 *     state is held as `{ render }` rather than the bare function)
 */
import { describe, it, expect } from 'vitest';
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell, useScreenPageHeader } from '../src/components/AppShell';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function withProviders(node: ReactNode) {
  __setDashboardClientForTests(new MockDashboardClient({ ensembles: [] }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** Pushes a stable PageHeader override that carries a probe testid. */
function HeaderProbe({ testId }: { testId: string }) {
  const renderFn = useCallback(
    () => (
      <header className="page-header" data-testid="page-header">
        <span data-testid={testId}>override-header</span>
      </header>
    ),
    [testId],
  );
  useScreenPageHeader(renderFn);
  return null;
}

/**
 * Toggle helper — controls whether the probe is mounted, so a test can
 * trigger the unmount path without re-rendering the whole shell.
 */
function Toggle({ initial = true, exposeToggle }: {
  initial?: boolean;
  exposeToggle: (toggle: () => void) => void;
}) {
  const [mounted, setMounted] = useState(initial);
  useEffect(() => {
    exposeToggle(() => setMounted((v) => !v));
  }, [exposeToggle]);
  return mounted ? <HeaderProbe testId="probe-header" /> : null;
}

describe('AppShell PageHeader slot', () => {
  it('renders the default operator chrome when no screen overrides', () => {
    render(
      withProviders(
        <AppShell>
          <div data-testid="probe-body">body</div>
        </AppShell>,
      ),
    );
    // Default chrome: density slider + theme toggle live inside the
    // PageHeader's DefaultActions slot.
    expect(screen.getByTestId('settings-density-slider')).toBeInTheDocument();
    expect(screen.getByTestId('settings-theme-toggle')).toBeInTheDocument();
    // No probe override.
    expect(screen.queryByTestId('probe-header')).toBeNull();
  });

  it('replaces the default chrome when a screen pushes a header', () => {
    render(
      withProviders(
        <AppShell>
          <HeaderProbe testId="probe-header" />
          <div data-testid="probe-body">body</div>
        </AppShell>,
      ),
    );
    // Override is visible; default chrome is gone.
    expect(screen.getByTestId('probe-header')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-density-slider')).toBeNull();
    expect(screen.queryByTestId('settings-theme-toggle')).toBeNull();
  });

  it('restores the default chrome when the overriding screen unmounts', () => {
    let toggle = () => {};
    render(
      withProviders(
        <AppShell>
          <Toggle exposeToggle={(t) => { toggle = t; }} />
          <div data-testid="probe-body">body</div>
        </AppShell>,
      ),
    );
    expect(screen.getByTestId('probe-header')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-density-slider')).toBeNull();

    act(() => { toggle(); });

    expect(screen.queryByTestId('probe-header')).toBeNull();
    expect(screen.getByTestId('settings-density-slider')).toBeInTheDocument();
    expect(screen.getByTestId('settings-theme-toggle')).toBeInTheDocument();
  });

  it('switches between two consecutive screens without leaking state', () => {
    let toggle = () => {};
    function Switcher({ exposeToggle }: { exposeToggle: (t: () => void) => void }) {
      const [which, setWhich] = useState<'a' | 'b'>('a');
      useEffect(() => {
        exposeToggle(() => setWhich((w) => (w === 'a' ? 'b' : 'a')));
      }, [exposeToggle]);
      return which === 'a'
        ? <HeaderProbe testId="probe-header-a" />
        : <HeaderProbe testId="probe-header-b" />;
    }
    render(
      withProviders(
        <AppShell>
          <Switcher exposeToggle={(t) => { toggle = t; }} />
          <div data-testid="probe-body">body</div>
        </AppShell>,
      ),
    );
    expect(screen.getByTestId('probe-header-a')).toBeInTheDocument();
    expect(screen.queryByTestId('probe-header-b')).toBeNull();

    act(() => { toggle(); });

    // After the swap, the slot reflects the new screen's header without
    // ever briefly falling back to the default chrome (the second
    // `setRender` happens inside the cleanup→effect commit phase, so
    // the default never renders between the two screens).
    expect(screen.queryByTestId('probe-header-a')).toBeNull();
    expect(screen.getByTestId('probe-header-b')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-density-slider')).toBeNull();
  });
});
