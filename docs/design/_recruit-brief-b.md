# Recruit brief — Batch B (tables / sidebar / chat / buttons)

**Audit**: #461 dashboard overflow + content-length robustness
**Issue**: https://github.com/vinceblank/claude-tempo/issues/461
**Lead**: tempo-overflow-lead
**Audit doc** (you'll add findings here): `docs/design/dashboard-overflow-audit-v0.28.10.md`
**Pre-log** (your starting suspect list): `docs/design/_lead-prelog.md`
**Fixtures** (test content): `docs/design/_overflow-fixtures.json`
**Branch you'll work on**: `feat/461-overflow-audit-b` (request worktree provision via cue to tempo-conductor)

---

## Your batch — B

Walk these components for content-length overflow:

1. **Sidebar** (`dashboard/src/components/Sidebar.tsx`) — `.ensemble-row`, `.er-name`, `.er-meta`, `.er-initial`, `.nav-row`, `.sidebar-footer`
2. **Hosts table** (`dashboard/src/screens/Hosts.tsx`) — table cells, especially Host column with FQDN
3. **Loadouts** (`dashboard/src/screens/Loadouts.tsx`) — table rows, action buttons, lineup column
4. **Schedules** (`dashboard/src/screens/Schedules.tsx`) — table rows, cron expression cells
5. **Settings panels** (`dashboard/src/screens/Settings.tsx`) — `.kv` rows, panel-head subj, section heads
6. **TempoStrip** (`dashboard/src/components/tempo/TempoStrip.tsx`) — sparkline + bpm overlay
7. **Workspace chat panel** (`dashboard/src/screens/Workspace.tsx` + `dashboard/src/components/chat/*`) — `.msg-body`, code blocks, long messages, multi-line cues
8. **Generic button rows** (Edit/Duplicate/+New patterns at narrow widths) — anywhere `.row` containers hold buttons
9. **panel-head bearing screens** — anywhere `.panel-head` renders subj + actions

**Pre-log hypotheses you own**: H1, H5, H7, H8, H9, H11 (see `_lead-prelog.md` for full hypothesis list).

**Out of your scope** (Batch A handles): EnsembleCard, PageHeader, PlayerDetail header, PlayerTypes cards, CreateEnsemble + Recruit wizards.

---

## Setup

### Step 1 — request worktree

Cue tempo-conductor:

> Request worktree `feat/461-overflow-audit-b` from `origin/main` for #461 batch B walk.

Wait for confirmation. Then `cd` to the provided path.

### Step 2 — start the dashboard

Working directory: your worktree root.

```bash
cd dashboard && npm install
npm run dev
```

Daemon-side seed (separate terminal, from the worktree root):

```bash
node dist/cli.js --dev daemon start
node dist/cli.js --dev up --lineup tempo-mock-jam
```

### Step 3 — open the dashboard in Chrome

Confirm dashboard URL with conductor at start of walk (typically `http://localhost:8474/dashboard` in dev mode).

### Step 4 — load fixtures

Reference `docs/design/_overflow-fixtures.json`. Special attention for Batch B:

- **Hostnames** (H5): inject FQDNs from `hostnames.fqdn` into the running daemon's host list. May require a synthetic daemon entry — coordinate with conductor if blocked.
- **Long ensemble names** (H1): use CreateEnsemble wizard manually with `ensembleNames.longTail` values. Confirm regex/length validation does not silently truncate before injection (if it does, file as an audit finding — server-side caps that aren't reflected in client layout are a finding).
- **Long messages** (H8): inject via mock player or via `cue` tool with code-block-bearing markdown. Test fixture: `cue alice "$(cat fixtures/long-code-block.md)"` (substituting actual content).
- **Long version strings / paths** (H9): if Settings KV values are short, override via React DevTools.

---

## Sample protocol

For each component, walk every (viewport × content-regime) cell relevant to that component's stress vectors. Skip canonical-content × canonical-viewport cells (covered by pixel audit).

### Per cell

1. **Set viewport**: Chrome DevTools device toolbar. Use the boundary pairs (1201/1199, 901/899, 521/519) — pixel audit's L-cluster proved boundary CQ bugs are findings-worthy.
2. **Set content**: ensure relevant fixture rendered.
3. **Live observe** via Chrome MCP `mcp__claude-in-chrome__javascript_tool`:
   ```js
   // Sample for the table cell you're walking, e.g. Host column:
   const cells = Array.from(document.querySelectorAll('[data-testid^="host-row-"] td:first-child'));
   cells.map(el => ({
     text: el.textContent.trim(),
     scrollWidth: el.scrollWidth,
     clientWidth: el.clientWidth,
     overflowing: el.scrollWidth > el.clientWidth + 1,
     rect: el.getBoundingClientRect(),
   }))
   ```
   For chat messages (H8):
   ```js
   const body = document.querySelector('[data-testid^="feed-message-"][data-testid$="-body"]');
   const inner = body.querySelector('pre, code');
   ({
     bodyClientWidth: body.clientWidth,
     bodyScrollWidth: body.scrollWidth,
     innerScrollWidth: inner?.scrollWidth,
     overflowing: body.scrollWidth > body.clientWidth + 1,
   })
   ```
4. **Visual observe**: screenshot via Chrome MCP. Look for:
   - Table column squeeze (other columns become unreadable when one column expands)
   - Sidebar bleed (sidebar text pushes into workspace area)
   - Code-block horizontal scrollbar OR content extending past `.msg-body { max-width: 72ch }`
   - Action buttons overlapping subj in `.panel-head`
   - TempoStrip sparkline clipping or scaling weirdly at narrow viewports
5. **Static corroborate**: read matching `components.css` rule + JSX class. Identify root cause.

---

## Findings format

File raw findings into `docs/design/_findings-b.md`. Same template as Batch A:

```markdown
### F-B-N — <one-line title>

- **Hypothesis ref**: H? (pre-log) or NEW
- **Component**: ComponentName
- **File**: path:LINE
- **CSS rule**: components.css:LINE-LINE
- **Viewport**: e.g. 1199 (boundary) | 834 (Tablet)
- **Content regime**: long-tail-realistic | synthetic-stress
- **Observed**: what you saw + DOM measurement
- **Expected**: design intent
- **Severity**: P1 | P2 | P3
- **Auto-P1**: yes/no
- **Disposition**: production-realistic | synthetic-stress | intentional-truncation | wire-pending
- **Root cause**: 1 line
- **Fix shape**: 1-2 lines CSS/JSX
- **Screenshot**: optional
```

For refuted: same shape as Batch A (`### H? — refuted` block).
For discovered-adjacent: `### F-B-NEW-N`.

---

## Coordination

### When to cue overflow-lead

- **H8 chat code-block ambiguity**: this hypothesis splits P1/P3 depending on whether overflow breaks the layout cap or just shows a scrollbar. **Definitely cue lead** with your finding before scoring — the design intent (deliberate scroll vs. wrap vs. ellipsis) needs ratification.
- **H1 Sidebar overflow severity**: depends on whether overflow is contained inside the sidebar (P1 prod-realistic) or bleeds into the workspace area (auto-P1). Cue lead if observed.
- **H5 Hosts table** root-cause discovery: if you find the right `max-width` for the Host column needs design judgment (truncate-with-tooltip vs. word-break vs. allow-row-wrap), cue lead with options.
- **H11 TempoStrip**: pre-log severity is TBD — your walk is the source of truth here.

### When to cue conductor

- Worktree provision (initial)
- Recruit-side blockers (daemon won't start, dashboard won't load)
- Stop-condition: batch complete, ready for lead consolidation

### Don't

- **Don't push the audit doc** — lead consolidates.
- **Don't switch branches** without conductor approval.
- **Don't alter fixtures** — cue lead with proposals if needed.

---

## ETA

Walk phase budget: ~2-3hr for Batch B (9 components × ~20 cells = 180 cells; many will be no-finding skim, ~30-35 will be confirms/adjusts/discovers).

Cue lead when complete with concise summary:

> Batch B walk complete. {N} findings filed into `_findings-b.md`. Hypotheses confirmed: H?, H?. Refuted: H?, H?. New: F-B-NEW-?. Cross-cutting candidate cluster: {root cause} affects {component list}.

---

## Quick start checklist

- [ ] Cue conductor: request `feat/461-overflow-audit-b` worktree
- [ ] `cd` to worktree, run `npm install` + `npm run dev` in `dashboard/`
- [ ] Run daemon: `node dist/cli.js --dev daemon start && --dev up --lineup tempo-mock-jam`
- [ ] Confirm dashboard URL with conductor
- [ ] Open `_overflow-fixtures.json` and `_lead-prelog.md` for reference
- [ ] Create `_findings-b.md` (scratchpad)
- [ ] Walk H1 (Sidebar) and H5 (Hosts table) first — highest-confidence P1
- [ ] Then H7, H8, H9 (panel-head, chat, Settings)
- [ ] Then H11 (TempoStrip — TBD)
- [ ] Generic button rows + Loadouts/Schedules tables walk last (no specific hypothesis — open-walk)
- [ ] After each component cluster, commit findings to your branch
- [ ] Cue lead when batch complete
