/**
 * Notifications — cross-ensemble chat-toast + sidebar-badge state.
 *
 * Architecture (architect's design — `docs/design/notifications-system.md`):
 *
 *   NotificationProvider (mounted inside ShellLayout in `router.tsx`,
 *   so `useParams` resolves and state survives across every route change)
 *     ├── activeEnsemble — URL-derived (`/ensemble/:id`)
 *     ├── unread: Record<ensembleId, count>
 *     ├── toasts: NotificationToast[]
 *     ├── fire(evt)             — enqueue + bump unread (suppression rule applied)
 *     ├── markRead(id)          — clear one ensemble's badge
 *     ├── setActiveEnsemble(id) — also clears unread + drops pending toasts FROM id
 *     └── dismissToast(id)      — drop one toast by id
 *
 * Behaviour rules (LOCKED by vinceblank in chat2.md:5859-6116):
 *
 *   1. **Filter**: only `role === 'maestro-in'` events trigger fire(),
 *      enforced upstream in `useNotificationStream` (commit 3). The
 *      provider itself trusts every fire() call.
 *
 *   2. **Suppression**: when `activeEnsemble === message.ensembleId`,
 *      no toast and no badge bump — the chat panel is already showing
 *      the message live.
 *
 *   3. **Grouping**: within `GROUP_WINDOW_MS` (8 s), repeat messages
 *      from the same `(ensembleId, sender)` pair merge into the
 *      previous toast — `count` increments and `expiresAt` resets.
 *
 *   4. **TTL**: toasts auto-dismiss after `TOAST_TIMEOUT_MS` (6 s).
 *      The expiry is data-driven from `expiresAt`, not setTimeout-per-
 *      mount. The array is the single source of truth.
 *
 *   5. **Cap**: rendering caps visible toasts at `MAX_VISIBLE_TOASTS`
 *      (3); the overflow chip is a UI-layer concern (commit 2).
 *
 * Commit-1 scope (this file): provider + hook + helper. UI components,
 * CSS, SSE wiring, and shell integration land in commits 2-4.
 *
 * Why URL not Zustand: `Sidebar`, `AppShell`, `Workspace` already read
 * `useParams<{id}>()`. Adding a parallel store creates a re-syncing
 * problem on back-button / deep-link. The URL is reliable, observable,
 * already wired everywhere — see design doc §4.1.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router-dom';
import type { EnsembleChatMessage } from 'agent-tempo/types';
import { getDashboardClient } from './client-singleton';
import { useEnsembleList } from './queries';

/** Toast TTL in ms — auto-dismiss after this duration. */
export const TOAST_TIMEOUT_MS = 6000;

/** Cap on rendered toasts; older roll into a `+N more` overflow chip. */
export const MAX_VISIBLE_TOASTS = 3;

/**
 * Same-sender grouping window. Repeat messages from the same
 * `(ensembleId, sender)` pair within this many ms collapse into a
 * single toast with a count chip rather than spamming the corner.
 */
export const GROUP_WINDOW_MS = 8000;

/** Shape callers pass to `fire()`. `ensembleName` defaults to `ensembleId`. */
export interface NotificationFireEvent {
  ensembleId: string;
  ensembleName?: string;
  sender: string;
  /** Player type used for avatar hue derivation; degrades to neutral on miss. */
  senderType?: string;
  body: string;
}

/** A live toast. Held in the provider's `toasts` array. */
export interface NotificationToast {
  id: number;
  ensembleId: string;
  ensembleName: string;
  sender: string;
  senderType?: string;
  body: string;
  /** Wall-clock ms — when the first message of the group arrived. */
  firstAt: number;
  /** Wall-clock ms — when the latest message of the group arrived. */
  ts: number;
  /** Wall-clock ms — when the toast auto-dismisses. */
  expiresAt: number;
  /** Number of grouped messages collapsed into this toast (>= 1). */
  count: number;
}

export interface NotificationContextValue {
  /** URL-derived active ensemble; `null` outside `/ensemble/:id`. */
  activeEnsemble: string | null;
  /** Override the active ensemble — clears its unread + drops pending toasts FROM it. */
  setActiveEnsemble: (id: string | null) => void;
  /** Per-ensemble unread counts (only ensembles with > 0 unread are keys). */
  unread: Readonly<Record<string, number>>;
  /** Clear one ensemble's badge without touching pending toasts. */
  markRead: (ensembleId: string) => void;
  /** Live toast queue, oldest-first. UI reverses for newest-on-top stacks. */
  toasts: ReadonlyArray<NotificationToast>;
  /** Drop one toast by id. */
  dismissToast: (toastId: number) => void;
  /** Enqueue a notification — applies grouping, suppression, and badging. */
  fire: (evt: NotificationFireEvent) => void;
}

/**
 * Soft-fallback used when `useNotifications()` is called outside a
 * provider — keeps unit-tested screens that render standalone (no
 * `NotificationProvider` wrapper) from having to no-op manually.
 * Frozen so callers can't accidentally mutate the shared instance.
 */
const NOOP_VALUE: NotificationContextValue = Object.freeze({
  activeEnsemble: null,
  setActiveEnsemble: () => {},
  unread: Object.freeze({}),
  markRead: () => {},
  toasts: Object.freeze([]),
  dismissToast: () => {},
  fire: () => {},
});

const NotificationCtx = createContext<NotificationContextValue | null>(null);

/**
 * Read the active ensemble id from the route. Returns `null` outside
 * `/ensemble/:id`. Single source of truth — `Sidebar`, `AppShell`, and
 * the notification provider all read it the same way (design §4.1).
 */
export function useActiveEnsembleId(): string | null {
  const { id } = useParams<{ id?: string }>();
  return id ?? null;
}

/**
 * Consume notification state. Returns a no-op stub outside the
 * provider so screens rendered standalone in tests don't have to wrap
 * themselves in one to compile.
 */
export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationCtx);
  return ctx ?? NOOP_VALUE;
}

export interface NotificationProviderProps {
  children: ReactNode;
}

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [activeEnsemble, setActiveEnsembleState] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<NotificationToast[]>([]);
  const idRef = useRef(1);

  /**
   * Mirror `activeEnsemble` into a ref so `fire` can read the current
   * value without re-creating its closure on every URL change. Two
   * reasons:
   *   1. Keeps `fire` referentially stable across renders, which
   *      matters for `useNotificationStream` (commit 3) — a churning
   *      identity tears down + re-opens every per-ensemble subscription
   *      on every navigation.
   *   2. The ref reflects the latest `setActiveEnsemble(id)` call
   *      synchronously, so a fire() that races a navigation still
   *      sees a consistent activeEnsemble.
   */
  const activeRef = useRef<string | null>(null);

  const setActiveEnsemble = useCallback((id: string | null) => {
    activeRef.current = id;
    setActiveEnsembleState(id);
    if (id == null) return;
    // Auto-clear unread + drop pending toasts FROM the now-open room.
    // The user is looking at it; the chat panel is the notification
    // surface for that ensemble.
    setUnread((u) => {
      if (!u[id]) return u;
      const next = { ...u };
      delete next[id];
      return next;
    });
    setToasts((arr) => arr.filter((t) => t.ensembleId !== id));
  }, []);

  // URL → in-state sync. The provider lives inside the router so
  // `useParams` resolves; this effect drives the side effects of an
  // ensemble switch (clear-unread + drop-pending) on every URL change.
  const urlActive = useActiveEnsembleId();
  useEffect(() => {
    setActiveEnsemble(urlActive);
  }, [urlActive, setActiveEnsemble]);

  const markRead = useCallback((ensembleId: string) => {
    setUnread((u) => {
      if (!u[ensembleId]) return u;
      const next = { ...u };
      delete next[ensembleId];
      return next;
    });
  }, []);

  const dismissToast = useCallback((toastId: number) => {
    setToasts((arr) => arr.filter((t) => t.id !== toastId));
  }, []);

  const fire = useCallback((evt: NotificationFireEvent) => {
    const ensembleId = evt.ensembleId;
    const ensembleName = evt.ensembleName ?? ensembleId;
    // `activeRef` reflects the latest URL / setActiveEnsemble update —
    // see the rationale on the ref declaration above.
    const isLooking = ensembleId === activeRef.current;

    // Bump the unread badge UNLESS the user is on this ensemble.
    if (!isLooking) {
      setUnread((u) => ({ ...u, [ensembleId]: (u[ensembleId] ?? 0) + 1 }));
    }

    const now = Date.now();

    // Pre-allocate the candidate id outside the setter so the updater
    // is pure (no ref mutation inside React's potentially-doubled call
    // under StrictMode dev mode). The id is discarded when grouping
    // merges instead of allocating a new toast — gaps are fine.
    const candidateId = idRef.current++;

    setToasts((arr) => {
      // Same-sender grouping: if the most recent toast is from the same
      // sender in the same ensemble within the grouping window, merge.
      // Collapses chatty agents into one toast that grows.
      const last = arr[arr.length - 1];
      if (
        last &&
        last.ensembleId === ensembleId &&
        last.sender === evt.sender &&
        now - last.firstAt < GROUP_WINDOW_MS
      ) {
        const merged: NotificationToast = {
          ...last,
          body: evt.body, // surface the latest line
          count: last.count + 1,
          ts: now,
          expiresAt: now + TOAST_TIMEOUT_MS,
        };
        return [...arr.slice(0, -1), merged];
      }

      // Don't enqueue a fresh toast for the room the user is on — the
      // chat panel is showing it live. (We already skipped the unread
      // bump above for the same reason.)
      if (isLooking) return arr;

      const next: NotificationToast = {
        id: candidateId,
        ensembleId,
        ensembleName,
        sender: evt.sender,
        senderType: evt.senderType,
        body: evt.body,
        firstAt: now,
        ts: now,
        expiresAt: now + TOAST_TIMEOUT_MS,
        count: 1,
      };
      return [...arr, next];
    });
  }, []);

  // Data-driven TTL. The toasts array is the single source of truth —
  // every change re-arms timers from each entry's `expiresAt`. The dep
  // is `toasts` (not `toasts.length`) because grouping merges keep the
  // same length but bump `expiresAt`; we must re-arm in that case too.
  useEffect(() => {
    if (toasts.length === 0) return;
    const now = Date.now();
    const timers = toasts.map((t) => {
      const remaining = Math.max(0, t.expiresAt - now);
      return setTimeout(() => {
        setToasts((arr) => arr.filter((x) => x.id !== t.id));
      }, remaining);
    });
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  const value = useMemo<NotificationContextValue>(
    () => ({
      activeEnsemble,
      setActiveEnsemble,
      unread,
      markRead,
      toasts,
      dismissToast,
      fire,
    }),
    [activeEnsemble, setActiveEnsemble, unread, markRead, toasts, dismissToast, fire],
  );

  return <NotificationCtx.Provider value={value}>{children}</NotificationCtx.Provider>;
}

// ── SSE wiring (commit 3) ────────────────────────────────────────────────
//
// `useNotificationStream` opens one SSE subscription per live ensemble
// and feeds `chat.appended` events with `role === 'maestro-in'` into
// `fire()`. The architect's design (§4.2) keeps this hook deliberately
// separate from `NotificationProvider`:
//
//   - The provider has zero TanStack-Query / network deps. Unit tests
//     that drive `fire()` imperatively can mount it standalone in a
//     bare `MemoryRouter` (no `QueryClientProvider` required).
//   - `NotificationStreamRunner` is a small render-nothing component
//     that calls the hook from inside the provider tree. Production
//     mounts both; tests of the provider in isolation can omit the
//     runner.
//
// Why per-ensemble multiplex (not the cluster-wide `/v1/events` stream):
// the dashboard's `DashboardTempoClient.subscribe(ensemble)` is per-
// ensemble by contract, and `EnsembleChatMessage` lacks an `ensemble`
// field so we tag at the multiplex boundary. Migration to a cluster
// stream (architect's R1) is a swap behind this hook surface — no
// upstream wire change needed today.

/**
 * Open per-ensemble SSE subscriptions for every ensemble in
 * {@link useEnsembleList}, filter `chat.appended` events down to
 * `role === 'maestro-in'`, and call `fire()` for each.
 *
 * Failure isolation: per-stream try/catch — one ensemble's wedge
 * doesn't kill the others (mirrors {@link useSseSubscription}).
 *
 * Acceptable PR-1 limitation: while `useEnsembleList()` is loading or
 * errored, no subscriptions exist. The 30 s `refetchInterval` re-arms
 * subscriptions on the next list refetch (see architect risk R5).
 */
export function useNotificationStream(fire: NotificationContextValue['fire']): void {
  const list = useEnsembleList();
  const ensembles = list.data;

  useEffect(() => {
    if (!ensembles || ensembles.length === 0) return;
    const client = getDashboardClient();

    // Cleanup-scoped flag the inner async loops check on each event.
    // Production transport (EventSource/fetch) ends the iterator when
    // the AbortController fires, but we double-belt with this flag for
    // mocks and edge cases where abort propagation is incomplete.
    let cancelled = false;

    const controllers = ensembles.map((e) => {
      const ctrl = new AbortController();
      (async () => {
        try {
          for await (const event of client.subscribe(e.name, {
            signal: ctrl.signal,
            topics: ['chat'],
          })) {
            if (cancelled) break;
            if (event.type !== 'chat.appended') continue;
            const msg = event.payload as EnsembleChatMessage;
            if (msg.role !== 'maestro-in') continue;
            // Tag `ensembleId` at the multiplex boundary — payload
            // doesn't carry it (architect §4.2 / risk R2).
            fire({
              ensembleId: e.name,
              ensembleName: e.name,
              sender: msg.from,
              body: msg.text,
            });
          }
        } catch {
          // Per-stream failure isolation. The dashboard already
          // accepts SSE flakiness as a normal mode (`useSseSubscription`
          // does the same pattern); we deliberately swallow rather
          // than escalate so an ensemble whose stream wedges doesn't
          // pull the other notification subscriptions down with it.
        }
      })();
      return ctrl;
    });

    return () => {
      cancelled = true;
      controllers.forEach((c) => c.abort('unmount'));
    };
  }, [ensembles, fire]);
}

/**
 * Render-nothing component that mounts {@link useNotificationStream}
 * inside the provider tree. Production wires this in `ShellLayout`
 * alongside `<NotificationProvider>` (commit 4); standalone provider
 * tests can omit it to avoid the QueryClient dependency.
 */
export function NotificationStreamRunner() {
  const { fire } = useNotifications();
  useNotificationStream(fire);
  return null;
}
