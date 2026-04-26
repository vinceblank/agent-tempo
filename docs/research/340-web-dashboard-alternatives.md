# Packaged Web Dashboard — Issue #340 Phase A research

- **Author**: tempo-researcher (claude-tempo[bot] ensemble)
- **Date**: 2026-04-26
- **Status**: Phase A (research) — feeds tempo-architect's Phase B (design + ADR)
- **Tracking issue**: #340
- **Phase B output (when available)**: `docs/design/340-web-dashboard.md` + ADR authored by tempo-architect

---

## 1. Prior-art audit — "library packages a dashboard"

| Project | Packaging shape | Distribution | Notable |
|---|---|---|---|
| **Mink** (https://github.com/drewpayment/mink) | **Single repo**, sibling `dashboard/` dir, **single npm package** | Next.js+Tailwind+shadcn → `dashboard/out` (prebuilt), shipped inside tarball via `files` | `mink dashboard` opens local browser. **Active** (v0.8.0, 2026-04-26). **`postinstall: build` hook is fragile** — copy the layout, NOT the install hook. |
| **Storybook** | Manager UI prebuilt with esbuild (`@storybook/builder-manager`), shipped in package | Static dist served via `manager-builder`'s `hostStatic` middleware | Migrated explicitly OFF per-project webpack manager (PR #18550 — "future / pre-built manager"). Validates the prebuild-once-at-publish model at scale. |
| **Drizzle Studio** | UI hosted at `https://local.drizzle.studio` (proprietary, public host); only API server in npm | Zero UI bytes shipped | **Anti-pattern for our use** — offline-broken, mixed-content (`https://` page → `http://localhost`), couples UI release cycle to a CDN. |
| **Prisma Studio** | Open-source `@prisma/studio-core`; full assembled CLI Studio is proprietary, **bundled locally** | Local serve, no CDN dependency | Unpacked size grew from **87 MB → 136 MB** (v6.19→v7.0.1). Bloat is `pglite`/`@prisma/dev`, not Studio per se — but it's the cautionary tale for size budget. |
| **vite-plugin-inspect** | Vue SPA precompiled to `dist/client/` | Vite middleware serves `__inspect/*` from package | Small (<2 MB). Confirms the prebuilt-static-served-from-host-process pattern is mainstream. |
| **NestJS Devtools** | UI at `https://devtools.nestjs.com`; only integration package in npm | Zero UI bytes; requires internet | Same anti-pattern as Drizzle. |

**Best precedent: Mink + Storybook hybrid.** Mink is the closest analogue (same proposed stack: Next.js / Tailwind / shadcn — though we'll lean Vite over Next.js, see §2). Storybook validates the architecture: **prebuild once at publish, ship static dist in the tarball, serve from existing host process.**

**Anti-pattern**: hosted-UI model (Drizzle, NestJS). Breaks offline use, creates CORS/mixed-content surface, couples daemon ABI to a remote deploy cycle. Hard reject.

## 2. Stack-choice analysis

| Choice | Recommendation | Rationale |
|---|---|---|
| **React 19.2.5** | Pin minor (`~19.2.5`) | Current stable; React 18 is supported but no upgrade reason for greenfield |
| **Vite 8.0.10** (NOT Next.js) | **Vite** | Issue describes an SPA bundled into a CLI tool; Next.js's runtime + RSC machinery is dead weight here. Vite's static `dist/` output is exactly what `dashboard/` needs. Mink uses Next.js but our scope is narrower. |
| **Tailwind 4.2.4** (Oxide engine, CSS-first `@theme`) | **v4** | v4 is stable + production-recommended; `@tailwindcss/vite` plugin pairs naturally. v3 is legacy-only. Verify shadcn current CLI is v4-compatible — confirmed via `npx shadcn@4.5.0 init`. |
| **shadcn 4.5.0** CLI (note: package renamed from `shadcn-ui`) | Confirmed | `npx shadcn@latest init/add`. Copy-paste-into-project — components live in `dashboard/components/ui/*` and are committed (NOT a runtime dependency). Likely starter set: `button`, `card`, `dialog`, `sheet`, `tabs`, `sidebar`, `toast`/`sonner`, `dropdown-menu`, `tooltip`, `badge`, `input`, `command` (search palette), `skeleton`. |
| **TanStack Query 5.100.5** | **Yes** | Server-state with built-in cache + revalidation maps cleanly to TempoClient subscribe events. Use it as the single source of truth for snapshot data; SSE events feed `queryClient.setQueryData(...)` updates. |
| **Zustand** for UI state | Light, optional | Drawer/modal/route-local state. Skip Redux entirely. |
| **React Router 7.14.2** | **v7, explicit routes** (NOT file-based) | v7 is current; explicit-routes config keeps the bundle smaller and the routing surface visible. File-based routing's value is in code-org for huge apps; not worth the bundle weight here. |
| **size-limit 12.1.0** in CI | **Yes** | Standard tool; alternatives unmaintained. Add `@size-limit/preset-app`. |

## 3. Build + packaging

- **Layout**: `dashboard/` sibling dir at repo root (mirrors Mink). NOT `src/dashboard/` — keeps the dashboard's `node_modules`, build artifacts, and tooling configs isolated from the main TS build.
- **Build pipeline**: top-level `npm run build` orchestrates `tsc && build:scripts && cd dashboard && npm run build && build:bundle` (existing `build:bundle` step for the Temporal workflow bundle). Net cost cap: **+30 s** to the build; if it overruns, split out `npm run build:dashboard` and run it lazily/conditionally.
- **Distribution**: ship `dashboard/dist/` static assets inside the npm tarball via `package.json#files` (alongside existing `dist/`, `workflow-bundle.js`, `assets/`, `examples/`, `packaging/`).
- **NO `postinstall` hook**. Mink's postinstall-build is a known support black hole on `npm i -g` — bundle is precompiled at publish time only.
- **Bundle-size budget**: **≤1 MB gzip-on-wire, ≤3 MB unpacked** for the dashboard portion. Enforce via `size-limit` in CI. Justification: vite-plugin-inspect (<2 MB) + Storybook prebuilt manager (~2-4 MB gzipped) + Mink's Next.js+shadcn output all fit this band; Prisma's 136 MB is the cautionary outlier.
- **Tree-shaking**: shadcn components are committed source — strip unused. Lazy-load chart/data-table chunks via `React.lazy` if any view exceeds 200 KB gzipped.

## 4. Daemon-side serving

The infrastructure already exists. Add **one file** + **one route registration**:

- **`src/http/dashboard.ts`** (new, ~80 LoC): static-asset handler. Reads from `dashboard/dist/` at module init, serves files with proper `Content-Type` + `Cache-Control: public, max-age=31536000, immutable` for hashed assets and `no-cache` for `index.html`. **SPA fallback**: any unmatched `GET /dashboard/*` returns `index.html` (200, not 404).
- **`src/http/server.ts`** route registration (~5 LoC): mount handler before the catchall.
- **Auth model: identical to existing `/v1/*`**. Loopback bind = no auth; non-loopback bind = bearer required. The dashboard SPA reads its bearer from a cookie set on the redirect-to-dashboard endpoint or from `localStorage` after a one-time exchange (Phase B decides).
- **CORS**: existing allowlist (`localhost:*` + `CLAUDE_TEMPO_CORS_ORIGINS`) covers the same-origin case (dashboard served from daemon). Cross-device pairing is a separate flow (§6).

## 5. CLI command

```
claude-tempo dashboard [--port <n>] [--bind <addr>] [--no-open]
```

- **Bootstrap**: ensure daemon is running (existing auto-start path); read `~/.claude-tempo/daemon.port`; compose URL `http://<host>:<port>/dashboard`; `child_process.spawn(opener, [url])` via `open` package or platform-native (`start` / `xdg-open` / `open`).
- `--port` overrides daemon port (rarely needed; daemon is already managed).
- `--bind` forwarded to daemon if not already running with that bind; **forces token mode** when non-loopback (existing daemon behavior).
- `--no-open` for headless servers — print the URL only.
- New file `src/cli/dashboard-command.ts` (~100 LoC), wire into `src/cli.ts` dispatcher.

## 6. Cross-device + mobile

- **Tailscale is the recommended path**. Document it in the Phase C README.
- **Bearer token UX** for cross-device:
  - **Lean**: QR-code-with-short-lived-pairing-token. The `claude-tempo dashboard` CLI prints a QR encoding `http://<tailscale-or-LAN-IP>:8473/dashboard?pair=<short-token>` (token TTL 5 min, single-use, exchanged for the long-lived bearer on the SPA's first load and stored in `localStorage`). Better UX than copy-paste on phone.
  - **Fallback**: copy-paste the bearer from the host machine.
- **Mobile responsive**: shadcn's components are responsive out of the box; reserve work for safe-area insets (`env(safe-area-inset-*)`), 44 × 44 pt minimum touch targets per Apple HIG, prefer `Sheet` over `Dialog` on small viewports.
- **Browser support**: modern evergreen only (last 2 versions of Chrome/Edge/Safari/Firefox); no IE / no Safari < 16.

## 7. Alternatives evaluated

| Alternative | Verdict | Why |
|---|---|---|
| **Use existing TUI as the only interface** | Reject | Mobile + cross-device explicit goals of #340; TUI doesn't address either. |
| **Static dashboard hosted on Vercel/Netlify, points at user's daemon** | Reject | Public-internet → loopback HTTP creates mixed-content + CORS surface; offline-broken; couples UI release to Vercel deploy. Same anti-pattern as Drizzle/NestJS. |
| **Electron / Tauri desktop app** | Reject | "Dashboard" framing implies browser-served; desktop app explodes the install footprint and adds platform-bundle pain. |
| **Iframe the TUI in a web wrapper** | Reject | TUI is Ink-rendered to a terminal; not portable. |
| **Use Drizzle Studio's "hosted UI talks to local daemon" model** | Reject | (see §1 anti-pattern) |
| **Next.js app router with RSC** | Reject (favor Vite) | RSC requires Node runtime; we're shipping a static SPA. RSC's value is server-rendered data fetching — we already have TempoClient subscribe. Dead weight. |
| **Per-project Vite build at user-install time** | Reject | Mink's `postinstall: build` is a known support black hole. Prebuild once at publish. |

## 8. Open questions for architect's Phase B

1. **Repo layout**: confirm `dashboard/` sibling dir vs sub-package (`@claude-tempo/dashboard`)? Sibling dir simpler; sub-package allows independent versioning (probably not needed v1).
2. **Build orchestration**: include in `npm run build` (cap +30 s) or split into `npm run build:dashboard`? Decide by measuring.
3. **Hot-reload dev workflow**: `cd dashboard && npm run dev` proxies daemon at `127.0.0.1:8473` → `vite.config.ts` `server.proxy` for `/v1/*` and `/dashboard/api/*`? Document in `docs/development.md`.
4. **Pairing-token shape**: short-lived (5-min) one-time-use vs JWT vs random base64url? Phase B locks the wire format.
5. **State management granularity**: TanStack Query as the *only* server-state layer, or pair with Zustand for cached subscribe state? Lean: TanStack Query alone — cleaner.
6. **Versioning**: dashboard pinned in lockstep with claude-tempo (no independent release). Confirm.
7. **Functional scope v1 cut**: confirm read-mostly + safe writes (cue, pause, play, release) per issue. Defer destructive writes (destroy, restart, restore, shutdown) to v2.
8. **Browser support floor**: last 2 evergreen only? Phase B locks the `targets` in `vite.config.ts`.
9. **Lighthouse / a11y budget**: aim for Lighthouse 90+ on Performance/Accessibility/Best Practices? Add to CI?
10. **Reference-fork story**: dashboard's `dashboard/README.md` should explicitly call out "fork this to build your own dashboard against TempoClient" per the issue's reference-quality goal.

**🚨 BLOCKER FOR PHASE B**: the two `api.anthropic.com/v1/design/...` URLs in the issue body return **404 from this environment** — they require Claude.ai-internal session auth that an MCP tool/CLI process doesn't have. The architect must bridge access (paste exported HTML/CSS or the design-token JSON, or share via a logged-in browser). Component shapes + design tokens cannot be locked without this.

## 9. Effort estimate

| Area | LoC range |
|---|---|
| Dashboard React app (routes, views, state, components) | 2,000–3,000 |
| TempoClient browser-mode glue (mostly exists in PR #325) | 100–200 |
| Daemon `src/http/dashboard.ts` + route reg + SPA fallback | 80–120 |
| `src/cli/dashboard-command.ts` + browser open + port-file read | 100–150 |
| Build pipeline (vite config, tailwind config, shadcn init, package.json) | 100–150 (config) |
| Tests — Vitest component + Playwright e2e | 500–800 |
| Docs (README "Web dashboard", CLAUDE.md, `dashboard/README.md`) | 200–300 |
| `size-limit` CI config | 20 |
| **Total v1** | **~3,100–4,740 LoC** |

Issue's **4,000–5,000** estimate is realistic. v2 (destructive writes + lineup mgmt + gates UI + worktree mgmt + schedule edit) likely +1,500–2,500 LoC.

## Sources

- [Mink GitHub](https://github.com/drewpayment/mink) — closest precedent
- [Storybook prebuilt-manager PR #18550](https://github.com/storybookjs/storybook/pull/18550)
- [Drizzle Studio / `local.drizzle.studio` discussion](https://github.com/drizzle-team/drizzle-orm/issues/2928) — anti-pattern reference
- [Prisma CLI install-size discussion #28787](https://github.com/prisma/prisma/discussions/28787) — bundle-size cautionary tale
- [vite-plugin-inspect](https://github.com/antfu-collective/vite-plugin-inspect) — small-SPA-served-from-host-process precedent
- [shadcn/ui docs](https://ui.shadcn.com/docs/cli) — current CLI 4.5.0 (note: package renamed from `shadcn-ui`)
- [Tailwind CSS 4 + Vite plugin](https://tailwindcss.com/docs/installation/using-vite)
- `src/http/server.ts`, `src/http/auth.ts`, `src/http/cors.ts`, `src/http/port-file.ts`, `src/http/responses.ts` — existing daemon HTTP infrastructure (PRs #320, #324, #325)
- `docs/SSE-PROTOCOL.md` — wire contract the dashboard consumes
- Issue #340 — full design sketch + 6 open questions; shadcn comment from vinceblank
- Prior Phase A docs: `docs/research/{094-095-sse-streaming, 262-skiptime-migration-scope, 334-player-saveable-state-alternatives, 131-claude-api-adapter-alternatives}.md`
