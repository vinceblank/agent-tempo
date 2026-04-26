# Dashboard Handoff Bundle — Note

## What this is

This is a **Claude Design (claude.ai/design) handoff bundle** for the claude-tempo web dashboard,
corresponding to issue [#340](https://github.com/vinceblank/claude-tempo/issues/340).

vinceblank mocked up the dashboard UI in Claude Design, then exported this bundle on **2026-04-26**.
The original handoff URLs (`api.anthropic.com/v1/design/h/...`) returned 404 from agent contexts
(auth issue), so vinceblank downloaded the zips manually and they were extracted here.

## How to use this bundle

**Read `project/dashboard.html` first** — it is the primary design entry point.
Then follow its imports: `styles.css` (design tokens), the JSX component files
(`shared.jsx`, `primitives.jsx`, `design-canvas.jsx`, `tweaks-panel.jsx`, `screens.jsx`).

**Do not render in a browser.** The HTML/CSS/JSX are prototypes, not runnable production code.
All dimensions, colors, and layout rules are spelled out in the source. Reading the source
directly is faster and more accurate than screenshotting.

Your job as implementer: **recreate pixel-perfectly** in the target technology stack.
Per the research recommendation in issue #341, the recommended stack is:
**React + Vite + Tailwind 4 + shadcn/ui**.

## Bundle contents

| File | Purpose |
|------|---------|
| `README.md` | Original Claude Design handoff README (read first) |
| `project/dashboard.html` | Primary design — main entry point |
| `project/design-system.html` | Design system spec — component inventory |
| `project/styles.css` | Design tokens (51 KB) — colors, spacing, typography |
| `project/design-canvas.jsx` | Canvas-level layout component |
| `project/tweaks-panel.jsx` | Controls/tweaks side panel |
| `project/shared.jsx` | Shared layout primitives |
| `project/primitives.jsx` | Low-level UI primitives |
| `project/screens.jsx` | Screen-level view components |
| `project/assets/` | SVG logos: icon, icon-dark, logo-light, logo-dark |

## What was omitted

| Omitted | Reason |
|---------|--------|
| `project/screenshots/` | Verify-state screenshots — redundant with source; per README: "don't render in browser" |
| `project/uploads/` | Pasted images vinceblank used during design session — personal source material, not implementer-facing |
| `project/.design-canvas.state.json` | Runtime canvas state — not load-bearing |
| `project/web-design-system.html` | Empty file (0 bytes) in source bundle |

## Canonical status

This directory is the **canonical source of truth** for design tokens and component shapes
for the #340 dashboard implementation. Reference it when recreating screens, verifying
color/spacing fidelity, or reviewing design decisions made during the mock-up phase.
