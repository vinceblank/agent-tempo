/**
 * useNotificationStream / NotificationStreamRunner tests — commit 3 of
 * feat/chat-notification-system.
 *
 * Drives the SSE bridge via `MockDashboardClient.emit(ensemble, event)`
 * and asserts the provider's state advances per the architect's spec
 * (§4.6 / docs/design/notifications-system.md):
 *
 *   - chat.appended with `role === 'maestro-in'` → fire() runs
 *   - chat.appended with `maestro-out` / `conductor-in` / `conductor-out`
 *     → suppressed
 *   - non-chat events (player.added, etc.) → suppressed
 *   - active-ensemble suppression: event from the URL-active ensemble
 *     bumps neither badge nor toast
 *   - subscription teardown when `useEnsembleList` data shrinks: emits
 *     to dropped ensembles no longer fire
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  EnsembleSummary,
  TempoEvent,
} from 'claude-tempo/http/event-types';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import {
  NotificationProvider,
  NotificationStreamRunner,
  useNotifications,
} from '../../src/lib/notifications';
import { __setDashboardClientForTests } from '../../src/lib/client-singleton';
import { ENSEMBLES_QUERY_KEY } from '../../src/lib/queries';
import { MockDashboardClient } from '../fixtures/mock-client';

interface SetupOpts {
  /** Initial ensembles served by the mock list query. */
  ensembles?: EnsembleSummary[];
  /** Initial path — drives the URL-active ensemble for suppression cases. */
  path?: string;
}

interface SetupHandle {
  mock: MockDashboardClient;
  qc: QueryClient;
  /**
   * Update the cached ensemble list, then wait for the stream effect
   * to re-run + the new per-ensemble subscriptions to be opened.
   * Async because React 19 + TanStack Query v5 don't propagate the
   * cache write through to effect re-runs synchronously inside a
   * plain `act(...)` — observer notification + commit + effect run
   * spans at least one macrotask tick.
   */
  setEnsembles: (next: EnsembleSummary[]) => Promise<void>;
  /**
   * Emit a synthetic SSE event into the named ensemble's stream.
   * Wraps the emit + microtask flush in `await act(async () => …)` so
   * the `fire()` call queued from the stream's for-await body lands
   * inside an act boundary (avoids the "update was not wrapped in
   * act(...)" warning).
   */
  emit: (ensemble: string, event: TempoEvent) => Promise<void>;
}

function makeSummary(name: string, playerCount = 1): EnsembleSummary {
  return { name, playerCount, hasConductor: false };
}

function makeChatEvent(
  msg: Partial<EnsembleChatMessage> & {
    role: EnsembleChatMessage['role'];
    from: string;
    text: string;
  },
  eventId = '1735000000000:0',
): TempoEvent {
  return {
    v: 1,
    type: 'chat.appended',
    eventId,
    payload: {
      id: msg.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
      from: msg.from,
      to: msg.to ?? 'maestro',
      text: msg.text,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      role: msg.role,
      ...(msg.broadcastId !== undefined ? { broadcastId: msg.broadcastId } : {}),
    },
  };
}

/** Renders the provider + runner + a state probe. The probe surfaces
 * `unread` / toast count / latest sender as `data-testid` text so tests
 * can assert via standard RTL queries. */
function setup({ ensembles = [], path = '/' }: SetupOpts = {}): SetupHandle {
  const mock = new MockDashboardClient({ ensembles });
  __setDashboardClientForTests(mock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Pre-seed the list so `useEnsembleList` resolves synchronously —
  // the stream effect runs on the same render rather than waiting on
  // a network round-trip the mock would have to fake.
  qc.setQueryData(ENSEMBLES_QUERY_KEY, ensembles);

  function Probe() {
    const { unread, toasts } = useNotifications();
    return (
      <>
        <span data-testid="unread-state">{JSON.stringify(unread)}</span>
        <span data-testid="toast-count">{toasts.length}</span>
        <span data-testid="toast-senders">{toasts.map((t) => t.sender).join(',')}</span>
      </>
    );
  }

  const tree = (children: ReactNode) => (
    <NotificationProvider>
      <NotificationStreamRunner />
      <Probe />
      {children}
    </NotificationProvider>
  );

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/ensemble/:id" element={tree(null)} />
          <Route path="*" element={tree(null)} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    mock,
    qc,
    setEnsembles: async (next) => {
      await act(async () => {
        qc.setQueryData(ENSEMBLES_QUERY_KEY, next);
        // Yield a macrotask so the TanStack Query observer fires +
        // React commits + the stream effect re-runs + inner async
        // IIFE calls `client.subscribe(...)` to register the new
        // per-ensemble push function. Without this step, an immediate
        // `mock.emit(<new-ensemble>, ...)` lands on an empty pushers
        // bucket and is silently lost.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    },
    emit: async (ensemble, event) => {
      await act(async () => {
        mock.emit(ensemble, event);
        // The for-await body inside the stream effect runs on a
        // microtask after push() resolves the pending next(); yield
        // here so the eventual fire() lands inside this act boundary.
        await Promise.resolve();
      });
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('useNotificationStream — fire path', () => {
  it('fires for a chat.appended event with role="maestro-in"', async () => {
    const { emit } = setup({ ensembles: [makeSummary('backend')] });

    await emit(
      'backend',
      makeChatEvent({ role: 'maestro-in', from: 'lead', text: 'tests green' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('1');
    expect(screen.getByTestId('toast-senders').textContent).toBe('lead');
    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ backend: 1 }),
    );
  });

  it('tags ensembleId from the subscription boundary, not from the payload', async () => {
    // EnsembleChatMessage has no `ensemble` field. The stream MUST tag
    // from the per-ensemble subscription's name, otherwise a multi-
    // ensemble setup would mis-attribute toasts.
    const { emit } = setup({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });

    await emit(
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'shipping' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('1');
    // Tagged from 'release' even though payload has no ensemble field.
    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ release: 1 }),
    );
  });
});

describe('useNotificationStream — filter', () => {
  it('suppresses role="maestro-out" (outgoing maestro messages)', async () => {
    const { emit } = setup({ ensembles: [makeSummary('backend')] });

    await emit(
      'backend',
      makeChatEvent({ role: 'maestro-out', from: 'maestro', text: 'sent' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
    expect(screen.getByTestId('unread-state').textContent).toBe('{}');
  });

  it('suppresses role="conductor-in" (peer-to-peer observed traffic)', async () => {
    const { emit } = setup({ ensembles: [makeSummary('backend')] });

    await emit(
      'backend',
      makeChatEvent({ role: 'conductor-in', from: 'soloist', text: 'fyi' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
    expect(screen.getByTestId('unread-state').textContent).toBe('{}');
  });

  it('suppresses role="conductor-out" (peer-to-peer observed traffic)', async () => {
    const { emit } = setup({ ensembles: [makeSummary('backend')] });

    await emit(
      'backend',
      makeChatEvent({ role: 'conductor-out', from: 'conductor', text: 'go' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
    expect(screen.getByTestId('unread-state').textContent).toBe('{}');
  });

  it('ignores non-chat events (player.added, etc.) entirely', async () => {
    const { emit } = setup({ ensembles: [makeSummary('backend')] });

    // Cast through unknown — the payload shape doesn't matter for this
    // test since the stream's filter rejects every non-`chat.appended`
    // event before inspecting the payload, and re-spelling the full
    // PlayerSummaryV1 here would be redundant detail.
    await emit('backend', ({
      v: 1,
      type: 'player.added',
      eventId: '1735000000000:0',
      payload: { playerId: 'tempo-soloist-1' },
    } as unknown) as TempoEvent);

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
  });
});

describe('useNotificationStream — active-ensemble suppression', () => {
  it('does not toast or badge a chat from the URL-active ensemble', async () => {
    const { emit } = setup({
      ensembles: [makeSummary('backend'), makeSummary('release')],
      path: '/ensemble/backend',
    });

    await emit(
      'backend',
      makeChatEvent({ role: 'maestro-in', from: 'lead', text: 'in active room' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
    expect(screen.getByTestId('unread-state').textContent).toBe('{}');
  });

  it('still fires for OTHER ensembles while one is URL-active', async () => {
    const { emit } = setup({
      ensembles: [makeSummary('backend'), makeSummary('release')],
      path: '/ensemble/backend',
    });

    await emit(
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'shipping' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('1');
    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ release: 1 }),
    );
  });
});

describe('useNotificationStream — subscription teardown', () => {
  it('drops subscriptions for ensembles removed from the list', async () => {
    const { emit, setEnsembles } = setup({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });

    // Sanity: both subscriptions are live — emits to either fires.
    await emit(
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'first' }),
    );
    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ release: 1 }),
    );

    // Shrink the list — `release` is no longer a known ensemble; the
    // stream effect should re-run, aborting the old release subscription.
    await setEnsembles([makeSummary('backend')]);

    // Emit to the dropped ensemble — must NOT fire.
    await emit(
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'after-drop' }),
    );

    // State unchanged from the first emit — the second one was
    // dropped by the cancelled subscription's break path.
    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ release: 1 }),
    );
    expect(screen.getByTestId('toast-count').textContent).toBe('1');
  });

  it('keeps remaining ensembles wired through a list shrink', async () => {
    const { emit, setEnsembles } = setup({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });

    await setEnsembles([makeSummary('backend')]);

    await emit(
      'backend',
      makeChatEvent({ role: 'maestro-in', from: 'lead', text: 'after-shrink' }),
    );

    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ backend: 1 }),
    );
  });

  it('opens a subscription for an ensemble newly added to the list', async () => {
    const { emit, setEnsembles } = setup({
      ensembles: [makeSummary('backend')],
    });

    // Pre-grow, an emit to `release` would be lost (no subscription).
    // After the list grows, the stream effect re-runs and opens one.
    await setEnsembles([makeSummary('backend'), makeSummary('release')]);

    await emit(
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'after-grow' }),
    );

    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ release: 1 }),
    );
  });

  it('no-ops when the ensemble list is empty', async () => {
    const { emit } = setup({ ensembles: [] });

    // No subscriptions exist; emit() pushes to nobody (the mock's
    // pushers map has no entry). Fire must not run.
    await emit(
      'backend',
      makeChatEvent({ role: 'maestro-in', from: 'lead', text: 'lost' }),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('0');
    expect(screen.getByTestId('unread-state').textContent).toBe('{}');
  });
});

describe('useNotificationStream — multiple events', () => {
  it('groups same-sender consecutive maestro-in events under one toast', async () => {
    const { emit } = setup({ ensembles: [makeSummary('backend')] });

    await emit(
      'backend',
      makeChatEvent(
        { role: 'maestro-in', from: 'lead', text: 'one' },
        '1735000000000:0',
      ),
    );
    await emit(
      'backend',
      makeChatEvent(
        { role: 'maestro-in', from: 'lead', text: 'two' },
        '1735000000000:1',
      ),
    );

    expect(screen.getByTestId('toast-count').textContent).toBe('1');
    // Unread bumps independently per fire — both events count.
    expect(screen.getByTestId('unread-state').textContent).toBe(
      JSON.stringify({ backend: 2 }),
    );
  });
});
