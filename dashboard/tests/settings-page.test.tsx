/**
 * Settings page (PR-G of #389) — replaces the retired SettingsSheet.
 *
 * Verifies:
 *   - 5 panels render with stable testids
 *   - Appearance controls (theme/density/accent) write through the
 *     Zustand prefs store and persist to dataset attributes
 *   - Debug-flag checkbox round-trips localStorage
 *   - Reset button restores defaults via the public store actions
 *   - Disband button is disabled-with-tooltip (PR-7 wires real handler)
 *   - Settings deep-links via the dashboard router (so the sidebar
 *     NavLink lands cleanly)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Settings } from '../src/screens/Settings';
import { createDashboardMemoryRouter } from '../src/router';
import { __resetPrefsForTests } from '../src/store/prefs';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';
import { MockDashboardClient } from './fixtures/mock-client';

beforeEach(() => {
  __resetPrefsForTests();
  // ConnectionPanel (#436) calls useHealth() which needs both a
  // QueryClientProvider and a client that implements health(). Inject the
  // MockDashboardClient so the hook resolves cleanly without a live daemon.
  __setDashboardClientForTests(new MockDashboardClient());
});
afterEach(() => {
  __setDashboardClientForTests(null);
  __resetPrefsForTests();
  vi.restoreAllMocks();
});

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Render the Settings page directly (no router) — fastest for the
 *  panel + control cases that don't depend on route resolution.
 *  Wraps in QueryClientProvider so ConnectionPanel's useHealth() resolves. */
function renderStandalone() {
  return render(
    <QueryClientProvider client={newQc()}>
      <Settings />
    </QueryClientProvider> as ReactNode,
  );
}

describe('Settings page', () => {
  it('renders all five panels with stable testids', () => {
    renderStandalone();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByTestId('settings-panel-connection')).toBeInTheDocument();
    expect(screen.getByTestId('settings-panel-profile')).toBeInTheDocument();
    expect(screen.getByTestId('settings-panel-notifications')).toBeInTheDocument();
    expect(screen.getByTestId('settings-panel-appearance')).toBeInTheDocument();
    expect(screen.getByTestId('settings-panel-danger-zone')).toBeInTheDocument();
  });

  it('exposes the Connection status pill', () => {
    renderStandalone();
    const status = screen.getByTestId('settings-connection-status');
    expect(status.textContent).toMatch(/connected/);
  });

  // Connection panel KVs (#436 + #444) — namespace and taskQueue must
  // reflect the live `/v1/health` response, not hard-coded defaults.
  // Mock advertises namespace=`default` + taskQueue=`claude-tempo`; pinning
  // both prevents another KV from silently regressing to a static string.
  it('Connection panel renders namespace + task queue from /v1/health', async () => {
    renderStandalone();
    const panel = screen.getByTestId('settings-panel-connection');
    // useHealth resolves async — wait on the *values* (not the static
    // labels) so we don't assert against the loading-state `…` placeholder.
    // Both literals are unique enough inside the panel to disambiguate
    // from other KV rows. Awaited in parallel — the two paints are
    // independent and React Query settles them in the same tick.
    await Promise.all([
      within(panel).findByText('default'),
      within(panel).findByText('claude-tempo'),
    ]);
  });

  it('the Danger zone panel spans both grid columns', () => {
    renderStandalone();
    const dz = screen.getByTestId('settings-panel-danger-zone');
    expect(dz.style.gridColumn).toBe('1 / -1');
  });

  describe('Appearance panel', () => {
    it('renders the three editable controls + debug checkbox', () => {
      renderStandalone();
      expect(screen.getByTestId('settings-theme-select')).toBeInTheDocument();
      expect(screen.getByTestId('settings-density-range')).toBeInTheDocument();
      expect(screen.getByTestId('settings-accent-select')).toBeInTheDocument();
      expect(screen.getByTestId('settings-debug-checkbox')).toBeInTheDocument();
    });

    it('flips the theme via the select and emits prefs-theme-set', () => {
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
      renderStandalone();
      fireEvent.change(screen.getByTestId('settings-theme-select'), {
        target: { value: 'light' },
      });
      expect(document.documentElement.dataset.theme).toBe('light');
      const lines = consoleInfo.mock.calls.flat().map(String);
      expect(lines.some((l) => l.includes('prefs-theme-set') && l.includes('"light"'))).toBe(true);
    });

    it('updates the density via the slider', () => {
      renderStandalone();
      const range = screen.getByTestId('settings-density-range') as HTMLInputElement;
      fireEvent.change(range, { target: { value: '8' } });
      expect(document.documentElement.dataset.density).toBe('8');
    });

    it('updates the accent via the select', () => {
      renderStandalone();
      fireEvent.change(screen.getByTestId('settings-accent-select'), {
        target: { value: 'sage' },
      });
      expect(document.documentElement.dataset.accent).toBe('sage');
    });

    it('debug toggle round-trips localStorage.claudeTempoDebug', () => {
      try { window.localStorage.removeItem('claudeTempoDebug'); } catch { /* ignore */ }
      renderStandalone();
      const checkbox = screen.getByTestId('settings-debug-checkbox') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
      expect(window.localStorage.getItem('claudeTempoDebug')).toBe('true');
      fireEvent.click(checkbox);
      expect(window.localStorage.getItem('claudeTempoDebug')).toBeNull();
    });
  });

  describe('Danger zone', () => {
    it('Disband button is disabled-with-tooltip', () => {
      renderStandalone();
      const disband = screen.getByTestId('settings-disband-all');
      expect(disband).toHaveAttribute('aria-disabled', 'true');
      expect(disband).toHaveAttribute('data-disabled-reason');
      expect(disband.getAttribute('data-disabled-reason')).toMatch(/daemon endpoint/);
    });

    it('Reset button restores defaults via the public store actions', () => {
      renderStandalone();
      // Mutate first so reset has work to do.
      fireEvent.change(screen.getByTestId('settings-theme-select'), { target: { value: 'light' } });
      fireEvent.change(screen.getByTestId('settings-accent-select'), { target: { value: 'plum' } });
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.documentElement.dataset.accent).toBe('plum');

      fireEvent.click(screen.getByTestId('settings-reset'));
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.dataset.accent).toBe('terracotta');
    });
  });

  describe('Router integration', () => {
    it('the /settings route mounts the Settings page (deep-link works)', async () => {
      const router = createDashboardMemoryRouter(['/settings']);
      render(
        <QueryClientProvider client={newQc()}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      // The page testid lands when the AppShell + Outlet wire through.
      expect(await screen.findByTestId('settings-page')).toBeInTheDocument();
    });
  });
});
