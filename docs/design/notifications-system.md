# Chat-notification system — design

**Status**: DRAFT (architect, branch `design/chat-notification-system`)
**Issue**: PR-1 of the chat-notification system port (Sonner removal lives in PR-2)
**Author**: tempo-architect
**Source**: `docs/design/dashboard-handoff/project/notifications.jsx` + `styles.css:1901-2121`
**Implements**: incoming-chat toasts + sidebar unread badges, ported from the Claude Design canvas to the React/TS dashboard

---

## 1 · Problem & scope

The dashboard operator (the maestro identity) coordinates multiple ensembles. While they're focused on one ensemble's chat — or on a non-chat screen entirely — they need a low-friction signal that another ensemble has new traffic for them.

**This PR ships:**

- A `NotificationProvider` + `useNotifications()` hook holding `{unreadByEnsemble, toasts, activeEnsemble}`.
- A `<ToastStack/>` component — bottom-right column of toasts, 6 s TTL, max 3 visible, `+N more` overflow chip, click-to-route.
- An `<UnreadBadge/>` numeric pill rendered in the sidebar's existing `.ensemble-row`.
- A persistent `useNotificationStream()` hook that drives `fire()` from the live SSE event source (multiplexed across every live ensemble).
- A CSS port of the 30 classes in `styles.css:1901-2121` into `dashboard/src/styles/components.css`.

**Out of scope (deferred):**

- Removal of Sonner — PR-2 of this effort. Sonner stays running for system-event toasts in PR-1.
- A persistent notification-center panel (the bell-icon idea from the source conversation, lines 5915-5961) — vinceblank declared "good enough" without it.
- External webhook delivery (Slack/Telegram/OS-native).
- Migration of mutation-feedback toasts to inline UI — also PR-2.

**Constraints (LOCKED by vinceblank):**

1. Only **incoming chat messages** trigger notifications — not phase changes, schedule fires, gate trips, or any other system events.
2. **Suppress when `activeEnsemble === message.ensembleId`** — if the operator is already on that ensemble's workspace, no toast and no badge.
3. **Outgoing messages don't trigger** — `role !== 'maestro-out'`. (See §4.3 for the exact filter.)

---

## 2 · Reference architecture (canonical source)

```
NotificationProvider (root context)
  ├── activeEnsemble          (URL-derived; see §4.1)
  ├── unread: Map<ens, count>
  ├── toasts: Toast[]
  ├── fire({ensembleId, sender, senderType, body})
  ├── markRead(ensembleId)
  ├── setActiveEnsemble(id)   ← also clears unread + drops pending toasts for `id`
  └── dismissToast(id)

useNotificationStream()        (effect-only hook mounted inside the provider)
  └── for each live ensemble:
        client.subscribe(ens, {topics:['chat']}) → filter chat.appended → fire(...)

<ToastStack onOpen={navigate}>  (mounted in AppShell, viewport-fixed)
  └── <Toast/> × N  (visible)
  └── "+ N more"    (overflow)

<UnreadBadge count={u[ensId]}/> (mounted in Sidebar's ensemble-row)
```

The shape is faithful to `notifications.jsx`. The new pieces are **`useNotificationStream`** (the SSE bridge that wasn't in the demo) and the **mount-point reorganisation** (the demo used a window event because triggers lived outside the provider tree; production wires the provider tree directly into the router so we don't need that bridge).

---

## 3 · CSS porting · 30-class inventory

`styles.css:1901-2121` defines:

| Class | Role |
|---|---|
| `.notif-badge` | Numeric pill (sidebar) |
| `.notif-dot` | Soft 6×6 dot for "new but no count" |
| `.ensemble-row.has-unread .er-name` / `.er-meta` | Bold + tone bump on unread rows |
| `.toast-stack` | Bottom-right column container |
| `.toast-overflow` | "+N more" pill |
| `.toast` + `:hover` | Toast card, hover-lift |
| `.toast[data-stack-index="1"]` / `"2"` | Depth-stack illusion |
| `@keyframes toast-in` | 240 ms entrance |
| `.toast-avatar` | 32×32 OKLCH disc |
| `.toast-body` / `.toast-head` / `.toast-sender` / `.toast-divider` / `.toast-ensemble` / `.toast-count` / `.toast-time` / `.toast-message` | Card layout |
| `.toast-actions` / `.toast-action` / `.toast-action--ghost` | Inline Reply / Dismiss buttons |
| `.toast-close` + hover-reveal rule | × button |

**Token compatibility (verified against `dashboard/src/styles/tokens.css`):**

| Source | Dashboard token | Status |
|---|---|---|
| `--accent`, `--accent-soft` | `--accent`, `--accent-soft` | ✓ identical |
| `--bg-1`, `--bg-2` | `--bg-1`, `--bg-2` | ✓ |
| `--rule`, `--rule-strong` | `--rule`, `--rule-strong` | ✓ |
| `--text`, `--dim`, `--muted` | `--text`, `--dim`, `--muted` | ✓ |
| `--ff-mono`, `--ff-display` | `--ff-mono`, `--ff-display` | ✓ |

A grep of `dashboard/src/styles/components.css` for `notif-badge|toast-stack|toast-avatar|notif-dot` returns **zero matches**, so the port is purely additive — no rename, no class collision.

**One production-only adjustment**: in the canvas, `.toast-stack` is `position: absolute` so toasts stay scoped to a single artboard. In the live dashboard the stack is global, so flip to `position: fixed`. Everything else copies verbatim.

---

## 4 · The seven design questions — answers

### 4.1 `activeEnsemble` derivation

**Decision**: derive from the URL. **No new store.**

The dashboard already encodes the active ensemble in the route (`/ensemble/:id`). `Sidebar.tsx`, `Workspace.tsx`, and `AppShell.tsx` all read it via `useParams<{ id?: string }>()`. We add a single helper:

```ts
// dashboard/src/lib/notifications.tsx (new)
export function useActiveEnsembleId(): string | null {
  const { id } = useParams<{ id?: string }>();
  return id ?? null;
}
```

The `NotificationProvider` calls `useActiveEnsembleId()` and feeds it to `setActiveEnsemble()` via a small `useEffect`:

```tsx
const active = useActiveEnsembleId();
useEffect(() => { setActiveEnsemble(active); }, [active]);
```

**Why URL, not Zustand**: there is exactly one source of truth already. Adding a parallel store creates a re-syncing problem the moment the user back-buttons or deep-links. The URL is reliable, observable, and already wired everywhere.

**Provider mount constraint**: this requires the provider be mounted **inside** the router (so `useParams` resolves). See §4.4.

### 4.2 SSE wiring — without leaking through the React tree

**Decision**: a new effect-only hook **`useNotificationStream()`** mounted once inside `NotificationProvider`. It opens a per-ensemble SSE subscription for every ensemble in `useEnsembleList()` and routes `chat.appended` events into `fire()`.

```ts
// dashboard/src/lib/notifications.tsx (sketch)
function useNotificationStream(fire: NotificationFire): void {
  const list = useEnsembleList();
  const client = getDashboardClient();

  useEffect(() => {
    const ensembles = list.data ?? [];
    if (ensembles.length === 0) return;

    const controllers = ensembles.map((e) => {
      const ctrl = new AbortController();
      (async () => {
        try {
          for await (const ev of client.subscribe(e.name, {
            signal: ctrl.signal,
            topics: ['chat'],
          })) {
            if (ev.type !== 'chat.appended') continue;
            if (!shouldNotify(ev.payload)) continue;
            fire({
              ensembleId: e.name,                  // tag from subscription, not payload
              ensembleName: e.name,
              sender: ev.payload.from,
              senderType: undefined,                // not on EnsembleChatMessage; resolve later
              body: ev.payload.text,
            });
          }
        } catch { /* per-stream failure tolerated */ }
      })();
      return ctrl;
    });

    return () => controllers.forEach((c) => c.abort('unmount'));
  }, [list.data, client, fire]);
}
```

**Why a hook, not a window event**: the canvas demo used `window.dispatchEvent('tempo:fire-notification')` because the demo trigger panel rendered outside the provider tree. In the production dashboard, **everything** lives inside the router, so a direct `useEffect → fire(...)` flow is cleaner — no global event bus to leak.

**Multiplex vs. cluster-wide stream**: the daemon technically exposes `/v1/events` (cluster-wide) per `src/http/server.ts`, but the dashboard's `DashboardTempoClient.subscribe(ensemble)` is intentionally per-ensemble. PR-1 multiplexes one EventSource per ensemble — typical N is 1–10, and the daemon's process-wide `DEFAULT_MAX_CONNECTIONS = 100` cap easily absorbs it. **Migration path** if N grows: add `client.subscribeAll()` returning the cluster stream and swap the implementation behind `useNotificationStream()` without touching the rest of the surface.

**Why `topics: ['chat']`**: the `SubscribeOptions` filter (defined in `src/http/event-types.ts:335`) lets the daemon drop non-chat events server-side. Phase changes, schedules, flags etc. are useless to the notification system, and their volume on a busy ensemble would otherwise dominate the wire.

**`chat.appended` payload missing `ensembleId`**: confirmed at `src/types.ts:897-919` — `EnsembleChatMessage` carries `id, from, to, text, timestamp, role, broadcastId?` but no ensemble field. We tag at the subscription boundary (the `ensemble` param to `subscribe()`), which is fine for the multiplex approach. **If we ever migrate to the cluster-wide `/v1/events` stream**, the wire would need an additive `ensemble` field on `chat.appended` — a non-breaking, append-only extension.

**Failure isolation**: each per-ensemble subscription is wrapped in its own try/catch. One ensemble's stream dropping doesn't kill the others; the dashboard already accepts SSE flakiness as a normal mode (`useSseSubscription` does the same pattern).

### 4.3 Outgoing-message filter

**Decision**: `role === 'maestro-in'` ONLY.

`EnsembleChatMessage.role` (per `src/types.ts:911`) is one of:

| Role | Meaning | Notify? |
|---|---|---|
| `maestro-out` | Maestro (you) → player | **No** (you sent it) |
| `maestro-in` | Player → maestro (you) | **Yes** ← the only PR-1 trigger |
| `conductor-out` | Conductor → non-maestro player | No (peer-to-peer; you're observing) |
| `conductor-in` | Non-maestro player → conductor | No (peer-to-peer; you're observing) |

The conductor's brief said "filter outgoing (`from === self` excluded)". The role discriminator is the precise version of that — `maestro-in` is exactly "to me, not from me". `conductor-*` events are peer-to-peer chatter that the operator is observing as the maestro; they shouldn't generate toasts in PR-1. (If we want to surface them later, we open it up — but right now the operator is only directly addressed via `maestro-in`.)

```ts
function shouldNotify(msg: EnsembleChatMessage): boolean {
  return msg.role === 'maestro-in';
}
```

This is also intentionally robust against `from === self` ambiguity — there's no string "self" identity to compare against on the client.

### 4.4 Provider mount point

**Decision**: mount `NotificationProvider` inside `ShellLayout` (the layout-route element in `router.tsx:53-58`), wrapping `<AppShell>`.

```tsx
// dashboard/src/router.tsx — modified
function ShellLayout() {
  return (
    <NotificationProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </NotificationProvider>
  );
}
```

**Why here, not at `<App>`**:

1. The provider needs `useParams()` (§4.1), which requires the router context. `App.tsx` mounts `<RouterProvider>` and is therefore *outside* the route tree.
2. ShellLayout already wraps the entire route tree (every screen renders below it via `<Outlet />`), so the provider state survives across all navigation — including the pseudo-modal pop-out window route paths.
3. Toasts must persist across route changes — fired toasts from ensemble A must keep showing while the user navigates Overview → Settings → Hosts. Mounting at the layout level satisfies that without re-mount.

**ToastStack mount**: rendered inside `AppShell`'s root markup, after `<main>`, so it's a sibling to the routed content. Position is `fixed` (per the production-mode CSS adjustment in §3) so it's viewport-relative regardless of which screen is mounted.

```tsx
// dashboard/src/components/AppShell.tsx — append before the closing wrapper div
<ToastStack onOpen={(ensembleId) => navigate(`/ensemble/${encodeURIComponent(ensembleId)}`)} />
```

### 4.5 CSS porting verification

Already covered in §3. Summary:

- **Tokens**: 100% compatible. No new tokens needed.
- **Class collisions**: zero (verified by grep).
- **One adjustment**: `.toast-stack { position: fixed }` instead of `absolute`.
- **Density-awareness**: the source CSS uses fixed pixel sizes inside the toast (12 / 14 / 32 px). These are intentionally dense-independent — toast affordances should look the same at every density setting. ✓ matches Sonner's behaviour.
- **Theme-awareness**: every tone uses tokens that flip with `[data-theme='light']`. ✓ free win.
- **Reduced-motion**: the `toast-in` keyframe animates entrance. We should wrap it under `@media (prefers-reduced-motion: no-preference)` per the existing `dashboard/src/lib/use-reduced-motion.ts` convention. **Lead implementation note**: copy the pattern from `components.css`'s existing reduced-motion guards (e.g. the `TempoStrip` rule).

### 4.6 Test strategy

Three layers, all Vitest under `dashboard/tests/notifications/`:

| File | Tests |
|---|---|
| `provider.test.tsx` | `fire()` enqueues toast + bumps unread; suppression rule (`activeEnsemble === ensembleId` → no toast, no badge); same-sender grouping (3 within 8 s → one toast with `count: 3`); `setActiveEnsemble()` clears that ensemble's unread + drops pending toasts; `markRead()` clears badge but leaves toast; toast TTL expiry (use vitest fake timers — verify the data-driven timer pattern from `notifications.jsx:31-40`); soft-fallback when no provider context (per `notifications.jsx:144-158`). |
| `toast-stack.test.tsx` | Renders newest-first; max 3 visible; "+N more" overflow chip when total > 3; click toast → calls `onOpen` with `ensembleId`; click × → `dismissToast`; click "Reply" / "Dismiss" inline actions; `data-stack-index` attribute set on each toast. |
| `unread-badge.test.tsx` | `count: 0` + no `dotOnly` → null; `dotOnly: true` + `count: 0` → `.notif-dot`; numeric pill for `count > 0`; `99+` rendering for `count > 99`; `aria-label` is `"N unread"`. |
| `stream.test.tsx` | Integration: a mock `DashboardTempoClient.subscribe` emits a synthetic `chat.appended` event; assert provider state advances. Run cases: (a) `maestro-in` → toast fires, (b) `maestro-out` → suppressed, (c) `conductor-in` → suppressed, (d) chat.appended on the active ensemble → suppressed even when role matches, (e) per-ensemble subscriptions tear down correctly when the ensemble list changes (mock returns `useEnsembleList` shrinking from 3 → 1). Reuses `dashboard/tests/fixtures/mock-client.ts`. |

**Visual regression**: deferred. Sonner already lacks one and the dashboard's existing test surface is class-and-attribute-based. If we add Storybook later, port the toasts with screenshots then.

**Coverage gates**: the existing `dashboard/tests/testid-coverage.test.tsx` audits that every `data-testid` appears in fixture markup. The new components must add stable testids:

| Component | testid |
|---|---|
| `<ToastStack>` | `toast-stack` |
| `<Toast>` | `toast-${id}` (per the canvas convention) and a stable `toast` class for the suppression-rule integration test |
| `<UnreadBadge>` | `unread-badge` |
| The Reply button | `toast-reply` |
| The Dismiss buttons (× and ghost) | `toast-dismiss` |

### 4.7 Intra-PR chunking

**Recommendation: 4 commits in one PR.** Each commit ships green tests; the PR merges atomically.

| # | Commit | Files | Tests |
|---|---|---|---|
| 1 | `feat(dashboard/notifications): provider + hook (no UI yet)` | NEW `dashboard/src/lib/notifications.tsx` (provider, hook, types — no JSX components yet) | NEW `dashboard/tests/notifications/provider.test.tsx` |
| 2 | `feat(dashboard/notifications): components + CSS port` | NEW `dashboard/src/components/notifications/{Toast,ToastStack,UnreadBadge}.tsx`; MOD `dashboard/src/styles/components.css` (append the 30-class block at the bottom) | NEW `dashboard/tests/notifications/toast-stack.test.tsx`, `unread-badge.test.tsx` |
| 3 | `feat(dashboard/notifications): SSE stream wiring` | MOD `dashboard/src/lib/notifications.tsx` to add `useNotificationStream()` | NEW `dashboard/tests/notifications/stream.test.tsx` |
| 4 | `feat(dashboard/notifications): integrate into shell, sidebar, workspace` | MOD `dashboard/src/router.tsx` (wrap ShellLayout); MOD `dashboard/src/components/AppShell.tsx` (mount ToastStack); MOD `dashboard/src/components/Sidebar.tsx` (UnreadBadge inside `.ensemble-row` + `.has-unread` modifier toggle) | MOD `dashboard/tests/router.test.tsx`; possibly MOD `app-shell-slot.test.tsx`, `workspace.test.tsx` if mounting affects existing assertions |

**Why this split, not a single mega-commit**: each step is independently reviewable, and #1+#2 are inert (no behaviour change) until #3 connects the SSE wire and #4 mounts everything. If review surfaces a problem with the integration step, we don't have to re-review the provider logic.

**Why not 4 separate PRs**: the change is small-medium and tightly coupled. Splitting into separate PRs would force scaffolding code (a temp window event bridge?) just so each intermediate PR is "user-visible". One PR with 4 commits ships the user-visible value atomically.

---

## 5 · File scope (verified against codebase)

### NEW

```
dashboard/src/lib/notifications.tsx                  ~250 LOC — provider, hook, useNotificationStream
dashboard/src/components/notifications/Toast.tsx     ~80 LOC
dashboard/src/components/notifications/ToastStack.tsx ~50 LOC
dashboard/src/components/notifications/UnreadBadge.tsx ~25 LOC
dashboard/tests/notifications/provider.test.tsx
dashboard/tests/notifications/toast-stack.test.tsx
dashboard/tests/notifications/unread-badge.test.tsx
dashboard/tests/notifications/stream.test.tsx
```

### MODIFIED

```
dashboard/src/styles/components.css     append §3's 30-class block (~220 LOC)
dashboard/src/router.tsx                wrap ShellLayout's children with NotificationProvider
dashboard/src/components/AppShell.tsx   mount <ToastStack /> below <main>
dashboard/src/components/Sidebar.tsx    render UnreadBadge inside .ensemble-row + .has-unread modifier
```

### NOT TOUCHED (by PR-1)

- `dashboard/src/App.tsx` — Sonner Toaster stays exactly where it is
- `dashboard/src/lib/toast.tsx` — keeps providing `toastSuccess/Error/Info`
- `dashboard/src/lib/sse.ts` — `useSseSubscription` for the workspace stays separate
- Anything in `src/http/` — the daemon-side wire is unchanged

---

## 6 · Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Multiplexing N persistent EventSources hits the daemon's `DEFAULT_MAX_CONNECTIONS = 100` cap. | Typical operator runs ≤10 ensembles; well below cap. If the dashboard ever supports cross-machine shared daemons with hundreds of ensembles, swap `useNotificationStream` to call a future `client.subscribeAll()` (path is open: see §4.2). |
| R2 | `EnsembleChatMessage` lacks `ensembleId`, so a future migration to the cluster-wide `/v1/events` stream needs a wire change. | Document the multiplex contract here. Wire change is **additive** (new optional field on `chat.appended`), so non-breaking under WIRE-PROTOCOL.md rules. |
| R3 | Two EventSources per ensemble — one for `useSseSubscription` (workspace) and one for `useNotificationStream` (notifications) — when the user is on a workspace route. | Acceptable: the daemon coalesces identical subscriptions on its end (same connection cap counts both); browser EventSource overhead is negligible. If profiling shows churn, extract a shared subscription cache keyed by `(ensemble, topics)`. |
| R4 | The grouping rule (3 messages from same sender within 8 s → one toast) interacts oddly with broadcast fan-out — a broadcast looks like 1 sender to N recipients, all hitting the operator's `maestro-in` stream. | Per `notifications.jsx:84-100`, grouping checks `last.sender === evt.sender`. A single broadcast already has a stable `from` per recipient stream, so it groups correctly. We DO NOT additionally group by `broadcastId` — the existing grouping behaviour is the canonical UX choice. |
| R5 | When `useEnsembleList()` is loading or errored, `useNotificationStream` opens zero subscriptions and silently drops events. | Acceptable for PR-1: the dashboard already shows a loading state; the operator wouldn't be navigating during it. If/when surface load is "live but stale", the next `refetchInterval` (30 s — see `queries.ts:83`) re-arms subscriptions automatically. |
| R6 | Reduced-motion users see the `toast-in` slide animation. | Wrap the `@keyframes toast-in` invocation under `@media (prefers-reduced-motion: no-preference)` per the existing convention in `components.css`. |
| R7 | Tests mounting `NotificationProvider` inside the memory router need a non-empty ensemble list, otherwise `useNotificationStream` no-ops and integration tests can't drive a SSE event into the provider. | `dashboard/tests/fixtures/factories.ts` already supplies ensemble fixtures; integration tests use them + a stub `subscribe()` that yields synthetic events. |

---

## 7 · Open questions (none blocking)

1. **`senderType` for avatar hue**: the canvas reads `window.hueForType(senderType)` to colour the toast avatar (see `notifications.jsx:208`). Our `EnsembleChatMessage` doesn't carry `senderType`. **Resolution**: the dashboard already has `dashboard/src/components/tempo/TypeBadge.tsx`; reuse the same hue-derivation helper, looking up the sender's `playerType` from the `useEnsembleSnapshot(ensemble)` cache. If the cache miss (e.g., a player just joined), default to a neutral hue — degrades gracefully.
2. **Ensemble display name vs. id**: `EnsembleSummary.name` is what we show. The source `notifications.jsx:71-73` falls back to `id` if no `name` is found. We don't have that distinction — `name` is the id in our world.

These are implementation details for tempo-lead; not architectural blockers.

---

## 8 · Out-of-scope follow-ups (post-PR-1)

- **PR-2**: remove Sonner; migrate mutation-feedback toasts to inline UI under their target buttons.
- **Notification center popover** (the bell-icon idea from chat2.md:5915-5961): if the operator wants persistent history, it's a clean addition — extend the provider with a bounded `history: Toast[]` ring and add a `<NotificationBell>` component. **Defer until requested.**
- **Cluster-wide `/v1/events` migration**: if N ensembles ever climbs north of ~30 per operator, swap `useNotificationStream`'s implementation behind the same hook surface. Wire change is additive only.
- **OS-native notifications** (`Notification` Web API): trivial later — just call `new Notification(...)` from `fire()` when permission granted. Not in PR-1.

---

## Appendix A · Architectural rationale recap

Two design choices warrant an explicit "why":

1. **URL as `activeEnsemble` source of truth, not a Zustand store** — every existing reader (`Sidebar`, `Workspace`, `AppShell`) already does this. Adding a parallel store re-introduces a sync problem we don't have.
2. **Per-ensemble subscription multiplex, not a cluster-wide stream** — the wire endpoint exists but the dashboard client doesn't expose it, and the additive wire field needed for cross-ensemble disambiguation (`chat.appended.ensemble`) is a deferrable change. PR-1 stays inside today's contract.

Both decisions optimise for "ship the user-visible value without expanding the wire". Migration paths to the alternatives (Zustand store / cluster stream) exist behind the same hook surfaces.
