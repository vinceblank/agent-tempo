/**
 * `useOrphans` — query-key reactivity check (#579).
 *
 * Different ensemble filters must produce different query keys so a
 * filter switch triggers a refetch instead of returning the prior
 * unfiltered cache slot. We mount two consumers (one filtered, one
 * unfiltered) and assert both `client.orphans` calls were made
 * independently. Also verifies the filter value is forwarded verbatim.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOrphans, orphansQueryKey } from '../src/lib/queries';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => __setDashboardClientForTests(null));

function Consumer({ ensemble }: { ensemble?: string }) {
  const q = useOrphans(ensemble);
  return <div data-testid={`status-${ensemble ?? 'all'}`}>{q.isSuccess ? 'ok' : '...'}</div>;
}

describe('useOrphans', () => {
  it('produces distinct query keys per ensemble filter', () => {
    expect(orphansQueryKey()).toEqual(['orphans', '__all__']);
    expect(orphansQueryKey('jam')).toEqual(['orphans', 'jam']);
    expect(orphansQueryKey('foo')).not.toEqual(orphansQueryKey('bar'));
    expect(orphansQueryKey()).not.toEqual(orphansQueryKey('jam'));
  });

  it('triggers an independent fetch for each filter (unfiltered vs filtered)', async () => {
    const client = new MockDashboardClient();
    const calls: Array<{ ensemble?: string } | undefined> = [];
    // Swap `client.orphans` with a spy that captures call args.
    const orig = client.orphans.bind(client);
    client.orphans = vi.fn(async (opts?: { ensemble?: string }) => {
      calls.push(opts);
      return orig();
    }) as unknown as typeof client.orphans;
    __setDashboardClientForTests(client);

    const qc = newQc();
    render(
      <QueryClientProvider client={qc}>
        <Consumer />
        <Consumer ensemble="jam" />
      </QueryClientProvider> as ReactNode,
    );

    await waitFor(() => {
      // Both consumers settle once the fetcher resolves.
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
    // Args mix of undefined (no filter) + { ensemble: 'jam' }.
    const hasUnfiltered = calls.some((c) => c === undefined);
    const hasJam = calls.some((c) => c?.ensemble === 'jam');
    expect(hasUnfiltered).toBe(true);
    expect(hasJam).toBe(true);
  });
});
