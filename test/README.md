# `test/` — Mocha integration suite

Mocha-driven Temporal workflow integration tests + wire-protocol drift detector.
Vitest-driven TUI and `TempoClient` fallback tests live alongside in [`tests/`](../tests/)
(yes, plural — see [CLAUDE.md](../CLAUDE.md#development) for the dual-directory rationale).

## Run

```bash
# Full suite (Mocha + Vitest). Use this for day-to-day local development.
npm test

# One half of the Mocha shard split — faster if you only touched one side.
npm run test:shard-1
npm run test:shard-2

# Vitest only (TUI + client fallback).
npm run test:tui
```

## Shared `TestWorkflowEnvironment` (#210 Phase 1)

The first `setupTestEnv()` call in a Mocha process creates a process-wide
`TestWorkflowEnvironment`; subsequent calls reuse it and only re-seed a per-file
random ensemble prefix (`test-ensemble-<hex>`) so `playerMetadata()` defaults
auto-namespace each file under the shared env. Real teardown runs once at
process exit via the global `after` hook in [`root-hooks.ts`](root-hooks.ts).

Fallback: set `TEMPO_TEST_ISOLATED=1` to restore the pre-Phase-1 per-file env
lifecycle (each file creates + tears down its own env). Use this when debugging
a flake you suspect is a cross-file state leak.

See [`docs/design/191-test-parallelization.md`](../docs/design/191-test-parallelization.md) §1
for the full derivation.

## 2-way Mocha shard (#191 Phase 2, #231)

CI splits the Mocha suite across two jobs per Node version. The split is
**timing-balanced, manifested** — defined explicitly in
[`shard-config.json`](shard-config.json) rather than derived from alphabetical
order (which drifts as tests are added).

**Rule** (design doc §2, v5): shard-1 pins the **top-N heaviest files by CI
wall-clock**, with N chosen so cross-shard drift lands ≤1.2× (the 20% rebalance
bound). Shard-2 is "everything else." As of PR #233 N=4 — the old
`session-phase-machine.test.ts` monolith was split into three files for future
drift safety; shard-1 now carries
`session-phase-detach.test.ts` (~48s, holds the two `skipTime` tests from #159
Gap 1), `outbox.test.ts` (41.6s), `scheduler.test.ts` (40.8s), and
`session-phase-claim.test.ts` (~22s) — totalling ~46% of the Mocha suite's
wall-clock. `session-phase-processing.test.ts` (~18s) stays in shard-2 as the
lightest of the three split files. Workflow-setup cost dominates per-test time
in these files.

Mechanics:

- `shard-1` runs only the files listed in `shard-config.json`.
- `shard-2` runs the default `.mocharc.yml` spec **minus** the shard-1 files,
  via Mocha's native `--ignore` flag. No custom runner; no duplicated lists.
- [`scripts/run-shard.js`](../scripts/run-shard.js) is a thin node wrapper that
  expands the JSON into Mocha args (for shard-1, `--no-config` + CLI mirror of
  the mocharc options + positional file list; for shard-2, default mocharc +
  `--ignore` for each shard-1 file) and execs Mocha. `shard-config.json` is
  the single source of truth; touch nothing else during rebalance.
- `npm test` (no shard suffix) still runs the full suite locally, unchanged.

> **Why `--no-config` for shard-1?** Mocha 11 unions the mocharc `spec:` glob
> with CLI positional args rather than letting CLI args replace it. If we
> left mocharc in charge and passed explicit file positionals, the default
> `dist-test/test/**/*.test.js` glob would silently pull in every file anyway
> and shard-1 would run the full suite. `--no-config` forces the CLI
> positional list to be authoritative; the mocharc `require:` + `timeout:` +
> `exit:` options are mirrored as CLI flags so shard-1 runs with the same
> shared-env teardown hook and per-test timeout as any other invocation.

### How to rebalance

Rebalance is driven by the **top-N heaviest** rule from design §2:

1. Identify the drift from CI. Each `build-and-test (shard-N, node-V)` job posts
   its Mocha wall-clock to the job summary. If `max / min > 1.2` over 3+ runs,
   rebalance.
2. Decide which file(s) to move. Two patterns:
   - **Shard-2 grew faster than shard-1** (because tests were added to shard-2):
     add the next-heaviest file *from shard-2* to the `shard-1` list in
     `shard-config.json`. Use a local per-file timing run (see §Local per-file
     timing below) to pick the right file.
   - **Shard-1 is heavier** (one of its files grew, e.g. new test cases added):
     remove the *lightest* file from shard-1. Prefer removing over adding,
     because shard-1 is meant to be "the small number of heavy files."
3. Open a one-line PR. `shard-config.json` changes; nothing else. Commit title:
   `refactor(test): rebalance shard-1 to top-N heaviest files (#<issue>)`.
4. Scan CI summaries on the first 3 post-merge runs to confirm the rebalance
   held. If drift is still >1.2×, you may need to move two files — escalate to
   the PR reviewer before firing a second rebalance.

### Local per-file timing

`scripts/run-shard.js` is purposely single-file to keep PR scope small. A
one-off wall-clock ranking of all test files is available via an ad-hoc Node
snippet: run each `.test.js` under `dist-test/test` in isolation with
`--no-config --require dist-test/test/root-hooks.js --timeout 30000 --exit`
(matches shard-1's invocation) and `time` them. The current ranking is
archived in `docs/design/191-test-parallelization.md` appendix v5.

Do **not** check in a timing-runner script unless the project develops a
recurring need to re-rank — the one-off snippet takes <10 min to re-run when
needed, and a permanent script adds surface without providing continuous value.

### Rebalance rule (20% drift bound)

If CI consistently shows `max/min > 1.2` for per-shard wall-clock over 3+ runs,
rebalance. The bound comes from design §2: beyond 20% drift the slower shard
becomes the critical path and negates the speedup versus a 1-way run.

### What NOT to do during a rebalance

- **Don't edit any `*.test.ts` file.** A rebalance is a pure CI-topology change;
  modifying test code in the same PR makes bisecting a subsequent flake much harder.
- **Don't edit `test/helpers.ts`, `root-hooks.ts`, or `.mocharc.yml`.** Those are
  Phase-1 surfaces and live on their own rev cycle. If a rebalance needs a
  helper change, split the PR.
- **Don't add files to both shards.** Mocha will run them twice and the job
  summary will drift.

See [`docs/design/191-test-parallelization.md`](../docs/design/191-test-parallelization.md) §2
for the wall-clock math and shard-split reasoning.

## Subdirectories

- [`test/conformance/`](conformance/) — per-adapter conformance tests
  (`adapter_class: 'interactive' | 'sdk'`).
- [`test/workflows/`](workflows/) — workflow-invariant tests for the v0.25
  session-lifecycle rebuild (see [the subdirectory README](workflows/README.md)).
- `test/*.test.ts` (flat) — everything else: outbox, scheduler, maestro, daemon,
  attachment lifecycle, wire-protocol drift.

## Related

- [`.mocharc.yml`](../.mocharc.yml) — default spec + `root-hooks.js` require.
- [`.mocharc.conformance.yml`](../.mocharc.conformance.yml) — narrower spec used
  by `npm run test:conformance`.
- [`test/tsconfig.json`](tsconfig.json) — compiles `test/**/*.ts` into
  `dist-test/` ahead of Mocha.
