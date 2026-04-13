# CLAUDE.md Audit — 2026-04-13

> **Purpose**: Audit report for issue #129. Produced before any changes are made to CLAUDE.md.
> Conductor and user must approve the "Remove entirely" list before Phase A4 execution.
>
> **Current size**: 261 lines. **Target root size**: ~150 lines.

---

## 1. Anthropic Best Practices Synthesis

*Based on research into https://docs.claude.com/en/docs/claude-code/memory,
https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/system-prompts,
and https://docs.claude.com/en/docs/claude-code/sub-agents.*

### Positive recommendations

Anthropic describes CLAUDE.md as "the place you write down what you'd otherwise re-explain." It
should contain facts Claude needs in every session: build commands, coding conventions, project
layout, and "always do X" rules. The documentation explicitly suggests adding to it when "Claude
makes the same mistake a second time" or "a new teammate would need the same context."

**Hard ceiling: 200 lines per CLAUDE.md file.** Beyond that, readability and adherence degrade.
For large projects, use `.claude/rules/` with path-scoped files — these load only when Claude is
working with matching files, saving context throughout the session. Concrete, verifiable
instructions outperform vague guidance: "Use 2-space indentation" beats "Format code properly."
Specificity directly correlates with consistent compliance.

### Anti-patterns — what to leave out

- **Don't restate what's already in tool definitions.** Tool descriptions live in tool definitions
  (and in `docs/tools.md`); repeating them in CLAUDE.md burns tokens for no benefit.
- **Don't include single-role-only procedures inline.** Multi-step setup procedures, role-specific
  workflows (e.g., release process), and environment setup commands belong in referenced docs.
- **Avoid verbosity.** The guidance states: "If your instructions are growing large, split them
  using imports or `.claude/rules/` files." Content that is *useful sometimes* differs from
  content that is *needed on every turn* — only the latter belongs inline.
- **Don't duplicate README or referenced docs.** Import or cross-link; don't copy.

### Subagent/Task tool philosophy

Deploy subagents (via `Task` tool) when "a side task would flood your main conversation with
search results, logs, or file contents you won't reference again." Root CLAUDE.md should define
behavioral guidance for the main agent; subagent configuration lives in separate agent definition
files with their own system prompts — not in the primary CLAUDE.md. The split keeps concerns
isolated: root CLAUDE.md governs turn-by-turn behavior, agent definitions govern specific roles.

### Structural guidance

**Under 200 lines.** Use `.claude/rules/` path-scoped files for role-specific or file-scoped
rules. Use `@path/to/file` imports to reference external content without inlining it. Keep
instructions specific and verifiable. Each section should answer: "Does a session need this on
every turn, or only sometimes?"

---

## 2. Section-by-Section Classification

Current CLAUDE.md is **261 lines** across 8 sections. Classification table:

| Section | Lines | Class | Proposed action |
|---------|------:|-------|-----------------|
| `# CLAUDE.md` header | 1 | KEEP | Trivial |
| **What is this?** | 6 | **KEEP inline** | Necessary 2-sentence orientation for every session |
| **Tech Stack** | 7 | **KEEP inline** | Short authoritative list; sessions need this to pick correct imports |
| **Project Structure** | 126 | **REWRITE TIGHTER** | Cut file annotations; keep skeleton with non-obvious mappings only (~40 lines) |
| **Development** | 39 | **MOVE** | Setup reference; rarely needed mid-session → `docs/development.md` |
| **Key Concepts** | 35 | **SPLIT** | ~8 core terms KEEP; ~23 detailed bullets MOVE → `docs/concepts.md` |
| **TUI Key Behaviors** | 10 | **MOVE** | Role-specific (TUI users only) → `docs/dashboard.md` (already exists) |
| **TUI Performance** | 12 | **MOVE** | Role-specific (`src/tui/` contributors only) → `docs/tui-performance.md` (new) |
| **Commit Convention** | 8 | **KEEP inline** | Universal rule, short, high-adherence value |
| **Release Process** | 11 | **MOVE** | devops-only, with a 2-line critical-rule summary kept inline |

---

## 3. Detailed Analysis

### Project Structure (126 lines → ~40 lines, REWRITE TIGHTER)

The full annotated tree is the single largest section. The annotations provide value for first-time
contributors but most are obvious from the filename (`commands.ts` = CLI commands) or redundant
with the Key Concepts section.

**Keep**: Top-level `src/` tree with directory names. Non-obvious files: `spawn.ts`,
`reconcile/orphans.ts`, `git-info.ts`, `workers.ts`. The `tools/` listing (every file is a
separate tool — useful for grep-free orientation). `tui/components/` can be collapsed to a single
line.

**Cut**: Per-file annotations on obvious files (`server.ts # MCP server entry point` —
obvious). The deeply annotated `tui/components/` subtree (18 lines for component names — already
documented in `docs/dashboard.md`). The `tui/utils/` subtree.

**Estimated saving**: ~85 lines.

### Development (39 lines → 6 lines kept inline, rest MOVED)

The full `temporal server start-dev` command with all 10 search attributes is important for new
environment setup — but it's not needed on every turn. Already documented as the canonical setup
path in README.md.

**Keep inline** (6 lines): `npm install`, `npm run build`, `npm test`, and the workflow bundle
rebuild note ("Always run `npm run build` after changing workflow code — pre-bundles workflows
into `workflow-bundle.js`").

**Move to `docs/development.md`**: The full `temporal server start-dev` command + all search
attributes, `npx ts-node src/server.ts`, the daemon worker note.

### Key Concepts — SPLIT detail

**KEEP inline** (9 bullets, ~15 lines): These are terms sessions encounter in cues from other
players and need to interpret correctly:

- Player, Conductor, Ensemble, Cue, Part (the 5 collaboration primitives)
- Outbox (essential — every tool action goes through it; getting this wrong causes bugs)
- Wire protocol rule (process mandate: "update WIRE-PROTOCOL.md in same commit")
- Daemon (short; sessions need to know to run `npm run build` after workflow changes)
- Player types / Agent type discovery (sessions need to know how to look up types)

**MOVE to `docs/concepts.md`** (22 bullets): Deep technical definitions that are reference
material, not per-turn guidance:

- set_name, Session status, Recruit (mechanics — sessions can read when needed)
- Adapter, Attachment phases, Lifecycle V2 flag (already in ARCHITECTURE.md)
- Restart, Detach/Destroy, Migrate (verb definitions — in `docs/tools.md`)
- Broadcast, Recall, Per-host task queues (tool-level details)
- Schedule, Lineup, Quality Gate, Worktree, Stage (feature concepts — in respective `docs/`)
- Hold/Release, Pause/Resume, Outbox lock (mid-session flow control — `docs/tools.md`)
- Maestro, TempoClient (architecture detail — already in `docs/ARCHITECTURE.md`)

### TUI Key Behaviors (10 lines → MOVE)

Only relevant to sessions operating the TUI or writing TUI code. The routing note (`@player`
prefix), schedule management, overlays/pickers, removed aliases, terminal size — all already
documented in `docs/dashboard.md`. **No new companion doc needed — move into existing
`docs/dashboard.md`.**

### TUI Performance (12 lines → MOVE)

Dense technical lessons specific to `src/tui/` contributors. Only needed when touching Ink/React
TUI code. Move to `docs/tui-performance.md` (new file) with a pointer in the Project Structure
annotation for `src/tui/`.

### Release Process (11 lines → 2 lines kept, rest MOVED)

Only devops needs the full sequence. However, the "never tag before bump commit" rule has caused
real problems before (mentioned in the note about tagging prematurely publishing old versions).

**Keep inline (2 lines)**: A critical-rule callout:
```
> **Release rule**: Bump `package.json` + CHANGELOG before tagging. Never tag a commit that
> doesn't match the version. See [docs/release-process.md](docs/release-process.md).
```

**Move to `docs/release-process.md`**: Full 4-step sequence.

---

## 4. New Companion Docs Required

| New file | Content | Priority |
|----------|---------|----------|
| `docs/development.md` | Full setup commands, `temporal server start-dev` with all SAs, dev workflow | High |
| `docs/concepts.md` | The 22 moved Key Concepts bullets, linked from root CLAUDE.md | High |
| `docs/tui-performance.md` | TUI Performance (Ink/React) hard-won lessons | Medium |
| `docs/release-process.md` | Full 4-step release sequence | Medium |

`docs/dashboard.md` **already exists** — TUI Key Behaviors section moves there (no new file).

---

## 5. Remove Entirely List

These items should be deleted, not relocated. Each has a justification.

### R1. `EncoreOutboxEntry` in `src/tools/stop.ts` reference pattern

**Location**: Key Concepts → `stop` tool annotation note (implicit in `stop.ts` MCP tool
reference in the Project Structure listing).

**Justification**: `encore` was removed in PR-D. The stop.ts annotation `# Stop a session (via
outbox)` is now inaccurate — stop.ts is a hint shim, not a real outbox entry. The annotation
should either be removed or updated to `# Hint shim — use destroy or detach instead`.

### R2. Historical `encore` parenthetical in Restart bullet

**Location**: Key Concepts, Restart bullet, line 197:
"Replaces the pre-v0.25 `encore` verb (which was `stale`-only)."

**Justification**: encore is removed. This parenthetical explains history for a concept that no
longer exists. Any session reading this may be confused about whether encore still exists.
**Remove the parenthetical.** The Restart definition is self-explanatory without it.

### R3. Repetitive `stop.ts` annotation cross-reference in Project Structure

**Location**: `src/tools/stop.ts` line in the Project Structure tree.

**Justification**: The current annotation says `# Stop a session (via outbox)`. But stop.ts is
now a hint shim (PR-D). This should be updated to `# Hint shim — use destroy/detach` or removed
entirely (since it's a deprecated file scheduled for PR-H deletion). Given PR-H is imminent,
removing the entry entirely and noting it in PR-H scope is cleaner than updating a dying file.

### R4. `tui/client.ts` backward-compatibility shim note

**Location**: Key Concepts → TempoClient bullet, and Project Structure → `src/tui/client.ts`.

**Justification**: "Thin re-export shim for backward compatibility — new consumers should import
from `src/client/` directly." This is an internal implementation note, not a per-turn behavioral
rule. Only relevant to contributors writing new TUI code; they can discover it by reading the
file. MOVE to `docs/ARCHITECTURE.md` (TempoClient section), not KEEP inline.

### R5. Deep `tui/components/` and `tui/utils/` file listing in Project Structure

**Location**: Project Structure tree, lines 109–132 (24 lines of TUI component filenames).

**Justification**: Sessions that aren't contributing to `src/tui/` never need these. The
component names are already documented in `docs/dashboard.md`. Keeping 24 lines of
`ComponentName.tsx # description` in every session's system prompt is pure waste. Collapse to:
```
├── tui/
│   ├── App.tsx / store.ts / commands.ts   # TUI root, state, slash commands
│   ├── components/    # See docs/dashboard.md for component inventory
│   └── utils/         # format, platform, theme, fullscreen, history
```

### R6. `src/activities/maestro.ts` detailed annotation

**Location**: Project Structure, `src/activities/maestro.ts` annotation.

**Justification**: "(refreshEnsembleState, relayCommandToConductor, fetchConductorHistory,
fetchEnsembleChat)" — listing function names in the project structure tree is unusual detail level.
The function names are internal and discoverable by reading the file. Simplify annotation to
`# Maestro activities`.

---

## 6. Proposed Trimmed Root CLAUDE.md Structure (~150 lines)

```
# CLAUDE.md                                           (1)

## What is this?                                      (5)
[2-sentence description]

## Tech Stack                                         (8)
[6 dependency bullets]

## Project Structure                                  (52)
[Collapsed tree: top-level dirs + key files only;
 tui/components/ collapsed to 3-line stub;
 per-file annotations only for non-obvious files]

## Development                                        (12)
npm install / npm run build / npm test
+ workflow bundle rebuild note
+ "see docs/development.md for full setup"

## Key Concepts                                       (25)
[9 bullets: Player, Conductor, Ensemble, Cue, Part,
 Outbox, Wire protocol rule, Daemon, Player types]
→ see docs/concepts.md for full glossary

## Commit Convention                                  (8)
[unchanged]

## Release Process                                    (6)
[2-line critical-rule callout]
→ see docs/release-process.md for full sequence
```

**Total: ~117 lines.** (Conservative estimate; actual will depend on tree compression.)

---

## 7. Estimated Size Reduction

| Section | Current | Proposed root | Δ |
|---------|--------:|-------------:|--:|
| What is this? | 6 | 6 | 0 |
| Tech Stack | 7 | 7 | 0 |
| Project Structure | 126 | 42 | −84 |
| Development | 39 | 12 | −27 |
| Key Concepts | 35 | 25 | −10 |
| TUI Key Behaviors | 10 | 0 | −10 |
| TUI Performance | 12 | 0 | −12 |
| Commit Convention | 8 | 8 | 0 |
| Release Process | 11 | 6 | −5 |
| **Total** | **261** | **~117** | **−144** |

Lines moved to companion docs: ~140. Lines deleted entirely: ~4 (the remove-entirely items).

---

## 8. Uncertain Classification Calls

These are genuinely ambiguous — conductor input requested:

**U1. Key Concepts → Session status (line 193)**

The Session status bullet is long (5 lines: pending → active → stale → blocked, response
tracking, auto-recovery). It's relevant to QA players and conductors reading `ensemble` output,
but not to engineers coding a tool. Keep inline or move?

*My inclination*: MOVE to `docs/concepts.md`. The terms appear in `ensemble` output but their
mechanics (3min delivery, 5min blocked detection) are reference-level detail.

**U2. Key Concepts → Per-host task queues (line 202)**

"Each host runs a `claude-tempo-{hostname}` activity worker...`recruit` tool accepts an optional
`host` parameter." With PR-F shipping, this will be more important. But it's detailed enough to
be reference.

*My inclination*: MOVE to `docs/concepts.md` but add a one-liner in the root Key Concepts:
"`host` param on `recruit`/`restart`/`migrate` routes to `claude-tempo-{hostname}` task queue."

**U3. `src/tools/stop.ts` in Project Structure**

`stop.ts` is a hint shim scheduled for deletion in PR-H. Should I:
(a) Remove from Project Structure now (pre-empting PR-H)
(b) Update annotation to "Hint shim — scheduled for PR-H deletion"
(c) Leave as-is and let PR-H docs pass handle it

*My inclination*: (b) — update annotation now to avoid confusion; let PR-H delete the file.

**U4. Development → `temporal server start-dev` search attributes**

The 10-attribute command is in `README.md` and will be in `docs/development.md`. But CI's
`.github/workflows/ci.yml` also registers them. If a new contributor sets up from CLAUDE.md only,
they need this. However, `claude-tempo server` already handles this automatically.

*My inclination*: MOVE entirely (the CLI handles registration; manual command is a fallback
developers almost never need).

---

## Quick-reference links

- Issue: [#129 perf: lazy-load CLAUDE.md sections](https://github.com/vinceblank/claude-tempo/issues/129)
- Current CLAUDE.md: [`CLAUDE.md`](../../CLAUDE.md) (261 lines)
- Architecture doc: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — overlaps with several Key Concepts bullets
- Dashboard doc: [`docs/dashboard.md`](../dashboard.md) — TUI Key Behaviors already partially covered here
- Wire protocol: [`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md)
