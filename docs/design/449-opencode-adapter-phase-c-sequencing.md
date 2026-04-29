# OpenCode adapter — Phase C sequencing note

> **Status**: Implementation hand-off (Phase B merged in #475 / `bd3c6aec`)
> **Author**: tempo-architect
> **Branch (suggested)**: `feat/449-opencode-phase-c-impl`
> **Worktree**: `.claude/worktrees/feat+449-opencode-phase-c-impl`
> **Audience**: Phase C implementing engineer (lead or eng), conductor for dispatch.
> **Reading order**: skim before starting; reference during implementation. Delete this file after Phase C ships — it has no archival value once the work is done (the design doc + ADR 0015 carry the architectural record).

---

## 0. What this note is

A short operational checklist that orders the Phase C work into a sane commit sequence and flags the gotchas. The architectural record lives in `docs/design/449-opencode-adapter.md` (full design) and `docs/adr/0015-opencode-adapter.md` (locked decisions). **This note is the *how*, not the *what*** — refer back to those for any "why" question.

If the design doc and this note ever disagree, the design doc wins.

---

## 1. PR shape — locked: **single PR**

Per ADR 0015 §90, Phase C ships as **one additive PR, no breaking changes**. Splitting buys little:

- None of the bookkeeping items (config.ts ENV constant, types.ts AgentType extension, WIRE-PROTOCOL.md description) ship a usable feature on their own.
- A multi-PR sequence creates intermediate states where (a) `agentType: 'opencode'` is in the type union but no adapter exists, or (b) the adapter exists but can't be recruited. Each intermediate state is a half-feature with no consumer — pure overhead for the reviewer.
- Total scope is ~805–1,175 LoC (per design §8) — comfortably PR-sized.

**One PR, one branch, one merge.** If review surfaces something that needs splitting, that's a follow-up call at review time — but plan for one PR.

---

## 2. Suggested branch + worktree

- **Branch**: `feat/449-opencode-phase-c-impl`
- **Worktree**: `.claude/worktrees/feat+449-opencode-phase-c-impl` (matches the existing `+`-instead-of-`/` filesystem convention)
- **PR title**: `feat(adapters): #449 OpenCode headless adapter (Phase C — implementation)`
- **PR body**: link back to the design doc, ADR 0015, and this sequencing note. Note the Q6 path picked (A or B — see §5 below). Note any §3 gotcha hit or sidestepped.

---

## 3. Commit-cluster sequence

Land in this order (or fold all into a single squash-merged commit on the PR — but if you split for review readability, this is the order). **Items within the same step have no internal ordering constraint** — pick the order that's easiest for you.

### Step 1 — Foundation (no behavior change yet)

These three add symbols/dependencies that downstream code references. They MUST land before or in the same commit as Step 2.

1. **`src/config.ts`** — add `OPENCODE_MODEL: 'CLAUDE_TEMPO_OPENCODE_MODEL'` to the `ENV` constant (next to the existing `API_MODEL: 'CLAUDE_TEMPO_API_MODEL'`).
2. **`src/types.ts`** — extend the `AgentType` union to include `'opencode'`. Pre-existing values: `'claude' | 'copilot' | 'mock' | 'claude-api'`. New: `'claude' | 'copilot' | 'mock' | 'claude-api' | 'opencode'`.
3. **`package.json`** — add `@opencode-ai/sdk` to `optionalDependencies` at version `~1.14.29` (tilde, NOT caret — see §4 gotcha 4). Run `npm install` to refresh `package-lock.json` in the same commit.

### Step 2 — Adapter implementation

Land the new directory `src/adapters/opencode/`. The §8.1 skeleton in the design doc is the spine:

- `adapter.ts` — `OpenCodeAttachment extends SdkAttachment`, ~350-500 LoC (the skeleton in design §8.1 is the structural template; fill in the helpers and pollLoop).
- `server-bridge.ts` — `OpenCodeServerBridge` HTTP/SSE wrapper, ~150-250 LoC. Methods: `waitForHealth`, `getHealth`, `createSession`, `promptAsync`, `abortSession`, `deleteSession`, `subscribeEvents`. Surface contract listed in design §8.1's "exports" section.
- `config.ts` — `synthesizeOpenCodeConfig` + `ProviderEnvMap` + `detectProviderEnvFromModel` + `redactSecrets`. Spec in design §3.4 + §4.1.
- `helpers.ts` — `probeFreePort`, `waitForExit`, `isVersionMatch`. Each ~10-25 LoC; some can stay inline in `adapter.ts` if it's cleaner. Engineer's call.
- `README.md` — adapter-specific README. **Initial commit can be a placeholder**; fill in after Step 5 (the Q6 verify-at-impl experiment) so the findings have somewhere to live.

### Step 3 — Wire it into the adapter system

These two depend on Step 2 (the `OpenCodeAttachment` class must exist before they reference it):

1. **`src/adapters/index.ts`** — register `OpenCodeAttachment` in the registry bootstrap. Pattern matches existing `claude-api` registration — one import + one `register(...)` call.
2. **`src/adapters/base.ts`** (`AdapterRegistry.resolveFromAgentType`) — extend the switch / lookup with the `'opencode'` → `OpenCodeAttachment` case. One line.

### Step 4 — Surface it via recruit

Depends on Steps 2 + 3 being in place — otherwise `recruit` would accept `agent: 'opencode'` and crash at adapter resolution.

1. **`src/tools/recruit.ts`** — extend the `agent` Zod enum to include `'opencode'`; relax the `model` regex from `^claude-[a-z0-9-]+$` to `^[a-z0-9][a-z0-9-/.:_]*$` so `provider/model` strings flow through. Update the `.describe()` text per design §3.1.
2. **Optional-dep pre-flight** — extend the existing recruit pre-flight pattern (the one that catches missing `@anthropic-ai/sdk` for claude-api) to catch missing `@opencode-ai/sdk` AND missing `opencode` binary on PATH for the OpenCode case. Actionable error message per ADR 0015 §85.

### Step 5 — Q6 verify-at-impl experiment + Path selection

**Time-box: ≤30 min** per design §5.2. Do this AFTER Step 2's adapter shell compiles but BEFORE finalizing `invokeSdk`'s session-create logic. Sequencing-wise, this is a branch point inside Step 2:

1. Run the experiment: `POST /session` against a real `opencode serve` → kill the subprocess → restart → `GET /session/:id`. Does the session id round-trip survive subprocess restart?
2. **If YES** (Path A): the §8.1 skeleton is correct as-is. Adapter stashes `session.id` via `updateMetadataSignal` + reuses on restart. No additional code.
3. **If NO** (Path B): adapter rebuilds OpenCode-side history from `allMessagesQuery` + `allSentMessagesQuery` on restart. Mirrors `claude-api`'s `buildAnthropicMessages` shape, ~80 LoC. The §8.1 skeleton's `if (!this.openCodeSessionId) { ... }` path becomes "if the workflow had a stashed id but the OpenCode server doesn't know it, walk the history and rebuild."
4. **Document the finding in `src/adapters/opencode/README.md`** — record which path was picked and why. This is the only architectural decision that lives only in the implementation PR (not in the design doc or ADR).

**Lean: Path A is the simpler implementation; pick A unless evidence forces B.** Per design §5.2.

### Step 6 — Tests

1. **`test/adapter-opencode-lifecycle-v2.test.ts`** — adapter conformance test. Follows the per-adapter naming convention. Mirror the structure of the existing `test/adapter-sdk-lifecycle-v2.test.ts` (or whatever the SDK-class baseline test is named at impl time — verify the exact filename in `test/`).
2. **Wire-protocol drift detector** — already a no-op for this PR (no new wire surface). The detector validates that `claimAttachment` / `heartbeat` / `processingStart` / `processingEnd` / `markDelivered` / `updateMetadata` are referenced — they will be, via `SdkAttachment` inheritance + the §8.1 skeleton's `updateMetadataSignal` usage. No detector change needed.

### Step 7 — Wire-protocol doc + this sequencing note cleanup

1. **`docs/WIRE-PROTOCOL.md`** — extend the `sessionId` field description on `updateMetadata` to note that OpenCode joins Copilot as a consumer. Per design §7.1 item 1. **Independent of all other steps** — can be the first commit, can be the last. No code dependency.
2. **Delete this sequencing note** (`docs/design/449-opencode-adapter-phase-c-sequencing.md`) in the Phase C PR. It has served its purpose; the design doc + ADR + the actual implementation carry the record going forward.

---

## 4. Gotchas

Listed in priority order (highest-likelihood-to-trip first).

### 4.1 `ENV.OPENCODE_MODEL` must be declared before adapter compiles

The `OpenCodeAttachment` constructor literally references `process.env[ENV.OPENCODE_MODEL]` (design §8.1 line ~601). If `ENV.OPENCODE_MODEL` isn't in `src/config.ts` first (or in the same commit), TypeScript will fail with `Property 'OPENCODE_MODEL' does not exist on type ...`. **Land Step 1's config.ts edit before or together with Step 2's adapter implementation.** Splitting is fine; ordering is not.

### 4.2 `AgentType` extension must precede the registry case clause

`AdapterRegistry.resolveFromAgentType` (Step 3 item 2) switches on the `AgentType` union. Adding the `'opencode'` case before extending the union in `src/types.ts` will TS-error: `Type '"opencode"' is not assignable to type 'AgentType'`. **Land Step 1's types.ts extension before or together with Step 3's registry case.** Same-commit is fine.

### 4.3 Optional dep must land in package.json before tests run

The adapter imports `@opencode-ai/sdk` via `try { require(...) } catch {}` (design §8.1 lines 542-554). If the dep isn't in `package.json` (`optionalDependencies`), the catch path triggers in CI for everyone — including non-OpenCode users — and the adapter's `require.main === module` self-exec exits 1. The dep must be declared in `package.json` (Step 1 item 3) before any test that exercises adapter import. **Tilde-pin (`~1.14.29`), NOT caret** — see 4.4.

### 4.4 `~1.14.29`, NOT `^1.14.29` — tilde discipline

ADR 0015 locks `@opencode-ai/sdk@~1.14.29`. OpenCode ships breaking changes under SemVer minor (per Phase A spike: `parts` data model, `userMessage.variant`). Caret would let `^1.14.29 → 1.15.0` flow through and silently break the adapter. **Code review red flag**: if anyone PRs `"^"`, push back; the rationale is in ADR 0015 §82 ("Negative consequences") and §105 ("Alternatives considered, rejected").

### 4.5 Recruit pre-flight depends on adapter being registered

Don't ship the recruit Zod extension (Step 4 item 1) in a commit where the adapter registration (Step 3) is still missing — `recruit` would accept `agent: 'opencode'`, pass validation, then crash at adapter resolution time with a confusing error. **In a single-commit / single-PR shape, this is moot. If splitting commits, Steps 2-3 must land before Step 4.**

### 4.6 `--hostname 127.0.0.1` is hardcoded; do NOT make it configurable

Per design §6 + ADR 0015 §53: OpenCode's HTTP server has no Bearer auth in v1.14.x. Loopback bind is the operational mitigation for the no-auth gap. **Code review red flag**: if anyone proposes a `CLAUDE_TEMPO_OPENCODE_BIND_ADDRESS` env var or a `--hostname` recruit param, push back hard. The single-machine-trust model depends on the loopback hardcode.

### 4.7 `mdns: false` in synthesized config

Same security rationale as 4.6 — avoids leaking session presence over Bonjour. The `synthesizeOpenCodeConfig` helper (Step 2, `config.ts`) must emit `mdns: false` in the inline JSON. Don't omit; don't make configurable.

### 4.8 `opencode` binary check before adapter spawn

Adapter spawns `opencode serve` (design §5.7). If `opencode` is not on PATH, `child_process.spawn` will fail with `ENOENT` — the adapter should fail fast with an actionable error message ("install OpenCode: `npm install -g opencode-ai` OR `npx opencode serve` … etc."), not silently log and hang. Add an explicit `which opencode` check (or equivalent — `command -v` on POSIX, `where opencode` on Windows) in `run()` before the spawn call.

### 4.9 Q6 verify-at-impl is BLOCKING for `invokeSdk`'s session-create logic

The §8.1 skeleton bakes in Path A's `if (!this.openCodeSessionId) { POST /session }` shape. If the experiment finds Path B is required, the conditional gets a second branch (workflow-history walk + replay). Don't write the skeleton verbatim and call it done — gate on the experiment first. **Time-box: ≤30 min, picks one path, document in `src/adapters/opencode/README.md`.**

### 4.10 Cross-platform signal handling on Windows

Per ADR 0015 §84: Bun runtime on Windows handles SIGINT/SIGTERM differently from POSIX. The skeleton's `process.on('SIGTERM', shutdown)` may not fire on Windows. Test the graceful-detach path on Windows specifically (the lead's Windows machine is the canonical platform — coordinate via the conductor for a Windows smoke run). If Windows can't deliver SIGTERM cleanly to the child `opencode serve`, fall back to `SIGKILL` immediately on Windows (track via `process.platform === 'win32'` branch in `killSubprocess`).

### 4.11 PID file format — two PIDs, one file, newline-separated

Design §8.1 step 9: `logs/{playerId}.pid` is a two-line file — adapter PID on line 1, `opencode serve` subprocess PID on line 2. Operators may grep PID files to find orphan processes; honor the format. Don't write JSON; don't write space-separated; don't write a single PID. Two lines, two integers, trailing newline.

---

## 5. Q6 verify-at-impl — concrete experiment script

The single Phase B → C carry-forward decision. Do this experiment EARLY in Step 2 (after the bridge code compiles, before finalizing `invokeSdk`).

```bash
# 1. Start opencode serve in a terminal
opencode serve --port 4096 --hostname 127.0.0.1

# 2. In another terminal: create a session
SID=$(curl -s -X POST http://127.0.0.1:4096/session | jq -r .id)
echo "Created session: $SID"

# 3. Kill opencode serve (Ctrl-C in the first terminal)

# 4. Restart opencode serve with the same flags

# 5. Try to fetch the session
curl -s http://127.0.0.1:4096/session/$SID
#    - 200 + valid Session body → PATH A: OpenCode persists. Use the §8.1 skeleton as-is.
#    - 404 → PATH B: OpenCode does NOT persist across server restart. Implement workflow-history rebuild (~80 LoC, mirrors claude-api's buildAnthropicMessages).

# 6. Document the result in src/adapters/opencode/README.md.
```

If the experiment is inconclusive (session returns 200 but with a stub body, partial state, or fails on next `prompt_async`) — **default to Path B**. Path B is forward-compatible with both outcomes; Path A is only correct if the persistence is truly complete. Conservative call when uncertain.

---

## 6. Definition of done for Phase C

The PR is ready for QA review when:

- [ ] All Step 1-7 items landed
- [ ] `npm run build` clean (TypeScript compiles, no errors)
- [ ] `npm test` passes including the new `test/adapter-opencode-lifecycle-v2.test.ts`
- [ ] Manual smoke (design §9.3) — actual recruit of an `agent: 'opencode'` player against a real `opencode serve` subprocess on the engineer's machine, completing at least one round-trip turn
- [ ] Q6 path picked, documented in `src/adapters/opencode/README.md`
- [ ] Cross-platform smoke — Windows graceful-detach verified (4.10)
- [ ] `docs/WIRE-PROTOCOL.md` updated with the `sessionId` description extension (Step 7 item 1)
- [ ] This sequencing note (`docs/design/449-opencode-adapter-phase-c-sequencing.md`) deleted in the same PR

QA will validate against:
- Design doc §9.1-9.3 (test strategy + manual smoke)
- ADR 0015 consequences list (positive + negative items can be observed in the implementation)
- Wire-protocol drift detector (no-op for this PR; passes trivially)
- LoC budget (~805-1,175 — flag in PR body if you blew through 1,500)

---

## 7. References

- [`docs/design/449-opencode-adapter.md`](449-opencode-adapter.md) — full design (the "what & why")
- [`docs/adr/0015-opencode-adapter.md`](../adr/0015-opencode-adapter.md) — locked decisions (the architectural record)
- [`docs/research/449-opencode-adapter-spike.md`](../research/449-opencode-adapter-spike.md) — Phase A research spike (PR #468) — OpenCode surface audit
- `src/adapters/claude-api/adapter.ts` — closest existing precedent (HTTP-bridge, pinned-runId, PID file, terminal-cleanup wiring, optional-dep guard, `pollLoop`)
- `src/adapters/copilot/adapter.ts` — closest existing subprocess-pattern precedent
- `src/adapters/sdk/base.ts` — `SdkAttachment` lifecycle contract (~80 % of adapter wiring inherited)
- `src/adapters/README.md` — adapter contract + reconnect opt-in guidance
- `src/tools/recruit.ts` — agent-enum surface + pre-flight pattern (extend additively)
