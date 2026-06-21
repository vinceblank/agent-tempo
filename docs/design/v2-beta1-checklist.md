# 2.0.0-beta.1 Ship Checklist

> **Author**: tempo-architect · 2026-06-20 · the testable finish line for the first 2.0 release.
> First 2.0 target is a **beta** (`2.0.0-beta.1`), not GA. Phasing from [`v2-execution-plan.md`](./v2-execution-plan.md) §5.

## ⭐ The beta.1 bar, in one sentence
**A beta tester can run `upgrade-to-2` on 1.7.0 → install `2.0.0-beta.1` → `up --from-upgrade`, and their
ensemble comes back as protocol-2 workflows WITH continuity (schedules, #334 state, session resume).**
That round-trip is the SAFETY gate. The subtractive payload (TUI/shim/tool deletions) is what makes it
*2.0*, but the cutover core is what makes it *safe to hand out*. Cut the beta when BOTH are done; never
ship the payload without the safety core.

---

## 1. MUST-ship — the SAFETY CORE (non-negotiable; this is what makes the cutover safe)

- [ ] **#786 keystone — stamp + guard.** *Done bar:* `upsertMemo({AgentTempoProtocol:2})` in all 4
  workflow types; boot guard scans (bounded, **fail-closed on partial scan**) for un-stamped Running
  workflows and refuses `createWorkers()` with the migration command; `protocolVersion` validator rejects
  v1 adapters on `claimAttachment`.
- [ ] **#786 continuity-seeding fast-follow — CONFIRMED a beta.1 gate (non-droppable).** *Done bar:*
  `up --from-upgrade` recreates protocol-2 workflows AND seeds #334 state slots, schedules, `sessionId`,
  non-default `model` from the snapshot; undelivered cues surfaced-for-review (not redelivered); snapshot
  archived-on-success / pristine-on-failure. *(A stamp-only recreate is lossy → breaks the A2 thesis → NOT
  shippable to a tester.)*
- [ ] **Minimal cutover SMOKE (CI).** *Done bar:* one automated happy-path test — up on 1.7.0 →
  upgrade-to-2 → install 2.0-beta.1 → up --from-upgrade → assert players recreated + schedules/state/
  sessionId preserved + all stamped protocol-2 + guard refuses an un-stamped run. *(This is the beta.1
  slice of #796; the FULL matrix is the GA gate — see §2.)*

## 1b. MUST-ship — the SUBTRACTIVE PAYLOAD (defines the 2.0 theme)

- [ ] **#787 — all 20 `patched()` stripped.** *Done bar:* 11 eager deletes + 9 branch-collapses per
  [`v2-787-marker-map.md`](./v2-787-marker-map.md); zero `patched(`/`deprecatePatch(` in `src/workflows/`;
  workflow bundle rebuilds; workflow tests green.
- [ ] **#788 — wire v2.** *Done bar:* `pendingReset` removed + Pi pre-#750 fallback deleted (per
  [`v2-788-adapter-migration.md`](./v2-788-adapter-migration.md) — `pendingMessages` STAYS, adapters
  untouched); SA dual-read → memo-only; 4 legacy SAs dropped from registration + `LEGACY_SEARCH_ATTRIBUTES`;
  `refreshEnsembleState` V1 removed (always-V2); WIRE-PROTOCOL.md regenerated as v2 (capturing #786's
  additions); drift-detector `SECTION_TO_KIND` updated; drift test green.
- [ ] **#794 (+#792 residual) — shims gone.** *Done bar:* the 9 shims deleted (census §C);
  `CLAUDE_TEMPO_DEBUG` removed; **no `CLAUDE_TEMPO_*` literal remains in `src/`**; legacy-migration.ts +
  marker gone; build/tests green.
- [ ] **#789 — TUI deleted.** *GATE: #742 P0 mission-control parity CLOSED first.* *Done bar:* `src/tui/`
  + 21 test files gone; `ink`×3/`react`/`@types/react` dropped from package.json; bare-command default
  repointed (bootstrap + `status` + hints per D2); `docs/tui*.md` deleted; README surgery; removed-verb hints.
- [ ] **#793 — tool merges, ALIASED.** *Done bar:* coat-check ×4→1, state ×3→1, schedule ×3→1, stages
  ×2→1, gates partial — via the descriptor layer; **aliases present and stay through the beta** (drop at GA);
  tool tests green; registered-tool count down ~8.

## 1c. Cross-cutting gates
- [ ] `npm run check:all` green (build, tests, drift, lints, size-limit, tarball).
- [ ] **§E KEEP list respected** — no over-strip regression (optional `gitRoot`/`sessionId`, `cue`
  `attachmentTicket`, deliverability phase-undefined guard, etc. all intact).
- [ ] CHANGELOG + migration note done (§3).

---

## 2. Explicitly DEFERRED (name them so nothing creeps into beta.1)
- **Full #796 round-trip E2E *passing*** (multi-host, force-drain, straggler, edge-case matrix) → **GA gate.**
  *(beta.1 ships the minimal smoke only — §1.)*
- **Alias drop** (#793 aliases) → **GA.**
- **B2 attachment-core extraction** → **beta.2+** (contingent on T1.1 PR-2/3 settled).
- **#795 SA auto-registration** → **beta.2** (D5).
- **#791 deeper command-center UX** → **beta.2.**
- **Command-center board parity — `broadcast`, `migrate`, `schedule create`** → **beta.2.** Board supports schedule list+delete in beta.1; create stays on CLI/MCP tool. `broadcast` and `migrate` likewise CLI-only during the beta window.
- **Web-dashboard fate review** → **GA review** (stays per D3).
- **Full docs surgery** → progressive; beta.1 needs only the migration note + breaking-changes CHANGELOG.

---

## 3. Release mechanics
- **Version:** `2.0.0-beta.1`.
- **npm dist-tag: `next`** (CONFIRMED — better than overloading `beta`). `@latest`→1.7.0 stable (safe
  default; existing `npm i agent-tempo` users are NOT pulled onto a breaking prerelease), `@beta`→the
  1.7.x line, `@next`→2.0 prereleases. No collision. ⚠ **Release guard:** the publish workflow MUST tag
  `2.0.0-beta.1` as `next` explicitly — never `latest` (a prerelease on `latest` would push the breaking
  cutover onto every default install). devops owns this guard.
- **CHANGELOG `[2.0.0-beta.1]` — breaking-changes-FIRST:** lead with **⚠ BREAKING / MIGRATION REQUIRED**
  (the cutover: `upgrade-to-2` → `up --from-upgrade`; wire-protocol v2 → 1.x adapters rejected, upgrade all
  hosts; TUI removed; env unified; tool aliases). Then the subtractive cleanup. Then the migration pointer.
- **Migration note** (`docs/ops/v2-cutover.md`): the 3-step round-trip + "1.x adapters won't attach to 2.0
  workflows — upgrade all hosts' daemons first" + known beta limitations (full E2E matrix not yet certified).

---

## 4. The critical bar — minimum to safely hand a beta tester
All of §1 (SAFETY CORE) green:
1. `upgrade-to-2` on 1.7.0 writes the snapshot (shipped, #785).
2. Install `2.0.0-beta.1`.
3. `up --from-upgrade` recreates protocol-2 workflows **with continuity**.
4. Recreated ensemble is functional (protocol-2 adapters attach; cue/report work).
5. Guard fail-closed verified (refuses an un-stamped run).
6. The minimal cutover smoke passes in CI.

If §1 is green, the beta is **safe to release** even if §1b is mid-flight — but per the 2.0 theme, cut
the beta only when §1b (the subtractive payload) is also done, so beta.1 reads as *2.0*, not "1.8 with a
guard." §1 is the floor; §1+§1b is the finish line.
