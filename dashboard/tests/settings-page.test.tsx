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
  // Mock advertises namespace=`default` + taskQueue=`agent-tempo`; pinning
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
      within(panel).findByText('agent-tempo'),
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

    it('debug toggle round-trips localStorage.agentTempoDebug', () => {
      try { window.localStorage.removeItem('agentTempoDebug'); } catch { /* ignore */ }
      renderStandalone();
      const checkbox = screen.getByTestId('settings-debug-checkbox') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
      expect(window.localStorage.getItem('agentTempoDebug')).toBe('true');
      fireEvent.click(checkbox);
      expect(window.localStorage.getItem('agentTempoDebug')).toBeNull();
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

  // ── PR-G design-canvas decisions (ST-1/3/4) ────────────────────────
  //
  // Pixel-audit v0.28.9 PR-G ratified three intentional impl-vs-canvas
  // divergences in Settings. ST-2 (live controls) is already covered by
  // the Appearance describe-block above. These pins keep the next audit
  // from re-flagging:
  //
  //   ST-1 — KEEP impl's `version` KV row (canonical lacks it).
  //   ST-3 — DON'T ADD canonical's `metronome = on` mock row.
  //   ST-4 — Profile/Notifications panels show `—` placeholder shape.
  //
  // Canonical reconciliation: #458. See Settings.tsx file-header for
  // the verdict trail.
  describe('PR-G design-canvas decisions', () => {
    /** Find the `<div class="kv">` row whose `kv-k` label matches `label`,
     *  scoped to `panel`. Lets ST-4 pin per-row label↔value pairing
     *  instead of just counting placeholder dashes (which would survive
     *  a row reorder that put `—` on the wrong field). */
    function kvRow(panel: HTMLElement, label: string) {
      const row = within(panel).getByText(label).closest('.kv');
      if (!row) throw new Error(`kv row "${label}" not found in panel`);
      return within(row as HTMLElement);
    }

    it('ST-1: Connection panel renders the version row from /v1/health', async () => {
      // MockDashboardClient advertises version='0.0.0-test'. Asserting
      // both label + value pins the row stays paired — a regression
      // that drops the label but keeps the value (or vice versa)
      // would still slip past a value-only assertion.
      renderStandalone();
      const panel = screen.getByTestId('settings-panel-connection');
      await within(panel).findByText('0.0.0-test');
      expect(within(panel).getByText('version')).toBeInTheDocument();
    });

    it('ST-3: Appearance panel does not render a metronome row', () => {
      // Canonical mock has `<KV k="metronome" v="on" />`; impl skips
      // it. Panel-scoped so an unrelated string elsewhere on the page
      // (none today) wouldn't silently mask a regression.
      renderStandalone();
      const panel = screen.getByTestId('settings-panel-appearance');
      expect(within(panel).queryByText(/metronome/i)).toBeNull();
    });

    it('ST-4 (Profile): four KV rows, three `—` placeholders + the default lineup', () => {
      // Profile is wire-pending. Three rows show `—`; only
      // `default lineup` carries a real default. Per-row pairing
      // prevents a future "hard-code a name" regression that
      // technically keeps the dash count at 3.
      renderStandalone();
      const panel = screen.getByTestId('settings-panel-profile');
      expect(kvRow(panel, 'display name').getByText('—')).toBeInTheDocument();
      expect(kvRow(panel, 'email').getByText('—')).toBeInTheDocument();
      expect(kvRow(panel, 'default host').getByText('—')).toBeInTheDocument();
      expect(kvRow(panel, 'default lineup').getByText('tempo-dev-team')).toBeInTheDocument();
    });

    it('ST-4 (Notifications): four canonical KV rows render', () => {
      // Notifications is also wire-pending. Canvas mock and impl
      // agree on the row shape (4 KVs); pin it so a future
      // feature collapse doesn't silently drop one.
      renderStandalone();
      const panel = screen.getByTestId('settings-panel-notifications');
      expect(within(panel).getByText('player detached')).toBeInTheDocument();
      expect(within(panel).getByText('conductor handoff')).toBeInTheDocument();
      expect(within(panel).getByText('schedule fired')).toBeInTheDocument();
      expect(within(panel).getByText('recruit failed')).toBeInTheDocument();
    });
  });
});
