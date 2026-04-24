/**
 * #306: Bottom-pinned notification stack — reducer contract tests.
 *
 * Covers:
 *  - Adding N notifications stacks them in order.
 *  - Expired entries are filtered out on every new add (lazy cleanup).
 *  - Cap at NOTIFICATION_CAP — the oldest entry drops when exceeded.
 *  - DISMISS_OLDEST_NOTIFICATION removes the oldest live entry (Esc).
 *  - DISMISS_NOTIFICATION removes by id.
 *  - CLEAR_NOTIFICATIONS empties the stack.
 *  - Per-kind TTL values (errors get extra time to read).
 *  - commitNotification helper dispatches the correct action shape.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  initialState,
  tuiReducer,
  NOTIFICATION_TTL_MS,
  NOTIFICATION_CAP,
  type TuiAction,
  type TuiState,
  type NotificationItem,
} from '../../src/tui/store';
import { commitNotification } from '../../src/tui/commands';
import { stripLeadingIcon } from '../../src/tui/App';

function makeNotification(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: overrides.id ?? 1,
    kind: overrides.kind ?? 'error',
    content: overrides.content ?? 'test message',
    timestamp: overrides.timestamp ?? Date.now(),
    expiresAt: overrides.expiresAt ?? Date.now() + 10_000,
    ...overrides,
  };
}

describe('notifications reducer (#306)', () => {
  it('ADD_NOTIFICATION appends to an empty stack', () => {
    const s0 = initialState('demo');
    expect(s0.notifications).toEqual([]);
    const out = tuiReducer(s0, {
      type: 'ADD_NOTIFICATION',
      notification: makeNotification({ id: 1, content: 'first' }),
    });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0].content).toBe('first');
  });

  it('ADD_NOTIFICATION stacks multiple live entries in insertion order', () => {
    let state: TuiState = initialState('demo');
    for (let i = 1; i <= 3; i++) {
      state = tuiReducer(state, {
        type: 'ADD_NOTIFICATION',
        notification: makeNotification({ id: i, content: `msg${i}` }),
      });
    }
    expect(state.notifications.map(n => n.content)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('ADD_NOTIFICATION filters expired entries before appending', () => {
    const now = Date.now();
    const seeded: TuiState = {
      ...initialState('demo'),
      notifications: [
        // Already expired
        makeNotification({ id: 1, content: 'stale', expiresAt: now - 1000 }),
        // Still live
        makeNotification({ id: 2, content: 'fresh', expiresAt: now + 5000 }),
      ],
    };
    const out = tuiReducer(seeded, {
      type: 'ADD_NOTIFICATION',
      notification: makeNotification({ id: 3, content: 'new', expiresAt: now + 8000 }),
    });
    // Expired 'stale' was dropped; 'fresh' + 'new' remain.
    expect(out.notifications.map(n => n.content)).toEqual(['fresh', 'new']);
  });

  it(`caps the stack at NOTIFICATION_CAP (${NOTIFICATION_CAP}) — oldest drops`, () => {
    let state: TuiState = initialState('demo');
    for (let i = 1; i <= NOTIFICATION_CAP + 2; i++) {
      state = tuiReducer(state, {
        type: 'ADD_NOTIFICATION',
        notification: makeNotification({ id: i, content: `msg${i}` }),
      });
    }
    // With NOTIFICATION_CAP = 3, after 5 adds, the oldest 2 dropped.
    expect(state.notifications).toHaveLength(NOTIFICATION_CAP);
    expect(state.notifications[0].id).toBe(3);
    expect(state.notifications[NOTIFICATION_CAP - 1].id).toBe(NOTIFICATION_CAP + 2);
  });

  it('DISMISS_NOTIFICATION removes the matching id and leaves the rest', () => {
    let state: TuiState = initialState('demo');
    for (let i = 1; i <= 3; i++) {
      state = tuiReducer(state, {
        type: 'ADD_NOTIFICATION',
        notification: makeNotification({ id: i }),
      });
    }
    const out = tuiReducer(state, { type: 'DISMISS_NOTIFICATION', id: 2 });
    expect(out.notifications.map(n => n.id)).toEqual([1, 3]);
  });

  it('DISMISS_NOTIFICATION returns the same reference when id is unknown', () => {
    const seeded: TuiState = {
      ...initialState('demo'),
      notifications: [makeNotification({ id: 1 })],
    };
    const out = tuiReducer(seeded, { type: 'DISMISS_NOTIFICATION', id: 999 });
    expect(out).toBe(seeded);
  });

  it('DISMISS_OLDEST_NOTIFICATION removes the oldest live notification (Esc path)', () => {
    const now = Date.now();
    const seeded: TuiState = {
      ...initialState('demo'),
      notifications: [
        makeNotification({ id: 1, expiresAt: now + 5000, content: 'first' }),
        makeNotification({ id: 2, expiresAt: now + 5000, content: 'second' }),
        makeNotification({ id: 3, expiresAt: now + 5000, content: 'third' }),
      ],
    };
    const out = tuiReducer(seeded, { type: 'DISMISS_OLDEST_NOTIFICATION' });
    expect(out.notifications.map(n => n.content)).toEqual(['second', 'third']);
  });

  it('DISMISS_OLDEST_NOTIFICATION skips expired entries — acts on what the user sees', () => {
    const now = Date.now();
    const seeded: TuiState = {
      ...initialState('demo'),
      notifications: [
        makeNotification({ id: 1, expiresAt: now - 1000, content: 'stale' }),
        makeNotification({ id: 2, expiresAt: now + 5000, content: 'fresh' }),
      ],
    };
    const out = tuiReducer(seeded, { type: 'DISMISS_OLDEST_NOTIFICATION' });
    // 'stale' was expired; Esc consumed only 'fresh'.
    expect(out.notifications).toHaveLength(0);
  });

  it('DISMISS_OLDEST_NOTIFICATION returns same reference when the stack is empty', () => {
    const s0 = initialState('demo');
    const out = tuiReducer(s0, { type: 'DISMISS_OLDEST_NOTIFICATION' });
    expect(out).toBe(s0);
  });

  it('CLEAR_NOTIFICATIONS empties the stack', () => {
    const seeded: TuiState = {
      ...initialState('demo'),
      notifications: [makeNotification({ id: 1 }), makeNotification({ id: 2 })],
    };
    const out = tuiReducer(seeded, { type: 'CLEAR_NOTIFICATIONS' });
    expect(out.notifications).toEqual([]);
  });

  it('CLEAR_NOTIFICATIONS is a no-op (same reference) when already empty', () => {
    const s0 = initialState('demo');
    const out = tuiReducer(s0, { type: 'CLEAR_NOTIFICATIONS' });
    expect(out).toBe(s0);
  });

  it('NOTIFICATION_TICK bumps the tick counter without touching notifications', () => {
    const seeded: TuiState = {
      ...initialState('demo'),
      notifications: [makeNotification({ id: 1 })],
      notificationTick: 0,
    };
    const out = tuiReducer(seeded, { type: 'NOTIFICATION_TICK' });
    expect(out.notificationTick).toBe(1);
    // Notifications array reference preserved — cheap re-render, not a rebuild.
    expect(out.notifications).toBe(seeded.notifications);
  });

  it('errors get a longer TTL than warn/info so guard refusals stay readable', () => {
    // Pin the ratio — errors must outlive warn/info by design (docstring).
    expect(NOTIFICATION_TTL_MS.error).toBeGreaterThan(NOTIFICATION_TTL_MS.warn);
    expect(NOTIFICATION_TTL_MS.error).toBeGreaterThan(NOTIFICATION_TTL_MS.info);
  });
});

describe('commitNotification helper (#306)', () => {
  it('dispatches ADD_NOTIFICATION with the correct kind + content', () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    commitNotification(dispatch, 'error', 'kaboom');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [action] = dispatch.mock.calls[0] as [{ type: string; notification: NotificationItem }];
    expect(action.type).toBe('ADD_NOTIFICATION');
    expect(action.notification.kind).toBe('error');
    expect(action.notification.content).toBe('kaboom');
    // Sanity: monotonic id, future expiry.
    expect(action.notification.id).toBeGreaterThan(0);
    expect(action.notification.expiresAt).toBeGreaterThan(action.notification.timestamp);
  });

  it('TTL-per-kind: error TTL is longer than info TTL', () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    commitNotification(dispatch, 'error', 'critical');
    commitNotification(dispatch, 'info', 'fyi');
    const [err] = dispatch.mock.calls[0] as [{ notification: NotificationItem }];
    const [info] = dispatch.mock.calls[1] as [{ notification: NotificationItem }];
    const errTtl = err.notification.expiresAt - err.notification.timestamp;
    const infoTtl = info.notification.expiresAt - info.notification.timestamp;
    expect(errTtl).toBeGreaterThan(infoTtl);
  });

  it('id monotonically increases across calls', () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    commitNotification(dispatch, 'warn', 'one');
    commitNotification(dispatch, 'warn', 'two');
    const [first] = dispatch.mock.calls[0] as [{ notification: NotificationItem }];
    const [second] = dispatch.mock.calls[1] as [{ notification: NotificationItem }];
    expect(second.notification.id).toBeGreaterThan(first.notification.id);
  });
});

describe('stripLeadingIcon (#306)', () => {
  // The renderer prepends a kind-based icon; many historical call sites
  // also embedded the icon in the content string. Without normalization
  // the user sees the icon twice (e.g. "✗ ✗ Cannot destroy …"). This
  // helper de-duplicates at the render boundary.
  it('strips a leading "✗ " from error-style content', () => {
    expect(stripLeadingIcon('✗ foo')).toBe('foo');
  });

  it('strips a leading "⚠ " from warn-style content', () => {
    expect(stripLeadingIcon('⚠ bar')).toBe('bar');
  });

  it('strips a leading "ⓘ " from info-style content', () => {
    expect(stripLeadingIcon('ⓘ baz')).toBe('baz');
  });

  it('leaves content without a leading icon unchanged', () => {
    expect(stripLeadingIcon('no icon')).toBe('no icon');
  });

  it('only strips the single leading icon, not occurrences mid-string', () => {
    expect(stripLeadingIcon('foo ✗ bar')).toBe('foo ✗ bar');
  });

  it('does not strip an icon that lacks a trailing space', () => {
    // The renderer always emits "icon + space"; a bare leading glyph
    // without a space is most likely intentional (not a duplicated icon).
    expect(stripLeadingIcon('✗bar')).toBe('✗bar');
  });
});
