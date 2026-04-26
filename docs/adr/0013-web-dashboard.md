# ADR 0013 — Packaged web dashboard via `claude-tempo dashboard`

- **Status**: Accepted (design — implementation deferred to scheduled engineer pickup; eng-2 named per conductor)
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/design/340-web-dashboard.md`](../design/340-web-dashboard.md), [`docs/research/340-web-dashboard-alternatives.md`](../research/340-web-dashboard-alternatives.md), [`docs/design/dashboard-handoff/`](../design/dashboard-handoff/) (canonical design bundle, PR #345), issue #340

## Context

Issue #340 proposes a packaged React web dashboard for managing claude-tempo ensembles, started via a new CLI verb `claude-tempo dashboard`. Goal: become the **primary cross-device interface** (alongside the existing terminal TUI), serve as a reference fork-target for downstream consumers, and ship as a reasonably-sized addition to the npm tarball.

Infrastructure to support a dashboard already landed in v0.27 + Phase 3 of #94/#95: daemon HTTP server (PR #320), SSE streaming (PR #324), `TempoClient.subscribe()` (PR #325), bearer-token auth + CORS, multi-host support. The dashboard is a thin client over the existing wire surface; **no new Temporal signals/queries/updates** are required.

Phase A research (PR #341, `docs/research/340-web-dashboard-alternatives.md`) audited prior art (Mink, Storybook, Drizzle/Prisma Studio anti-patterns), validated a Vite + Tailwind 4 + shadcn 4.5 stack, refined the LoC estimate to ~3,100–4,740, and surfaced 10 open questions for this design spike to lock.

vinceblank's canonical visual design lives in [`docs/design/dashboard-handoff/`](../design/dashboard-handoff/) (PR #345), exported from Claude Design (`claude.ai/design`). The bundle ships HTML/CSS/JSX prototypes for **9 screens** (Overview, Workspace, Player Detail, Recruit, Create Ensemble, Loadouts, Player Types, Schedules, Hosts), full design tokens (warm-neutral palette + terracotta accent + density slider 4–9 + light/dark themes), and custom motifs (animated metronome, tempo strip, phase dot, player avatar). Per the bundle's README, the implementer's job is to **recreate them pixel-perfectly in whatever technology makes sense for the target codebase** — for us, the researcher-locked stack.

The design spike was tasked with locking the 10 open questions, mapping design tokens into a shadcn theme schema, and specifying the daemon static-asset integration before engineer pickup.

## Decision

**Adopt the packaged web dashboard as designed in [`docs/design/340-web-dashboard.md`](../design/340-web-dashboard.md).** The design lives there; this ADR records the decision.

Headline locked-in choices:

- **Repo layout**: sibling `dashboard/` directory at repo root (mirrors Mink). Own `package.json` + `node_modules` + tsconfig + Vite/Tailwind configs; isolated from main TS build. **NOT** a separately-versioned npm sub-package.
- **Stack**: React 19.2.5, Vite 8.0.10 (NOT Next.js — RSC is dead weight for an SPA bundled into a CLI), Tailwind 4.2.4 (Oxide engine, CSS-first `@theme`), shadcn 4.5.0 (copy-paste, NOT runtime dep), TanStack Query 5.100.5 (server state), React Router 7.14.2 (explicit routes), Zustand 5.x (user prefs), size-limit 12 (CI gate), Vitest (component) + Playwright (e2e smoke).
- **Build & packaging**: top-level `npm run build` invokes `npm --prefix dashboard run build` before the workflow bundle step. **Cap +30 s**; split out lazily if it blows. **Static assets shipped via `package.json#files`**; **NO `postinstall` build hook** (Mink's known support black hole).
- **Bundle budget**: ≤1 MB gzip-on-wire / ≤3 MB unpacked for the dashboard portion. Enforced by `size-limit` in CI; hard fail if exceeded.
- **Daemon serving**: one new file (`src/http/dashboard.ts`, ~80 LoC) for static + SPA fallback at `/dashboard/*`; reuses existing auth (bearer for non-loopback) and CORS allowlist. Two new endpoints under `/dashboard/api/*` for the QR-code pairing flow (POST `/pair` + GET `/pair/:token`).
- **CLI verb**: `claude-tempo dashboard [--port] [--bind] [--no-open] [--pair]` — auto-starts daemon, reads port file, opens browser, optionally mints a 5-min single-use pairing token and prints a QR code.
- **Cross-device auth**: Tailscale primary path; QR-code-with-short-lived-pairing-token UX for mobile. **Token shape**: `crypto.randomBytes(32).toString('base64url')`, 5-min TTL, single-use, in-memory map (daemon restart invalidates outstanding pairings — acceptable).
- **State management**: **TanStack Query** for server state (snapshots from `/v1/state/:ensemble`; SSE events feed `queryClient.setQueryData`). **Zustand** for user preferences (theme/density/accent/viewport, `localStorage`-backed). **useState** for component-local UI state. **NO Redux**.
- **v1 functional cut**: **all 9 screens render**; only **safe writes wired** (cue, report, release, play, pause, recruit). Destructive verbs (destroy, restart, restore, shutdown), schedule edit, lineup edit, gates, worktrees — disabled with `Coming in v2` tooltip. Visible-but-disabled deliberately, so the v2 roadmap is on-screen.
- **Browser support floor**: last 2 evergreen of Chrome/Edge/Safari/Firefox; Safari ≥16; no IE. Locked in `vite.config.ts` `build.target`.
- **Lighthouse / a11y**: targets Perf ≥85 / Accessibility ≥90 / Best Practices ≥90 (mobile, 4G throttle). **CI checks size-limit only**; Lighthouse is a **release-checklist item**, not blocking CI.
- **Versioning**: dashboard pinned in lockstep with claude-tempo (no independent release). CI enforces `dashboard/package.json` version matches root.
- **Reference-fork story**: `dashboard/README.md` documents the TempoClient integration shape, design-token mapping, and an explicit "fork-and-customize" guide. Mentioned from the main README. Honours issue #340's reference-quality goal.
- **Design tokens**: full mapping table from `dashboard-handoff/styles.css` CSS variables to shadcn theme tokens (`--accent` → `--primary`, `--bg` → `--background`, `--rule` → `--border`, …) lives in design §8. Custom tempo motifs (Metronome, TempoStrip, PhaseDot, PlayerAvatar, TypeBadge, Brandmark) ported verbatim to `dashboard/src/components/tempo/`.

10 open questions — locked answers:

| Q | Locked decision |
|---|---|
| Repo layout | Sibling `dashboard/` dir |
| Build orchestration | In default `npm run build`; `build:dashboard` standalone; +30 s cap |
| Hot reload | Vite dev server with proxy to daemon |
| Pairing token shape | Opaque base64url 32-byte random; 5-min TTL; single-use; in-memory |
| State management | TanStack Query (server) + Zustand (prefs); NO Redux |
| Versioning | Lockstep with root; CI enforced |
| v1 functional cut | All screens render; only safe writes wired; destructive disabled-with-tooltip |
| Browser support | Last 2 evergreen; Safari ≥16; no IE |
| Lighthouse / a11y | Targets 85/90/90; CI=size-limit only; Lighthouse=release checklist |
| Reference-fork story | `dashboard/README.md` with fork guide |

## Consequences

- **Positive**:
  - **Cross-device + mobile-friendly access** — the explicit gap the TUI doesn't address. Tailscale + QR-pairing fits the existing daemon auth model with no new wire-protocol surface.
  - **Zero new Temporal signals/queries/updates** — dashboard is a thin client over the existing daemon HTTP/SSE wire. No workflow changes; no `WIRE-PROTOCOL.md` updates beyond static-asset routing.
  - **`TempoClient` is the source of truth for the wire contract** — dashboard imports the published types directly; new tools and surfaces light up automatically as `TempoClient` grows.
  - **Visible v2 roadmap** — disabled-with-tooltip pattern shows users what's coming without UI churn during v2 unlock. Engineer can ship destructive-write paths in a later PR with no layout changes.
  - **Bundle budget is honest** — 1 MB gzip / 3 MB unpacked is enforced by CI from day one, not aspirational. Prisma's 87 MB → 136 MB cautionary tale (per researcher §1) doesn't repeat here.
  - **Fork-friendly** — the `dashboard/` dir is dependency-isolated and architecture-documented. Downstream consumers can fork it as a starting point against `TempoClient` without lifting the rest of claude-tempo.
  - **Visual design is canonical** — implementer pulls tokens directly from `dashboard-handoff/styles.css` rather than re-deriving from screenshots. Component shapes pre-spec'd across 9 artboards in `dashboard.html`.
- **Negative**:
  - **+30 s build cost** for `npm run build`. If it blows the cap during impl, the fallback (split into a lazy `build:dashboard` invoked only at release time) is documented; both paths are in scope.
  - **Static assets shipped in tarball** grow the npm package by ~1 MB. Acceptable per the bundle-budget reasoning; well under the 2 MB ceiling the issue named.
  - **Path-alias for `claude-tempo` imports** in the dashboard (vs npm workspaces) means the dashboard depends on the source layout being stable. If `src/client/` reorganises, the alias breaks. Acceptable trade — npm workspaces add tooling complexity that isn't justified for a single dashboard consumer.
  - **In-memory pairing-token map** means daemon restart invalidates outstanding pairings. Operator re-runs `--pair`; no persistence layer to manage. Acceptable trade — pairings are transient.
  - **Lighthouse not in CI** means perf regressions can land between releases. Mitigated by size-limit catching the most common cause (bundle bloat); release-time manual run catches the rest.
  - **Sibling-dir + path-alias setup is non-obvious for new contributors** — `dashboard/README.md` + `docs/development.md` document the dev workflow explicitly.
  - **Browser support floor of last-2-evergreen** excludes ~3% of real-world traffic. Acceptable for a developer-facing tool; revisit if telemetry shows otherwise.
- **Neutral**:
  - **~3,100–4,740 LoC implementation cost** matches researcher's refined estimate. Single PR or 3 sequenced PRs (engineer's call). eng-2 named as natural implementer post-#329 TempoClient split.
  - **shadcn components are committed source, not runtime dep** — PR diffs will include component scaffolding, but tree-shaking strips unused. Standard shadcn pattern.
  - **Two test directories already exist** (Mocha `test/` and Vitest `tests/`); dashboard adds Playwright e2e smoke under `dashboard/tests/e2e/`. Three test runners total — manageable.

## Alternatives considered

- **Use existing TUI as the only interface** — rejected. Mobile + cross-device are explicit goals of #340; the TUI doesn't address either.
- **Hosted UI on Vercel/Netlify (Drizzle Studio model — `https://local.drizzle.studio`)** — rejected. Public-internet → loopback HTTP creates mixed-content + CORS surface; offline-broken; couples UI release to a CDN deploy cycle. Per researcher §1 anti-pattern.
- **Electron / Tauri desktop app** — rejected. "Dashboard" framing implies browser-served; desktop app explodes the install footprint and adds platform-bundle pain.
- **Iframe the TUI in a web wrapper** — rejected. TUI is Ink-rendered to a terminal; not portable to browser context.
- **Next.js with App Router + RSC** — rejected. RSC requires Node runtime; we're shipping a static SPA. RSC's value is server-rendered data fetching — we already have `TempoClient.subscribe()`. Dead weight for our scope.
- **Per-project Vite build at user-install time (`postinstall: build`)** — rejected. Mink's known support black hole on `npm i -g`. Prebuild once at publish; `dashboard/dist/` ships in the tarball.
- **Sub-package with independent version (`@claude-tempo/dashboard`)** — rejected for v1. No external consumer; lockstep eliminates the "which dashboard goes with which daemon" matrix. Revisit if downstream forks need independent versioning.
- **Subprocess vs in-process MCP for dashboard tool calls** — N/A; dashboard speaks HTTP+SSE to the daemon, not MCP. The MCP-bridging design from #131 (claude-api adapter) is for adapter contexts, not dashboard.
- **Redux + redux-saga** — rejected. TanStack Query + Zustand cover both server and prefs state with less ceremony. Redux added complexity exceeds its value.
- **Cypress for e2e** — rejected in favour of Playwright. Faster, fewer flakes, better mobile-viewport story, matches researcher §2.
- **shadcn-ui (deprecated package name)** — rejected; use shadcn 4.5 (renamed package). Researcher confirmed `npx shadcn@4.5.0 init` is current CLI.
- **Tailwind 3 (legacy)** — rejected; v4 is production-recommended; Oxide engine + CSS-first `@theme` are notably better DX.
- **JWT pairing token vs opaque random** — rejected. JWT adds signing key management for a 5-min single-use token; opaque random is simpler and functionally equivalent at this scale.
- **Persistent pairing tokens (file-backed)** — rejected. Daemon-restart-invalidation is fine; transient by design.
- **Aggressive ship-everything-v1 (destructive verbs included)** — rejected. Destructive paths need confirmation flows we're still designing; ship safe writes first, gather feedback, then enable destructive.
- **CI Lighthouse gate** — rejected for v1. Adds ~2 min per CI run; size-limit catches the most common cause (bundle bloat); manual release-checklist catches the rest.

## Forward-looking notes

- **v2 destructive writes** — `destroy`, `restart`, `restore`, `shutdown` with confirmation modals. Estimated +800–1,200 LoC. Likely a single follow-up PR.
- **v2 schedule + lineup CRUD** — full create/edit/delete UX for schedules and lineups. Estimated +400–800 LoC.
- **v2 quality gates UI** — set, evaluate, view criteria across the ensemble. Estimated +300–500 LoC.
- **v2 worktree management** — set/list/delete worktrees from the dashboard. Estimated +200–300 LoC.
- **v2 "fetch saved state" UX** — composes with #334 (player-saveable state, just landed) — show a per-player "saved state" badge + fetch panel. Small additive.
- **v2 advisor consultation surface** — composes with #131 Phase 2 (advisor strategy) when it lands. Show executor/advisor split + per-turn cost in the chat log.
- **v2 cost monitoring** — once #131's `recordTurnUsage` signal lands, dashboard surfaces per-session / per-ensemble token + dollar burn rate.
- **v2 dark/light auto** — `prefers-color-scheme` media-query auto-toggle (currently manual via Settings sheet).
- **v2 i18n** — out of scope for v1; researcher §8 deferred. Revisit if international contributors materialise.
- **v3 multi-user / RBAC** — out of scope. The current bearer-token model assumes single-operator. Multi-user requires a real auth surface (OIDC, …) — large project; separate issue.
- **External-host hosting** (e.g., a managed `https://dashboard.claude-tempo.dev` against your local daemon) — explicit anti-pattern per researcher §1; not pursued.
- **Wire-protocol additions post-v1.0** must register with the protobuf field-number plan in `protos/README.md` reservations log when #319 (protobuf migration) lands. The dashboard speaks JSON over HTTP; the protobuf migration is Temporal-internal — no dashboard changes when #319 lands.
- **TUI deprecation path** — TUI continues indefinitely. The dashboard is additive, not a replacement. If/when usage data shows the dashboard fully subsumes TUI use cases, deprecation can be considered; not v1 or v2 concern.

## References

- [`docs/design/340-web-dashboard.md`](../design/340-web-dashboard.md) — full design (14 sections, repo layout, daemon serving, design-token mapping, scope cut, build pipeline, test strategy, decision log)
- [`docs/research/340-web-dashboard-alternatives.md`](../research/340-web-dashboard-alternatives.md) — Phase A research (PR #341) — prior art, stack analysis, alternatives, 10 open questions
- [`docs/design/dashboard-handoff/`](../design/dashboard-handoff/) — canonical design bundle (PR #345; Claude Design export)
- Issue #340 — original proposal with 6 design-space areas, sequencing, acceptance criteria
- ADR 0007 (TempoClient Core/WithSpawn split), 0008 (coat-check), 0009 (protobuf), 0011 (saveable-state), 0012 (claude-api adapter) — design-spike template precedent
- `src/http/{server,auth,cors,port-file,responses}.ts` — daemon HTTP infrastructure (PRs #320, #324, #325)
- `docs/SSE-PROTOCOL.md` — wire contract the dashboard consumes via TempoClient
- `src/client/` — TempoClient implementation (PR #325 split; #329 Core/WithSpawn extracted — eng-2 has fresh context)
- Mink (https://github.com/drewpayment/mink) — closest packaging precedent
- shadcn/ui v4.5, Tailwind 4.2, TanStack Query 5, React Router 7, Vite 8, Zustand 5, size-limit 12, Playwright — locked stack (researcher §2)
