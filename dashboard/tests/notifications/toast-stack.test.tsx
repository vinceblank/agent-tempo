/**
 * ToastStack + Toast component tests — commit 2 of
 * feat/chat-notification-system.
 *
 * Drives the components via the real provider so the full path
 * (fire → state → render → click → dismiss) is exercised end-to-end.
 * Stream-level tests (mocked SSE driving fire) live in commit 3's
 * `stream.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  NotificationProvider,
  useNotifications,
  type NotificationFireEvent,
} from '../../src/lib/notifications';
import { ToastStack } from '../../src/components/notifications/ToastStack';

interface SetupOpts {
  /** Toasts to seed via fire() in a useEffect after mount. */
  initialFires?: NotificationFireEvent[];
  /** onOpen handler the stack passes to each Toast — defaults to a vi.fn(). */
  onOpen?: (ensembleId: string) => void;
}

interface SetupHandle {
  /** Fire another toast after the initial render. Wraps in act(). */
  fire: (evt: NotificationFireEvent) => void;
  /** Captured onOpen spy (the supplied one or the default vi.fn()). */
  onOpen: ReturnType<typeof vi.fn>;
}

/**
 * Render the ToastStack inside a MemoryRouter + NotificationProvider,
 * seed initial toasts via a `<Seed>` probe, and capture the `fire`
 * callback into a ref so tests can dispatch additional toasts after
 * mount without re-rendering.
 */
function setup({ initialFires = [], onOpen }: SetupOpts = {}): SetupHandle {
  const onOpenSpy = vi.fn(onOpen);

  // Captured at first useNotifications() call inside the provider.
  // Defined here so the closures inside <Seed>/<Capture> can write
  // through. We assign in an effect (post-mount), so React's render
  // pass is pure.
  const ref: { fire: ((evt: NotificationFireEvent) => void) | null } = {
    fire: null,
  };

  function Capture() {
    const { fire } = useNotifications();
    ref.fire = fire;
    return null;
  }

  function Seed() {
    const { fire } = useNotifications();
    useEffect(() => {
      initialFires.forEach((e) => fire(e));
      // Mount-only effect. `fire` is stable per commit-1's ref-backed
      // closure and `initialFires` is frozen for the lifetime of the
      // setup() call, so re-firing on dep change isn't a real concern
      // — but exhaustive-deps doesn't know that.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  render(
    <MemoryRouter initialEntries={['/']}>
      <NotificationProvider>
        <Capture />
        <Seed />
        <ToastStack onOpen={onOpenSpy} />
      </NotificationProvider>
    </MemoryRouter>,
  );

  return {
    fire: (evt) => {
      act(() => {
        ref.fire?.(evt);
      });
    },
    onOpen: onOpenSpy,
  };
}

describe('ToastStack', () => {
  it('renders nothing when there are no toasts', () => {
    setup();
    expect(screen.queryByTestId('toast-stack')).toBeNull();
  });

  it('renders the toast-stack region when at least one toast is live', () => {
    setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'hello' }],
    });
    const region = screen.getByTestId('toast-stack');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('role', 'region');
    expect(region).toHaveAttribute('aria-label', 'Notifications');
  });

  it('renders the newest toast first (data-stack-index="0") and stacks older below', () => {
    setup({
      initialFires: [
        { ensembleId: 'a', sender: 's1', body: 'first message' },
        { ensembleId: 'b', sender: 's2', body: 'second message' },
        { ensembleId: 'c', sender: 's3', body: 'third message' },
      ],
    });

    const toasts = screen.getAllByRole('alert');
    expect(toasts).toHaveLength(3);

    // Newest is first in DOM (the flex `column-reverse` flip then
    // visually places it at the bottom — see ToastStack comments).
    expect(toasts[0]).toHaveAttribute('data-stack-index', '0');
    expect(toasts[0].textContent).toContain('third message');

    expect(toasts[1]).toHaveAttribute('data-stack-index', '1');
    expect(toasts[1].textContent).toContain('second message');

    expect(toasts[2]).toHaveAttribute('data-stack-index', '2');
    expect(toasts[2].textContent).toContain('first message');
  });

  it('caps visible toasts at MAX_VISIBLE_TOASTS and surfaces a "+N more" overflow chip', () => {
    setup({
      initialFires: [1, 2, 3, 4, 5].map((n) => ({
        ensembleId: `e${n}`,
        sender: `s${n}`,
        body: `m${n}`,
      })),
    });

    const toasts = screen.getAllByRole('alert');
    expect(toasts).toHaveLength(3);

    const overflow = screen.getByTestId('toast-overflow');
    expect(overflow).toBeInTheDocument();
    expect(overflow.textContent).toBe('+2 more');
  });

  it('does NOT render the overflow chip when total toasts ≤ cap', () => {
    setup({
      initialFires: [1, 2].map((n) => ({
        ensembleId: `e${n}`,
        sender: `s${n}`,
        body: `m${n}`,
      })),
    });
    expect(screen.queryByTestId('toast-overflow')).toBeNull();
  });

  it('clicking a toast routes via onOpen and drops it from the stack', () => {
    const { onOpen } = setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'click me' }],
    });

    const toast = screen.getByRole('alert');
    act(() => {
      fireEvent.click(toast);
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('backend');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clicking the × close button dismisses without calling onOpen', () => {
    const { onOpen } = setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn).toHaveAttribute('data-testid', 'toast-dismiss');

    act(() => {
      fireEvent.click(closeBtn);
    });

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clicking the ghost Dismiss button dismisses without calling onOpen', () => {
    const { onOpen } = setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissBtn).toHaveAttribute('data-testid', 'toast-dismiss');

    act(() => {
      fireEvent.click(dismissBtn);
    });

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clicking the Reply button routes via onOpen (same as clicking the body)', () => {
    const { onOpen } = setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });

    const replyBtn = screen.getByRole('button', { name: 'Reply →' });
    expect(replyBtn).toHaveAttribute('data-testid', 'toast-reply');

    act(() => {
      fireEvent.click(replyBtn);
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('backend');
  });

  it('Reply button stops event propagation so onOpen fires exactly once', () => {
    // Without stopPropagation, the click would bubble to the toast
    // div's onClick and trigger onOpen a second time.
    const { onOpen } = setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply →' }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders a count chip when a toast represents grouped messages', () => {
    const { fire } = setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'first' }],
    });
    fire({ ensembleId: 'backend', sender: 'lead', body: 'second' });
    fire({ ensembleId: 'backend', sender: 'lead', body: 'third' });

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('third'); // most recent body wins
    // Count chip surfaces the grouped total.
    const countEl = toast.querySelector('.toast-count');
    expect(countEl).not.toBeNull();
    expect(countEl?.textContent).toBe('3');
  });

  it('does NOT render a count chip for an ungrouped (count=1) toast', () => {
    setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'lone' }],
    });
    const toast = screen.getByRole('alert');
    expect(toast.querySelector('.toast-count')).toBeNull();
  });

  it('Toast root carries data-testid="toast-${id}" + the stable "toast" class', () => {
    setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });
    const toast = screen.getByRole('alert');
    expect(toast).toHaveClass('toast');
    expect(toast.getAttribute('data-testid')).toMatch(/^toast-\d+$/);
  });

  it('Toast avatar renders the sender initial uppercased', () => {
    setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });
    const toast = screen.getByRole('alert');
    const avatar = toast.querySelector('.toast-avatar');
    expect(avatar?.textContent).toBe('L');
  });

  it('Toast head shows @sender and ensemble name', () => {
    setup({
      initialFires: [
        {
          ensembleId: 'backend',
          ensembleName: 'Backend Team',
          sender: 'lead',
          body: 'tests green',
        },
      ],
    });
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('@lead');
    expect(toast.textContent).toContain('Backend Team');
    expect(toast.textContent).toContain('tests green');
  });
});

describe('ToastStack with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a toast disappears from the stack after the provider TTL fires', () => {
    setup({
      initialFires: [{ ensembleId: 'backend', sender: 'lead', body: 'msg' }],
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    act(() => {
      // TOAST_TIMEOUT_MS is 6000 — see notifications.tsx.
      vi.advanceTimersByTime(7000);
    });

    expect(screen.queryByRole('alert')).toBeNull();
    // Stack region also unmounts when the queue is empty.
    expect(screen.queryByTestId('toast-stack')).toBeNull();
  });
});
