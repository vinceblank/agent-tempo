# Design: Test Parallelization (#191)

**Status**: Proposed
**Author**: tempo-architect
**Date**: 2026-04-18
**Input**: tempo-researcher #16 spike + workflow-ID audit (landed same day).
**Baseline**: Mocha 5m 32s, Vitest ~5s.
**Issue**: [#191](https://github.com/vinceblank/claude-tempo/issues/191)
**Depends on**: #209 (35s scheduler test fix) — independent, ships first.

---

## TL;DR

**Recommendation** (revised after workflow-ID audit): Phase 1 — ship **Option C (cross-file shared `TestWorkflowEnvironment`)** first. The audit reduced its refactor cost from ~1 week to ~1 day (3 files touched, no per-test edits). Phase 2 — layer **Option A (2-way matrix shard)** on top. Reject `mocha --parallel` for now.

| Stage | Critical path | Reduction | New CI jobs |
|---|---|---|---|
| Baseline today | 332s (5m 32s) | — | 3 |
| After #209 | ~300s (5m 00s) | 10% | 3 |
| After Phase 1 (shared env) | ~215s (3m 35s) | 35% | 3 (no change) |
| After Phase 2 (shard on top) | ~108s (1m 48s) | 67% | 6 |

**Why C first, not A first** (pivot from earlier draft): C is now ~1-day refactor with zero CI-yaml changes; it's the lowest-risk first move. Shipping it first also stress-tests shared-env stability before we add shard complexity on top. If A ships first, a future C regression would force us to reason about both mechanisms simultaneously.

---

## 1. Option C — shared `TestWorkflowEnvironment` (Phase 1)

### Cost (revised per audit)

Researcher's static analysis of all 22 `setupTestEnv()` callers found:
- **Root cause** of would-be collisions: `playerMetadata()` / `conductorMetadata()` in `test/helpers.ts` default `ensemble: 'test-ensemble'`. Same ID + same default ensemble across files = collision under shared env.
- **7 files Tier A** (parameterized IDs, safe as-is).
- **15 files Tier B** (hardcoded literals + default ensemble).
- **Concrete collisions**: `conductor` playerId used in `workflow.test.ts` (×4), `quality-gate.test.ts`, `worktree.test.ts` — all default ensemble.
- **3 files have ZERO destroy cleanup** (`maestro.test.ts`, `global-maestro.test.ts`, `pause-spawn-drain.test.ts`) — under shared env, workflows leak across files.

### Refactor path — 3 files touched

| File | Change |
|---|---|
| `test/helpers.ts` | `playerMetadata()` / `conductorMetadata()` defaults derive from a per-file random ensemble suffix (`test-ensemble-${randomId}`, seeded once in `setupTestEnv`). Auto-namespaces all 8 default-ensemble callers with zero per-test edits. |
| `test/maestro.test.ts` | Add `afterEach` destroys to prevent cross-test leaks under shared env. |
| `test/global-maestro.test.ts` | Same. |

`pause-spawn-drain.test.ts` is entirely `.skip` — no-op.

### Savings

Per researcher: 50-85s across the full run (17 × 3-5s per-file env setup). On the current 300s critical path that's **~85s → 215s (3m 35s)**. Not transformative alone, but shippable in ~1 day with no CI yaml changes.

### Caveat

Researcher's audit is static-only. Runtime state leaks not validated — possible culprits include:
- **Search-attribute re-registration** may fail on second invocation in same Temporal server (though base code already registers idempotently).
- **Activity-stub leaks** if a test mocks an activity and doesn't restore it.
- **Global timer/cron state** in scheduler tests.

Mitigation: Phase 1 PR should include a 20-run loop of `npm test` locally + CI before merge, watching for flakes.

## 2. Option A — 2-way matrix shard (Phase 2)

Post-Phase 1 the critical path is ~215s. A 2-way split targets ~108s per shard. 3-way (~72s) costs 3 extra CI jobs for marginal wall-clock gain — reject.

**Split rule — timing-balanced, manifested.** Alphabetical drifts. Proposal: `test/shard-config.json`:

```json
{
  "shard-1": [
    "test/scheduler.test.ts",
    "test/outbox.test.ts",
    "test/session-phase-machine.test.ts",
    "test/hold-release.test.ts",
    "test/maestro.test.ts"
  ],
  "shard-2": ["test/**/*.test.ts"]
}
```

Shard 2 is "everything else" via `--ignore`. Mocha's native `--file` + `--ignore` args — no custom runner.

Post-#209 + shared-env math:

| Shard | Files | Wall-clock (with shared env savings prorated) |
|---|---|---|
| 1 | scheduler + outbox + phase-machine + hold-release + maestro (~149s raw) | **~107s** |
| 2 | remaining ~17 files (~146s raw) | **~105s** |

CI jobs: 3 → 6 (2 shards × 3 Node versions). For a project of this size and free-tier budget, acceptable.

When shard balance drifts >20%, an engineer moves a file between shards — one-line PR. Low toil.

## 3. `mocha --parallel` — reject

Researcher flagged 4 workers on 4-core as risky. 2 workers would be safer CPU-wise but still runs 2 `TestWorkflowEnvironment` instances **inside one GHA runner**. Once Phase 2's matrix shard is in place, GHA already provides inter-VM parallelism; stacking intra-VM parallelism doubles server memory pressure for modest wall-clock gain. Only revisit if Phase 2 plateaus and we have instrumented headroom data (peak memory, sustained CPU%) from the GHA runner.

## 4. Rollout — phased

| Phase | Scope | PR title | Ship order | Files touched |
|---|---|---|---|---|
| 0 | Fix #209 (35s flake) | `fix(test): ...` | Before Phase 1 | 1 |
| 1 | Option C — shared `TestWorkflowEnvironment` | `refactor(test): shared env, per-file namespace suffix` | After #209, observe 20 CI runs before Phase 2 | 3 |
| 2 | Option A — 2-way matrix shard | `feat(ci): shard mocha tests 2-way` | After Phase 1 stabilizes | ~4 (CI yaml, `shard-config.json`, `test/README.md`, scripts/package.json) |

Phasing rationale: each phase is **independently valuable and cleanly revertible**. Phase 1 ships a test-helper refactor with no CI yaml changes. Phase 2 ships a CI yaml change with no test-code churn. If Phase 1 destabilizes, we roll back `test/helpers.ts` and the 2 test files — no CI plumbing to unwind. If Phase 2 misbehaves, we roll back the yaml and `shard-config.json` — test code unchanged.

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Runtime state leak under shared env** (Phase 1) — audit was static-only | Medium | Medium–High | Run 20-iteration local loop pre-merge; canary the PR for 1 week on main before Phase 2. `TEMPO_TEST_ISOLATED=1 npm test` fallback path preserves per-file env for debugging. |
| **Search-attribute re-registration** collides on second suite invocation | Low | Medium | Existing registration is idempotent; verify with explicit test. Document in `test/README.md`. |
| **Workflow ID collisions** from a caller not using the random-suffix default | Medium during rollout | High (flaky cross-file contamination) | Lint rule or grep-based CI check: fail if `ensemble: 'test-ensemble'` appears as a literal outside `helpers.ts`. |
| **Shard balance drift** as tests are added (Phase 2) | Medium | Low (one-line rebalance PR) | CI posts per-shard wall-clock; warn if `max/min > 1.3×`. |
| **Flaky test attribution** — one shard green, other red | Low | Medium | Keep test-level retry; don't add shard-level retry (masks real failures). Surface failed shard name in GHA job summary. |
| **GHA job-minute cost** — 3 → 6 jobs per PR (Phase 2 only) | Certain | Low for this project size | Monitor monthly; revert to 1-way if budget pressure emerges. |
| **Maintenance burden of `shard-config.json`** (Phase 2) | Low | Low | Docs in `test/README.md`; rebalance check in CI catches drift. |
| **`afterEach` destroy adds per-test overhead** (Phase 1) | Low | Low | Destroy is cheap (~10ms per call); measurable but negligible vs env-startup savings. |

## 6. Recommendation

1. Ship **#209** (separate PR) → critical path drops to 300s.
2. Ship **Phase 1 (Option C shared env)** → critical path drops to **~215s (3m 35s)**. ~1-day refactor; 3 files touched; zero CI yaml changes. Run 20-iteration local loop pre-merge. Observe 20 CI runs post-merge watching for flakes before Phase 2.
3. Ship **Phase 2 (Option A matrix shard)** once Phase 1 stabilizes → critical path drops to **~108s (1m 48s)**. ~50-line yaml + config PR. No test-code churn.
4. Default **stop here**. Re-evaluate 3rd shard or `mocha --parallel` only if wall-clock creeps back above 2m over time.

**Validation spike needed?** No — the refactor path is well-scoped and reversible. However, if the 20-iteration local loop surfaces flakes, kick a focused spike on the specific runtime-state leak (search attributes, activity stubs, or scheduler cron state — whichever shows up).

## Out of scope (per dispatch)

- Eliminating `TestWorkflowEnvironment` — it's the right primitive.
- Rewriting tests to avoid workflow integration — that integration IS the value being tested.

## Appendix — revision history

- **v1** (initial): Recommended A → C phasing based on #16 spike estimate that C was ~1-week audit.
- **v2**: Pivoted to **C → A** after workflow-ID audit reduced C's cost to ~1 day (3 files). Lower-risk first move; stress-tests shared-env stability before adding shard complexity.
- **v3** (post-implementation, 2026-04-18): Phase 1 implementation (tempo-eng, #210) surfaced an estimation miss in the audit that fed v2. The audit reported **~8 literal `'test-ensemble'` occurrences** as the safety-critical collision surface; the actual full-repo sweep was **40 occurrences** across Tier A/B files. The extras lived in mock-only test files that bypass Temporal entirely, so the **safety property held** — zero collision risk at runtime — but the **cosmetic sweep** (literals to replace for consistency/lint-clean) was 5× larger than the design doc implied. No technical rework was needed; the Phase 1 PR simply had a larger diff than forecast. **Lesson for future audits of this kind**: separate the reported count into two metrics — *safety-relevant* (files that share the collision surface) and *total-sweep* (files the lint/rename touches, including Temporal-free ones). Conflating them understates PR size and risks reviewer surprise.
