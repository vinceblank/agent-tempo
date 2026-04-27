/**
 * Hosts screen — covers loading / error / empty / populated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { HostInfo } from 'claude-tempo/types';
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
});
