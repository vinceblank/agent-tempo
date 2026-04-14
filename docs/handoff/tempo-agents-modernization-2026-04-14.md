# Shipped Agent Modernization Audit — 2026-04-14

> **Purpose**: WS1 findings document for the `chore/agent-examples-v0.25-modernize` PR.
> Produced by Explore subagent survey before any edits were made. Serves as the decision
> gate before the docs player begins rewriting.
>
> **Files surveyed**: All 8 shipped files in `examples/agents/`
> **v0.25 changes checked against**: Retirement of `stop` and `encore`; introduction of
> `detach`, `destroy`, `restart`, `migrate`, `attachment_info`; new session lifecycle phases.

---

## Summary

| File | Retired Refs | Outdated Lifecycle Language | Severity | Action Required |
|------|:---:|:---:|:---:|---|
| **tempo-conductor.md** | `stop` (line 41) | Yes (context pressure section) | **Critical** | Replace stop guidance + context pressure recovery |
| tempo-composer.md | None | None | Minor | WS2/3 only (no WS1 changes) |
| tempo-soloist.md | None | None | Minor | WS2/3 only |
| tempo-tuner.md | None | None | Minor | WS2/3 only |
| tempo-critic.md | None | None | Minor | WS2/3 only |
| tempo-improv.md | None | None | Minor | WS2/3 only |
| tempo-liner.md | None | None | Minor | WS2/3 only |
| tempo-roadie.md | None | None | Minor | WS2/3 only |

**Net assessment**: WS1 scope is much narrower than feared. Only `tempo-conductor.md` has
active v0.25 incompatibility. All other 7 files use generic collaboration patterns (`ensemble`,
`cue`, `report`, `who_am_i`) that survived the v0.25 rebuild intact.

---

## Critical: tempo-conductor.md

### Finding 1 — Retired `stop` tool reference (line 41)

**Exact text (stale):**
```
- **`stop`**: Remove players when their work is complete and they're no longer needed. Don't leave idle sessions running.
```

**Problem**: `stop` is retired in v0.25. This instruction tells conductors to do the wrong thing:
- "Don't leave idle sessions running" contradicts v0.25 design — `detach` is now the park
  mechanism; detached sessions survive with full history and can be `restart`ed instantly.
- Guidance to "remove players when work is complete" conflates `detach` (temporary park) with
  `destroy` (irreversible termination).

**Fix**: Replace with the WS2 Session Lifecycle section drafted by the conductor (see Workstream 2).

### Finding 2 — Context Pressure recovery uses retired pattern (lines 85–91)

**Exact text (stale):**
```markdown
1. **Stop** the player's session
2. **Recruit** a fresh session with the same name, type, and working directory
3. Pass the player's structured summary as the **initial message** so the new session picks
   up where the old one left off
```

**Problem**: Step 1 says `stop` — which doesn't exist in v0.25. The correct v0.25 flow would
use `detach` (park existing session) or `destroy` (if context is truly corrupted and the
workflow needs to be abandoned), then `recruit` a fresh session.

**Fix**: Update Step 1 to "**Detach** the player's session (parks it with full history
preserved)" and add a note that `destroy` is an option if the session is irrecoverable.

---

## Minor files (WS1 no-ops)

All 7 non-conductor files avoid tool-specific guidance for session lifecycle management. They
use only:
- Ensemble query tools: `ensemble`, `who_am_i`
- Communication tools: `cue`, `report`, `broadcast`
- Discovery tools: `agent_types`

None of these were retired or changed semantics in v0.25. These files are clean and need no
WS1 changes.

---

## WS1 Scope Impact on PR Budget

| File | WS1 changes | WS2 changes | WS3 changes | Estimated delta |
|------|-------------|-------------|-------------|----------------|
| tempo-conductor.md | ~15–20 lines replaced + new lifecycle section (~15 lines) | C4 triage structure, C5 change classification, C6 wire protocol stability | Concrete cue examples | ~50–60 lines net |
| tempo-composer.md | None | A4 `/simplify` + "don't over-architect" | Anti-pattern callout | ~10–15 lines |
| tempo-soloist.md | None | E1 `/simplify` in Working Style | Anti-pattern callout | ~5–8 lines |
| tempo-tuner.md | None | Q4 `/simplify` in review stance | Anti-pattern callout | ~5–8 lines |
| tempo-critic.md | None | None (not in WS2 list) | Optional polish | ~0–5 lines |
| tempo-improv.md | None | R1 "check existing research" | Anti-pattern callout | ~5–8 lines |
| tempo-liner.md | None | D7 `/simplify`, D8 CHANGELOG note | Anti-pattern callout | ~5–10 lines |
| tempo-roadie.md | None | V1 `/finishing-feature-branch`, V2 "never tag before bump" | Anti-pattern callout | ~8–12 lines |

Totals well within the ~30-line-per-file growth budget set by the conductor.

---

## Pre-requisite: PR #152 merge

All edits must land on `chore/agent-examples-v0.25-modernize` branched from fresh `main` after
PR #152 merges. The files being edited (`examples/agents/*.md`) are only touched by PR #152 in
the subagent offload section already added — no conflicts expected.

---

*Survey performed 2026-04-14. Subagent read all 8 files at revision on `main` + pending PR #152
content. No edits made during survey.*
