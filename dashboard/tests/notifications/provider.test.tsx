/**
 * NotificationProvider unit tests — commit 1 of feat/chat-notification-system.
 *
 * Covers the contract locked by the architect's design (§4.6 of
 * `docs/design/notifications-system.md`):
 *
 *   - fire() enqueues a toast and bumps unread
 *   - suppression: activeEnsemble === ensembleId → no toast, no badge
 *     (exercises both the URL-driven path AND the imperative
 *     setActiveEnsemble() path)
 *   - same-sender grouping within GROUP_WINDOW_MS → one toast w/ count
 *   - setActiveEnsemble() clears that ensemble's unread + drops pending toasts
 *   - markRead() clears badge but leaves the toast intact
 *   - dismissToast() drops one toast without touching unread
 *   - data-driven TTL: a merge re-arms the timer (so the merged toast
 *     lives 6 s from the LATEST message, not from the first)
 *   - soft-fallback no-op when called outside the provider
 *
 * UI components, CSS, and SSE wiring are NOT in scope here — they
 * land in commits 2-3 of this PR.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  GROUP_WINDOW_MS,
  NotificationProvider,
  TOAST_TIMEOUT_MS,
  useNotifications,
} from '../../src/lib/notifications';

/**
 * Build a `renderHook` wrapper that mounts the provider inside a
 * MemoryRouter at `initialPath`. The path drives `useParams` so
 * `activeEnsemble` mirrors the URL — letting one harness exercise
 * both the route-driven and the imperative `setActiveEnsemble` paths.
 */
function wrap(initialPath = '/') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/ensemble/:id"
            element={<NotificationProvider>{children}</NotificationProvider>}
          />
          <Route
            path="*"
            element={<NotificationProvider>{children}</NotificationProvider>}
          />
        </Routes>
      </MemoryRouter>
    );
  };
}

describe('NotificationProvider', () => {
  describe('fire()', () => {
    it('enqueues a toast and bumps unread for a non-active ensemble', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({
          ensembleId: 'backend-team',
          sender: 'lead',
          body: 'tests green on auth/refresh',
        });
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0]).toMatchObject({
        ensembleId: 'backend-team',
        ensembleName: 'backend-team', // defaults to id when name omitted
        sender: 'lead',
        body: 'tests green on auth/refresh',
        count: 1,
      });
      expect(result.current.unread).toEqual({ 'backend-team': 1 });
    });

    it('uses the supplied ensembleName when provided', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({
          ensembleId: 'backend-team',
          ensembleName: 'Backend Team',
          sender: 'lead',
          body: 'hello',
        });
      });

      expect(result.current.toasts[0].ensembleName).toBe('Backend Team');
    });

    it('preserves senderType for downstream avatar hue lookup', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({
          ensembleId: 'backend-team',
          sender: 'lead',
          senderType: 'tempo-soloist',
          body: 'hi',
        });
      });

      expect(result.current.toasts[0].senderType).toBe('tempo-soloist');
    });
  });

  describe('suppression rule', () => {
    it('drops the toast and skips the badge bump when activeEnsemble matches via URL', () => {
      const { result } = renderHook(() => useNotifications(), {
        wrapper: wrap('/ensemble/backend-team'),
      });

      // URL → activeEnsemble sync runs in an effect; renderHook's
      // internal act() flushes effects before returning, so the active
      // ensemble is already set on the first observed render.
      expect(result.current.activeEnsemble).toBe('backend-team');

      act(() => {
        result.current.fire({
          ensembleId: 'backend-team',
          sender: 'lead',
          body: 'into the active room',
        });
      });

      expect(result.current.toasts).toHaveLength(0);
      expect(result.current.unread).toEqual({});
    });

    it('drops the toast and skips the badge bump when activeEnsemble is set imperatively', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.setActiveEnsemble('backend-team');
      });
      act(() => {
        result.current.fire({
          ensembleId: 'backend-team',
          sender: 'lead',
          body: 'into the active room',
        });
      });

      expect(result.current.toasts).toHaveLength(0);
      expect(result.current.unread).toEqual({});
    });

    it('still fires for OTHER ensembles while one is active', () => {
      const { result } = renderHook(() => useNotifications(), {
        wrapper: wrap('/ensemble/my-band'),
      });

      act(() => {
        result.current.fire({
          ensembleId: 'release-crew',
          sender: 'liner',
          body: 'shipping the changelog',
        });
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].ensembleId).toBe('release-crew');
      expect(result.current.unread).toEqual({ 'release-crew': 1 });
    });
  });

  describe('grouping', () => {
    beforeEach(() => {
      // Vitest fakes Date by default along with timers, so wall-clock
      // arithmetic inside fire() (firstAt / expiresAt / now) advances
      // step-for-step with vi.advanceTimersByTime.
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('collapses 3 messages from the same sender within the window into one toast', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 1' });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 2' });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 3' });
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0]).toMatchObject({
        ensembleId: 'backend',
        sender: 'lead',
        body: 'msg 3', // most recent body wins
        count: 3,
      });
      // Unread bumps independently per fire — each fire was a non-active room.
      expect(result.current.unread).toEqual({ backend: 3 });
    });

    it('does not group different senders inside the same ensemble', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 1' });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.fire({ ensembleId: 'backend', sender: 'composer', body: 'msg 2' });
      });

      expect(result.current.toasts).toHaveLength(2);
      expect(result.current.toasts.map((t) => t.sender)).toEqual(['lead', 'composer']);
    });

    it('does not group across ensembles even from the same sender', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 1' });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.fire({ ensembleId: 'release', sender: 'lead', body: 'msg 2' });
      });

      expect(result.current.toasts).toHaveLength(2);
      expect(result.current.toasts.map((t) => t.ensembleId)).toEqual(['backend', 'release']);
    });

    it('starts a new toast once the grouping window elapses (measured from firstAt)', () => {
      // GROUP_WINDOW_MS (8s) > TOAST_TIMEOUT_MS (6s), so the only way to
      // keep the original toast alive long enough to test the
      // post-window branch is to merge once mid-window — that bumps
      // expiresAt while leaving firstAt at 0.
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 1' });
      });
      // t=4000: merge → firstAt stays 0, count=2, expiresAt=10000.
      act(() => {
        vi.advanceTimersByTime(4000);
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 2' });
      });
      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].count).toBe(2);

      // t=9000: now - firstAt = 9000 ≥ GROUP_WINDOW_MS (8000) → no
      // merge. The toast is still alive (expiresAt=10000), so we end
      // up with two distinct toasts.
      act(() => {
        vi.advanceTimersByTime(5000);
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 3' });
      });

      expect(result.current.toasts).toHaveLength(2);
      expect(result.current.toasts[0].count).toBe(2);
      expect(result.current.toasts[1].count).toBe(1);
    });
  });

  describe('setActiveEnsemble', () => {
    it('clears unread and drops pending toasts FROM the now-active ensemble', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: '1' });
        result.current.fire({ ensembleId: 'release', sender: 'liner', body: '2' });
      });

      expect(result.current.toasts).toHaveLength(2);
      expect(result.current.unread).toEqual({ backend: 1, release: 1 });

      act(() => {
        result.current.setActiveEnsemble('backend');
      });

      // backend's badge cleared + its toast dropped; release survives.
      expect(result.current.unread).toEqual({ release: 1 });
      expect(result.current.toasts.map((t) => t.ensembleId)).toEqual(['release']);
    });

    it('reflects URL-driven active ensemble in the context value', () => {
      const { result } = renderHook(() => useNotifications(), {
        wrapper: wrap('/ensemble/backend'),
      });

      expect(result.current.activeEnsemble).toBe('backend');

      // Fire for a different ensemble to confirm suppression isn't
      // accidentally tied to a hard-coded value.
      act(() => {
        result.current.fire({ ensembleId: 'release', sender: 'liner', body: '1' });
      });
      expect(result.current.unread).toEqual({ release: 1 });
    });

    it('passing null clears active ensemble without touching state', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: '1' });
        result.current.setActiveEnsemble('release'); // unrelated ensemble
      });
      expect(result.current.unread).toEqual({ backend: 1 });
      expect(result.current.toasts).toHaveLength(1);

      act(() => {
        result.current.setActiveEnsemble(null);
      });

      // Null doesn't drop anything — only the matching-id branch does.
      expect(result.current.unread).toEqual({ backend: 1 });
      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.activeEnsemble).toBeNull();
    });
  });

  describe('markRead', () => {
    it('clears the unread badge but leaves the toast in place', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: '1' });
      });
      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.unread).toEqual({ backend: 1 });

      act(() => {
        result.current.markRead('backend');
      });

      expect(result.current.unread).toEqual({});
      expect(result.current.toasts).toHaveLength(1);
    });

    it('is a no-op for an ensemble with no unread', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      const before = result.current.unread;
      act(() => {
        result.current.markRead('nope');
      });
      // Same reference — the updater short-circuits when there's
      // nothing to clear, so React skips the re-render.
      expect(result.current.unread).toBe(before);
    });
  });

  describe('dismissToast', () => {
    it('removes one toast by id without touching unread', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: '1' });
      });
      const id = result.current.toasts[0].id;

      act(() => {
        result.current.dismissToast(id);
      });

      expect(result.current.toasts).toHaveLength(0);
      // Badge persists — dismissing the toast doesn't mean "I read it".
      expect(result.current.unread).toEqual({ backend: 1 });
    });
  });

  describe('TTL', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-dismisses a toast after TOAST_TIMEOUT_MS', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: '1' });
      });
      expect(result.current.toasts).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1);
      });
      expect(result.current.toasts).toHaveLength(1); // still alive

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(result.current.toasts).toHaveLength(0); // dismissed
    });

    it('extends the TTL when grouping merges a toast (data-driven re-arm)', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 1' });
      });
      // Group-merge at t=4000 (the original toast would have expired
      // at t=6000). The merge bumps expiresAt to t=4000+6000=10000.
      act(() => {
        vi.advanceTimersByTime(4000);
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: 'msg 2' });
      });
      expect(result.current.toasts[0].count).toBe(2);

      // Just before the new expiry — still alive.
      act(() => {
        vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1);
      });
      expect(result.current.toasts).toHaveLength(1);

      // Cross the new expiry — gone.
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(result.current.toasts).toHaveLength(0);
    });

    it('clears the timer when a toast is dismissed manually', () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: wrap('/') });

      act(() => {
        result.current.fire({ ensembleId: 'backend', sender: 'lead', body: '1' });
      });
      const id = result.current.toasts[0].id;

      act(() => {
        result.current.dismissToast(id);
      });
      expect(result.current.toasts).toHaveLength(0);

      // Past the original TTL — nothing should resurface; the timer
      // was cleared by the effect's cleanup when toasts shrank.
      act(() => {
        vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 2);
      });
      expect(result.current.toasts).toHaveLength(0);
    });
  });

  describe('soft-fallback (no provider)', () => {
    it('returns a no-op hook value when called outside a provider', () => {
      // Bare MemoryRouter — no NotificationProvider wrapper.
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
      );
      const { result } = renderHook(() => useNotifications(), { wrapper });

      expect(result.current.activeEnsemble).toBeNull();
      expect(result.current.unread).toEqual({});
      expect(result.current.toasts).toEqual([]);

      // Setters / fire are silent no-ops — must NOT throw.
      expect(() => {
        result.current.setActiveEnsemble('foo');
        result.current.fire({ ensembleId: 'foo', sender: 'a', body: 'b' });
        result.current.markRead('foo');
        result.current.dismissToast(0);
      }).not.toThrow();

      // State stays empty after no-op calls.
      expect(result.current.toasts).toEqual([]);
      expect(result.current.unread).toEqual({});
    });
  });
});
