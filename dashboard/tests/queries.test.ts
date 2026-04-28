/**
 * Tests for the TanStack Query hooks (`useEnsembleList`,
 * `useEnsembleSnapshot`).
 */
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useAgentTypes,
  useEnsembleList,
  useEnsembleSnapshot,
  useLineups,
} from '../src/lib/queries';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';

function wrap(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useEnsembleList', () => {
  it('returns the list from the mock client', async () => {
    const mock = new MockDashboardClient({
      ensembles: [
        { name: 'demo', playerCount: 2, hasConductor: true, state: 'online' },
        { name: 'other', playerCount: 1, hasConductor: false, state: 'paused' },
      ],
    });
    const qc = newClient();
    const { result } = renderHook(() => useEnsembleList({ client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0].name).toBe('demo');
  });

  it('surfaces fetch errors as Error', async () => {
    const mock = new MockDashboardClient({
      ensemblesError: new Error('temporal-down'),
    });
    const qc = newClient();
    const { result } = renderHook(() => useEnsembleList({ client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('temporal-down');
  });
});

describe('useEnsembleSnapshot', () => {
  it('returns the canned snapshot for the requested ensemble', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', hasConductor: true }),
    });
    const qc = newClient();
    const { result } = renderHook(() => useEnsembleSnapshot('demo', { client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ensemble).toBe('demo');
    expect(result.current.data?.hasConductor).toBe(true);
  });

  it('does not fetch when ensemble is null', () => {
    const mock = new MockDashboardClient();
    const qc = newClient();
    const { result } = renderHook(() => useEnsembleSnapshot(null, { client: mock }), {
      wrapper: wrap(qc),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('surfaces snapshot errors', async () => {
    const mock = new MockDashboardClient({
      snapshotError: new Error('ensemble-not-found'),
    });
    const qc = newClient();
    const { result } = renderHook(() => useEnsembleSnapshot('demo', { client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('ensemble-not-found');
  });
});

describe('useAgentTypes (#400)', () => {
  it('returns the wire catalog from the mock client', async () => {
    const mock = new MockDashboardClient({
      agentTypes: [
        { name: 'tempo-conductor', description: 'Lead.', source: 'shipped' },
        { name: 'project-special', description: 'Project-only.', source: 'project' },
      ],
    });
    const qc = newClient();
    const { result } = renderHook(() => useAgentTypes({ client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[1].source).toBe('project');
  });

  it('surfaces fetch errors as Error', async () => {
    const mock = new MockDashboardClient({
      agentTypesError: new Error('catalog-down'),
    });
    const qc = newClient();
    const { result } = renderHook(() => useAgentTypes({ client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('catalog-down');
  });
});

describe('useLineups (#400)', () => {
  it('returns the wire catalog from the mock client', async () => {
    const mock = new MockDashboardClient({
      lineups: [
        { name: 'tempo-dev-team', description: 'Full cycle.', players: 5, source: 'shipped' },
        { name: 'my-saved', description: 'A saved one.', players: 2, source: 'saved' },
      ],
    });
    const qc = newClient();
    const { result } = renderHook(() => useLineups({ client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[1].source).toBe('saved');
    expect(result.current.data?.[1].players).toBe(2);
  });

  it('surfaces fetch errors as Error', async () => {
    const mock = new MockDashboardClient({
      lineupsError: new Error('lineups-down'),
    });
    const qc = newClient();
    const { result } = renderHook(() => useLineups({ client: mock }), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('lineups-down');
  });
});
