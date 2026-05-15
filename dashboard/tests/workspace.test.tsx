/**
 * Workspace screen tests — render the screen behind a memory router
 * with a snapshot fixture, then verify testids + logEvents + the
 * conductor-derivation contract (#358).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient } from './fixtures/mock-client';
import { makePlayer, makeSnapshot } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWorkspace(client: MockDashboardClient, initialPath = '/ensemble/demo') {
  __setDashboardClientForTests(client);
  const qc = newQc();
  const router = createDashboardMemoryRouter([initialPath]);
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('Workspace screen', () => {
  it('renders the workspace testid + roster + chat-log when the snapshot lands', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 2, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          makePlayer({ playerId: 'tempo-conductor', isConductor: true, playerType: 'tempo-conductor' }),
          makePlayer({ playerId: 'tempo-eng', playerType: 'my-tempo-engineer' }),
        ],
      }),
    });
    renderWorkspace(mock);

    // `roster` only renders in the data-loaded branch, so wait for it
    // explicitly instead of `workspace-demo` (which the loading branch
    // also renders).
    expect(await screen.findByTestId('roster')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-demo')).toBeInTheDocument();
    expect(screen.getByTestId('chat-log-demo')).toBeInTheDocument();
    expect(screen.getByTestId('player-row-tempo-conductor')).toBeInTheDocument();
    expect(screen.getByTestId('player-row-tempo-eng')).toBeInTheDocument();
  });

  it('marks exactly the conductor row with conductor-indicator (#358 derivation)', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          // Non-conductor first to prove the derivation walks the array
          // (mirrors the TUI's #358 regression test).
          makePlayer({ playerId: 'tempo-eng' }),
          makePlayer({ playerId: 'boss', isConductor: true, playerType: 'tempo-conductor' }),
        ],
      }),
    });
    renderWorkspace(mock);

    // Wait for the data branch (roster only renders post-snapshot).
    await screen.findByTestId('roster');
    const indicators = screen.getAllByTestId('conductor-indicator');
    expect(indicators).toHaveLength(1);
    // The conductor-indicator is nested inside the conductor's row,
    // so the closest ancestor `[data-testid^="player-row"]` identifies
    // which player owns it.
    const ownerRow = indicators[0].closest('[data-testid^="player-row-"]');
    expect(ownerRow).toHaveAttribute('data-testid', 'player-row-boss');
  });

  it('renders the conductor first in the roster regardless of name (#462)', async () => {
    // Tripwire: the conductor is named to sort LAST alphabetically,
    // and the snapshot delivers it LAST in input order. The render
    // must put it at index 0 anyway (conductor-first) and preserve
    // alphabetical secondary order among the non-conductors.
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          makePlayer({ playerId: 'bob' }),
          makePlayer({ playerId: 'alice' }),
          makePlayer({ playerId: 'z-conductor', isConductor: true, playerType: 'tempo-conductor' }),
        ],
      }),
    });
    renderWorkspace(mock);

    const roster = await screen.findByTestId('roster');
    const rows = Array.from(roster.querySelectorAll<HTMLElement>('[data-testid^="player-row-"]'));
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'player-row-z-conductor',
      'player-row-alice',
      'player-row-bob',
    ]);
  });

  it('emits workspace.opened logEvent on mount', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', players: [makePlayer()] }),
    });
    renderWorkspace(mock);
    await waitFor(() => {
      const lines = (console.info as unknown as { mock: { calls: string[][] } }).mock.calls
        .flat()
        .map(String);
      expect(
        lines.some(
          (l) => l.includes('[agent-tempo:dashboard]') && l.includes('workspace.opened'),
        ),
      ).toBe(true);
    });
  });

  it('renders an empty-roster message when no players are present', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', players: [], hasConductor: false }),
    });
    renderWorkspace(mock);
    const roster = await screen.findByTestId('roster');
    expect(roster.textContent).toMatch(/Empty ensemble/);
  });

  it('shows the chat-log compressed-gap banner when chat is empty + hasMore is true', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer()],
        chat: { messages: [], total: 12, hasMore: true },
      }),
    });
    renderWorkspace(mock);
    await waitFor(() => {
      expect(screen.getByTestId('chat-log-demo-compressed-gap')).toBeInTheDocument();
    });
  });

  it('surfaces a role=alert error when the snapshot fails', async () => {
    const mock = new MockDashboardClient({ snapshotError: new Error('snapshot-down') });
    renderWorkspace(mock);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByTestId('error-workspace-demo').textContent).toMatch(/snapshot-down/);
  });

  // ── Audit rev2 fidelity polish (P1.2 + P1.5) ──

  it('binds the page-subtitle to lineup placeholder + conductor + host (#389 R3.P1.5)', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          makePlayer({
            playerId: 'tempo-conductor',
            isConductor: true,
            hostname: 'studio.local',
          }),
        ],
      }),
    });
    renderWorkspace(mock);
    // Wait for the snapshot-resolved render — the subtitle binding
    // only appears once `players` is populated.
    await waitFor(() => {
      expect(screen.getByText(/conducted by/i)).toBeInTheDocument();
    });
    // Subtitle now matches design's `Lineup X · conducted by Y on Z`
    // shape. Lineup half degrades to `Lineup —` until the wire ships
    // an explicit lineup field on `EnsembleStateV1` (architect-tracked).
    const subtitle = screen.getByText(/conducted by/i).closest('.page-subtitle');
    expect(subtitle).toBeTruthy();
    expect(subtitle!.textContent).toMatch(/Lineup\s*—/);
    expect(subtitle!.textContent).toMatch(/conducted by/i);
    expect(subtitle!.textContent).toMatch(/tempo-conductor/);
    expect(subtitle!.textContent).toMatch(/studio\.local/);
    // Hardcoded lineup is gone (we render `—` placeholder, not a name).
    expect(screen.queryByText(/tempo-dev-team/)).toBeNull();
  });

  it('renders schedules in the side-panel when the snapshot has any', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [makePlayer({ playerId: 'tempo-conductor', isConductor: true })],
        schedules: [
          {
            name: 'status-check',
            message: 'status?',
            target: 'tempo-conductor',
            createdBy: 'maestro',
            type: 'interval',
            interval: 600_000,
            nextFireAt: new Date(Date.now() + 60_000).toISOString(),
            firedCount: 0,
          },
        ],
      }),
    });
    renderWorkspace(mock);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-schedules-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-schedules-list')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-schedule-status-check')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-schedules-empty')).toBeNull();
  });

  it('schedules side-panel falls back to empty-state when no schedules', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [makePlayer({ playerId: 'tempo-conductor', isConductor: true })],
        schedules: [],
      }),
    });
    renderWorkspace(mock);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-schedules-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-schedules-empty')).toBeInTheDocument();
  });

  // ── Pixel-audit PR-E (#454 §4.2 F-A-3, F-A-7) ────────────────────────
  //
  // The chat panel's "Pop out" button must be wrapped in a `.popout-btn`
  // span so the canonical `@container artboard (max-width: 520px) {
  // .popout-btn { display: none } }` rule binds and the button hides at
  // the phone breakpoint. JSDOM doesn't evaluate container queries, so
  // we assert the wrapper *exists* — the static class-application is
  // what was missing pre-PR-E, not the rule itself.

  it('wraps the workspace-popout button in a .popout-btn span (F-A-3)', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', players: [makePlayer()] }),
    });
    renderWorkspace(mock);
    const popout = await screen.findByTestId('workspace-popout');
    const wrapper = popout.closest('.popout-btn');
    expect(wrapper).not.toBeNull();
  });

  // F-A-7: Event log meta line should match canonical workspace.jsx:414
  // verbatim — `ring · max 200 · messages elided`.
  it('event-log meta line includes the canonical "messages elided" copy (F-A-7)', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', players: [makePlayer()] }),
    });
    renderWorkspace(mock);
    await screen.findByTestId('workspace-event-log');
    expect(screen.getByText(/ring · max 200 · messages elided/)).toBeInTheDocument();
  });

  // F-A-7: Schedules side-panel head right-slot has a `+ New` link to
  // the Schedules screen (canonical workspace.jsx:433).
  it('schedules side-panel exposes a + New link to the Schedules screen (F-A-7)', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [makePlayer({ playerId: 'tempo-conductor', isConductor: true })],
        schedules: [],
      }),
    });
    renderWorkspace(mock);
    const newLink = await screen.findByTestId('workspace-schedules-new');
    expect(newLink).toHaveAttribute('href', '/schedules');
    expect(newLink.textContent).toMatch(/New/);
  });

  // ── PR-C3 mobile shell wiring ───────────────────────────────────────

  describe('mobile shell (PR-C3)', () => {
    function makeMobileMock() {
      return new MockDashboardClient({
        snapshot: makeSnapshot({
          ensemble: 'demo',
          players: [
            makePlayer({ playerId: 'tempo-conductor', isConductor: true, phase: 'attached' }),
            makePlayer({ playerId: 'tempo-eng', phase: 'attached' }),
            makePlayer({ playerId: 'tempo-qa', phase: 'awaiting' }),
          ],
        }),
      });
    }

    it('pushes lineup + 4-pill status into PhoneAppBar via useScreenPhoneAppBar', async () => {
      renderWorkspace(makeMobileMock());
      await screen.findByTestId('roster');

      // PhoneAppBar's status row reflects Workspace's derived counts:
      // 2 attached → "2 active", 1 awaiting → "1 idle", 0 detached.
      const status = await screen.findByTestId('phone-appbar-status');
      expect(status.textContent).toMatch(/2 active/);
      expect(status.textContent).toMatch(/1 idle/);
      // Detached zero → pill omitted (PhoneAppBar's status-row behaviour).
      expect(status.textContent).not.toMatch(/detached/);
    });

    it('the PhoneAppBar action button shares state with the desktop side-toggle', async () => {
      renderWorkspace(makeMobileMock());
      await screen.findByTestId('roster');

      // showSide defaults true, so the action button lands `is-active`.
      const action = screen.getByTestId('phone-appbar-action');
      const desktopToggle = screen.getByTestId('workspace-side-toggle');
      expect(action.className).toMatch(/\bis-active\b/);
      expect(desktopToggle.className).toMatch(/\bis-active\b/);
      expect(screen.getByTestId('workspace-side')).toBeInTheDocument();

      // Tapping the phone action button hides the side panel + flips
      // BOTH buttons' is-active class (they read the same React state).
      fireEvent.click(action);
      expect(action.className).not.toMatch(/\bis-active\b/);
      expect(desktopToggle.className).not.toMatch(/\bis-active\b/);
      expect(screen.queryByTestId('workspace-side')).not.toBeInTheDocument();

      // And the desktop toggle reopens it for both surfaces.
      fireEvent.click(desktopToggle);
      expect(action.className).toMatch(/\bis-active\b/);
      expect(screen.getByTestId('workspace-side')).toBeInTheDocument();
    });

    it('the bottom-sheet scrim closes the side panel when tapped', async () => {
      renderWorkspace(makeMobileMock());
      await screen.findByTestId('roster');

      // Scrim renders alongside the side panel — `.ws-side-scrim` is
      // `display: none` on desktop via components.css line 389, but the
      // element is in the DOM so the click handler is testable here
      // (jsdom doesn't honour container queries either way).
      const scrim = screen.getByTestId('workspace-side-scrim');
      fireEvent.click(scrim);
      expect(screen.queryByTestId('workspace-side')).not.toBeInTheDocument();
    });
  });
});
