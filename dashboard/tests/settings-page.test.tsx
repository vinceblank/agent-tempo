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
import { render, screen, fireEvent } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Settings } from '../src/screens/Settings';
import { createDashboardMemoryRouter } from '../src/router';
import { __resetPrefsForTests } from '../src/store/prefs';

beforeEach(() => __resetPrefsForTests());
afterEach(() => {
  __resetPrefsForTests();
  vi.restoreAllMocks();
});

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Render the Settings page directly (no router) — fastest for the
 *  panel + control cases that don't depend on route resolution. */
function renderStandalone() {
  return render(<Settings />);
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
      // The reason should mention PR-7 / safe-write so the user knows
      // when to expect the action to wire up.
      expect(disband.getAttribute('data-disabled-reason')).toMatch(/PR-7/);
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
