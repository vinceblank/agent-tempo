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

**Split rule — top-N heaviest, data-derived.** `test/shard-config.json` lists the top-N heaviest files by measured CI wall-clock, with N chosen so that cross-shard drift lands ≤1.2× (the 20% rebalance bound). Shard-2 is "everything else" driven by the default `.mocharc.yml` spec minus the shard-1 list via Mocha's `--ignore` flag. No custom runner; no alphabetical assignment (which drifts as tests are added).

As of v5 (#231), N=3:

```json
{
  "shard-1": [
    "test/session-phase-machine.test.ts",
    "test/outbox.test.ts",
    "test/scheduler.test.ts"
  ]
}
```

Measured per-file wall-clock (see v5 appendix for the full 48-file ranking):

| Shard | Files | Wall-clock | % of total |
|---|---|---|---|
| 1 | session-phase-machine (88.7s) + outbox (41.6s) + scheduler (40.8s) | **171.1s** | 52.1% |
| 2 | remaining 45 files (sum of per-file times + shared-env overhead) | **157.0s** | 47.9% |

Cross-shard drift: **1.09× (~9%)**, well within the 20% bound.

CI jobs: 3 → 6 (2 shards × 3 Node versions) + 3 independent Vitest jobs. For a project of this size and free-tier budget, acceptable.

**Mocha 11 caveat (implementation note).** Mocha 11 *unions* the mocharc `spec:` glob with CLI positional args rather than replacing. A positional-args-only approach against the default config would silently pull in the full suite, so `scripts/run-shard.js` bypasses the mocharc for shard-1 via `--no-config` and mirrors the mocharc options (`require:` / `timeout:` / `exit:`) on the CLI. Shard-2 keeps the mocharc default plus `--ignore` per shard-1 file. See the `run-shard.js` docstring for details.

**Rebalance rule.** When CI consistently shows per-shard `max/min > 1.2` across 3+ runs, update `shard-config.json` — either add the next-heaviest file (if shard-2 got heavier) or remove the current heaviest (if shard-1 got heavier). One-line edit, no other files change. `test/README.md` ships the operator-facing procedure.

## 3. `mocha --parallel` — reject

Researcher flagged 4 workers on 4-core as risky. 2 workers would be safer CPU-wise but still runs 2 `TestWorkflowEnvironment` instances **inside one GHA runner**. Once Phase 2's matrix shard is in place, GHA already provides inter-VM parallelism; stacking intra-VM parallelism doubles server memory pressure for modest wall-clock gain. Only revisit if Phase 2 plateaus and we have instrumented headroom data (peak memory, sustained CPU%) from the GHA runner.

## 4. Rollout — phased

| Phase | Scope | PR title | Ship order | Files touched |
|---|---|---|---|---|
| 0 | Fix #209 (35s flake) | `fix(test): ...` | Before Phase 1 | 1 |
| 1 | Option C — shared `TestWorkflowEnvironment` | `refactor(test): shared env, per-file namespace suffix` | After #209, observe 5 CI runs before Phase 2 (reduced from 20 per v4) | 3 |
| 2 | Option A — 2-way matrix shard | `feat(ci): shard mocha tests 2-way` | After Phase 1 stabilizes | ~4 (CI yaml, `shard-config.json`, `test/README.md`, scripts/package.json) |

Phasing rationale: each phase is **independently valuable and cleanly revertible**. Phase 1 ships a test-helper refactor with no CI yaml changes. Phase 2 ships a CI yaml change with no test-code churn. If Phase 1 destabilizes, we roll back `test/helpers.ts` and the 2 test files — no CI plumbing to unwind. If Phase 2 misbehaves, we roll back the yaml and `shard-config.json` — test code unchanged.

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Runtime state leak under shared env** (Phase 1) — audit was static-only | Medium | Medium–High | Run 20-iteration local loop pre-merge; observe 5 clean CI runs on main before Phase 2 (window reduced from 20 per v4 — Phase 1 landed clean with no state-leak signals). `TEMPO_TEST_ISOLATED=1 npm test` fallback path preserves per-file env for debugging. |
| **Search-attribute re-registration** collides on second suite invocation | Low | Medium | Existing registration is idempotent; verify with explicit test. Document in `test/README.md`. |
| **Workflow ID collisions** from a caller not using the random-suffix default | Medium during rollout | High (flaky cross-file contamination) | Lint rule or grep-based CI check: fail if `ensemble: 'test-ensemble'` appears as a literal outside `helpers.ts`. |
| **Shard balance drift** as tests are added (Phase 2) | Medium | Low (one-line rebalance PR) | CI posts per-shard wall-clock; warn if `max/min > 1.3×`. |
| **Flaky test attribution** — one shard green, other red | Low | Medium | Keep test-level retry; don't add shard-level retry (masks real failures). Surface failed shard name in GHA job summary. |
| **GHA job-minute cost** — 3 → 6 jobs per PR (Phase 2 only) | Certain | Low for this project size | Monitor monthly; revert to 1-way if budget pressure emerges. |
| **Maintenance burden of `shard-config.json`** (Phase 2) | Low | Low | Docs in `test/README.md`; rebalance check in CI catches drift. |
| **`afterEach` destroy adds per-test overhead** (Phase 1) | Low | Low | Destroy is cheap (~10ms per call); measurable but negligible vs env-startup savings. |

## 6. Recommendation

1. Ship **#209** (separate PR) → critical path drops to 300s.
2. Ship **Phase 1 (Option C shared env)** → critical path drops to **~215s (3m 35s)**. ~1-day refactor; 3 files touched; zero CI yaml changes. Run 20-iteration local loop pre-merge. Observe 5 CI runs post-merge watching for flakes before Phase 2 (observation window reduced from 20 per v4).
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
- **v4** (2026-04-18 evening): Reduced the post-Phase-1 observation window from 20 → 5 clean CI runs before unlocking Phase 2 (matrix shard). Rationale: initial CI traffic post-merge showed zero flakes and no runtime state-leak signals (search-attribute re-registration, activity-stub leaks, and scheduler cron state all quiet). The v3 20-run bar was conservative — it was set when the shared-env audit was still static-only and runtime behaviour was unconfirmed; with two clean runs at decision time and no signals surfacing, 5 is a sufficient empirical bar. Decision-maker: vinceblank.
- **v5** (2026-04-18 late evening, PR #232): **Rebalanced shard-1 from 5 files to 3 after CI data disproved the initial 5-file split.** The v2/v3 design picked the 5 files it believed were heaviest based on pre-Phase-1 per-file characteristics; first CI run of the PR #232 implementation showed **2.24× drift** (shard-1 222s vs shard-2 99s) — a 124% imbalance, far above the 20% bound. Root cause: Phase 1's shared `TestWorkflowEnvironment` changed per-file scaling asymmetrically. Files that used to spend most of their time on env setup (which was previously per-file and is now amortized) shrank proportionally more than files dominated by in-test workflow work — so `session-phase-machine.test.ts` grew to be disproportionately heavy relative to the others in the original 5. Full 48-file wall-clock measurement (run locally with `mocha --no-config` per file, ratio cross-checked against CI — CI 2.24× vs laptop 2.43× confirms ratios carry between platforms even when absolute times don't) revealed the distribution below. Rebalanced to **shard-1 = {session-phase-machine, outbox, scheduler}** (top-3 heaviest, 171.1s = 52.1% of total), landing **1.09× drift (~9%)**. Also introduces the durable *"top-N heaviest, N chosen to land ≤1.2× drift"* rule in §2 — replaces the prior hard-coded 5-file list so future rebalances become "adjust N" rather than "re-derive which files to pick." Platform-stability observation (CI vs laptop ratio within noise) is documented for future debugging. Full per-file ranking (for reference during rebalance — do not reproduce in PRs):

  | Time | File |
  |---|---|
  | 88.7s | `session-phase-machine.test.ts` |
  | 41.6s | `outbox.test.ts` |
  | 40.8s | `scheduler.test.ts` |
  | 23.3s | `hold-release.test.ts` |
  | 22.0s | `maestro.test.ts` |
  | 14.6s | `pause-resume.test.ts` |
  | 12.0s | `adapter-reconnect.test.ts` |
  | 11.5s | `global-maestro.test.ts` |
  | 11.4s | `session-lease.test.ts` |
  | 10.6s | `adapter-claude-code-lifecycle-v2.test.ts` |
  | 10.0s | `workflow.test.ts` |
  | 6.0s | `integration.test.ts` |
  | <6s | 36 remaining files (each ≤5.4s, most ≤2s) |

  Decision-maker: tempo-conductor on PR #232 review.
