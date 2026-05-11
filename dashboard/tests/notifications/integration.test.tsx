/**
 * Integration tests — commit 4 of feat/chat-notification-system.
 *
 * Verifies the full wire end-to-end through the production app shell:
 *   1. The router mounts NotificationProvider + NotificationStreamRunner.
 *   2. AppShell mounts ToastStack with a navigate handler.
 *   3. Sidebar renders UnreadBadge + the `.has-unread` modifier
 *      and clears the badge on click.
 *
 * Drives a real SSE event through `MockDashboardClient.emit` and
 * observes the live DOM. Same async-`act(...)` macrotask pattern as
 * `stream.test.tsx` — TanStack Query observer notifications +
 * cache writes don't propagate synchronously through React 19.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { EnsembleSummary, TempoEvent } from 'claude-tempo/http/event-types';
import type { EnsembleChatMessage } from 'claude-tempo/types';
import { App } from '../../src/App';
import { createDashboardMemoryRouter } from '../../src/router';
import { __setDashboardClientForTests } from '../../src/lib/client-singleton';
import { MockDashboardClient } from '../fixtures/mock-client';

function makeSummary(name: string, playerCount = 1): EnsembleSummary {
  return { name, playerCount, hasConductor: false };
}

function makeChatEvent(
  msg: Partial<EnsembleChatMessage> & {
    role: EnsembleChatMessage['role'];
    from: string;
    text: string;
  },
): TempoEvent {
  return {
    v: 1,
    type: 'chat.appended',
    eventId: '1735000000000:0',
    payload: {
      id: msg.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
      from: msg.from,
      to: msg.to ?? 'maestro',
      text: msg.text,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      role: msg.role,
    },
  };
}

async function renderApp(initialPath: string, mock: MockDashboardClient) {
  __setDashboardClientForTests(mock);
  const router = createDashboardMemoryRouter([initialPath]);
  const utils = render(<App router={router} />);
  // The App's QueryClient fetches `useEnsembleList()` asynchronously;
  // the stream effect opens per-ensemble subscriptions only AFTER the
  // query resolves. Wait for the sidebar to render an ensemble row
  // (proxy for "list query has resolved") before any test code emits
  // events — otherwise emits land on an empty pushers map.
  if (mock.ensembles.length > 0) {
    await screen.findByTestId(`sidebar-ensemble-${mock.ensembles[0].name}`);
  }
  return utils;
}

async function emitEvent(mock: MockDashboardClient, ensemble: string, event: TempoEvent) {
  await act(async () => {
    mock.emit(ensemble, event);
    // Yield a microtask so the for-await body inside the stream
    // effect processes the event + calls fire() within this act
    // boundary (avoids the "update was not wrapped in act" warning).
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('notifications integration', () => {
  it('renders a toast when a maestro-in chat event arrives for a non-active ensemble', async () => {
    const mock = new MockDashboardClient({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });
    await renderApp('/', mock);

    // Pre-state: no toasts.
    expect(screen.queryByTestId('toast-stack')).toBeNull();

    await emitEvent(
      mock,
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'shipping' }),
    );

    // Toast appears at the AppShell root.
    expect(screen.getByTestId('toast-stack')).toBeInTheDocument();
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('@liner');
    expect(toast.textContent).toContain('release');
    expect(toast.textContent).toContain('shipping');
  });

  it('decorates the sidebar row with a numeric badge + .has-unread modifier', async () => {
    const mock = new MockDashboardClient({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });
    await renderApp('/', mock);

    await emitEvent(
      mock,
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'one' }),
    );
    await emitEvent(
      mock,
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'two' }),
    );

    const row = screen.getByTestId('sidebar-ensemble-release');
    expect(row).toHaveClass('has-unread');
    // The UnreadBadge lives inside the row.
    const badge = row.querySelector('[data-testid="unread-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('2');
    expect(badge).toHaveAttribute('aria-label', '2 unread');
  });

  it('does NOT badge or toast when the chat event arrives for the URL-active ensemble', async () => {
    const mock = new MockDashboardClient({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });
    await renderApp('/ensemble/backend', mock);

    await emitEvent(
      mock,
      'backend',
      makeChatEvent({ role: 'maestro-in', from: 'lead', text: 'into active room' }),
    );

    expect(screen.queryByTestId('toast-stack')).toBeNull();
    const row = screen.getByTestId('sidebar-ensemble-backend');
    expect(row).not.toHaveClass('has-unread');
    expect(row.querySelector('[data-testid="unread-badge"]')).toBeNull();
  });

  it('clicking the sidebar row clears the badge synchronously (markRead path)', async () => {
    const mock = new MockDashboardClient({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });
    await renderApp('/', mock);

    await emitEvent(
      mock,
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'msg' }),
    );

    let row = screen.getByTestId('sidebar-ensemble-release');
    expect(row).toHaveClass('has-unread');

    act(() => {
      fireEvent.click(row);
    });

    // Re-query after click — navigation may swap the routed content.
    row = screen.getByTestId('sidebar-ensemble-release');
    expect(row).not.toHaveClass('has-unread');
    expect(row.querySelector('[data-testid="unread-badge"]')).toBeNull();
  });

  it('clicking a toast routes to that ensemble and drops the toast', async () => {
    const mock = new MockDashboardClient({
      ensembles: [makeSummary('backend'), makeSummary('release')],
    });
    await renderApp('/', mock);

    await emitEvent(
      mock,
      'release',
      makeChatEvent({ role: 'maestro-in', from: 'liner', text: 'click me' }),
    );

    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('release');

    await act(async () => {
      fireEvent.click(toast);
    });

    // Toast is gone — `ToastStack`'s onOpen handler calls
    // `navigate()` and `dismissToast()` together. The dismissal is
    // the observable "click went through the AppShell wiring"
    // signal at this integration layer; the route-change behaviour
    // is covered by `router.test.tsx`, and the badge-clearing side
    // effect of `setActiveEnsemble` is covered by
    // `provider.test.tsx`. Asserting both here would re-test
    // react-router-dom's memory-router and risk flakiness from its
    // async navigate semantics.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
