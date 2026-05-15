# Packaged web dashboard — `agent-tempo dashboard`

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-architect
> **Branch**: `design/340-web-dashboard`
> **Tracking**: issue #340 (approved for autonomous pickup)
> **Audience**: implementing engineer (eng-2 named as natural pickup), conductor for review.

---

## 0. TL;DR

Ship a React + Vite + Tailwind 4 + shadcn/ui SPA at `dashboard/`, prebuilt at publish time, served by the existing daemon HTTP server at `/dashboard` on the same port as `/v1/*`. New CLI verb `agent-tempo dashboard` opens the local browser. Cross-device access via Tailscale or LAN with a **QR-code one-time-pairing-token → long-lived bearer** handshake.

The SPA consumes the existing daemon HTTP/SSE event source (PRs #320, #324, #325) via `TempoClient` — **zero new wire-protocol surface**, **zero new daemon endpoints** beyond a single static-asset handler (`src/http/dashboard.ts`, ~80 LoC) and a one-time-pairing endpoint pair. Old non-dashboard users pay no install or runtime cost.

Visual language is locked by the **canonical design bundle in `docs/design/dashboard-handoff/`** (PR #345 — vinceblank-authored, exported from Claude Design): dark-first warm-neutral palette, terracotta accent (`#E07A5F`), Instrument Sans / Instrument Serif / JetBrains Mono fonts (Google Fonts), animated metronome motif, tempo-strip activity sparkline, density slider (4–9, default 6), phase dots with pulse animation. Per-screen layouts spec'd across **9 artboards** in `dashboard.html`.

**Locked decisions on researcher's 10 open questions**:

| Q | Decision |
|---|---|
| Q1 Repo layout | **Sibling `dashboard/` dir** (mirrors Mink); own `package.json` + `node_modules`; **NOT** sub-package versioning |
| Q2 Build orchestration | Top-level `npm run build` invokes `npm --prefix dashboard run build` before `build:bundle`. Standalone `build:dashboard` script for partial rebuilds. **Cap +30 s**; split lazily if it blows. |
| Q3 Hot reload dev | Vite dev server (`cd dashboard && npm run dev`) with `server.proxy` for `/v1/*` and `/dashboard/api/*` → `127.0.0.1:8473` |
| Q4 Pairing-token shape | **Opaque base64url 32-byte random**; 5-min TTL; single-use; in-memory map on daemon (no persistence) |
| Q5 State management | **TanStack Query for server state** + **Zustand for user prefs (theme/density/accent/viewport)** + `useState` for component-local. NO Redux. |
| Q6 Versioning | **Lockstep** — `dashboard/package.json` version mirrors root `package.json`; CI enforced |
| Q7 v1 functional cut | **All screens render**, but only **safe writes wired** (`cue`, `report`, `release`, `play`, `pause`, `recruit`). Destructive (`destroy`, `restart`, `restore`, `shutdown`), schedule edit, lineup edit, gates, worktrees → disabled with `Coming in v2` tooltip |
| Q8 Browser support | **Last 2 evergreen** of Chrome/Edge/Safari/Firefox; no IE; Safari ≥16. Locked in `vite.config.ts` `build.target`. |
| Q9 Lighthouse / a11y | **Targets**: Perf ≥85 (mobile, 4G throttle), Accessibility ≥90, Best Practices ≥90. **CI checks size-limit only**; Lighthouse is a **release-checklist item**, not blocking CI. |
| Q10 Reference-fork story | **`dashboard/README.md`** documents the TempoClient integration shape, design-token mapping, and an explicit "fork-and-customize" guide. Mentioned from the main README. |

**Wire surface — strictly additive**: 1 new route mount (`/dashboard/*` static), 2 new endpoints under `/dashboard/api/*` (`POST /pair` + `GET /pair/:token`). Reuses existing `/v1/state/:ensemble`, `/v1/events/:ensemble`, `/v1/health`, `/v1/ensembles`, `/v1/hosts` snapshot + SSE endpoints. **Zero new Temporal signals/queries/updates**.

**Estimated implementation cost**: ~3,100–4,740 LoC (researcher's refined estimate). Single PR or 2–3 sequenced PRs (engineer's call). eng-2 named as natural implementer.

---

## 1. Why now

Issue #340 makes the case explicit; the infrastructure to support a web dashboard just landed in v0.27 + the Phase 3 work for #94/#95:

- **Daemon HTTP server** (PR #320, merged) — `/v1/state/:ensemble`, `/v1/health`, `/v1/ensembles`, `/v1/hosts` snapshot endpoints
- **SSE streaming** (PR #324, merged) — `/v1/events/:ensemble`, `/v1/events` real-time event source
- **`TempoClient.subscribe()`** (PR #325, merged) — fetch-based AsyncIterable streaming consumer
- **Auth + CORS** — bearer token in `~/.agent-tempo/config.json`; default `localhost:*` allowlist; non-loopback bind requires bearer
- **Multi-host support** (#274 v0.27) — per-host task queues, host profiles surfaced via `/v1/hosts`

The dashboard is a **thin client over `TempoClient`** — no new wire protocol, no new auth surface, no new daemon endpoints needed for v1 beyond static-asset serving + a tiny pairing endpoint pair for cross-device.

Phase A research (PR #341, `docs/research/340-web-dashboard-alternatives.md`) audited prior art (Mink, Storybook, Drizzle/Prisma Studio anti-patterns), validated the Vite + Tailwind 4 + shadcn 4.5 stack, refined LoC to ~3,100–4,740, and surfaced 10 open questions for this spike to lock.

The canonical visual design lives in `docs/design/dashboard-handoff/` (PR #345). Per the bundle's own README: *"recreate them pixel-perfectly in whatever technology makes sense"* — for us, React + Vite + Tailwind 4 + shadcn/ui per researcher.

---

## 2. Repo layout — locked

```
agent-tempo/                          # existing repo root
├── package.json                       # root (agent-tempo)
├── src/                               # existing TS sources
│   └── http/
│       └── dashboard.ts               # NEW — static-asset handler + SPA fallback (~80 LoC)
├── dashboard/                         # NEW — sibling dir, not src/dashboard
│   ├── package.json                   # version pinned in lockstep with root via CI check
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── routes.tsx                 # explicit React Router 7 config
│   │   ├── pages/                     # 9 screens per design bundle
│   │   │   ├── Overview.tsx           # screen C
│   │   │   ├── Workspace.tsx          # screen A — primary
│   │   │   ├── PlayerDetail.tsx       # screen B
│   │   │   ├── CreateEnsemble.tsx     # screen D — v2 (read-only in v1)
│   │   │   ├── Recruit.tsx            # screen E — wizard, v1
│   │   │   ├── Loadouts.tsx           # screen F — v2 (read-only in v1)
│   │   │   ├── PlayerTypes.tsx        # screen G — v1 read-only
│   │   │   ├── Schedules.tsx          # screen H — v1 read-only / v2 CRUD
│   │   │   └── Hosts.tsx              # screen I — v1 read-only
│   │   ├── components/
│   │   │   ├── ui/                    # shadcn-generated (committed)
│   │   │   ├── tempo/                 # custom motifs (Metronome, TempoStrip, PhaseDot, PlayerAvatar)
│   │   │   ├── chat/                  # ChatLog, MessageInput, RosterItem
│   │   │   └── shell/                 # AppShell, Sidebar, PageHeader, PhoneAppBar
│   │   ├── lib/
│   │   │   ├── client.ts              # TempoClient browser-mode factory
│   │   │   ├── queries.ts             # TanStack Query hooks per surface
│   │   │   ├── sse.ts                 # SSE event → queryClient.setQueryData glue
│   │   │   └── prefs.ts               # Zustand store (theme, density, accent, viewport)
│   │   ├── styles/
│   │   │   ├── tokens.css             # CSS-first @theme — maps from dashboard-handoff/styles.css
│   │   │   └── globals.css            # base resets, typography, density variables
│   │   └── types.ts                   # Re-exports from agent-tempo's TempoClient types
│   ├── public/
│   │   └── (icons / favicon — uses dashboard-handoff/assets/)
│   ├── tests/
│   │   ├── components/                # Vitest component tests
│   │   └── e2e/                       # Playwright (small smoke pack — not Cypress)
│   ├── README.md                      # NEW — fork-and-customize guide (Q10)
│   └── dist/                          # built artifacts; shipped via files[] but gitignored
└── docs/
    └── design/
        ├── 340-web-dashboard.md       # THIS DESIGN
        └── dashboard-handoff/          # canonical design bundle (PR #345)
```

**Why sibling `dashboard/`, not `src/dashboard/`**: keeps the dashboard's `node_modules`, build artifacts (`dist/`), and tooling configs (Vite, Tailwind) isolated from the main TypeScript build. Mirrors Mink's layout. The root `tsconfig.json` excludes `dashboard/` so the main build doesn't try to compile it; `dashboard/tsconfig.json` is independent.

**Why NOT a separately-versioned npm sub-package**: no consumer of the dashboard exists outside this repo. Lockstep versioning eliminates the "which dashboard version goes with which daemon version" matrix.

---

## 3. Stack — confirmed locks (from researcher §2)

| Layer | Pin | Notes |
|---|---|---|
| Runtime | React 19.2.5 (`~19.2.5`) | Current stable; no SSR/RSC needed |
| Bundler | Vite 8.0.10 | Static SPA output to `dashboard/dist/`; **NOT Next.js** |
| CSS | Tailwind 4.2.4 | Oxide engine; CSS-first `@theme`; `@tailwindcss/vite` plugin |
| Components | shadcn 4.5.0 | Copy-paste-into-`dashboard/src/components/ui/`; **NOT a runtime dep** |
| Server state | TanStack Query 5.100.5 | Single source of truth for snapshots; SSE feeds `setQueryData` |
| User prefs | Zustand 5.x (small store) | theme / density / accent / viewport — `localStorage`-backed |
| Routing | React Router 7.14.2 | **Explicit routes**, NOT file-based; smaller bundle |
| Bundle budget | size-limit 12.1.0 | CI gate; preset-app |
| Tests | Vitest (component) + Playwright (e2e smoke) | Match existing test discipline (Vitest = `tests/`, NOT Mocha) |

**Initial shadcn component set** (per design analysis): `button`, `card`, `dialog`, `sheet` (for mobile drawer), `tabs`, `sidebar`, `sonner` (toast), `dropdown-menu`, `tooltip`, `badge`, `input`, `command` (search palette), `skeleton`, `scroll-area`, `popover`, `separator`, `slider` (density), `switch`, `radio-group`, `select`. Add as needed during implementation; tree-shaking strips the rest.

---

## 4. Daemon-side serving

### 4.1 New file: `src/http/dashboard.ts` (~80 LoC)

Static-asset handler with SPA fallback:

```ts
// src/http/dashboard.ts (skeleton)
import { createReadStream, statSync } from 'fs';
import { join, extname } from 'path';
import type { ServerResponse, IncomingMessage } from 'http';

const DASHBOARD_DIST = join(__dirname, '..', '..', 'dashboard', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.woff2':'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serve the prebuilt dashboard SPA at `/dashboard/*`.
 *  - Hashed asset paths get `Cache-Control: public, max-age=31536000, immutable`.
 *  - `index.html` gets `Cache-Control: no-cache` (ensures users pick up new builds).
 *  - Any unmatched path under `/dashboard/*` falls back to `index.html` (SPA routing).
 *  - `/dashboard` (no trailing slash) → 301 to `/dashboard/`.
 */
export function handleDashboardRequest(req: IncomingMessage, res: ServerResponse): void {
  // ... resolve path under DASHBOARD_DIST, MIME-detect, fallback to index.html ...
}
```

Wired into `src/http/server.ts` route table around the existing **bearer-auth gate** — two-position wiring keeps static assets behind auth on non-loopback binds while letting the QR-pair token-exchange endpoint reach the SPA before any bearer is in hand:

1. **Pre-auth exception** — `GET /dashboard/api/pair/:token` is placed **before** the auth gate, parallel to `/v1/health`. The token *is* the auth (single-use, 5-min TTL, opaque base64url) and exists specifically to bootstrap the pair-flow's bearer exchange.
2. **Post-auth dispatch** — `/dashboard/*` static handler and `POST /dashboard/api/pair` are placed **after** the bearer-auth gate. On non-loopback binds (`0.0.0.0`, LAN, Tailscale) static SPA assets and pair-token minting require the existing bearer, identical to `/v1/*` endpoints.

The dispatch uses the normalized `pathname` already parsed at the top of `handle()` — matching the surrounding code style (existing handler uses `new URL(req.url ?? '/', …).pathname`, NOT `req.url?.startsWith()`):

```ts
// src/http/server.ts (excerpt — additive insertions around existing auth gate)

// ---- pre-auth exceptions ----
if (method === 'GET' && pathname === '/v1/health') {
  return handleHealth(res, ctx);                            // existing
}
// GET /dashboard/api/pair/:token — token IS the auth, parallel to /v1/health.
const pairConsume = pathname.match(/^\/dashboard\/api\/pair\/([^/]+)$/);
if (method === 'GET' && pairConsume) {
  return handlePairConsume(req, res, ctx, decodeURIComponent(pairConsume[1]));
}

// ---- existing bearer auth + CORS gate (UNCHANGED) ----
// const reqBearer = bearerRequired(...); if (reqBearer && !valid) → 401
// CORS allowlist evaluation
// ... existing logic unchanged ...

// ---- post-auth dispatch ----
if (method === 'POST' && pathname === '/dashboard/api/pair') {
  return handlePairCreate(req, res, ctx);                   // requires bearer
}
if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
  return handleDashboardRequest(req, res);                  // static + SPA fallback
}

// ... existing /v1/ensembles, /v1/state, /v1/events, ... routing unchanged ...
```

**Security rationale (qa-2):** Placing the static handler *before* the auth gate would let any client on a non-loopback bind (LAN, Tailscale) load the dashboard SPA without authentication. While `/v1/*` writes would still be blocked (the SPA's runtime requests still hit the auth gate), exposing the SPA shell — with embedded ensemble names visible in the bundle's data fetches, telemetry hooks, and SSE-subscription scaffolding — is a partial information leak we explicitly do not want. Treat the static SPA as the same trust boundary as the `/v1/*` API surface. The single carve-out is `GET /dashboard/api/pair/:token` because the token is itself a single-use, short-TTL bearer.

### 4.2 New endpoints: `POST /dashboard/api/pair` + `GET /dashboard/api/pair/:token`

For the QR-code cross-device pairing flow (§7). These live under `/dashboard/api/*`, **separate from `/v1/*`** — they are dashboard-internal, not part of the stable wire protocol.

```ts
// src/http/dashboard-pair.ts (new, ~120 LoC)
const pendingPairings = new Map<string, { createdAt: number; consumed: boolean }>();
const PAIR_TTL_MS = 5 * 60 * 1000;

// POST /dashboard/api/pair  — issued by daemon when CLI invokes `dashboard --pair`
//   Body: none
//   Auth: requires existing bearer (operator on the host machine)
//   Response: { token, expiresAt, qrUrl }   where qrUrl includes the token
export function handlePairCreate(...) { ... }

// GET /dashboard/api/pair/:token  — consumed by the SPA on first load
//   No auth required (the token IS the auth)
//   Response: { bearerToken, expiresAt }
//   Side effect: marks token consumed; subsequent requests with this token 410
export function handlePairConsume(...) { ... }
```

**Token shape**: `crypto.randomBytes(32).toString('base64url')` (43 chars, opaque). 5-min TTL, single-use, **in-memory only** (daemon restart invalidates outstanding pairings — this is fine; pair again).

### 4.3 Auth model — identical to existing `/v1/*`

| Bind | Auth requirement |
|---|---|
| Loopback (`127.0.0.1`, `::1`) | None (existing daemon behaviour) |
| Non-loopback (`0.0.0.0`, LAN, Tailscale) | Bearer token required (existing daemon behaviour) |

The dashboard SPA receives its bearer one of three ways:

1. **Loopback** — no bearer needed; daemon serves dashboard + `/v1/*` over HTTP without auth on `127.0.0.1`.
2. **Cross-device pair** — operator runs `agent-tempo dashboard --pair`, daemon prints a QR code. Phone scans → SPA loads at `http://<host>:<port>/dashboard/?pair=<token>` → SPA exchanges via `GET /dashboard/api/pair/:token` for the bearer → stores in `localStorage`.
3. **Manual paste** — operator copies bearer from `~/.agent-tempo/config.json`, pastes into a settings sheet on the SPA. Fallback path; QR is the recommended UX.

### 4.4 CORS

Existing allowlist (`localhost:*` + `CLAUDE_TEMPO_CORS_ORIGINS`) covers same-origin (dashboard served from daemon). Cross-device via Tailscale uses the daemon's hostname/IP — also same-origin. **No CORS changes for v1.** Future: a hosted external dashboard would need explicit origin allowlisting; out of scope.

---

## 5. CLI command

```
agent-tempo dashboard [--port <n>] [--bind <addr>] [--no-open] [--pair]
```

| Flag | Purpose |
|---|---|
| `--port` | Override daemon port (rare; daemon usually self-manages) |
| `--bind` | Forward to daemon if not already running with that bind. **`--bind 0.0.0.0` forces token-mode** (existing behaviour) |
| `--no-open` | Skip the browser-launch; print URL only — for headless servers |
| `--pair` | Generate a one-time-use pairing token + QR code; print to terminal. Requires non-loopback bind |

### 5.1 Bootstrap flow

```ts
// src/cli/dashboard-command.ts (new, ~120 LoC)
async function runDashboard(args: DashboardArgs) {
  await ensureDaemonRunning(args);              // existing auto-start helper
  const port = await readPortFile();             // existing helper
  const url = `http://${args.bind ?? '127.0.0.1'}:${port}/dashboard/`;

  if (args.pair) {
    const token = await mintPairToken(port);     // POST /dashboard/api/pair
    const qrUrl = `${url}?pair=${token}`;
    printQrCode(qrUrl);                          // qrcode-terminal package (small)
    console.log(`Pairing URL (5-min TTL): ${qrUrl}`);
    console.log(`Or visit ${url} on this machine.`);
    return;
  }

  if (!args.noOpen) await openBrowser(url);      // 'open' package
  console.log(`Dashboard: ${url}`);
}
```

### 5.2 Wired into the CLI dispatcher

`src/cli.ts` and `src/cli/commands.ts` get a new verb registration. Help text via `src/cli/help-text.ts`.

---

## 6. SPA architecture

### 6.1 `TempoClient` browser-mode integration

PR #325 already shipped fetch-based AsyncIterable subscribe. The dashboard imports the published `agent-tempo` types directly:

```ts
// dashboard/src/lib/client.ts
import { createTempoClientCore } from 'agent-tempo/client/core';
import { getBearerFromStorage } from './auth';

// NOTE: We use `createTempoClientCore` (no spawn capability) — the dashboard
// is a browser, it cannot launch local processes. The full `createTempoClient`
// is the CLI entry point; the Core variant is exactly the right fit for this
// browser-mode integration. See ADR 0007 for the Core/WithSpawn split.
export function buildClient() {
  return createTempoClientCore({
    baseUrl: window.location.origin,
    bearer: getBearerFromStorage(),  // null on loopback (no auth)
  });
}
```

**Caveat**: the dashboard is a peer in the monorepo; importing from `agent-tempo` requires a workspace setup. Two options:

- **Path-alias**: `dashboard/tsconfig.json` adds `"paths": { "agent-tempo/*": ["../src/*"] }`; `vite.config.ts` mirrors with `resolve.alias`. Simpler; chosen.
- **npm workspaces** with `dashboard` as a workspace package. Heavier; deferred.

### 6.2 TanStack Query + SSE bridge (`dashboard/src/lib/sse.ts`)

The single source of truth for server snapshots is the `useEnsembleSnapshot(ensembleId)` hook. SSE events feed `queryClient.setQueryData()`:

```ts
// dashboard/src/lib/sse.ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildClient } from './client';

export function useEnsembleSubscription(ensembleId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ensembleId) return;
    const ctrl = new AbortController();
    const client = buildClient();
    (async () => {
      for await (const event of client.subscribe(ensembleId, { signal: ctrl.signal })) {
        // Apply event to the queryKey ['ensemble', ensembleId] cache.
        // Event shapes per docs/SSE-PROTOCOL.md.
        qc.setQueryData(['ensemble', ensembleId], (prev: any) => applyEvent(prev, event));
      }
    })();
    return () => ctrl.abort();
  }, [ensembleId, qc]);
}
```

**Snapshot hydration**: `queryFn` for `['ensemble', ensembleId]` calls `client.state(ensembleId)` (existing `/v1/state/:ensemble` endpoint). Subscription kicks in after the snapshot resolves; SSE events apply diffs.

### 6.3 User-prefs Zustand store (`dashboard/src/lib/prefs.ts`)

```ts
// dashboard/src/lib/prefs.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const usePrefs = create(persist<{
  theme: 'dark' | 'light';
  density: 4 | 5 | 6 | 7 | 8 | 9;
  accent: string;            // hex; defaults '#E07A5F'
  viewport: 'desktop' | 'laptop' | 'tablet' | 'phone';
  setTheme: (t: 'dark' | 'light') => void;
  setDensity: (d: number) => void;
  setAccent: (a: string) => void;
}>(
  (set) => ({
    theme: 'dark',
    density: 6,
    accent: '#E07A5F',
    viewport: 'desktop',
    setTheme: (theme) => set({ theme }),
    setDensity: (density) => set({ density }),
    setAccent: (accent) => set({ accent }),
  }),
  { name: 'agent-tempo-dashboard-prefs' },
));
```

The root component reads prefs and applies to `document.documentElement.dataset` (matches the design bundle's `data-theme` / `data-density` mechanism — see `dashboard.html:43-49`).

### 6.4 Action calls (write paths)

Every safe-write action goes through `TempoClient`:

```tsx
// dashboard/src/pages/Workspace.tsx (excerpt)
const cueMutation = useMutation({
  mutationFn: ({ playerId, message }: { playerId: string; message: string }) =>
    buildClient().cue({ ensemble, playerId, message }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['ensemble', ensemble] }),
});
```

Optimistic updates for `cue` and `pause` / `play` are TanStack-native via `onMutate` / `onError` rollback.

---

## 7. Cross-device + mobile

### 7.1 Tailscale primary path

Document in `dashboard/README.md` and `docs/development.md`: install Tailscale on host + phone, run daemon with `--bind 0.0.0.0`, visit `http://<tailscale-ip>:8473/dashboard/` on phone. Tailscale-internal traffic is implicitly authenticated; the bearer-token requirement on non-loopback bind still applies (defence in depth).

### 7.2 QR-code pairing flow

```
1. Operator on host runs:           agent-tempo dashboard --pair
2. Daemon mints token (32-byte b64url, 5-min TTL, single-use)
3. CLI prints QR code encoding:     http://<host>:<port>/dashboard/?pair=<token>
4. Phone scans QR → loads SPA
5. SPA reads ?pair=<token> from URL, calls GET /dashboard/api/pair/:token
6. Daemon verifies token unconsumed + within TTL → returns long-lived bearer
7. SPA stores bearer in localStorage; redirects to /dashboard/ (drops pair query)
8. Subsequent requests use the bearer; pair token is now consumed (subsequent uses 410)
```

If the QR is shared / token expires before scan → SPA shows a "pairing expired, run `agent-tempo dashboard --pair` again" banner.

### 7.3 Mobile responsive

shadcn primitives are responsive by default. Reserve work for:

- **Safe-area insets** — `env(safe-area-inset-*)` on the main layout shell + `Sheet`-based mobile drawer
- **Touch targets** — minimum 44 × 44 pt per Apple HIG; verify in Playwright e2e on mobile viewport
- **Sheet vs Dialog** — small viewports use `Sheet`; desktop uses `Dialog` (shadcn supports both — wrap in a `useMediaQuery` hook)
- **Phone app bar** — design bundle `dashboard.html` has a `PhoneAppBar` component; map to a sticky-top mobile-only bar

The design bundle already specifies four viewport sizes (`desktop` 1440 / `laptop` 1180 / `tablet` 834 / `phone` 390) — implementer matches breakpoints.

---

## 8. Design tokens — mapping from `dashboard-handoff/styles.css` to Tailwind 4 + shadcn theme

The handoff bundle is **canonical** for design tokens (per HANDOFF-NOTE.md). Mapping table:

### 8.1 Color tokens (dark theme; `[data-theme="dark"]`)

| `styles.css` var | Value | Tailwind 4 / shadcn token |
|---|---|---|
| `--accent` | `#E07A5F` | `--primary` |
| `--accent-soft` | `oklch(0.72 0.12 28 / 0.18)` | `--primary-foreground-soft` (custom) |
| `--accent-ink` | `oklch(0.92 0.05 28)` | `--primary-foreground` |
| `--bg` | `#0F1117` | `--background` |
| `--bg-1` | `#141722` | `--card`, `--popover` |
| `--bg-2` | `#1A1E2B` | `--secondary` |
| `--bg-3` | `#20253417` | `--muted` |
| `--bg-chat-out` | `#1B2030` | (custom — `--chat-out`) |
| `--text` | `#F5EEE6` | `--foreground` |
| `--text-2` | `#C5C1B9` | `--secondary-foreground` |
| `--dim` | `#7D8090` | `--muted-foreground` |
| `--muted` | `#4B5064` | (custom — keep as `--muted-2`; shadcn already uses `--muted`) |
| `--rule` | `#262B3A` | `--border` |

> **Source-vs-shadcn naming swap (`--bg-3` ↔ source `--muted`):** the two source vars look related but map to *different* shadcn slots. The soft tinted surface `--bg-3` (`#20253417`) lands on shadcn's `--muted` token, while the source `--muted` (`#4B5064`, an ink-tone for inactive controls) becomes a custom `--muted-2`. Implementer should add an inline comment to `dashboard/src/styles/tokens.css` documenting this split so future maintainers don't conflate the two. Example header comment near the `--muted` / `--muted-2` declarations:
> ```css
> /* IMPORTANT: shadcn's `--muted` corresponds to the SOURCE `--bg-3` (a
>  * tinted surface). The SOURCE `--muted` is a separate ink tone — kept
>  * here as `--muted-2`. Do NOT collapse them; they paint different roles
>  * in the dashboard-handoff design. */
> ```
| `--rule-strong` | `#343A4F` | `--input` (matches shadcn semantic) |
| `--ok` / `--warn` / `--err` / `--info` | `#8CC79A` / `#E9C888` / `#EF5C5C` / `#7FB3D5` | (custom — `--success` / `--warning` / `--destructive` / `--info`) |

Light-theme palette (`[data-theme="light"]`) lives in `styles.css:66-88`; mapped identically to the dark-theme token names.

### 8.2 Typography

| Role | Family | Source |
|---|---|---|
| UI | **Instrument Sans** (with `Inter` as fallback if Instrument unavailable on the host) | Google Fonts |
| Display | **Instrument Serif** (with `Fraunces` fallback) | Google Fonts |
| Mono | **JetBrains Mono** | Google Fonts |

> **Source-vs-rendered note**: `styles.css` declares `Instrument Sans/Serif` first; `dashboard.html` Google Fonts `<link>` loads `Inter` and `Fraunces` (not Instrument). The visually-rendered output of the design uses Inter/Fraunces fallbacks. Implementer should load **Instrument Sans + Instrument Serif + JetBrains Mono** (matching the `--ff-*` declarations) so the rendered SPA matches the *intended* design, not the prototype's loaded-font drift. Alternative: if Instrument fonts are problematic on slow connections, fall back to Inter/Fraunces (closer to what was rendered during design).

Loaded via Google Fonts `<link>` in `dashboard/index.html` — same pattern as the prototype.

### 8.3 Density variables

`styles.css:38-52` defines six density steps (`data-density="4"` through `"9"`, default `6`). Each sets `--density-pad`, `--density-pad-y`, `--density-gap`, `--density-fs`, `--density-fs-sm`, `--density-line`. Carry verbatim — Tailwind 4's `@theme` accepts arbitrary CSS variables.

The Zustand prefs store sets `document.documentElement.dataset.density = String(prefs.density)`; the rest is handled by CSS attribute selectors.

### 8.4 Custom motifs (preserve verbatim)

| Motif | Source | Lock |
|---|---|---|
| **Metronome** (animated swinging triangle) | `primitives.jsx:7-27` | Port to `dashboard/src/components/tempo/Metronome.tsx`; preserve `--bpm-dur` CSS variable + `is-running` class semantics |
| **Tempo strip** (sparkline + beat bars) | `primitives.jsx:100+`, `styles.css:184-204` | Custom React component; not a shadcn equivalent |
| **Phase dot** (icon + pulse animation for active) | `primitives.jsx:44-52`, `styles.css:140-156` | Maps to `useAttachmentPhase` hook + animated dot; phases per `docs/concepts.md` |
| **Player avatar** (musical-glyph on tinted square; conductor gets treble clef) | `primitives.jsx:55-81` | Port verbatim; `hueForType` + `glyphFor` helpers from `shared.jsx` |
| **Type badge** (tiny chip) | `primitives.jsx:83-98` | Port verbatim; `hueForType` for color |
| **Brandmark** (metronome + wordmark) | `primitives.jsx:30-41` | Port verbatim |

These are NOT shadcn primitives — they're agent-tempo-specific. Live under `dashboard/src/components/tempo/`.

### 8.5 Tweaks panel — defer to dashboard-internal Settings sheet

The design has a "Tweaks" side panel (`tweaks-panel.jsx`) for theme/density/accent/viewport. In v1 this becomes a **shadcn Sheet** triggered from a settings icon in the sidebar — viewport switching is desktop-only utility (the SPA already adapts to actual viewport via media queries; the prototype's manual viewport selector was a design-time tool, not user-facing).

---

## 9. v1 scope — locked

### 9.1 What ships in v1

**All 9 screens render.** Read paths fully wired. Write paths gated on safety:

| Screen | v1 status |
|---|---|
| **A — Workspace** (chat + roster + tempo strip) | ✅ Full — cue, pause, play, release wired; chat scroll + message input |
| **B — Player Detail sheet** | ✅ Full — read attachment_info, recall, set_part; pause/play/release/recruit-replacement wired |
| **C — Overview** | ✅ Read-only ensemble cards + recent activity event log |
| **D — Create Ensemble** | ⚠️ Read-only preview / disabled CTA → "Coming in v2" tooltip |
| **E — Recruit wizard** | ✅ Full — recruit is a safe write |
| **F — Loadouts** (lineups) | ⚠️ Read-only list / disabled CTAs |
| **G — Player Types** | ✅ Read-only — agent type discovery via existing `agent_types` tool |
| **H — Schedules** | ⚠️ Read-only list / disabled create-edit CTAs |
| **I — Hosts** | ✅ Read-only — `/v1/hosts` endpoint |

### 9.2 Disabled-with-tooltip pattern

```tsx
<Tooltip content="Coming in v2 — destructive verbs require confirmation flows we're still designing.">
  <Button variant="ghost" disabled size="sm">Destroy</Button>
</Tooltip>
```

Visible-but-disabled is intentional: shows users what's coming without requiring a code-path-removed-then-restored cycle in v2.

### 9.3 What v2 unlocks

- Destructive: `destroy`, `restart`, `restore`, `shutdown` with explicit confirmation modals
- Schedule create / edit / delete
- Lineup create / edit / load / save
- Quality gates UI (set, evaluate, view)
- Worktree management (set/list/delete)
- Stage management

Estimated v2 cost: +1,500–2,500 LoC per researcher.

---

## 10. Build & packaging

### 10.1 Top-level `package.json` orchestration

```json
{
  "scripts": {
    "build": "tsc && build:scripts && build:dashboard && build:bundle",
    "build:dashboard": "npm --prefix dashboard ci && npm --prefix dashboard run build",
    "build:bundle": "node scripts/build-workflow-bundle.js",
    "size-limit": "size-limit"
  },
  "files": [
    "dist/",
    "workflow-bundle.js",
    "dashboard/dist/",                    // NEW — shipped static assets
    "dashboard/package.json",             // NEW — for traceability (no node_modules shipped)
    "assets/",
    "examples/",
    "packaging/"
  ],
  "engines": { "node": ">=20" }
}
```

### 10.2 NO postinstall build

Mink's `postinstall: build` is a known support black hole (per researcher §1). Static assets are precompiled at publish time only; the npm tarball ships ready-to-serve `dashboard/dist/`.

### 10.3 size-limit CI gate

```js
// .size-limit.js (NEW, root)
module.exports = [
  {
    name: 'dashboard JS bundle (gzip-on-wire)',
    path: 'dashboard/dist/assets/*.js',
    limit: '1 MB',
  },
  {
    name: 'dashboard CSS bundle',
    path: 'dashboard/dist/assets/*.css',
    limit: '100 KB',
  },
];
```

CI step `npm run size-limit` after `build:dashboard`. Hard fail if exceeded — bundle bloat is a recurring blocker for cross-device UX over slow connections.

### 10.4 Build cap target

**+30 s** to total `npm run build`. Measured during impl; if blown, split out to a lazy `npm run build:dashboard` invoked separately (release pipeline only).

---

## 11. Testing

### 11.1 Vitest component tests (`dashboard/tests/components/`)

- Render each screen with mocked `TempoClient`; assert key elements present
- Cue mutation optimistic update → rollback on error
- Pairing-token consume flow → bearer stored, redirect drops query param
- Density/theme toggles update `document.documentElement.dataset`
- Accessibility: `axe-core` on critical screens (Workspace, Overview, Recruit)

### 11.2 Playwright e2e smoke (`dashboard/tests/e2e/`)

Small pack — not full coverage:

- Smoke 1: `agent-tempo dashboard` opens, Overview loads, ensemble list renders from snapshot
- Smoke 2: cue from Workspace lands as a chat message via SSE round-trip (against test fixture daemon)
- Smoke 3: phone viewport — Sidebar collapses to Sheet, PhoneAppBar visible
- Smoke 4: pairing flow — `--pair` mints token; SPA exchanges; bearer stored

NO Cypress. Vitest + Playwright is the chosen split (Vitest matches existing test discipline in `tests/`).

### 11.3 size-limit CI gate

Per §10.3.

### 11.4 Lighthouse — release-checklist item, not CI

Targets: Perf ≥85 (mobile, 4G throttle), Accessibility ≥90, Best Practices ≥90. Manual run before each release; failures gate release but don't gate CI. **Saves ~2 minutes per CI run; v1 ships faster.**

### 11.5 Wire-protocol drift detector

Already enforced; no new wire surface, so no impact.

---

## 12. Open questions resolution — researcher's 10

| # | Question | Locked decision | Rationale |
|---|---|---|---|
| 1 | Repo layout | Sibling `dashboard/` dir | Mirrors Mink; isolates node_modules; no need for sub-package versioning |
| 2 | Build orchestration | In default `npm run build`; `build:dashboard` as standalone | Cap +30 s; if blown, split out lazily |
| 3 | Hot reload | Vite dev server with `server.proxy` for `/v1/*` and `/dashboard/api/*` → `127.0.0.1:8473` | Standard Vite pattern; documented in `docs/development.md` |
| 4 | Pairing-token shape | Opaque `crypto.randomBytes(32).toString('base64url')`; 5-min TTL; single-use; in-memory map | Simplest forward-compatible shape; daemon restart invalidates is fine |
| 5 | State management | TanStack Query (server) + Zustand (prefs) + `useState` (component-local) | Three layers, clear responsibilities; NO Redux |
| 6 | Versioning | Lockstep — `dashboard/package.json` version mirrors root | No external consumer; eliminates compat matrix |
| 7 | v1 functional cut | All screens render; only safe writes wired; destructive disabled-with-tooltip | Ships visible v2 roadmap; no UI churn during v2 unlock |
| 8 | Browser support | Last 2 evergreen Chrome/Edge/Safari/Firefox; Safari ≥16; no IE | Locked in `vite.config.ts` `build.target` |
| 9 | Lighthouse / a11y | Targets 85/90/90; CI checks size-limit only; Lighthouse is release-checklist | Faster CI; manual gate at release |
| 10 | Reference-fork story | `dashboard/README.md` documents TempoClient integration + design-token mapping + fork-and-customize guide | Issue's reference-quality goal honoured |

---

## 13. Sequencing

### 13.1 Independence

- **#318 coat-check** — orthogonal; dashboard doesn't observe coat-check entries in v1 (could in v2 as an attachment-fetch UX)
- **#319 protobuf migration** — dashboard speaks JSON over HTTP (TempoClient's existing transport); not affected by Temporal-internal payload format
- **#334 saveable-state** — dashboard could surface "save state" button per-player in v2 (not v1)
- **#94/#95 SSE event source** — **prerequisite — must be fully shipped (PR-4 TUI cutover + 48 h soak)** per issue #340 sequencing

### 13.2 Recommended drop point

After PR-4 + 48 h soak (per issue). Aligns with eng-2 availability post-#329 split (TempoClient context fresh).

Could be 1 large PR (~3,100–4,740 LoC) or split into **3 sequenced PRs**:
- **PR-A** — Vite scaffolding, design tokens, shadcn theme, layout shell, TempoClient + TanStack Query plumbing (~1,000 LoC)
- **PR-B** — All 9 screens (read paths only), routing, SSE bridge (~1,800 LoC)
- **PR-C** — Safe-write wiring (cue / pause / play / release / recruit), pairing flow, CLI verb, daemon static-asset handler, tests (~1,000 LoC)

Engineer's call. PR-A as a solo first drop is good for early review.

### 13.3 Alignment with v1.0 release theme

If protobuf migration (#319) lands as v1.0, the dashboard could be a v1.0 launch headline — "agent-tempo, now with mobile-friendly web dashboard". Consider sequencing for that.

---

## 14. References

- **Issue #340** — original proposal with motivation, 6 design-space areas, sequencing
- **PR #341** — Phase A research (`docs/research/340-web-dashboard-alternatives.md`)
- **PR #345** — design bundle (`docs/design/dashboard-handoff/`) — canonical visual source
- **ADR 0013** — [`0013-web-dashboard.md`](../adr/0013-web-dashboard.md) — decision record
- ADR 0007 / 0008 / 0009 / 0011 / 0012 — design-spike template precedent
- `src/http/{server,auth,cors,port-file,responses}.ts` — daemon HTTP infrastructure (PRs #320, #324, #325)
- `docs/SSE-PROTOCOL.md` — wire contract the dashboard consumes via TempoClient
- `src/client/` — TempoClient implementation (PR #325 split; #329 Core/WithSpawn extracted)
- Mink (https://github.com/drewpayment/mink) — closest packaging precedent
- shadcn/ui v4.5 — copy-paste component library
- Tailwind 4.2 + Vite plugin — CSS-first `@theme` engine
- TanStack Query 5 — server-state library
- React Router 7 — explicit-route config
- Zustand 5 + persist middleware — user-prefs store
- size-limit 12 — CI bundle gate
- Playwright — e2e smoke tests
