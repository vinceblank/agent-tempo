/**
 * Tests for the dashboard mutation hooks (PR-7b of #340).
 *
 * Each hook: success path + error path + telemetry breadcrumb. The
 * cue mutation's optimistic-update branch lives in the dedicated
 * `cue-optimistic.test.tsx` to keep this file focused on the
 * end-to-end mutation surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useCueMutation,
  usePauseMutation,
  usePlayMutation,
  useReleaseMutation,
  useRecruitMutation,
} from '../src/lib/mutations';
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

let consoleInfo: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

function loggedActions(): string[] {
  return [
    ...consoleInfo.mock.calls.flat(),
    ...consoleWarn.mock.calls.flat(),
  ].map(String);
}

describe('useCueMutation', () => {
  it('calls client.cue + emits started + succeeded log lines', async () => {
    const mock = new MockDashboardClient({ snapshot: makeSnapshot({ ensemble: 'demo' }) });
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => useCueMutation('demo'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ to: 'tempo-eng', message: 'go' });

    expect(mock.mutationCalls).toContainEqual({
      method: 'cue', args: ['demo', 'tempo-eng', 'go'],
    });
    const lines = loggedActions();
    expect(lines.some((l) => l.includes('mutation.cue.started'))).toBe(true);
    expect(lines.some((l) => l.includes('mutation.cue.succeeded'))).toBe(true);
  });

  it('logs failed + rolls back on error', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo' }),
      mutationErrors: { cue: new Error('temporal-down') },
    });
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => useCueMutation('demo'), { wrapper: wrap(qc) });
    await expect(
      result.current.mutateAsync({ to: 'tempo-eng', message: 'x' }),
    ).rejects.toThrow('temporal-down');
    await waitFor(() => expect(result.current.isError).toBe(true));

    const lines = loggedActions();
    expect(lines.some((l) => l.includes('mutation.cue.failed'))).toBe(true);
  });
});

describe('usePauseMutation + usePlayMutation', () => {
  it('pause: calls client.pause + emits success log', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => usePauseMutation('demo'), { wrapper: wrap(qc) });
    await result.current.mutateAsync();

    expect(mock.mutationCalls).toContainEqual({ method: 'pause', args: ['demo'] });
    expect(loggedActions().some((l) => l.includes('mutation.pause.succeeded'))).toBe(true);
  });

  it('play: forwards { release: true } when passed', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => usePlayMutation('demo'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ release: true });

    expect(mock.mutationCalls).toContainEqual({
      method: 'play', args: ['demo', { release: true }],
    });
  });

  it('pause: emits failure log on error', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { pause: new Error('boom') },
    });
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => usePauseMutation('demo'), { wrapper: wrap(qc) });
    await expect(result.current.mutateAsync()).rejects.toThrow('boom');
    expect(loggedActions().some((l) => l.includes('mutation.pause.failed'))).toBe(true);
  });
});

describe('useReleaseMutation', () => {
  it('without playerId fans out across the ensemble', async () => {
    const mock = new MockDashboardClient();
    mock.releaseResult = { released: ['a', 'b'], errors: [] };
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => useReleaseMutation('demo'), { wrapper: wrap(qc) });
    const out = await result.current.mutateAsync();
    expect(out.released).toEqual(['a', 'b']);
    expect(mock.mutationCalls).toContainEqual({ method: 'release', args: ['demo', undefined] });
  });

  it('with playerId routes single-player release', async () => {
    const mock = new MockDashboardClient();
    mock.releaseResult = { released: ['tempo-eng'], errors: [] };
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => useReleaseMutation('demo'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ playerId: 'tempo-eng' });
    expect(mock.mutationCalls).toContainEqual({
      method: 'release', args: ['demo', 'tempo-eng'],
    });
  });
});

describe('useRecruitMutation', () => {
  it('routes to client.recruit + returns playerId', async () => {
    const mock = new MockDashboardClient();
    mock.recruitResult = { playerId: 'tempo-eng', entryId: 'entry-42' };
    __setDashboardClientForTests(mock);
    const qc = newQc();

    const { result } = renderHook(() => useRecruitMutation('demo'), { wrapper: wrap(qc) });
    const out = await result.current.mutateAsync({
      name: 'tempo-eng', workDir: '/repo', agent: 'claude',
    });

    expect(out).toEqual({ playerId: 'tempo-eng', entryId: 'entry-42' });
    expect(mock.mutationCalls[0].method).toBe('recruit');
    expect(loggedActions().some((l) => l.includes('mutation.recruit.succeeded'))).toBe(true);
  });
});
