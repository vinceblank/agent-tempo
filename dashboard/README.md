# claude-tempo dashboard

A web dashboard for managing claude-tempo ensembles. Bundled into the npm package and served by the daemon at `/dashboard/*`.

This directory is a **sibling project** to the main `src/` TypeScript build — independent `node_modules`, build artifacts, and tooling. The shared `claude-tempo` source lives at `../src/` and is reachable via the `claude-tempo/*` path alias (configured in `vite.config.ts` and `tsconfig.json`).

## Status

PR-2 of [#340](https://github.com/vinceblank/claude-tempo/issues/340) — Vite + Tailwind 4 scaffold + AppShell + testability infra. The shell renders a brandmark, sidebar, and page header; **no real data is wired yet**. PR-4 introduces `TempoClient` integration; PR-5 fills out the read-only screens.

## Stack (locked — see [`docs/adr/0013-web-dashboard.md`](../docs/adr/0013-web-dashboard.md))

| Layer | Pin |
|---|---|
| React | 19.2.5 |
| Vite | 8.0.10 |
| Tailwind | 4.2.4 (Oxide engine, CSS-first `@theme`) |
| shadcn | 4.5.0 (committed source under `src/components/ui/`) |
| TanStack Query | 5.100.5 |
| React Router | 7.14.2 |
| Zustand | ^5 |
| size-limit | 12.1.0 |
| Tests | Vitest (component) + Playwright (e2e smoke, future) |

Browser support floor: last two evergreen of Chrome/Edge/Safari/Firefox; **Safari ≥ 16**. Older Safari is excluded because the design tokens use `oklch()` which requires ≥ 15.4; we set the floor at 16 to align CSS and ECMA targets.

## Dev workflow

```bash
# from repo root
npm --prefix dashboard install        # one-time
npm --prefix dashboard run dev        # Vite dev server on :5173, proxies /v1/* and /dashboard/api/* to the daemon at 8473
npm --prefix dashboard run build      # production bundle → dashboard/dist/
npm --prefix dashboard run lint
npm --prefix dashboard run test
```

`npm run build` at the repo root invokes `npm --prefix dashboard run build` as part of the full build pipeline. Target overhead: **+30 s**; if exceeded, the design doc has a fallback (split out as a release-only `build:dashboard`).

## Testability

This dashboard is tested both by Vitest (component tests) and by an autonomous AI agent (the claude-tempo conductor) using `mcp__claude-in-chrome__*` browser automation tools. Tailwind class names are **NOT** a stable test surface; `data-testid` is.

Every interactive or state-significant element MUST carry a stable `data-testid` attribute.

### Naming convention

`<surface>-<action-or-state>-<identifier>` — kebab-case, lowercased.

Examples:

- `data-testid="player-row-tempo-conductor"`
- `data-testid="cue-input"` / `data-testid="cue-submit"`
- `data-testid="broadcast-badge"`
- `data-testid="conductor-indicator"`
- `data-testid="loading"` + `data-resource="ensemble-list"` (loading states)
- `data-testid="error-toast"` + `role="alert"` (errors)
- `data-testid="settings-theme-toggle"` / `data-testid="settings-density-slider"`

If an element is genuinely test-irrelevant (pure decoration, screen-reader-only utility text), add `data-testid-exempt="<reason>"` instead. The `tests/testid-coverage.test.tsx` Vitest crawl asserts every `button`, `input`, `select`, `textarea`, and `[role="button"]` has either `data-testid` or `data-testid-exempt`.

### Banned

- `window.confirm`, `window.alert`, `window.prompt` — they block claude-in-chrome and pause the autonomous validation driver until a human dismisses them. Use shadcn `AlertDialog` / `Dialog` / Sonner toast instead.
- Native `<dialog>` elements — same blocking behaviour. Use shadcn `Dialog` / `AlertDialog` / `Sheet`.

ESLint enforces both bans; lint is build-blocking (see `eslint.config.js`).

### Console logging

State transitions, mutations, and SSE events MUST log via `logEvent(action, kvs)` from `src/lib/log.ts`. Output format:

```
[claude-tempo:dashboard] <action> key=value key=value
```

The conductor's autonomous validation script can `mcp__claude-in-chrome__read_console_messages` with the regex `\[claude-tempo:dashboard\]` to verify state transitions without parsing the DOM. This mirrors the `[claude-tempo:adapter]` shape used by adapter heartbeat logs (#249).

Debug-level logs are gated by `?debug=1` in the URL or `localStorage.agentTempoDebug = 'true'`.

## Design tokens

The canonical design lives at [`docs/design/dashboard-handoff/`](../docs/design/dashboard-handoff/). Tokens are ported into `src/styles/tokens.css` with the Tailwind 4 `@theme` directive; the §8.1 `--bg-3`/`--muted` swap is documented inline.

Custom tempo motifs (Metronome, TempoStrip, PhaseDot, PlayerAvatar, TypeBadge, Brandmark) live under `src/components/tempo/` (PR-2 ships only Brandmark; the rest land in PR-4/PR-5).

## Reference / fork-and-customize

This dashboard is structured to be **reasonably forkable** as a starting point against `TempoClient`. Downstream consumers building their own dashboard against claude-tempo can copy this directory, adjust the path alias, and replace `src/components/` to taste while reusing the AppShell + prefs scaffolding.

Detailed fork notes will land in a follow-up PR once PR-4 wires up `TempoClient` and the integration shape is stable.
