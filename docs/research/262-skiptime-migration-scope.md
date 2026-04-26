# `skipTime` → `createTimeSkipping` Migration Scope — Issue #262

- **Author**: tempo-researcher (claude-tempo[bot] ensemble)
- **Date**: 2026-04-26 (refresh-and-persist of issue-comment research from 2026-04-20)
- **Status**: **Parked** — graduated from issue-only comments to versioned doc. Recommendation continues to track [vinceblank's 2026-04-19 deprioritize decision](https://github.com/vinceblank/claude-tempo/issues/262#issuecomment-4277094436).
- **Tracking issue**: #262
- **Prior canonical sources** (this doc supersedes for reference but does NOT change the standing decision):
  - [Original tempo-researcher inventory](https://github.com/vinceblank/claude-tempo/issues/262#issuecomment-4284567729)
  - [Implementation-time addendum (one-mode-per-process invariant)](https://github.com/vinceblank/claude-tempo/issues/262#issuecomment-4284572465)
  - [vinceblank's deprioritize reply](https://github.com/vinceblank/claude-tempo/issues/262#issuecomment-4277094436)

---

## 1. `skipTime` inventory under current `main`

Verified 2026-04-26. Same five call sites in two files, **unchanged** from the 2026-04-20 audit:

| File | Line | Duration | Purpose |
|---|---|---|---|
| `test/session-phase-detach.test.ts` | 125 | 1 000 ms | drainingDeadline — pre-deadline check |
| `test/session-phase-detach.test.ts` | 131 | 2 000 ms | push past 2 s deadline |
| `test/session-phase-detach.test.ts` | 170 | 3 000 ms | default 5 s window — mid-drain check |
| `test/session-phase-detach.test.ts` | 175 | 3 000 ms | past 5 s auto-promote |
| `test/pause-resume.test.ts` | 238 | 5 000 ms | scheduler skips fires while paused |

**Total real wall-clock: 14 s** per Mocha run. Despite the helper's name, `skipTime()` in `test/helpers.ts:362` is `testEnv.sleep(durationMs)` on a `createLocal()` env — i.e. genuine wall-clock sleep, NOT Temporal time-skipping.

All five sites exercise pure workflow-timer waits (drain deadlines / scheduler `nextFireAt`). None races the dispatch loop (the #190 footgun).

## 2. Reopen-trigger status (against vinceblank's 2026-04-19 list)

| Trigger | Status as of 2026-04-26 |
|---|---|
| 3rd or 4th heavy `skipTime` site lands | **Not fired** — still 5 sites in 2 files |
| CI runtime sustained complaint | Not surfaced to research scope; defer to conductor/operator signals |
| Tests for the 3-minute stale window | **Structurally impossible** — the stale heuristic was removed in #175 and its regression test deleted in #178 (`test/processing-lifecycle.test.ts:129–135` documents this). |
| Tests for the 30-minute schedule-fire timing | **Not added** — would still be a fresh reopen signal if it ever lands |
| Someone already deep in `test/helpers.ts` | **Not fired** — last meaningful change was PR #195 ("replace racy `skipTime(1)` with poll-with-timeout"), which pre-dates the parking decision |

**No reopen trigger has fired.** Recommendation continues to be: stay parked.

## 3. Why migration is not justified — vinceblank's 5 blockers (verbatim citations)

From [issue #262 comment](https://github.com/vinceblank/claude-tempo/issues/262#issuecomment-4277094436):

1. **Search-attribute `extraArgs` incompatibility** — `createTimeSkipping()` runs the Java test server. Our env uses 9 `--search-attribute` `extraArgs` via the CLI dev server; Java server's startup-config surface differs and likely silently no-ops these. Most session/conductor tests query search attributes; regression risk is real.
2. **Singleton-env clock bleed** — SDK docs: *"time skipping is global to the environment … highly recommend running tests serially … or creating a separate environment per test."* Our shared singleton across 40+ Mocha files violates this.
3. **ARM / Apple Silicon friction** — SDK explicitly: *"Time Skipping Test Server is not supported on ARM platforms. Execution on Apple silicon Macs will work if Rosetta 2 is installed."*
4. **SDK's own recommendation** — `@temporalio/testing` v1.15.0 d.ts: *"For general Workflow testing, it is generally preferable to use `createLocal` instead."*
5. **Auto-skip-on-result doesn't apply** — our session workflows don't return; they live until destroyed. The headline `createTimeSkipping()` benefit (auto-advance while awaiting `handle.result()`) never fires here.

## 4. Cheap alternative if this ever becomes annoying

vinceblank's pointer: drop the test-only deadline constants via the existing override pattern (`gracePeriodMs` in `test/scheduler.test.ts:55–57`). **~10 LOC, zero SDK risk, ~9 s reclaim** — captures most of what a full migration would buy. Eng territory, not research; no PR planned from this doc.

## 5. Deferred broader opportunity (separate issue if ever pursued)

Earlier audit identified ~125 s reclaimable across `scheduler.test.ts` (~35 s), `outbox.test.ts` (~35 s), `hold-release.test.ts` (~20 s), `maestro.test.ts` (~19 s), `pause-resume.test.ts` (~7 s extra), `global-maestro.test.ts` (~8 s) — all using **local `setTimeout`-based `sleep()` helpers, not `skipTime`**. Re-counted 2026-04-26: ~50 sleep call sites across the same six files (close to prior count, churn but no major drift). Reclaiming those requires rewriting the local `sleep` helpers to `testEnv.sleep()` and per-test real-time-activity audits — out of scope here, file as its own issue if/when justified.

## 6. Implementation-time guard pattern (for whoever ever picks this up)

If a future `setupTimeSkippingTestEnv()` ever lands alongside `setupTestEnv()`, the two singletons MUST NOT coexist in-process. From the [implementation-time addendum](https://github.com/vinceblank/claude-tempo/issues/262#issuecomment-4284572465):

```ts
let envMode: 'local' | 'skipping' | undefined;

export async function setupTestEnv() {
  if (envMode && envMode !== 'local') {
    throw new Error(`already initialized as '${envMode}' — can't switch to 'local' in same process`);
  }
  envMode = 'local';
  /* ... */
}

export async function setupTimeSkippingTestEnv() {
  if (envMode && envMode !== 'skipping') {
    throw new Error(`already initialized as '${envMode}' — can't switch to 'skipping' in same process`);
  }
  envMode = 'skipping';
  /* ... */
}
```

Mocha's parallel-file runner executes each file in its own worker process, so the invariant is naturally satisfied today; the guard is defense-in-depth against a future shared-env mode that serial-runs both helpers.

## 7. Outcome

**Recommendation: continue parking #262.** Refresh the inventory annually or whenever a reopen trigger fires, whichever comes first. This doc is the reference snapshot; the issue stays open as a parking lot per vinceblank's 2026-04-19 framing.

## Sources

- Issue #262 — full thread, including vinceblank's 2026-04-19 deprioritize reply and the prior tempo-researcher comments
- `test/helpers.ts:340–364` — `skipTime` definition + docstring flagging the real-sleep behavior
- `test/processing-lifecycle.test.ts:129–135` — confirms the 3-minute stale heuristic is gone
- PR #195 (`5c9b285`) — last meaningful `test/helpers.ts` change (race fix per #190)
- `@temporalio/testing` v1.15.0 d.ts — SDK's own preference for `createLocal` for general workflow testing
