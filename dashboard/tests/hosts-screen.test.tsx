/**
 * Hosts screen — covers loading / error / empty / populated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { HostInfo } from 'agent-tempo/types';
import { Hosts } from '../src/screens/Hosts';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderHosts(client: MockDashboardClient) {
  __setDashboardClientForTests(client);
  return render(
    <QueryClientProvider client={newQc()}>
      <MemoryRouter><Hosts /></MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}
afterEach(() => __setDashboardClientForTests(null));

describe('Hosts screen', () => {
  it('renders empty state when no hosts reporting', async () => {
    renderHosts(new MockDashboardClient({ hosts: [] }));
    await waitFor(() => {
      expect(screen.getByTestId('hosts-empty')).toBeInTheDocument();
    });
  });

  it('renders one row per host with the required testids', async () => {
    const hostA: HostInfo = {
      hostname: 'host-a',
      instances: [{
        pid: 1, version: '0.28.0', identity: 'host-a:1:0.28.0',
        lastAccessTime: '2026-04-27T00:00:00.000Z',
        hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: true,
      }],
      recruitReady: true,
      freshness: 'live',
      profile: {
        hostname: 'host-a', version: '0.28.0', defaultAgent: 'claude',
        platform: 'linux', capabilities: [],
      },
      profileStaleness: 'fresh',
    };
    renderHosts(new MockDashboardClient({ hosts: [hostA] }));
    await waitFor(() => {
      expect(screen.getByTestId('host-row-host-a')).toBeInTheDocument();
    });
    expect(screen.getByTestId('host-row-host-a-version').textContent).toBe('0.28.0');
    expect(screen.getByTestId('host-row-host-a-platform').textContent).toBe('linux');
    expect(screen.getByTestId('host-row-host-a-freshness').textContent).toBe('live');
  });

  it('shows role=alert on /v1/hosts error', async () => {
    renderHosts(new MockDashboardClient({ hostsError: new Error('hosts-down') }));
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-testid', 'error-hosts');
      expect(alert.textContent).toMatch(/hosts-down/);
    });
  });

  it('renders all 7 columns + actions per host (PR-F2 table layout)', async () => {
    const hostA: HostInfo = {
      hostname: 'rosalind',
      instances: [{
        pid: 42, version: '0.28.0', identity: 'rosalind:42:0.28.0',
        lastAccessTime: '2026-04-27T00:00:00.000Z',
        hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: true,
      }],
      recruitReady: true,
      freshness: 'live',
      profile: {
        hostname: 'rosalind', version: '0.28.0', defaultAgent: 'claude',
        platform: 'darwin', capabilities: [],
        availablePlayerTypes: ['tempo-conductor', 'tempo-soloist', 'tempo-tuner'],
      },
      profileStaleness: 'fresh',
    };
    renderHosts(new MockDashboardClient({ hosts: [hostA] }));
    await waitFor(() => {
      expect(screen.getByTestId('hosts-table')).toBeInTheDocument();
    });
    // Per-cell testids — every column the design lists has one.
    expect(screen.getByTestId('host-row-rosalind-platform').textContent).toBe('darwin');
    expect(screen.getByTestId('host-row-rosalind-sessions').textContent).toBe('—');
    expect(screen.getByTestId('host-row-rosalind-types').textContent).toBe('3');
    expect(screen.getByTestId('host-row-rosalind-daemon').textContent).toBe('0.28.0');
    expect(screen.getByTestId('host-row-rosalind-uptime').textContent).toBe('—');
    expect(screen.getByTestId('host-row-rosalind-heartbeat').textContent).toMatch(/ago$/);
    expect(screen.getByTestId('host-row-rosalind-logs')).toBeInTheDocument();

    // PR-E H-1: Platform cell uses the canonical `var(--text-2)` ink
    // tier (same as Heartbeat below), not `dim` / `--dim` (which is one
    // tier dimmer). Mirrors canonical screens.jsx:512.
    const platformCell = screen.getByTestId('host-row-rosalind-platform') as HTMLElement;
    expect(platformCell.style.color).toBe('var(--text-2)');
    expect(platformCell.className).not.toMatch(/\bdim\b/);
  });

  it('hides stale hosts by default; "Show stale" toggle reveals them', async () => {
    const live: HostInfo = {
      hostname: 'live-1',
      instances: [{
        pid: 1, version: '0.28.0', identity: 'live-1:1:0.28.0',
        lastAccessTime: new Date().toISOString(),
        hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: true,
      }],
      recruitReady: true, freshness: 'live',
      profile: { hostname: 'live-1', version: '0.28.0', defaultAgent: 'claude',
        platform: 'linux', capabilities: [] },
      profileStaleness: 'fresh',
    };
    const stale: HostInfo = {
      hostname: 'stale-1',
      instances: [{
        pid: 2, version: '0.27.0', identity: 'stale-1:2:0.27.0',
        lastAccessTime: '2026-01-01T00:00:00.000Z',
        hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: true,
      }],
      recruitReady: false, freshness: 'stale',
      profile: { hostname: 'stale-1', version: '0.27.0', defaultAgent: 'claude',
        platform: 'linux', capabilities: [] },
      profileStaleness: 'stale',
    };
    renderHosts(new MockDashboardClient({ hosts: [live, stale] }));
    await waitFor(() => {
      expect(screen.getByTestId('host-row-live-1')).toBeInTheDocument();
    });
    // Stale hidden by default.
    expect(screen.queryByTestId('host-row-stale-1')).toBeNull();
  });

  it('empty-state copy shifts when stale hosts exist but are filtered out', async () => {
    const stale: HostInfo = {
      hostname: 'stale-only',
      instances: [{
        pid: 1, version: '0.27.0', identity: 'stale-only:1:0.27.0',
        lastAccessTime: '2026-01-01T00:00:00.000Z',
        hasWorkflowWorker: false, hasActivityWorker: false, hasHostQueueWorker: false,
      }],
      recruitReady: false, freshness: 'stale',
      profile: { hostname: 'stale-only', version: '0.27.0', defaultAgent: 'claude',
        platform: 'linux', capabilities: [] },
      profileStaleness: 'stale',
    };
    renderHosts(new MockDashboardClient({ hosts: [stale] }));
    await waitFor(() => {
      expect(screen.getByTestId('hosts-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('hosts-empty').textContent).toMatch(/Show stale/);
  });
});
