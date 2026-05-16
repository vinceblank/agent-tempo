/**
 * Sidebar — Orphans badge visibility (#579).
 *
 * The badge is hidden when `useOrphanCount` resolves to 0 (or errors)
 * and visible with the count when >0. Hooks must always be called
 * unconditionally (React rules), so a count of 0 is enough — we don't
 * need to mock the hook out of existence.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Sidebar } from '../src/components/Sidebar';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSidebar(client: MockDashboardClient) {
  __setDashboardClientForTests(client);
  return render(
    <QueryClientProvider client={newQc()}>
      <MemoryRouter><Sidebar /></MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}

afterEach(() => __setDashboardClientForTests(null));

describe('Sidebar — Orphans nav entry + badge', () => {
  it('always renders the Orphans nav link', async () => {
    const client = new MockDashboardClient();
    renderSidebar(client);
    expect(await screen.findByTestId('nav-orphans')).toBeInTheDocument();
  });

  it('hides the badge when the count is 0 (cluster tidy)', async () => {
    const client = new MockDashboardClient();
    client.orphansResponse = { v: 1, capturedAt: '2026-05-16T00:00:00.000Z', orphans: [] };
    renderSidebar(client);
    // Resolve the query; assert badge stays absent.
    await waitFor(() => {
      expect(screen.getByTestId('nav-orphans')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sidebar-orphans-badge')).not.toBeInTheDocument();
  });

  it('renders the badge with the count when orphans > 0', async () => {
    const client = new MockDashboardClient();
    client.orphansResponse = {
      v: 1, capturedAt: '2026-05-16T00:00:00.000Z',
      orphans: [
        { workflowId: 'w1', playerId: 'a', ensemble: 'jam', preferredHost: 'h1', hostLiveness: 'live', phase: 'detached', detachedSince: null, lastHeartbeatAt: null, migrateCommand: '/migrate a h1' },
        { workflowId: 'w2', playerId: 'b', ensemble: 'jam', preferredHost: 'h2', hostLiveness: 'missing', phase: 'detached', detachedSince: null, lastHeartbeatAt: null, migrateCommand: '/migrate b h2' },
        { workflowId: 'w3', playerId: 'c', ensemble: 'jam', preferredHost: 'h3', hostLiveness: 'stale', phase: 'detached', detachedSince: null, lastHeartbeatAt: null, migrateCommand: '/migrate c h3' },
      ],
    };
    renderSidebar(client);
    const badge = await screen.findByTestId('sidebar-orphans-badge');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('3 orphans');
  });

  it('hides the badge gracefully when the count query errors', async () => {
    const client = new MockDashboardClient();
    client.orphansError = new Error('temporal-down');
    renderSidebar(client);
    await waitFor(() => {
      expect(screen.getByTestId('nav-orphans')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sidebar-orphans-badge')).not.toBeInTheDocument();
  });
});
