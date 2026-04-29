# Recruit brief — Batch A (cards / headers / wizards)

**Audit**: #461 dashboard overflow + content-length robustness
**Issue**: https://github.com/vinceblank/claude-tempo/issues/461
**Lead**: tempo-overflow-lead
**Audit doc** (you'll add findings here): `docs/design/dashboard-overflow-audit-v0.28.10.md`
**Pre-log** (your starting suspect list): `docs/design/_lead-prelog.md`
**Fixtures** (test content): `docs/design/_overflow-fixtures.json`
**Branch you'll work on**: `feat/461-overflow-audit-a` (request worktree provision via cue to tempo-conductor)

---

## Your batch — A

Walk these components for content-length overflow:

1. **EnsembleCard** (`dashboard/src/components/EnsembleCard.tsx`) — `.ec-meta`, `.ec-desc`, `.ec-roster`, `.ec-head`
2. **PageHeader** (`dashboard/src/components/PageHeader.tsx`) — `.page-title`, `.page-pills`, `.page-actions`, `.page-subtitle`
3. **PlayerDetail header** (`dashboard/src/screens/PlayerDetail.tsx`) — sheet head, accent name, status row
4. **PlayerTypes cards** (`dashboard/src/screens/PlayerTypes.tsx:128-207`) — `.types-grid`, `.display`, summary, action row
5. **CreateEnsemble wizard** (`dashboard/src/screens/CreateEnsemble.tsx`) — `.picker-row`, form fields
6. **Recruit wizard** (`dashboard/src/screens/Recruit.tsx`) — `.picker-row`, type-badge slot

**Pre-log hypotheses you own**: H2, H3, H4, H6, H10, H12, H13, H14 (see `_lead-prelog.md` for the full hypothesis list with static evidence + severity guesses).

**Out of your scope** (Batch B handles): Sidebar, Hosts table, Settings, Workspace chat, TempoStrip, panel-head walks.

---

## Setup

### Step 1 — request worktree

Cue tempo-conductor:

> Request worktree `feat/461-overflow-audit-a` from `origin/main` for #461 batch A walk.

Wait for confirmation. Then `cd` to the provided path.

### Step 2 — start the dashboard

Working directory: your worktree root.

```bash
# Install deps if not cached
cd dashboard && npm install

# Build the dashboard once (or run in dev mode for hot-reload)
npm run dev
```

Daemon-side seed (separate terminal, from the worktree root):

```bash
node dist/cli.js --dev daemon start
node dist/cli.js --dev up --lineup tempo-mock-jam
```

This gives a 5-player baseline ensemble with deterministic mock players.

### Step 3 — open the dashboard in Chrome

Either via `claude-tempo --dev dashboard` (auto-opens) or manually navigate to the dashboard URL (typically `http://localhost:8474/dashboard` in dev mode — confirm with conductor at start of walk).

### Step 4 — load fixtures

Load `docs/design/_overflow-fixtures.json` mentally as your test content source. For each (component, viewport, content-regime) cell:

- **Canonical content**: use the content already in the running ensemble (pre-seeded canonical fixtures).
- **Long-tail content**: inject via wizard (CreateEnsemble manually with longTail fixture name) OR via React DevTools (override props on a target component).
- **Stress content**: same channels as long-tail but with `*.stress` arrays. Note: claude-tempo enforces `ENSEMBLE_NAME_REGEX` + max-length on names — if a stress fixture is rejected at the validation layer, **flag as an audit finding** (means the field has a server-side cap but layout might not handle the just-below-cap case).

---

## Sample protocol

For each component, walk **every** (viewport × content-regime) cell. Skip canonical-content × canonical-viewport cells (covered by pixel audit). Net cells per component: ~24 (10 viewports × 3 regimes minus 4 canonical-canonical).

### Per cell

1. **Set viewport**: Chrome DevTools device toolbar → custom dimensions, dark theme, density 6 (default). Use the boundary viewport pairs (1201/1199, 901/899, 521/519) to catch CQ-edge bugs.
2. **Set content**: ensure the relevant fixture is rendered (CreateEnsemble with longTail name, etc.).
3. **Live observe** via Chrome MCP `mcp__claude-in-chrome__javascript_tool`:
   ```js
   // Sample for the component you're walking, e.g. .ec-meta:
   const el = document.querySelector('[data-testid^="ensemble-card-"] .ec-meta');
   const r = el.getBoundingClientRect();
   ({
     scrollWidth: el.scrollWidth,
     clientWidth: el.clientWidth,
     overflowing: el.scrollWidth > el.clientWidth + 1,
     rect: { w: r.width, h: r.height, x: r.x, y: r.y },
   })
   ```
4. **Visual observe**: take a screenshot via Chrome MCP. Look for:
   - Text clipped without ellipsis-by-design
   - Card overlapping adjacent card (auto-P1 trigger)
   - Button row wider than container
   - Scrollbar appearing in non-scrollable region
5. **Static corroborate**: if a finding observed, read the matching `components.css` rule + JSX class to identify root cause. Don't file a finding without a static root-cause guess.

---

## Findings format

File raw findings into `docs/design/_findings-a.md` (your working scratchpad — committed for recoverability, deleted before PR). Promote into `dashboard-overflow-audit-v0.28.10.md` §4 after coordination with overflow-lead.

For each finding, capture:

```markdown
### F-A-N — <one-line title>

- **Hypothesis ref**: H? (pre-log) or NEW
- **Component**: ComponentName
- **File**: dashboard/src/components/X.tsx:LINE
- **CSS rule**: components.css:LINE-LINE
- **Viewport**: 1180 (Laptop) | etc.
- **Content regime**: long-tail-realistic | synthetic-stress
- **Observed**: what you saw (1-2 sentences + DOM measurement)
- **Expected**: what the design intends (graceful wrap / ellipsis / no overflow)
- **Severity**: P1 | P2 | P3 (per audit doc §1.5 rubric)
- **Auto-P1**: yes/no (overflow into adjacent sibling at canonical viewport)
- **Disposition**: production-realistic | synthetic-stress | intentional-truncation | wire-pending
- **Root cause**: missing `min-width: 0` on .X / missing ellipsis on .Y / etc.
- **Fix shape**: 1-2 lines of CSS or JSX change
- **Screenshot**: optional path
```

For **refuted hypotheses** (validated, no finding):

```markdown
### H? — refuted

Walked at viewports {V1, V2, …} × regimes {R1, R2}. Observed: graceful wrap / ellipsis / no overflow. Static rule that prevents overflow: `.X { overflow: hidden; }`. No finding.
```

For **discovered-adjacent** findings (not in pre-log):

```markdown
### F-A-NEW-N — <title>

(Same template as numbered findings.)
```

---

## Coordination

### When to cue overflow-lead

- **Ambiguity on severity**: hypothesis predicted P1 prod-realistic but you observed only at synthetic stress → cue lead with the cell + observation, lead decides whether to retier or accept new severity.
- **Cross-cutting finding**: same root cause shows up across multiple components — flag the cluster pattern, lead clusters in §7.
- **Discovered-adjacent that doesn't fit any hypothesis**: file freely as F-A-NEW-N; cue lead only if it changes the audit scope.
- **Methodology question**: if Chrome MCP refuses (CSP, daemon-down, etc.) cue lead before improvising — we want consistent measurement methodology across both batches.

### When to cue conductor

- Worktree provision (initial)
- Recruit-side blockers (daemon won't start, dashboard won't load, fixture won't seed)
- Stop-condition: you've finished your batch, ready for lead consolidation

### Don't

- **Don't push the audit doc** — overflow-lead consolidates `_findings-a.md` + `_findings-b.md` into the audit doc §4 + numbered findings. You write to your working scratchpad only.
- **Don't switch branches** without conductor approval per CLAUDE.md.
- **Don't alter `_overflow-fixtures.json`** — that's the lead's locked input. If you need an additional fixture, cue lead with a proposal.

---

## ETA

Walk phase budget: ~2-3hr for Batch A (6 components × ~24 cells = 144 cells; many will be no-finding skim, ~30 will be confirms/adjusts/discovers).

Cue lead when complete with a concise summary:

> Batch A walk complete. {N} findings filed into `_findings-a.md`. Hypotheses confirmed: H?, H?, H?. Refuted: H?, H?. New: F-A-NEW-?. Cross-cutting candidate cluster: {root cause} affects {component list}.

---

## Quick start checklist

- [ ] Cue conductor: request `feat/461-overflow-audit-a` worktree
- [ ] `cd` to worktree, run `npm install` + `npm run dev` in `dashboard/`
- [ ] Run daemon: `node dist/cli.js --dev daemon start && --dev up --lineup tempo-mock-jam`
- [ ] Confirm dashboard URL with conductor (typically dev mode → `http://localhost:8474`)
- [ ] Open `_overflow-fixtures.json` and `_lead-prelog.md` for reference
- [ ] Create `_findings-a.md` (scratchpad)
- [ ] Walk H2, H3, H4, H6, H10, H12, H13, H14 in pre-log order (highest-confidence first)
- [ ] After each component cluster, commit findings to your branch (recoverable progress)
- [ ] Cue lead when batch complete
