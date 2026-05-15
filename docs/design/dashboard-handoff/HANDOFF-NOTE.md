# Dashboard Handoff Bundle — Note

## What this is

This is a **Claude Design (claude.ai/design) handoff bundle** for the agent-tempo web dashboard,
corresponding to issues [#340](https://github.com/vinceblank/agent-tempo/issues/340) and
[#389](https://github.com/vinceblank/agent-tempo/issues/389).

vinceblank mocked up the dashboard UI in Claude Design, then exported this bundle. Three versions
exist in the wild:

| Version | Date | Status |
|---|---|---|
| v1 | 2026-04-26 | **Stripped** — chats/ + screenshots/ + uploads/ + web-design-system.html omitted. Implementer-facing summary only. **Replaced by v3.** |
| v2 | 2026-04-27 | First unstripped re-fetch; added chats/, workspace.jsx, full web-design-system.html. Captured during #389 audit. **Superseded by v3.** |
| v3 | 2026-04-28 | **Current.** vinceblank rewrote `web-design-system.html` (1394→1658 lines) to match `dashboard.html` reality after a 7-point spec-vs-implementation audit. Underlying `screens.jsx` + `styles.css` unchanged from v2. |

The contents of this directory are the **v3 bundle**.

## How to use this bundle — IMPORTANT

Per the bundle's own `README.md` (top of this directory): **read the chat transcripts in
`chats/` first**. They show the iteration history — what the user actually wants and where
they landed. The HTML/JSX/CSS files are the OUTPUT; the chats are where the INTENT lives.

Then **read `project/dashboard.html` in full**. It's the primary design entry point. Follow
its imports: `styles.css` (design tokens + components), the JSX component files
(`shared.jsx`, `primitives.jsx`, `design-canvas.jsx`, `tweaks-panel.jsx`,
`workspace.jsx`, `screens.jsx`).

`project/web-design-system.html` is the **canonical web design system spec** — token names,
typography roles, italic discipline, sidebar width, phase chip vocabulary. Tagged in the
audit as the binding source for type roles and component anatomy.

Per the bundle `README.md`: **don't render in a browser unless asked.** The HTML/CSS/JSX
are prototypes, not runnable production code. All dimensions, colors, and layout rules are
spelled out in the source.

## Bundle contents

| Path | Purpose |
|------|---------|
| `README.md` | "CODING AGENTS: READ THIS FIRST" — chats-pointer + dashboard.html imports |
| `chats/chat1.md` | TUI design system origin chat (110 lines) |
| `chats/chat2.md` | Web dashboard iteration history (5270 lines — read tail for latest decisions) |
| `project/dashboard.html` | Primary design — main entry point |
| `project/workspace.jsx` | EnsembleWorkspace surface (552 lines) — Sidebar + composer + popout + mobile primitives |
| `project/screens.jsx` | Screen-level view components (646 lines) |
| `project/web-design-system.html` | Canonical web design system spec (1658 lines) |
| `project/design-system.html` | TUI design system spec (older, separate from web) |
| `project/styles.css` | Design tokens + component styles (1888 lines) |
| `project/primitives.jsx` | Low-level UI primitives |
| `project/shared.jsx` | Shared layout primitives + mock data |
| `project/design-canvas.jsx` | Canvas-level layout (the multi-artboard view in `dashboard.html`) |
| `project/tweaks-panel.jsx` | Controls/tweaks side panel |
| `project/assets/` | SVG logos: icon, icon-dark, logo-light, logo-dark |
| `project/screenshots/` | verify1-6, composer, composer2, broken, check, initial — design-state snapshots |
| `project/uploads/` | Source images vinceblank used during the design session |

## Companion artifact

[`../dashboard-audit-389.md`](../dashboard-audit-389.md) — the architect's audit + phasing
plan derived from this bundle. Lists every PR (PR-0 through PR-G), per-screen gaps,
shared-primitive inventory, and risk register. The audit doc is the **binding spec** for
implementers; this bundle is the **canonical source**.

## Re-sync responsibility

The architect owns periodic re-sync of this bundle with vinceblank's Claude Design exports.
When vinceblank lands a new bundle version, update this file's version table and replace
the directory contents.

## Canonical status

This directory is the **canonical source of truth** for design tokens, component shapes,
and visual intent for #340 / #389 dashboard implementation. Reference it when recreating
screens, verifying color/spacing fidelity, or reviewing design decisions made during the
mock-up phase.
