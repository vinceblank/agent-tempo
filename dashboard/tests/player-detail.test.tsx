/**
 * PlayerDetail screen — drilldown panel mounted as a child route under
 * Workspace.
 *
 * Covers the PR-D rebuild (`docs/design/dashboard-audit-389.md` §PR-D):
 *
 *   - Action row: 5 disabled-with-tooltip CTAs + ✕ close.
 *   - Three KV sections with locked-in groupings — `Phase & lease`,
 *     `Work`, `Messages` (audit Q2 lock-in).
 *   - Real codebase phases via PhaseDot (rev 4 C3).
 *   - Transcript sourced from `useEnsembleSnapshot.chat`, filtered by
 *     player, last 4-6 messages.
 *   - "—" placeholder for wire-extension fields not yet exposed.
 *
 * Plus the v0.27 testid surface (`-id`, `-type`, `-phase`, `-close`,
 * `-not-found`) which downstream tests still query.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient } from './fixtures/mock-client';
import { makePlayer as basePlayer, makeChatMessage, makeSnapshot } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import type { EnsembleChatMessage } from 'claude-tempo/types';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makePlayer(overrides: Partial<PlayerSummaryV1> = {}): PlayerSummaryV1 {
  return basePlayer({
    hostname: 'main-laptop',
    playerType: 'my-tempo-engineer',
    part: 'Building features',
    gitBranch: 'main',
    workDir: '/repos/app',
    ...overrides,
  });
}

function renderAtPath(client: MockDashboardClient, path: string) {
  __setDashboardClientForTests(client);
  const qc = newQc();
  const router = createDashboardMemoryRouter([path]);
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

describe('PlayerDetail panel — base contract', () => {
  it('mounts at the nested route and exposes the legacy testid surface', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [
          makePlayer({ playerId: 'tempo-eng' }),
          makePlayer({ playerId: 'tempo-qa', playerType: 'my-tempo-qa', phase: 'awaiting' }),
        ],
      }),
    });

    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng')).toBeInTheDocument();
    });
    // Legacy compatibility shim: `-id`/`-type`/`-phase` testids still
    // surface the same data so older tests don't have to be rewritten.
    expect(screen.getByTestId('player-detail-tempo-eng-id').textContent).toContain('tempo-eng');
    expect(screen.getByTestId('player-detail-tempo-eng-type').textContent).toContain('my-tempo-engineer');
    expect(screen.getByTestId('player-detail-tempo-eng-phase').textContent).toContain('attached');
  });

  it('exposes a close button with the documented testid', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-close')).toBeInTheDocument();
    });
    // We test presence + clickability only; react-router navigation is
    // not under test here.
    expect(() => screen.getByTestId('player-detail-tempo-eng-close').click()).not.toThrow();
  });

  it('renders a not-found message when the playerId is absent from the snapshot', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/ghost');
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-ghost-not-found')).toBeInTheDocument();
    });
  });

  it('uses role="dialog" on the panel for assistive-tech surfacing', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('data-testid', 'player-detail-tempo-eng');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });
  });
});

describe('PlayerDetail — action row (audit §PR-D)', () => {
  it('renders 5 disabled-with-tooltip CTAs + ✕ close', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-actions')).toBeInTheDocument();
    });
    for (const key of ['dm', 'recall', 'restart', 'detach', 'destroy']) {
      const btn = screen.getByTestId(`player-detail-tempo-eng-action-${key}`);
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      expect(btn.getAttribute('title')).toMatch(/PR-7/);
    }
    expect(screen.getByTestId('player-detail-tempo-eng-close')).toBeInTheDocument();
  });
});

describe('PlayerDetail — KV sections (audit Q2 lock-in)', () => {
  it('renders the three sections with the locked-in titles', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-section-phase-lease')).toBeInTheDocument();
    });
    expect(screen.getByTestId('player-detail-tempo-eng-section-work')).toBeInTheDocument();
    expect(screen.getByTestId('player-detail-tempo-eng-section-messages')).toBeInTheDocument();

    // Verify the section-head titles render verbatim.
    expect(screen.getByText('Phase & lease')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
  });

  it('Phase & lease — populates phase / host / heartbeat from the snapshot, "—" for unwired', async () => {
    const lastHeartbeatAt = new Date(Date.now() - 12_000).toISOString();
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng', lastHeartbeatAt })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    const section = await screen.findByTestId('player-detail-tempo-eng-section-phase-lease');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-host').textContent).toContain('main-laptop');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-heartbeat').textContent).toMatch(/\d+s ago/);
    // Wire-extension placeholders.
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-adapter').textContent).toContain('—');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-lease').textContent).toContain('—');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-run-id').textContent).toContain('—');
    // Phase row hosts the PhaseDot (one instance scoped to this section).
    const dot = within(section).getByTestId('phase-dot-tempo-eng');
    expect(dot).toHaveAttribute('data-phase', 'attached');
  });

  it('Work — uses dir/branch/part from the snapshot; worktree is "—"', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({
          playerId: 'tempo-eng',
          workDir: '/repos/claude-tempo',
          gitBranch: 'feat/x',
          part: 'Refactor lease math',
        })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    const section = await screen.findByTestId('player-detail-tempo-eng-section-work');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-dir').textContent).toContain('/repos/claude-tempo');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-branch').textContent).toContain('feat/x');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-part').textContent).toContain('Refactor lease math');
    expect(within(section).getByTestId('player-detail-tempo-eng-kv-worktree').textContent).toContain('—');
  });

  it('Messages — all three rows render as "—" placeholders pre-wire-extension', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    const section = await screen.findByTestId('player-detail-tempo-eng-section-messages');
    for (const k of ['received', 'sent', 'outbox']) {
      expect(within(section).getByTestId(`player-detail-tempo-eng-kv-${k}`).textContent).toContain('—');
    }
  });
});

describe('PlayerDetail — phase rendering (rev 4 C3)', () => {
  it.each([
    ['booting', 'booting'],
    ['attached', 'attached'],
    ['processing', 'processing'],
    ['awaiting', 'awaiting'],
    ['draining', 'draining'],
    ['detached', 'detached'],
    ['gone', 'gone'],
  ] as const)('PhaseDot reflects real codebase phase "%s"', async (phase, expected) => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng', phase })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');
    // PhaseDot renders inside the panel in the header (showLabel) AND
    // the kv-phase row (showLabel). The parent Workspace's roster may
    // render its own PhaseDot for the same player; we scope to the
    // panel so the test exercises only PlayerDetail's surface.
    const panel = await screen.findByTestId('player-detail-tempo-eng');
    const dots = within(panel).getAllByTestId('phase-dot-tempo-eng');
    expect(dots.length).toBeGreaterThanOrEqual(2);
    for (const d of dots) {
      expect(d).toHaveAttribute('data-phase', expected);
    }
  });
});

describe('PlayerDetail — transcript', () => {
  function makeMsg(o: Partial<EnsembleChatMessage>): EnsembleChatMessage {
    return makeChatMessage(o);
  }

  it('renders messages where the player is sender or recipient (last 6, oldest-on-top)', async () => {
    const messages: EnsembleChatMessage[] = [
      // Most-recent-first per snapshot semantics.
      makeMsg({ id: '7', from: 'maestro', to: 'tempo-eng', text: 'g', timestamp: '2026-04-28T00:00:07Z', role: 'maestro-out' }),
      makeMsg({ id: '6', from: 'tempo-eng', to: 'maestro', text: 'f', timestamp: '2026-04-28T00:00:06Z', role: 'maestro-in' }),
      makeMsg({ id: '5', from: 'tempo-eng', to: 'conductor', text: 'e', timestamp: '2026-04-28T00:00:05Z', role: 'conductor-in' }),
      makeMsg({ id: '4', from: 'maestro', to: 'tempo-eng', text: 'd', timestamp: '2026-04-28T00:00:04Z', role: 'maestro-out' }),
      makeMsg({ id: '3', from: 'tempo-eng', to: 'maestro', text: 'c', timestamp: '2026-04-28T00:00:03Z', role: 'maestro-in' }),
      makeMsg({ id: '2', from: 'tempo-eng', to: 'maestro', text: 'b', timestamp: '2026-04-28T00:00:02Z', role: 'maestro-in' }),
      makeMsg({ id: '1', from: 'tempo-eng', to: 'maestro', text: 'a', timestamp: '2026-04-28T00:00:01Z', role: 'maestro-in' }),
      // Should be excluded — neither sender nor recipient is the player.
      makeMsg({ id: 'other', from: 'tempo-qa', to: 'maestro', text: 'unrelated', timestamp: '2026-04-28T00:00:08Z', role: 'maestro-in' }),
    ];
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
        chat: { messages, total: messages.length, hasMore: false },
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    const transcript = await screen.findByTestId('player-detail-tempo-eng-transcript');
    // 7 candidates, capped at 6, "unrelated" filtered out.
    expect(transcript).toHaveAttribute('data-count', '6');
    // Oldest-on-top after reverse: ids 2..7. Scope to direct row
    // elements (FeedMessage's rendered root carries `data-direction`)
    // so the `…-body` testids don't pollute the order check.
    const ids = Array.from(transcript.querySelectorAll('[data-direction]'))
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual([
      'feed-message-2',
      'feed-message-3',
      'feed-message-4',
      'feed-message-5',
      'feed-message-6',
      'feed-message-7',
    ]);
    // Conductor-side overheard messages render as `route`.
    expect(screen.getByTestId('feed-message-5')).toHaveAttribute('data-direction', 'route');
    // Maestro-out renders as `out`, maestro-in renders as `in`.
    expect(screen.getByTestId('feed-message-7')).toHaveAttribute('data-direction', 'out');
    expect(screen.getByTestId('feed-message-6')).toHaveAttribute('data-direction', 'in');
  });

  it('shows an empty placeholder when no messages match the player', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
        chat: {
          messages: [
            makeMsg({ id: 'x', from: 'tempo-qa', to: 'maestro', text: 'unrelated', role: 'maestro-in' }),
          ],
          total: 1,
          hasMore: false,
        },
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-transcript-empty')).toBeInTheDocument();
    });
  });
});
