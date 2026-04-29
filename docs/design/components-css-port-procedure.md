# `components.css` canonical-port procedure

The dashboard's `dashboard/src/styles/components.css` is a **selective port**
of the canonical hand-off bundle at
`docs/design/dashboard-handoff/project/styles.css`. The port is re-synced
manually each minor release until the planned shadcn integration replaces
the bespoke CSS layer. This document is the operational runbook for that
re-sync.

> **Why a manual port?** The canonical bundle contains rules the dashboard
> doesn't ship (design-system-page-only chrome, undeclared tokens, density
> attribute selectors) and rules owned by other layers (`tokens.css`,
> `globals.css`, React primitives). A naked copy would drag those into
> production. The selective filter — documented in the file's own header
> — preserves the canonical's discipline without inheriting its dead
> weight.

## When to re-sync

CI runs `scripts/check-components-css-sync.ts` on every dashboard PR and
prints a drift report:

| drift line count | action |
|---|---|
| 0 | in sync — no action |
| 1 – 49 | minor drift — accumulate; no PR needed yet |
| 50 – 149 | **WARN** — schedule a re-sync PR; CI prints a banner |
| 150+ | **FAIL** — CI hard-fails; re-sync required before merge |

A "drift line" is the sum of canonical-side insertions + deletions
between the LAST-SYNC marker and the current canonical HEAD. It is not
the impl-side edit count — actual port work is usually smaller because
many canonical changes are already in scope or already ported.

## The four-step re-sync

### 1. Survey the canonical drift

```bash
# What changed in the canonical since the last port?
LAST_SYNC=$(grep 'LAST-SYNC COMMIT' dashboard/src/styles/components.css \
  | head -1 | awk '{print $NF}')
git diff "$LAST_SYNC..HEAD" -- docs/design/dashboard-handoff/project/styles.css
```

Read the diff top-to-bottom. Each hunk is a candidate port. For each
hunk decide:

- **Port verbatim** — the rule is in scope (selectors the dashboard
  actually renders) and uses declared tokens.
- **Port with substitution** — rule is in scope but references undeclared
  tokens (e.g. `--surface-1/2`, `--text-1`). Substitute per the
  *Canonical → impl token mapping* in `components.css`'s header. If a
  new undeclared token appears, expand the mapping table in the same
  PR and file a canonical-side issue with `audit/canonical` label.
- **Skip** — rule belongs to one of the excluded sections (DS-page chrome,
  density tokens, React-primitive territory, etc.). The header lists
  the exclusions verbatim; consult before skipping.

### 2. Apply matching changes

Edit `dashboard/src/styles/components.css`. Keep the structure of each
canonical block intact — the section markers (the `/* ─── */` rules)
exist so re-sync diffs are reviewable.

If a port introduces a new selector that requires a JSX change to take
effect (e.g. `.er-initial` requires Sidebar.tsx to render the element),
land the JSX edit in the same PR. The re-sync is a contract, not a
half-shipped CSS change.

### 3. Update the LAST-SYNC marker

Bump the marker in the file header to whatever you used as the
`HEAD` in step 1:

```diff
- LAST-SYNC COMMIT: 829f67d39088ce6f8553cd35b41e2041533c9eed
+ LAST-SYNC COMMIT: <new SHA>
- PORT DATE: 2026-04-29 (PR-B of #454, components.css 137-line re-sync)
+ PORT DATE: <today> (<this PR>, <one-line summary>)
```

The PORT DATE narrative is the human pointer back to the PR; the
LAST-SYNC commit is the machine pointer the CI script reads.

### 4. Verify locally

```bash
npm run build:scripts
node dist/scripts/check-components-css-sync.js   # expect "IN SYNC"
npm --prefix dashboard run lint
npm --prefix dashboard run test
npm --prefix dashboard run build
```

Open the dashboard at all four canonical viewports — Desktop 1440×900,
Laptop 1180×820, Tablet 834×1100, Phone 390×780 — and spot-check the
sections you touched. The dashboard responds to `@container artboard`
inline-size, so resizing the browser window past the breakpoint is a
sufficient proxy.

## Token substitution conventions

The canonical hand-off bundle references three tokens it does not
declare. The selective port substitutes them per this table (also
mirrored in `components.css`'s header):

| canonical token | impl token | paint role |
|---|---|---|
| `--surface-1` | `--bg-1` | raised surface (sidebar background) |
| `--surface-2` | `--bg-2` | panel background |
| `--text-1` | `--text` | primary ink |

Substitutions are limited to the F-LEAD-3 `.er-initial` block today.
If a future canonical addition references `--surface-1/2` or `--text-1`
in a different role, audit the new usage before extending the mapping.
For genuinely new undeclared tokens, file a canonical-side issue with
the `audit/canonical` label *before* picking an impl substitute.

## What's *not* in this file

The `components.css` header lists the sections the port deliberately
excludes:

- `:root` token blocks + `[data-theme]` palettes → `tokens.css`
- Density attribute selectors (`html[data-density="…"]`) → `tokens.css`
- `*`/`html`/`body` resets + utility classes → `globals.css`
- `@keyframes` → `globals.css`
- Brandmark / metronome / phase-dot / type-badge primitives → owned by
  React primitives in `dashboard/src/components/`
- Design-tool surface (`.winchrome*`, `.beatgrid`, `.ds-*`) → never
  rendered by the dashboard
- `.sheet-overlay` + bare `.sheet` → not in audit allow-list; player
  detail uses `.player-sheet*` instead

When a canonical change lands in any of these areas, the re-sync skips
it. The drift number includes those lines, which means a high count
*may* reflect activity in excluded sections rather than real impl
work — always read the diff before estimating.

## Background

- The selective-port pattern was introduced in #389 PR-0 alongside the
  initial dashboard layout primitives.
- The drift-detection CI hook + this procedure doc landed with PR-B
  of #454 (the v0.28.0-beta.9 pixel-alignment audit).
- The shadcn integration that retires the bespoke CSS layer is
  tracked separately; until then this runbook is the source of truth
  for keeping `components.css` honest.

See also:

- `docs/design/dashboard-pixel-audit-v0.28.9.md` — the full 37-finding
  audit that motivated PR-B
- `docs/design/dashboard-audit-389.md` §6.5 — original Path B port
  rationale
- `dashboard/src/styles/components.css` (header) — in-file mirror of
  the in-scope filter and token mapping
