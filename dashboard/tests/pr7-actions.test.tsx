/**
 * PR-7 — destructive action hooks + ConfirmDialog + PlayerDetail
 * action-row wiring.
 *
 * Each mutation hook gets a positive + error path. The ConfirmDialog
 * component gets keyboard + click coverage. PlayerDetail action row
 * verifies the destroy-confirm flow end-to-end against the mock
 * client's `destroy` recorder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';
import {
  useDestroyMutation,
  useDetachMutation,
  useRecallMutation,
  useRestartMutation,
} from '../src/lib/mutations';
import { ConfirmDialog } from '../src/components/wizard/ConfirmDialog';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { makePlayer } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrap(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('useRestartMutation', () => {
  it('forwards playerId to the client + records the call', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useRestartMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await result.current.mutateAsync({ playerId: 'tempo-eng' });
    expect(mock.mutationCalls).toContainEqual({
      method: 'restart',
      args: ['demo', { playerId: 'tempo-eng' }],
    });
  });

  it('surfaces errors from the client', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { restart: new Error('endpoint pending') },
    });
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useRestartMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await expect(
      result.current.mutateAsync({ playerId: 'tempo-eng' }),
    ).rejects.toThrow('endpoint pending');
  });
});

describe('useDestroyMutation', () => {
  it('calls client.destroy with the supplied playerId', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useDestroyMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await result.current.mutateAsync({ playerId: 'tempo-eng', reason: 'manual' });
    expect(mock.mutationCalls).toContainEqual({
      method: 'destroy',
      args: ['demo', { playerId: 'tempo-eng', reason: 'manual' }],
    });
  });

  it('surfaces errors from the client', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { destroy: new Error('unauthorised') },
    });
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useDestroyMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await expect(
      result.current.mutateAsync({ playerId: 'tempo-eng' }),
    ).rejects.toThrow('unauthorised');
  });
});

describe('useDetachMutation', () => {
  it('calls client.detach', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useDetachMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await result.current.mutateAsync({ playerId: 'tempo-eng', reason: 'user-stop' });
    expect(mock.mutationCalls).toContainEqual({
      method: 'detach',
      args: ['demo', { playerId: 'tempo-eng', reason: 'user-stop' }],
    });
  });

  it('surfaces errors from the client', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { detach: new Error('not found') },
    });
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useDetachMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await expect(
      result.current.mutateAsync({ playerId: 'tempo-eng' }),
    ).rejects.toThrow('not found');
  });
});

describe('useRecallMutation', () => {
  it('calls client.recall', async () => {
    const mock = new MockDashboardClient();
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useRecallMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await result.current.mutateAsync({ playerId: 'tempo-eng', limit: 20 });
    expect(mock.mutationCalls).toContainEqual({
      method: 'recall',
      args: ['demo', { playerId: 'tempo-eng', limit: 20 }],
    });
  });

  it('surfaces errors from the client', async () => {
    const mock = new MockDashboardClient({
      mutationErrors: { recall: new Error('endpoint pending') },
    });
    __setDashboardClientForTests(mock);
    const { result } = renderHook(() => useRecallMutation('demo'), {
      wrapper: wrap(newQc()),
    });
    await expect(
      result.current.mutateAsync({ playerId: 'tempo-eng' }),
    ).rejects.toThrow('endpoint pending');
  });
});

describe('ConfirmDialog', () => {
  it('renders title + cancel/confirm + dispatches the right callback', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Destroy player?"
        confirmLabel="Destroy"
        onCancel={onCancel}
        onConfirm={onConfirm}
        testIdPrefix="t"
      >
        body content
      </ConfirmDialog>,
    );
    expect(screen.getByText('Destroy player?')).toBeInTheDocument();
    expect(screen.getByText(/body content/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('t-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('t-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('disables both buttons + shows the pending suffix while in flight', () => {
    render(
      <ConfirmDialog
        title="Disband all?"
        confirmLabel="Disband all"
        pending
        onCancel={() => {}}
        onConfirm={() => {}}
        testIdPrefix="d"
      >
        irreversible
      </ConfirmDialog>,
    );
    const cancel = screen.getByTestId('d-cancel');
    const confirm = screen.getByTestId('d-confirm');
    expect(cancel).toBeDisabled();
    expect(confirm).toBeDisabled();
    expect(confirm.textContent).toContain('Disband all…');
  });

  it('closes via the Escape key', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Destroy?"
        confirmLabel="Destroy"
        onCancel={onCancel}
        onConfirm={() => {}}
        testIdPrefix="esc"
      >
        body
      </ConfirmDialog>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('PlayerDetail — destroy confirm flow', () => {
  function renderDetail() {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    __setDashboardClientForTests(mock);
    const router = createDashboardMemoryRouter([
      '/ensemble/demo/player/tempo-eng',
    ]);
    return {
      mock,
      ...render(
        <QueryClientProvider client={newQc()}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    };
  }

  it('opens a confirm dialog when Destroy is clicked', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-action-destroy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-action-destroy'));
    expect(
      screen.getByTestId('player-detail-tempo-eng-destroy-confirm-dialog'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Destroy tempo-eng\?/)).toBeInTheDocument();
  });

  it('cancels the destroy without dispatching the mutation', async () => {
    const { mock } = renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-action-destroy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-action-destroy'));
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-destroy-confirm-cancel'));
    expect(mock.mutationCalls.find((c) => c.method === 'destroy')).toBeUndefined();
  });

  it('dispatches destroy on confirm with the correct ensemble + playerId', async () => {
    const { mock } = renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-action-destroy')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-action-destroy'));
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-destroy-confirm-confirm'));
    await waitFor(() => {
      expect(mock.mutationCalls).toContainEqual({
        method: 'destroy',
        args: ['demo', { playerId: 'tempo-eng' }],
      });
    });
  });

  it('Recall / Restart / Detach dispatch their mutations directly (no confirm)', async () => {
    const { mock } = renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-action-recall')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-action-recall'));
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-action-restart'));
    fireEvent.click(screen.getByTestId('player-detail-tempo-eng-action-detach'));
    await waitFor(() => {
      expect(mock.mutationCalls.map((c) => c.method)).toEqual(
        expect.arrayContaining(['recall', 'restart', 'detach']),
      );
    });
  });
});

describe('Workspace — uptime pill (P1.6)', () => {
  // Imported lazily so we can reuse the renderHooks setup elsewhere.
  it('renders only when snapshot.startedAt is on the wire', async () => {
    const { Workspace } = await import('../src/screens/Workspace');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({ ensemble: 'demo', startedAt: fiveMinutesAgo }),
    });
    __setDashboardClientForTests(mock);
    const router = createDashboardMemoryRouter(['/ensemble/demo']);
    render(
      <QueryClientProvider client={newQc()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const pill = screen.getByTestId('workspace-uptime-pill');
      expect(pill.textContent).toMatch(/up.*\d+m/);
    });
    void Workspace; // suppress unused-import
  });

  it('hides when startedAt is missing', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({ ensemble: 'demo' }),
    });
    __setDashboardClientForTests(mock);
    const router = createDashboardMemoryRouter(['/ensemble/demo']);
    render(
      <QueryClientProvider client={newQc()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      // The page header pills row exists; the uptime pill specifically does not.
      expect(screen.queryByTestId('workspace-uptime-pill')).not.toBeInTheDocument();
    });
  });
});
