/**
 * Cue mutation — optimistic update + rollback contract (PR-7b of #340).
 *
 * Verifies the architect's risk #2: the optimistic message and the
 * eventual SSE-arrived message must not duplicate. Specifically:
 *   - `onMutate` appends an `optimistic-${nonce}` message to the
 *     cached snapshot before the mutation resolves.
 *   - On error, the cache rolls back to the pre-mutation snapshot.
 *   - Optimistic messages are NEVER given a `broadcastId` so they
 *     don't collapse with #357's broadcast fold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { EnsembleStateV1 } from 'claude-tempo/http/event-types';
import {
  __setOptimisticNonceFnForTests,
  OPTIMISTIC_ID_PREFIX,
  useCueMutation,
} from '../src/lib/mutations';
import { ensembleQueryKey } from '../src/lib/queries';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  __setOptimisticNonceFnForTests(() => 'fixed-nonce');
});

afterEach(() => {
  __setDashboardClientForTests(null);
  __setOptimisticNonceFnForTests(null);
  vi.restoreAllMocks();
});

describe('Cue optimistic update', () => {
  it('appends an optimistic message to the cached snapshot before the mutation resolves', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const qc = newQc();
    qc.setQueryData<EnsembleStateV1>(ensembleQueryKey('demo'), makeSnapshot({ ensemble: 'demo' }));

    const { result } = renderHook(() => useCueMutation('demo'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ to: 'tempo-eng', message: 'go ship it' });

    const cached = qc.getQueryData<EnsembleStateV1>(ensembleQueryKey('demo'));
    const optimistic = cached?.chat.messages.find(
      (m) => m.id === `${OPTIMISTIC_ID_PREFIX}fixed-nonce`,
    );
    expect(optimistic).toBeDefined();
    expect(optimistic?.text).toBe('go ship it');
    expect(optimistic?.role).toBe('maestro-out');
    expect(optimistic?.broadcastId).toBeUndefined();
  });

  it('rolls back the snapshot on mutation error', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { cue: new Error('temporal-down') },
    });
    __setDashboardClientForTests(mock);
    const qc = newQc();
    const initialSnapshot = makeSnapshot({ ensemble: 'demo' });
    qc.setQueryData<EnsembleStateV1>(ensembleQueryKey('demo'), initialSnapshot);

    const { result } = renderHook(() => useCueMutation('demo'), { wrapper: wrap(qc) });
    await expect(
      result.current.mutateAsync({ to: 'tempo-eng', message: 'will fail' }),
    ).rejects.toThrow('temporal-down');
    await waitFor(() => expect(result.current.isError).toBe(true));

    const cached = qc.getQueryData<EnsembleStateV1>(ensembleQueryKey('demo'));
    expect(cached?.chat.messages).toEqual(initialSnapshot.chat.messages);
    expect(cached?.chat.total).toBe(initialSnapshot.chat.total);
  });

  it('SSE chat.appended reconciles with the optimistic entry — no duplicate row', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const qc = newQc();
    qc.setQueryData<EnsembleStateV1>(ensembleQueryKey('demo'), makeSnapshot({ ensemble: 'demo' }));

    // Fire the cue: applies optimistic.
    const { result } = renderHook(() => useCueMutation('demo'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ to: 'tempo-eng', message: 'reconcile me' });

    // Sanity: the optimistic is in the cache.
    let cached = qc.getQueryData<EnsembleStateV1>(ensembleQueryKey('demo'));
    expect(cached?.chat.messages).toHaveLength(1);
    expect(cached?.chat.messages[0].id).toBe(`${OPTIMISTIC_ID_PREFIX}fixed-nonce`);

    // Now simulate the SSE chat.appended event arriving with the
    // canonical id. `applyEvent` should drop the optimistic and
    // append the canonical, leaving exactly one row.
    const { applyEvent } = await import('../src/lib/sse');
    cached = applyEvent(cached, {
      v: 1, type: 'chat.appended',
      eventId: '1735000000000:1',
      payload: {
        id: 'msg-canonical-1',
        from: 'maestro',
        to: 'tempo-eng',
        text: 'reconcile me',
        timestamp: '2026-04-27T00:00:00.500Z',
        role: 'maestro-out',
      },
    });

    expect(cached?.chat.messages).toHaveLength(1);
    expect(cached?.chat.messages[0].id).toBe('msg-canonical-1');
    // `total` should reflect just the optimistic's bump — the SSE
    // event is a replacement, not a new add.
    expect(cached?.chat.total).toBe(1);
  });

  it('strips just the optimistic entry when there was no prior snapshot', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { cue: new Error('boom') },
    });
    __setDashboardClientForTests(mock);
    const qc = newQc();
    // No prior snapshot in the cache — the rollback path must still
    // remove the optimistic entry it added in onMutate.
    const { result } = renderHook(() => useCueMutation('demo'), { wrapper: wrap(qc) });

    // Seed an empty snapshot so onMutate has something to spread into.
    qc.setQueryData<EnsembleStateV1>(ensembleQueryKey('demo'), makeSnapshot({ ensemble: 'demo' }));

    await expect(
      result.current.mutateAsync({ to: 'tempo-eng', message: 'x' }),
    ).rejects.toThrow();

    const cached = qc.getQueryData<EnsembleStateV1>(ensembleQueryKey('demo'));
    const hasOptimistic = cached?.chat.messages.some(
      (m) => m.id.startsWith(OPTIMISTIC_ID_PREFIX),
    );
    expect(hasOptimistic).toBe(false);
  });
});
