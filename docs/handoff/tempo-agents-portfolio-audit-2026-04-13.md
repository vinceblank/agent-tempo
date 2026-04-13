# Shipped Agent Portfolio Audit — 2026-04-13

> **Purpose**: Cross-reference user-local `~/.claude/agents/my-tempo-*.md` files against their
> shipped `examples/agents/tempo-*.md` equivalents. Identifies improvements accumulated in
> user-local files that may warrant porting back to the shipped examples.
>
> **Decision gate**: PORT items listed below require user sign-off before any shipped file
> changes. LOCAL-ONLY items stay in `~/.claude/agents/` only. This doc is audit-only.

---

## File Pairs Audited

| User-local | Shipped equivalent |
|---|---|
| `~/.claude/agents/my-tempo-engineer.md` | `examples/agents/tempo-soloist.md` |
| `~/.claude/agents/my-tempo-qa.md` | `examples/agents/tempo-tuner.md` |
| `~/.claude/agents/my-tempo-researcher.md` | `examples/agents/tempo-improv.md` |
| `~/.claude/agents/my-tempo-docs.md` | `examples/agents/tempo-liner.md` |
| `~/.claude/agents/my-tempo-architect.md` | `examples/agents/tempo-composer.md` |
| `~/.claude/agents/my-tempo-devops.md` | `examples/agents/tempo-roadie.md` |
| `~/.claude/agents/my-tempo-po.md` | `examples/agents/tempo-conductor.md` |
| `~/.claude/agents/la-tempo-advisor.md` | _(no shipped equivalent)_ |

**Note**: The "Subagent offload (Task tool)" section has already been applied to both sets of
files (PR #152) and is excluded from this diff.

---

## Classification Key

- **PORT** — Generic improvement that benefits any user; should be added to shipped file
- **LOCAL-ONLY** — Project/user-specific; stays in `~/.claude/agents/` only
- **UNCERTAIN** — Ambiguous; flagged for user decision

---

## Pair 1: Engineer → Soloist

**Dominant pattern**: User-local has extensive claude-tempo-specific sections (Codebase Context,
Code Patterns, Cross-Platform & Agent Type Awareness) that are entirely LOCAL-ONLY. The shipped
Soloist is leaner but has some better wording on generic principles.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| E1 | `/simplify` skill reference in Working Style | User-local | Shipped lacks this. "After implementation, run `/simplify` to catch over-engineering." Generic advice for any engineer. |
| E2 | Explicit time threshold in "Ask early" | Shipped → backport | Shipped: "stuck for more than a few minutes...don't waste time on dead ends." User-local is vaguer. Shipped's framing is cleaner. |
| E3 | Peer collaboration on shared interfaces | Shipped → backport | Shipped mentions "coordinate with other soloists on shared interfaces or dependencies." User-local omits this dimension. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, Code Patterns (MCP tool, workflow, activity, testing patterns), Outbox
Entry Types, Cross-Platform & Agent Type Awareness, `npm run build` rebuild reminder,
`/temporal-developer` skill (claude-tempo workflow-specific).

---

## Pair 2: QA → Tuner

**Dominant pattern**: User-local adds extensive claude-tempo-specific review checklists, red
flags, and edge cases. The shipped Tuner has stronger generic debugging philosophy that the
user-local lacks.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| Q1 | "Error detective work" philosophy | Shipped → backport | Shipped Responsibilities section: "When bugs surface, correlate errors across components, trace cascade failures, and identify root causes. Don't just find *what* broke — find *why* it broke and *what else* might be affected." Completely absent from user-local. Excellent generic QA principle. |
| Q2 | "Correlate across boundaries" working style | Shipped → backport | "When debugging, don't stop at the first error. Trace the failure across modules and services — the symptom is rarely the cause." Not in user-local. |
| Q3 | "Investigate, don't patch" | Shipped → backport | "When a test fails, find the root cause. Don't just fix the test to make it pass." Not in user-local. |
| Q4 | `/simplify` skill reference | User-local → port | User-local has this in review stance; shipped doesn't. Generic advice for any QA reviewer. |
| Q5 | "Assess testability implications and flag concerns early" (composer collaboration) | Shipped → backport | User-local doesn't mention proactive testability review during design phase. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, Review Checklist (all 7 items with `src/workflows/`, `src/tools/` file
refs), Red flags list, Edge Cases to Specifically Test, Cross-Platform & Agent Type Review
Points, `/temporal-developer` skill.

---

## Pair 3: Researcher → Improv

**Dominant pattern**: User-local has a large Research Domains table and Current Architecture
section — entirely project-specific. The shipped Improv has more comprehensive role description;
user-local has a few better working-style notes.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| R1 | "Check existing research before duplicating" | User-local → port | "Look in `docs/` and ask the ensemble before duplicating prior work." Shipped omits this principle. Generic advice for any researcher. |
| R2 | "Map uncharted territory: document what you find so others can follow" | Shipped → backport | More explicit in shipped Responsibilities. User-local's equivalent is vaguer. |
| R3 | "Read documentation, source code, and issues to build understanding" | Shipped → backport | Shipped Responsibilities adds this. User-local doesn't enumerate this explicitly. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, Research Domains table (all rows are Temporal/MCP/Claude Code/claude-
tempo-specific), Current Architecture You Should Know, `/temporal-developer` skill (Temporal-
specific), specific research areas (competitors, temporal-advanced, cross-platform spawning).

---

## Pair 4: Docs → Liner

**Dominant pattern**: User-local has extensive claude-tempo-specific feature checklists and
document ownership tables (LOCAL-ONLY). The shipped Liner has richer generic documentation
philosophy that user-local lacks.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| D1 | "Write migration guides and upgrade notes when breaking changes land" | Shipped → backport | Completely absent from user-local. Generic docs responsibility for any project. |
| D2 | README philosophy: landing page, 200-400 line target, benchmark | Shipped → backport | "README is a landing page, not a manual." With specific line target and gold-standard comparisons. Very useful generic guidance. |
| D3 | Docs linking pattern: one CTA + inline links (lazygit/fzf model) | Shipped → backport | Specific, reusable anti-pattern guidance. User-local lacks this. |
| D4 | Generic `docs/` structure principle: "topic-based with index" | Shipped → backport | Shipped describes the structure philosophy; user-local has a claude-tempo-specific structure listing. Generic version is more useful. |
| D5 | "Content moves, never disappears" | Shipped → backport | When trimming docs, relocated content goes to `docs/`, never deleted. Absent from user-local. |
| D6 | Responsibility framing: "quality, accuracy, completeness" not just ownership | Shipped → backport | Shipped: "Own README, CHANGELOG, CLAUDE.md **quality, accuracy, and completeness**." Cleaner and more comprehensive framing. |
| D7 | `/simplify` reference | User-local → port | "Don't over-document. Keep entries concise." Shipped lacks this. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, Documents You Own table (CLAUDE.md/README/CHANGELOG/WIRE-PROTOCOL),
Feature Documentation Checklist (all 9 subsections with `src/tools/`, `src/workflows/` refs),
Cross-Reference Verification (grep patterns against specific claude-tempo files).

---

## Pair 5: Architect → Composer

**Dominant pattern**: User-local is heavily claude-tempo-specific (Temporal constraints, outbox
pattern, wire protocol). Shipped Composer has better generic architecture principles.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| A1 | Observability principle | Shipped → backport | "Design systems that are debuggable. Think about logging, tracing, and error reporting from the start." Completely absent from user-local. Critical generic architecture concern. |
| A2 | "Have strong views on architecture, loosely held" | Shipped → backport | Philosophical guidance absent from user-local. "Change your mind when presented with evidence." |
| A3 | Generic delegation language | Shipped → backport | Shipped: "hand off to soloists" (generic). User-local names a specific player type. Shipped is more reusable. |
| A4 | "Don't over-architect" with `/simplify` thinking | User-local → port | User-local: "Use `/simplify` thinking — if a design adds abstraction layers without concrete benefit, simplify." Shipped doesn't have this explicit principle. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, Architectural Boundaries table (src/tools/, src/workflows/, etc.),
Key Design Patterns (outbox pattern, dual workers, wire protocol, session lifecycle), Temporal
Constraints to Design Around, `/temporal-developer` skill.

---

## Pair 6: DevOps → Roadie

**Dominant pattern**: User-local has very detailed claude-tempo CI/release/npm pipeline specifics
(LOCAL-ONLY). Shipped has better generic operations philosophy.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| V1 | `/finishing-feature-branch` skill reference | User-local → port | Shipped lacks this. Generic skill advice for any DevOps/roadie player. |
| V2 | "Never tag before the version bump commit exists on main" principle | User-local → port | Learned from a real incident. Shipped lacks this cautionary principle. Generic enough for any project with tag-based releases. |
| V3 | Monitoring, alerting, observability responsibilities | Shipped → backport | Shipped Responsibilities includes: "Monitor deployed systems — set up alerting, logging, and dashboards." User-local completely omits ops monitoring. Important generic dimension. |
| V4 | Team environment coordination | Shipped → backport | Shipped: "Environment setup is ready for the team." User-local focuses only on the technical release steps, not team coordination. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, CI Pipeline with specific yml file steps, Release Pipeline with GitHub
Actions details, PR and Release Process exact steps, version bumping rules with specific
`package.json`/`CHANGELOG.md` format, Temporal Server Setup with SA names.

---

## Pair 7: PO → Conductor

**Dominant pattern**: User-local is the most extensively customized. Has full issue triage
workflow, issue safety policy, release coordination, and player delegation — all claude-tempo-
specific. Shipped Conductor has important generic conductor patterns the user-local lacks.

### PORT candidates

| # | What | From | Justification |
|---|------|------|---------------|
| C1 | Worktree coordination section | Shipped → backport | Shipped has a full "Worktree Coordination" section: create worktree before assigning, player works in isolation, conductor removes after PR merges, list to check. User-local completely lacks this. Highly valuable generic conductor workflow. |
| C2 | Worktree discipline rules | Shipped → backport | Shipped: "Provision before assigning (never assign branches without worktrees), no unsanctioned branch switches, PR scope check." Not in user-local. |
| C3 | Comprehensive responsibilities framing | Shipped → backport | Shipped lists: analyze dependencies, coupling, integration points; select API paradigms; identify scalability/security/maintainability risks. User-local's responsibilities are thin. Generic conductor concerns. |
| C4 | Generic nightly-triage philosophy | User-local → port (partially) | User-local has a sophisticated triage workflow (5 steps: review new issues, identify small tasks, decompose large ones, assign to players, update backlog). Structure is generic; the claude-tempo-specific parts (labels, branch naming, CI checks) stay LOCAL-ONLY. Worth porting the triage structure. |

### LOCAL-ONLY (confirmed)

All of: Codebase Context, Player name delegation (my-tempo-* names), Change Classification
(outbox/determinism/wire-protocol details), Issue Safety Policy (tamper check, `vinceblank`
author exception), Release coordination details (package.json/CHANGELOG/npm), Nightly triage
specifics (github labels, branch naming `feat/<issue-number>`, CI patterns, trusted author
exceptions).

---

## Pair 8: la-tempo-advisor.md

**Result**: No shipped equivalent in `examples/agents/`. This is an advisory role for another
project using claude-tempo externally. Leave as-is in user-local; no porting action needed.

---

## Summary: PORT Decision Gate

The following items are **proposed for porting to shipped files**. User sign-off required before
implementation. A follow-up PR would handle all approved ports.

### High confidence — recommend PORT

| ID | Shipped file | Content to add | Source |
|----|-------------|----------------|--------|
| Q1 | tempo-tuner.md | "Error detective work" philosophy in Responsibilities | from shipped (already present — confirm user-local should adopt) |
| Q2 | tempo-tuner.md | "Correlate across boundaries" working style | from shipped |
| Q3 | tempo-tuner.md | "Investigate, don't patch" principle | from shipped |
| D1 | tempo-liner.md | Migration guides and upgrade notes responsibility | from shipped |
| D2 | tempo-liner.md | README philosophy (landing page, 200-400 lines, benchmarks) | from shipped |
| D3 | tempo-liner.md | Docs linking pattern (lazygit/fzf model) | from shipped |
| D5 | tempo-liner.md | "Content moves, never disappears" principle | from shipped |
| A1 | tempo-composer.md | Observability principle (logging, tracing, error reporting) | from shipped |
| A2 | tempo-composer.md | "Strong views, loosely held" philosophy | from shipped |
| C1 | tempo-conductor.md | Worktree coordination section | from shipped |
| C2 | tempo-conductor.md | Worktree discipline rules | from shipped |
| V3 | tempo-roadie.md | Monitoring, alerting, observability responsibilities | from shipped |

### Medium confidence — recommend PORT, but verify

| ID | Shipped file | Content to add | Note |
|----|-------------|----------------|------|
| E1 | tempo-soloist.md | `/simplify` skill reference | Simple addition; low risk |
| R1 | tempo-improv.md | "Check existing research before duplicating" principle | Minor addition |
| A4 | tempo-composer.md | "Don't over-architect" + `/simplify` principle | Consistent with shipped philosophy |
| V2 | tempo-roadie.md | "Never tag before version bump commit" | Very project-pattern-specific; may feel too prescriptive for a generic shipped file |
| C4 | tempo-conductor.md | Generic nightly triage structure (without claude-tempo specifics) | Adds workflow value; needs careful editing to strip project-specific parts |

### User-local improvements NOT ported (already covered by shipped)

The following are cases where the SHIPPED version is actually BETTER than user-local, and the
user-local should ideally be updated (but that's outside this audit's scope):

- Tuner: Q2 "correlate across boundaries" and Q3 "investigate don't patch" are in shipped but
  not user-local — user-local files should inherit these (already partially true post-merge).
- Soloist: Better "ask early" framing is in shipped.
- Improv: "Map uncharted territory" / "document what you find" is stronger in shipped.
- Liner: README/docs philosophy (D2–D5) — the shipped version is architecturally cleaner.

---

## Recommended follow-up PR

If user approves the PORT items above: a single PR titled
`docs(agents): port improvements from user-local to shipped agent types` covering the approved
subset. Estimated 6–8 files touched, ~100–200 lines added across shipped files.

---

*Audit performed 2026-04-13. User-local files read from `C:\Users\vince\.claude\agents\`.
Shipped files read from `C:\repos\claude-tempo\examples\agents\`.*
