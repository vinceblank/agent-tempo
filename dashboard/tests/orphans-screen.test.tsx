/**
 * Orphans screen — #579. Covers loading / empty / populated / copy /
 * error states, plus the per-row liveness glyph join.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { OrphanV1 } from 'agent-tempo/http/event-types';
import { Orphans } from '../src/screens/Orphans';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderOrphans(client: MockDashboardClient) {
  __setDashboardClientForTests(client);
  return render(
    <QueryClientProvider client={newQc()}>
      <MemoryRouter><Orphans /></MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}

afterEach(() => __setDashboardClientForTests(null));

function orphan(p: Partial<OrphanV1> & { workflowId: string; playerId: string }): OrphanV1 {
  return {
    workflowId: p.workflowId,
    playerId: p.playerId,
    ensemble: p.ensemble ?? 'jam',
    preferredHost: p.preferredHost ?? 'host-A',
    hostLiveness: p.hostLiveness ?? 'live',
    phase: p.phase ?? 'detached',
    detachedSince: p.detachedSince ?? '2026-05-16T00:00:00.000Z',
    lastHeartbeatAt: p.lastHeartbeatAt ?? null,
    migrateCommand: p.migrateCommand ?? `/migrate ${p.playerId} ${p.preferredHost ?? 'host-A'}`,
  };
}

describe('Orphans screen', () => {
  it('renders the empty-state copy when no orphans are returned', async () => {
    const client = new MockDashboardClient();
    client.orphansResponse = { v: 1, capturedAt: '2026-05-16T00:00:00.000Z', orphans: [] };
    renderOrphans(client);
    await waitFor(() => {
      expect(screen.getByTestId('orphans-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('orphans-empty').textContent).toContain('cluster is tidy');
  });

  it('renders one row per orphan with the required testids', async () => {
    const client = new MockDashboardClient();
    client.orphansResponse = {
      v: 1, capturedAt: '2026-05-16T00:00:00.000Z',
      orphans: [
        orphan({ workflowId: 'agent-session-jam-alice', playerId: 'alice', preferredHost: 'host-A', hostLiveness: 'live' }),
        orphan({ workflowId: 'agent-session-jam-bob', playerId: 'bob', preferredHost: 'host-B', hostLiveness: 'missing' }),
      ],
    };
    renderOrphans(client);
    await waitFor(() => {
      expect(screen.getByTestId('orphan-row-agent-session-jam-alice')).toBeInTheDocument();
    });
    expect(screen.getByTestId('orphan-row-agent-session-jam-bob')).toBeInTheDocument();
    expect(screen.getByTestId('orphan-row-agent-session-jam-alice-player').textContent).toContain('alice');
    expect(screen.getByTestId('orphan-row-agent-session-jam-alice-host').textContent).toContain('host-A');
    // Stale-glyph + label visible — assert label, not the unicode glyph.
    expect(screen.getByTestId('orphan-row-agent-session-jam-bob-liveness').textContent?.toLowerCase()).toContain('missing');
  });

  it('copy button calls navigator.clipboard.writeText with the migrate command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const client = new MockDashboardClient();
    client.orphansResponse = {
      v: 1, capturedAt: '2026-05-16T00:00:00.000Z',
      orphans: [
        orphan({
          workflowId: 'w-orphan-x',
          playerId: 'orphan-x',
          preferredHost: null,
          hostLiveness: 'missing',
          migrateCommand: '/migrate orphan-x host-D --force --yes-steal=host-A',
        }),
      ],
    };
    renderOrphans(client);
    const btn = await screen.findByTestId('orphan-row-w-orphan-x-migrate-copy');
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith('/migrate orphan-x host-D --force --yes-steal=host-A');
  });

  it('renders the error panel when the snapshot fetch fails', async () => {
    const client = new MockDashboardClient();
    client.orphansError = new Error('temporal-unreachable');
    renderOrphans(client);
    await waitFor(() => {
      expect(screen.getByTestId('orphans-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('orphans-error').textContent).toContain('temporal-unreachable');
  });
});
