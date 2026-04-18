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

Mechanics:

- `shard-1` runs only the files listed in `shard-config.json`. These are the
  heaviest integration suites as of PR #231 (scheduler, outbox, phase-machine,
  hold-release, maestro) — ~5 files, ~50% of total wall-clock despite being
  <10% of test count (workflow setup cost dominates).
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

### How to move a file between shards

1. Edit `test/shard-config.json` — add or remove the file under `"shard-1"`.
2. Run `npm run test:shard-1` and `npm run test:shard-2` locally. Note the
   wall-clock of each (printed by `scripts/run-shard.js` tail + Mocha's own
   summary line).
3. If `max(shard-1, shard-2) / min(...) ≤ 1.2`, open a one-line PR. No other
   files change. Commit title: `refactor(test): rebalance shard split (…)`.
4. CI posts per-shard wall-clock to each job summary (top of the workflow run
   page) — scan those numbers on the first few post-merge runs to confirm the
   rebalance held.

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
