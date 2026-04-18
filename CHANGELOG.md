# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Shared `TestWorkflowEnvironment` across Mocha spec files** (#210 Phase 1). The
  first `setupTestEnv()` call in a test run now builds a process-wide test
  environment; subsequent calls reuse it and only re-seed a per-file random
  ensemble prefix (`test-ensemble-<hex>`) so `playerMetadata()` defaults
  auto-namespace without per-test edits. Real teardown happens once at process
  exit via a Mocha `mochaGlobalTeardown` hook. Saves ~50-85s on the full Mocha
  suite. Set `TEMPO_TEST_ISOLATED=1` to restore per-file env lifecycle when
  debugging cross-file state leaks.
- Added `afterEach` shutdown safety net to `test/maestro.test.ts` and
  `test/global-maestro.test.ts` so a failing assertion doesn't leak a running
  Maestro workflow into the next test under the shared env.
- New CI lint (`scripts/check-test-ensemble-literals.sh`) fails on stray
  `'test-ensemble'` literals outside `test/helpers.ts` / `test/root-hooks.ts`.

### Fixed

- **`test`: CLI crash-proof isolation test was silently skipping in CI** due
  to a wrong `__dirname` path resolution from the compiled test location
  (`dist-test/test/` → `..` → `dist-test/` instead of the repo root). The
  `before` hook's `fs.existsSync` check then failed, triggering `this.skip()`
  on the entire suite, and mocha reports silent-skip as a benign pending
  count that looks green in CI summaries. **PR #218's isolation guarantee
  was never empirically verified by CI** for the duration between its merge
  and this fix — only `scripts/verify-daemon-isolation-guard.js` (shipped in
  PR #219) actually ran the detector. The property itself held in practice,
  but the CI test was a placebo. This PR: (a) uses the correct two-level
  `__dirname` resolution, (b) **fails loud** (throws) instead of skipping
  when dist is missing — explicit `SKIP_ISOLATION_TEST=1` env gate for
  dev-loop opt-out, (c) adds a counter + `after`-hook assertion that catches
  any future `this.skip()` regression in the suite's `before` path. Caught
  while extending the isolation suite for #157 PR C. (partial fix for #157)
- **Adapter reconnect loop always resets its `reconnecting` flag** on every exit path.
  `BaseAttachment.runReconnectLoop` is now wrapped in `try/finally`, so aborts during
  backoff sleep, success, terminal bails, and unexpected throws all clean up state.
  Before this, a user-initiated `stopV2Lifecycle` racing a reconnect backoff could leave
  `reconnecting=true` — harmless in practice (`stopped=true` gated all ticks) but the
  leaked state masked diagnostics. Also adds an integration test for the
  `reconnect-exhausted` terminal path (previously only covered by the abort-during-sleep
  unit test). (closes #206)

### Added

- **`daemon start` pre-flight orphan check + `--force` escape hatch** (partial fix
  for #157). Before spawning, the CLI now scans for unexpected claude-tempo daemon
  processes (command-line match via PR A's `scanClaudeTempoDaemons`) and aborts
  with exit 1 + orphan list + troubleshooting-docs pointer if any are found. Pass
  `--force` to bypass the check (and clear a stale pid file as a side effect).
  Exit-1 default is deliberate: piling a new daemon on top of orphans is the
  original #157 user-pain scenario; `--force` is the opt-in for CI scripts that
  want idempotent-start behavior.
- **Daemon heartbeat file** at `~/.claude-tempo/daemon.heartbeat`. The daemon
  touches this file every 60 seconds; `daemon status` reports its age, flagging
  "stale" when the last touch is >120s ago. Disambiguates "pid is alive AND
  main loop is serving" from "pid is alive but something hung" — informational,
  doesn't drive any automatic action. (partial fix for #157)
- **`scripts/verify-daemon-isolation-guard.js`** — one-shot manual verification
  script for the #157 isolation guard's fail-path. The `daemon-command-isolation`
  test asserts no forbidden Temporal imports leak into the `require.cache` of
  the daemon CLI module. This script empirically confirms the detector would
  FAIL if a forbidden import were injected — belt-and-suspenders paranoia per
  tempo-qa observation on PR #218. Run before a release or after touching CLI
  imports.
- **`claude-tempo version` / `help` / `upgrade` / `config` are now crash-proof**
  (partial fix for #157 PR C). Each now routes through a dedicated minimal
  module (`src/cli/help-text.ts`, `src/cli/upgrade-command.ts`) or is inlined
  in `src/cli.ts` (`version`), dispatched from `src/cli.ts` *before* the full
  `./cli/commands` surface loads. `upgrade` references `@temporalio/client`
  via dynamic import inside its active-session-warning try/catch so SDK
  load failure silently skips the warning instead of crashing — exactly the
  scenario a user invoking `upgrade` is trying to recover from. `config show`
  and `config set` become crash-proof; `config` interactive's connection-test
  step is still dynamic-imported Temporal. The `test/cli-crash-proof-isolation.test.ts`
  suite enumerates `CRASH_PROOF_MODULES` and asserts — both at runtime (child-process
  `require.cache` scan) and statically (source-file regex for `import X from 'pkg'`
  syntax, excluding comments and `await import(...)`) — that no new regressions
  leak Temporal-adjacent modules into these crash-proof entrypoints. Future
  crash-proof candidates are a one-line addition to `CRASH_PROOF_MODULES`.

## [0.26.0-beta.2] - 2026-04-18

> **Beta release.** Fixes the adapter poller reconnect bug (#201), drops Node 18,
> and removes the last v0.26 wire-compat vestiges.
>
> **Install:** `npm i -g claude-tempo@0.26.0-beta.2`
> **Rollback:** `npm i -g claude-tempo@0.26.0-beta.1`

### Fixed

- **Sessions now self-heal after laptop sleep / network drop.** `InteractiveAttachment` opts into
  the new reconnect loop in `BaseAttachment`: when the workflow revokes a lease (heartbeat-timeout
  or superseded), the adapter re-attempts `claimAttachment` with exponential back-off for up to
  15 minutes before giving up. Previously, any lease revocation caused permanent shutdown.
  Adds `DetachReason: 'reconnect-exhausted'` for the terminal case. (closes #201, #205)

### BREAKING CHANGES

- **Dropped Node 18 support.** Minimum is now Node 20.
  `@temporalio/core-bridge` 1.15.0 already required Node 20 at runtime
  (its `engines.node` is `">= 20.0.0"`); the Node 18 CI job only passed
  because npm's engines field is advisory. This change aligns the
  declared supported surface with reality and removes the unsupported
  matrix slot, saving ~6 min per CI run. Users still on Node 18 must
  upgrade to Node 20 LTS (or later) before installing claude-tempo. (#204)
- **`updateMetadata` signal no longer accepts `status` field.** The
  legacy `status` field (kept as a TypeScript wire-compat vestige in
  v0.26-beta.1 so older clients wouldn't get a schema-mismatch on
  TypeScript type-check) has been removed from the signal's TypeScript
  payload type. Runtime behavior is unchanged — the handler has ignored
  the field since #175. Callers passing
  `status: 'active' | 'pending' | 'terminated'` in `updateMetadata`
  payloads must drop the field; attachment phase is driven by the V2
  wire surface (`claimAttachment` / `adapterExited` / `forceDetach` /
  `destroyUpdate`), visible via the `attachmentInfo` workflow query and
  the `ClaudeTempoAttachmentState` search attribute. (#212)
- **`createWorker()` factory removed** from `src/worker.ts`. The
  function has thrown-on-call since v0.10. Use `createWorkers()` which
  returns `{ sharedWorker, hostWorker }` — both must be run for
  cross-machine recruiting to function. (#212)
- **`src/tui/client.ts` back-compat re-export removed.** The shim
  re-exported `createTempoClient` from `src/client/` for v0.24 TUI
  compatibility. Internal consumers migrated by v0.26-beta.1 (#177).
  Any external importer of `claude-tempo/tui/client` must switch to
  `claude-tempo/client`. (#212)

## [0.26.0-beta.1] - 2026-04-18

> **Beta release.** Completes the #174 legacy-shim removal epic (PRs
> [#175](https://github.com/vinceblank/claude-tempo/pull/192),
> [#176](https://github.com/vinceblank/claude-tempo/pull/196),
> [#177](https://github.com/vinceblank/claude-tempo/pull/197),
> #178). The attachment-phase lifecycle (shipped in v0.25) is now the
> single source of lifecycle truth; the compat shim that let adapters
> migrate at their own pace through v0.25.x is gone.
>
> **Upgrade guide:** [`docs/ops/v0.26-migration.md`](docs/ops/v0.26-migration.md).
>
> **Install:** `npm i -g claude-tempo@0.26.0-beta.1`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.5`

### BREAKING CHANGES

- **`ClaudeTempoStatus` search attribute removed.** Long-lived Temporal
  clusters must manually drop the attribute — Temporal does not
  auto-unregister. See the migration guide for `tcld` / `temporal
  operator` commands. Lifecycle truth now lives on
  `ClaudeTempoAttachmentState` (seven-phase values) and the
  `attachmentInfo` query.
- **`SessionStatus` TypeScript enum removed** from the public SDK
  surface. Use `AttachmentPhase` (`booting | attached | processing |
  awaiting | draining | detached | gone`) for lifecycle-typed code.
- **`SessionMetadata.status` field removed.** Query `attachmentInfo`
  on the workflow handle for phase instead.
- **`EnsembleSessionInfo.status` field removed**; replaced by
  `EnsembleSessionInfo.phase?: AttachmentPhase`. `scanEnsembleSessions`
  reads the new field from `ClaudeTempoAttachmentState`.
- **`MaestroPlayerInfo.status` renamed to `phase?: AttachmentPhase`.**
  External `TempoClient` consumers reading `player.status` must
  migrate to `player.phase`.
- **`BLOCKED_WINDOW_MS` / `SessionStatus` removed** from
  `src/utils/validation.ts`.
- **`updateMetadata` signal no longer writes `status`.** The field
  remains on the signal wire-shape for backward compat (prevents older
  clients from crashing on schema-mismatch) but has no observable
  effect — phase transitions happen through the V2 wire surface
  (`claimAttachment` / `adapterExited` / `forceDetach` /
  `destroyUpdate`).
- **Ensemble / CLI / TUI output labels collapsed.** Where v0.25
  rendered `(stale)` / `(blocked)` / `(pending)` / `(terminated)`
  tags, v0.26 renders `(pending)` / `(disconnected)` / `(gone)` — the
  Option-B mapping from the seven underlying phases to five
  user-facing buckets.
- **End-to-end upgrade required.** A v0.25 CLI / TUI paired with a
  v0.26 daemon (or the reverse) is not supported. Upgrade both sides
  together.

### Removed

- Legacy `_heartbeat` / `_ping` probe messages (the workflow used to
  inject these after 1 hour of idle) — the adapter `heartbeat` signal
  is the real liveness channel.
- 3-minute stale detection heuristic and 5-minute blocked-window
  heuristic — replaced by adapter lease expiry and
  `processingDeadline`.
- `docs/ops/v0.25-beta1-release-checklist.md` — marked as historical
  / superseded by the v0.26 migration guide.
- `test/blocked-detection.test.ts` — obsolete (heuristics removed).
- 9 other shim-era skipped tests (deleted or rewritten against
  attachment phase assertions).

### Fixed

- **Node 24 CI flake on `test/stages.test.ts`.** Bumped the
  `retry()` helper's default timeout from 5 s → 10 s to absorb
  Node 24 scheduler variance; the "completes stage when all players
  report result" test flaked on first CI run during #196 / #197 and
  passed on rerun.

### Docs

- New [`docs/ops/v0.26-migration.md`](docs/ops/v0.26-migration.md) —
  operator-facing migration guide with cluster-side attribute-drop
  commands, SDK consumer-update checklist, and rollback steps.
- Rewrote `docs/concepts.md`, `docs/troubleshooting.md`, and
  `CLAUDE.md` "Attachment phase" section to describe the seven
  phases in place of the removed `ClaudeTempoStatus`.
- Added editor's note to `docs/design/session-lifecycle-rebuild-v2.md`
  marking the design as realized.
- Added § 11 to
  `docs/design/session-lifecycle-rebuild-v2-sequencing.md` capturing
  the PR-H shim-removal ladder (PRs #175–#178).
- New `CLAUDE.md` callout on the `test/` (Mocha) vs `tests/`
  (Vitest) directory split — both are first-class test targets and
  must be grepped together during call-site migrations.

## [0.25.0-beta.5] - 2026-04-18

> **Beta release.** Three daemon and outbox stability fixes.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.4`

### Fixed

- **#182 — Daemon recovers from stale startup lock.** A daemon process that
  died abruptly (OOM kill, power loss) left a `.lock` file behind, causing the
  next daemon startup to hang indefinitely waiting for the lock to clear. The
  lock file is now JSON-formatted (`{ pid, mtime }`) so the daemon can detect
  whether the lock owner is still alive; stale locks (dead PID) are removed and
  acquisition retried. Atomic tmp+rename pid writes prevent partial reads.
  Daemon-ready timeout extended from 10 s to 30 s to accommodate slower CI
  machines.
  ([#182](https://github.com/vinceblank/claude-tempo/issues/182), [#186](https://github.com/vinceblank/claude-tempo/pull/186))
- **#183 — `restart --fresh` regenerates session UUID.** `restart --fresh` (and
  `migrate --fresh`) reused the session's stored UUID for the new spawn, causing
  "Session ID already in use" errors when a prior spawn had written a partial
  `.jsonl` transcript before crashing. A new UUID is now generated for every
  forced-fresh restart, ensuring a clean transcript path.
  ([#183](https://github.com/vinceblank/claude-tempo/issues/183), [#187](https://github.com/vinceblank/claude-tempo/pull/187))
- **#184 — Agent type propagates through `restart --fresh` pipeline.** A
  regression caused forced-fresh restarts to lose the player's agent type
  (`agentDefinition`, `agentDefinitionPath`, `nativeResolvable`), falling back to
  defaults on the new spawn. These fields now flow through `restart --fresh` →
  `enqueueSpawnUpdate` → spawn activity. The `enqueueSpawnUpdate` wire protocol
  change is additive (new optional fields, non-breaking).
  ([#184](https://github.com/vinceblank/claude-tempo/issues/184), [#188](https://github.com/vinceblank/claude-tempo/pull/188))

---

## [0.25.0-beta.4] - 2026-04-17

### Added

- **#172 — Ensemble startup waits for the user's first message before the
  conductor acts.** Previously, `claude-tempo up <ens> --lineup <name>`
  immediately delivered `lineup.conductor.instructions` to the conductor,
  which then auto-executed the lineup's default Phase-1 workflow before the
  user had said anything. Now the conductor stays quiet on startup and
  decomposes from user intent instead. User-facing behavior is unchanged
  from the previous iteration; the implementation is simpler.
  - **Simplified design** (v0.26 refactor): workflow-level
    `pendingStartupContext` state and the `receiveMessage` interceptor were
    **removed**. Instead, the conductor's lineup instructions plus a
    combined banner + "wait for user, call `resume_ensemble` first"
    directive are baked directly into `SessionInput.messages[]` at workflow
    creation. The directive text itself drives the hold — the LLM reads
    "wait silently until the user speaks, then call `resume_ensemble`
    FIRST" and honors it. No workflow state, no signal filter.
  - `load_lineup` tool gains an `initialStartup: boolean` param. When true,
    it signals the lineup instructions (`from: 'lineup'`) and the banner +
    directive (`from: 'system'`) immediately and then pauses the entire
    ensemble via `pause_ensemble` (scheduler + per-session outbox +
    maestro). When false, it keeps legacy immediate-signal behavior with
    no banner and no pause.
  - CLI: `up --lineup` defaults to the new behavior and seeds the
    conductor workflow's `SessionInput.messages` with the lineup
    instructions + banner+directive at pre-creation time; `--no-hold` opts
    out for scripts that want legacy immediate-start. New
    `conduct --lineup <name>` flag applies the same semantics when
    starting just a conductor.
  - Shared `ensembleReadyBanner(name, playerCount)` is rendered verbatim
    on CLI stdout. The combined banner + directive message body used by
    the CLI and `load_lineup` tool is centralized in
    `ensembleReadyDirective(name, playerCount)` in `src/constants.ts`.
  - **Removed from the previous iteration** (none of these are reachable
    without upstream code paths that no longer exist):
    - `setPendingStartupContext` workflow update + `pendingStartupContext`
      query — removed from `docs/WIRE-PROTOCOL.md`.
    - `SessionInput.pendingStartupContext` and
      `SessionInput.hasInitialStartupRun` fields.
    - Workflow-level idempotency guard and `receiveMessage` interceptor —
      the user's message typed in the conductor tab never flowed through
      `receiveMessageSignal` anyway, so the interceptor fired on
      player-join announcements instead of real user input.
    - TUI `startupBanner` state + poll loop + `getPendingStartupContext`
      TempoClient method. If the chat-header banner is useful later it
      can be added back with a simpler mechanism.
    - Blocked-detection suppression guard keyed on
      `pendingStartupContext` — no longer needed because the conductor
      is paused at the ensemble level, not via workflow state.
  - The `patched('v0.26-pending-startup-context')` replay marker is
    retained as a no-op in the session workflow so existing replay
    histories that recorded the command deserialize cleanly.
  - Conductor-invoked `load_lineup` mid-work and `recruit` mid-work are
    unchanged — the conductor is already oriented there.

### Fixed

- **`resume_ensemble` directive lie** (#172): `ensembleReadyDirective` previously told the
  conductor that `resume_ensemble` "unpauses the scheduler and unlocks player outboxes" — but
  `resume_ensemble` never touched outbox locks. Held players would stay silent until the
  conductor also called `release` by hand. Directive text now accurately describes the correct
  sequence: call `resume_ensemble { release: true }` → decompose.
- **`resume_ensemble` opt-in release** (#172): added `release?: boolean` arg (default `false`,
  non-breaking). When `true`, fans out `releaseHeld` to every running session after unpausing —
  idempotent on non-held sessions. Surface via `claude-tempo resume --release`. Eliminates the
  two-step `resume` + `release` that the deferred-startup flow previously required.
- **Directive message ordering** (#172): the system directive ("wait silently, then call
  `resume_ensemble { release: true }`") is now seeded *before* the lineup instructions in the
  conductor's `messages[]`. Previously the directive appeared after the lineup briefing, which
  caused the LLM to miss the required startup tool calls when lineup instructions were long
  (e.g. multi-phase lineups like `my-tempo-po`).

---

## [0.25.0-beta.3] - 2026-04-16

> **Beta release.** Consolidates session-lifecycle cleanup fixes validated via
> live Windows smoke test across all single-machine verbs.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.2`
>
> **Smoke coverage:** `recruit`, `cue`, `report`, `set_name`, `set_part`,
> `who_am_i`, `recall`, `broadcast`, `listen`, `detach`, `restart --force`,
> `destroy`, `schedule` / `unschedule` / `schedules`, `save_lineup` /
> `load_lineup` / `release`, `worktree` (create/list/remove), `stage` /
> `stages` / `cancel_stage`, `quality_gate` / `evaluate_gate` / `gates`.
> `migrate` (cross-host) pending — requires second host to validate.

### Fixed

- **#164 — `destroy` kills the live attachment's OS process tree.** Previously,
  `destroyUpdate` cleared the workflow attachment and flipped phase to `gone`
  without killing `claude.exe`, silently leaking a process per destroy on
  Windows. The handler now awaits `hardTerminateAttachment` on the host's
  per-host task queue before flipping `destroyRequested`, using a
  destroy-specific 5s timeout so a missing host worker in test envs fails
  fast instead of wedging for 20s. Best-effort: if the activity throws, we
  log and continue to `setPhase('gone')` because `destroy` is terminal per
  §2.5. Only fires when `currentAttachment` is non-null — no activity
  overhead for sessions destroyed while already detached.
  ([#164](https://github.com/vinceblank/claude-tempo/issues/164), [#166](https://github.com/vinceblank/claude-tempo/pull/166), [#169](https://github.com/vinceblank/claude-tempo/pull/169))
- **#165 — parent `cmd.exe` walk closes the Windows Terminal tab orphan.**
  The #159 fix killed `claude.exe` but not the parent `cmd.exe /k` shell that
  WT spawned, leaving an unresponsive tab per `detach` / `restart --force` /
  `destroy`. `findProcessesByCommandLine` now walks up exactly one PPID level
  per matched PID and — if the parent is `cmd.exe` with the same
  `-n <playerName>` sentinel in its CommandLine — adds it to the
  `taskkill /T /F` set. Grandparents (`wt.exe`, `conhost.exe`) are out of
  scope by design; WT auto-closes the tab once its shell process exits. New
  profile setting `closeOnExit: "always"` on the `claude-tempo` WT profile
  handles the non-zero-exit cases as a fallback.
  ([#165](https://github.com/vinceblank/claude-tempo/issues/165), [#166](https://github.com/vinceblank/claude-tempo/pull/166))
- **Latent #159 regex fix: `hardTerminate` now tolerates the production
  quoted-arg form.** The original `-n\s+<playerName>` regex assumed a bare
  space between `-n` and the player name, but `src/spawn.ts` §WT hand-quotes
  each token in the `cmd /k` innerCmd, producing `... "-n" "<playerName>" ...`
  in the CommandLine visible to `Win32_Process`. `\s` didn't match the `"`, so
  **every previous #159 hardTerminate call was a silent no-op in production** —
  earlier smoke runs only passed because the adapter self-terminated on MCP
  detach. The regex is now `-n[\s"']+<escapedName>([\s"']|$)` on the PowerShell
  branch, `[[:space:]"']` on the Unix pgrep branch (POSIX ERE — `\s` matches
  literal 's' there), and `%-n%<name>%` + post-filter on the wmic fallback. Test
  fixtures reproduce the production-quoted topology via a `.bat` indirection so
  future regex-quoting regressions fail loudly instead of silently. ([#166](https://github.com/vinceblank/claude-tempo/pull/166))
- **Fire-and-forget destroyUpdate regression from the bundled #166 fix.** An
  early revision of #166 dropped the `await` on `hardTerminateAttachment` to
  avoid CI test-env cascades. Temporal does not dispatch activities from a
  workflow that has already set its terminal flag, so the activity was
  scheduled but never run. Restored the `await` with a 5s best-effort timeout
  and flipped `destroyRequested = true` after the await, keeping the main loop
  alive long enough for the activity to reach the host worker. Verified
  end-to-end via live smoke: `hardTerminate done (search) — killedPids=[<pid>]`
  appears in the daemon log and the WT tab closes. ([#169](https://github.com/vinceblank/claude-tempo/pull/169))
- **macOS: close terminal tabs on `detach` / `destroy`.** Parity with the
  Windows WT fix from #166. Terminal.app, iTerm2, and Ghostty previously left
  an interactive shell at a prompt after `claude.exe` exited. Now: Ghostty's
  `initial input` and iTerm2's `write text` both append `; exit` (so the shell
  exits after claude returns, regardless of exit code); Terminal.app's
  `.command` script prepends `exec` to the claude invocation so the shell
  slot is replaced — when claude exits, the script ends and Terminal.app
  closes the window per its settings. iTerm2's AppleScript injection path was
  also hardened with `JSON.stringify` escaping (reviewer catch). **Not tested
  on macOS** — no Apple hardware available at release time; no process-leak
  risk in any failure mode. ([#168](https://github.com/vinceblank/claude-tempo/pull/168))

### Tests

- **Closed review gaps from #166.** (1) Replaced the 1.5s fixed sleep in the
  #165 parent-walk test with a polling loop, matching `spawnTestVictim`'s 60×100ms
  pattern — prevents CI flakes on slow machines. (2) Added end-to-end coverage
  for player names containing dots (`tempo.player-1.test-...`) so the
  `replace(/[.-]/g, ...)` regex-escape path is exercised. (3) `afterEach`
  cleanup is now platform-aware: `taskkill /F /PID` on Windows,
  `process.kill('SIGKILL')` on Unix — fixes EPERM on Windows when the test
  spawned `cmd.exe` processes without an IPC channel. ([#167](https://github.com/vinceblank/claude-tempo/pull/167))
- **Added #164 behavioral tests.** `destroys a session with a live attachment —
  workflow completes, isDestroyed=true` exercises the actual production bug
  path (`claimAttachment` first, then `destroy`). `concurrent forceDetach +
  destroy — workflow reaches gone without errors` tests the race window
  discussed in the PR #166 review. ([#166](https://github.com/vinceblank/claude-tempo/pull/166))

### Docs

- **`load_lineup` `hold` flag: docstring now matches warm-hold implementation.**
  The tool description previously claimed `hold=true` would create workflows
  without spawning processes. The activity actually implements a "warm hold":
  processes DO spawn and attach, but the outbox is locked and the player
  receives a standby message until `release` is called. Surfaced during
  smoke testing when a user reasonably expected no spawn. Behavior unchanged;
  description corrected. ([#170](https://github.com/vinceblank/claude-tempo/pull/170))

### Known Limitations (unchanged from beta.2)

- `migrate` (cross-host) not validated in this beta — needs a second host.
- Windows Terminal's `closeOnExit: "always"` profile setting may not auto-close
  tabs on some WT versions when the shell exits non-zero; functional kill still
  works, tab persists with "process exited" banner. Cosmetic only.

---

## [0.25.0-beta.2] - 2026-04-14

> **Beta release.** Docs-only update on top of `0.25.0-beta.1`.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@0.25.0-beta.1`

### Docs

- **Agent examples modernized for v0.25** — `detach`, `destroy`, `restart`, and `migrate`
  replace the retired `stop` verb across all shipped agent types. Adds a new
  "Session Lifecycle" section to relevant agents. Generic agents ported with
  11 improvements (PR #154)
- **Subagent offload guidance** — read-heavy agent types (`tempo-critic`,
  `tempo-improv`, `tempo-composer`, `tempo-tuner`) now document the
  `Task`/`Explore` dispatch pattern for multi-file archaeology (PR #152)
- **CLAUDE.md restructured** — trimmed from 261 to 127 lines; detail split into
  four new companion docs (`docs/architecture.md`, `docs/tui.md`,
  `docs/configuration.md`, `docs/development.md`). Replaces `docs/dashboard.md`
  with `docs/tui.md` (PR #155)
- **docs/README.md index** — updated to include all four new companion docs (PR #156)

---

## [0.25.0-beta.1] - 2026-04-13

> **Beta release.** This is the consolidated v0.25 session-lifecycle-rebuild beta.
> All v0.25 PRs (A/B/C/D/E/F/G/H) are included. Please validate before GA.
>
> **Install:** `npm i -g claude-tempo@beta`
> **Rollback:** `npm i -g claude-tempo@latest` (returns to v0.24.x)
> **Report issues:** https://github.com/vinceblank/claude-tempo/issues
>
> **Known limitations:**
> - Windows test environment: `npm test` shows 22 failures due to `TestWorkflowEnvironment.createLocal` EACCES on ephemeral-server startup. Tracked in [#150](https://github.com/vinceblank/claude-tempo/issues/150). Does NOT affect runtime correctness — CI (Ubuntu) passes clean.
> - Multi-host integration tests are skipped by default (`INTEGRATION_MULTI_HOST=1` to opt in with a running docker-compose harness).
> - `CLAUDE_TEMPO_LIFECYCLE_V2` environment variable no longer exists — V2 is the only code path. If you set it, it's ignored.
>
> **2-week soak target:** GA as `v0.25.0` after validation.

The v0.25 session-lifecycle rebuild. Complete adapter attachment-lease model,
7-phase session state machine, explicit wire primitives for claim / heartbeat
/ detach / destroy. Replaces the v0.24 `updateMetadata({ status })` shim with
a dedicated attachment surface that cleanly separates adapter lifecycle (the
attached process) from session lifecycle (the Temporal workflow).

Design reference: `docs/design/session-lifecycle-rebuild-v2.md`.

### Added

- **V2 wire primitives** — `claimAttachmentUpdate` (transactional claim/renew
  with lease tracking), `heartbeatSignal` (extends `expiresAt` by the
  attachment's negotiated `leaseMs`), `forceDetachUpdate` (revoke with TOCTOU
  guard), `requestDetachSignal` (graceful drain request), `adapterExitedSignal`
  (collapse `draining → detached`), `attachmentInfoQuery` (phase + attachment
  snapshot), `orphanSummaryQuery` (daemon restore metadata),
  `enqueueSpawnUpdate` (spawn outbox entry with pre-claimed attachment),
  `setPreferredHostUpdate` (reconcile-on-boot targeting)
- **7-phase session state machine** — `booting` / `attached` / `processing` /
  `awaiting` / `draining` / `detached` / `gone`. Phase is exposed as the
  `ClaudeTempoAttachmentState` search attribute and via `attachmentInfo`.
  Transitions documented in `docs/design/session-lifecycle-rebuild-v2.md` §2.4
- **Awaiting phase wiring (#117)** — `setPhase('awaiting')` now fires when
  `processingEnd` lands in-flight at 0 with an idle outbox, and again as a
  main-loop refinement after outbox-dispatch drain. Previously the phase was
  declared in the enum but never actually entered
- **`Attachment.leaseMs` (#119a)** — attachment carries its negotiated lease
  duration; heartbeat renewals honour it rather than a workflow-side default
- **`SpawnOutboxEntry` discriminated union (#118)** — typed member of
  `OutboxEntry` with the 5 attachment-specific fields (`attachmentId`,
  `attachmentRunId`, `resumeAttachment`, `sessionId?`, `adapterId`) wired
  end-to-end through the spawn activity. Replaces the prior double-cast
  `type: 'recruit'` workaround
- **V2 attachment search attributes** — `ClaudeTempoAttachedHost`,
  `ClaudeTempoAttachmentId`, `ClaudeTempoAttachmentState`
- **Adapter class registry** — `AdapterRegistry` keyed by `adapterId`; shipped
  `InteractiveAttachment` (Claude Code CLI, 60s heartbeat) and
  `CopilotSdkAttachment` (Copilot bridge, 30s heartbeat, `sendAndWait`
  pairing via `processingStart`/`End`). Registry descriptors drive dispatch
  without hardcoded `isBridgeMode` branches
- **`SdkAttachment` base class** — synchronous `processingStart`/`End` pairing
  with `expectedAttachmentId`, batch-ack via optional `ackIds`,
  `onSuperseded` hook, `sdkInFlight` guard for split-brain safety (§9.3)
- **CAN-boundary lease extension (§2.3)** — before `continueAsNew`, extends
  `currentAttachment.expiresAt` by one heartbeat interval so a healthy
  attachment isn't reaped during the CAN transition
- **Attachment-phase + heartbeat-timeout test coverage** — new cases in
  `test/session-phase-machine.test.ts` assert the 5 awaiting transitions
  (§2.4), the `#119a` leaseMs-honouring heartbeat renewal, and the
  phase-agnostic §9.5.a lease-expiry reap (covers
  `attached`/`awaiting`/`processing` → `detached` with
  `reason: 'heartbeat-timeout'`)
- **`restart` tool** — revives any non-`gone` session: graceful
  `requestDetach` (or `forceDetach` with `force: true`), fresh
  `claimAttachment` on the target host, optional context replay, then
  `enqueueSpawn`. Works from any non-`gone` phase. Replaces `encore`
  (which was limited to `stale` sessions)
- **`detach` tool** — gracefully reaps the adapter (`requestDetach` signal
  → `draining → detached`); workflow survives and can be `restart`ed
- **`destroy` tool** — terminally ends the workflow (§2.5 semantics: phase →
  `gone`, outbox abandoned, COMPLETE immediately). Irreversible
- **`migrate` tool** — sugar for `restart --host=<h>`; sets `preferredHost`
  and routes the spawn to `claude-tempo-{host}` task queue
- **`attachment-info` tool** — diagnostic query for current attachment phase,
  holder, and in-flight count (`attachmentInfo` query wrapper)
- **Daemon reconcile-on-boot** (PR-E §10.1) — `reconcileOnBoot()` in
  `src/daemon.ts` scans for sessions whose workflow is Running but whose
  adapter process is gone (attached-to-local with dead PID, or detached
  with local `ClaudeTempoHostname`). Candidate set fetched via a single
  visibility query; per-candidate `attachmentInfo` + `orphanSummary`
  resolved before the policy decision. Shared `queryOrphanedSessions`
  helper in `src/reconcile/orphans.ts` is reused by the CLI `restore`
  command. `isAdapterProcessAlive` stubbed as `() => false` in
  v0.25.0-beta.1 — conservative always-restore, with silent backoff on
  `AttachmentConflict` per §10.6
- **`restorePolicy` decision tree** (PR-E §10.2) — new `DaemonConfig` in
  `~/.claude-tempo/config.json` with `restorePolicy`
  (`"auto"`/`"prompt"`/`"never"`, default `"prompt"`),
  `autoRestoreMaxAgeHours` (default 24), `autoRestoreEnsembles`
  (simple-prefix allowlist, empty = all), and `cleanupPolicy`
  (`detachedMaxAgeDays` 7, `destroyedMaxAgeDays` 30). `"never"` is the
  effective off-switch — there is no feature flag. Zod-validated with
  per-field defaults so partial configs merge cleanly
- **Daemon cleanup loop** (PR-E §13.4) — `cleanupLoop()` runs every 6
  hours (hardcoded; no config field). Two passes: detached orphans
  exceeding `detachedMaxAgeDays` are `destroy`ed with an audit reason;
  completed workflows exceeding `destroyedMaxAgeDays` are `terminate`d
  to reinforce the namespace retention policy. Retention math lives in
  exported `selectStaleDetachedOrphans()` for unit testing
- **`claude-tempo restore` CLI** (PR-E §10.3) — new top-level command:
  interactive picker (no args), specific `<name>`, `--all`,
  `--from-host=<h>`, `--dry-run`. Thin wrapper over
  `queryOrphanedSessions` + `TempoClient.restart`. `AttachmentConflict`
  on concurrent restore logged + counted as "skipped"
- **`claude-tempo daemon install` / `uninstall`** (PR-E §10.5) — OS
  service registration. Linux (`systemd --user` unit copied to
  `~/.config/systemd/user/`), macOS (launchd agent copied to
  `~/Library/LaunchAgents/`, best-effort untested with NOTE banner),
  Windows (Task Scheduler via `packaging/windows/install-task.ps1`,
  current-user task at logon). **User-level only** — never requires
  `sudo` or Administrator
- **Cross-host `restart` / `migrate`** (PR-F design §16, §16.5 Option B)
  — the `restart` MCP tool accepts an optional `host` parameter that
  routes the downstream `spawnProcess` activity to the per-host
  `claude-tempo-{host}` task queue. The `migrate` tool is sugar over
  `restart --host=<h>`. Both verbs surface a `confirmStealFromHost`
  arg and a CLI `--yes-steal=<hostname>` flag; cross-host force-restart
  requires the flag to match the current attachment's hostname exactly
  (client-side guard; no interactive prompts per §8 answer 5).
  `claude-tempo migrate <name> --to <hostname>` is the operator-friendly
  surface with copy-paste-friendly re-run errors
- **Daemon `reconcileOnBoot` cross-host filter** (PR-F §8 answer 2) —
  orphans whose `preferredHost` differs from the local hostname are
  logged + skipped rather than auto-restored. The remote host's daemon
  is the authoritative restorer for its own sessions. Proactive
  cross-daemon notification of orphans is a v0.26 follow-up (tracked
  as a separate issue). Log line format includes both hostnames for
  observability: `skipping restore for {workflowId}: preferredHost={X}, localHost={Y}`
- **TUI cross-host indicator** (PR-F §8 answer 3) — `ChatView` and
  `PlayerDetailView` surface the attached host when a session is on a
  remote machine: status line gains a `{host} · ` prefix in amber
  (`THEME.accent`) for remote sessions; local sessions omit the host
  entirely to reduce noise for the common case. Zero new Yoga nodes —
  the host segment is composed inline in the existing `<Text>` tree as
  a nested virtual text node per CLAUDE.md TUI Performance rules

### Changed

- **`processingStart` / `processingEnd`** — now Temporal updates (not signals),
  require `messageId` for idempotency, suppress stale detection while
  in-flight (§9.5.b safety timer ejects wedged entries after 15 min)
- **`processingStart` validator** — uses canonical `phase === 'gone'` (#119b;
  was compound `destroyed || destroyRequested` pre-PR-C-commit-4)
- **`stop` tool + CLI stop paths** — migrated from
  `updateMetadata({ status: 'terminated' })` to `destroyUpdate` (§2.5 semantics:
  abandon in-flight, COMPLETE immediately). Legacy terminate fallback retired
- **MCP server SIGINT/SIGTERM** — closing the terminal no longer destroys the
  workflow. Graceful detach via adapter's `adapterExited` only; the session
  stays in `detached` awaiting the next claim (e.g. `restart`)
- **Copilot adapter cleanup** — drops duplicate `updateMetadata({ status:
  'terminated' })` signal. `stopV2Lifecycle(graceful=true)` already fires
  `adapterExited` for the workflow-side detach collapse

### Fixed

- **#117** — awaiting phase was defined in `AttachmentPhase` enum and guarded
  by `processingStart` but never entered. Sessions cycled `attached ↔
  processing` instead of the spec'd `attached ↔ awaiting ↔ processing`
- **#118** — spawn outbox entry double `as unknown as OutboxEntry` cast
  removed via the new discriminated-union member
- **#119a** — heartbeat renewal now extends `expiresAt` by the caller-negotiated
  `leaseMs` stored on the attachment at claim time, not a hardcoded 90s default
- **#119b** — `processingStart` validator uses canonical `phase === 'gone'`
- **#120** — main-loop comment at `session.ts:1047` correctly describes the
  `updateMetadata({ status: 'terminated' })` shim as routing to
  `destroyRequested`. Resolved by commit 4 (`34dc888`) without a separate fix

### Removed

- **`encore` MCP tool** — retired; use `restart` instead (works on any
  non-`gone` phase, not just `stale`)
- **`encore` CLI command** (`claude-tempo encore`) — removed; use
  `claude-tempo restart`
- **`encore` TUI slash command** (`/encore`) — removed; use `/restart`
- **`EncoreOutboxEntry`** — outbox entry type and dispatch case deleted
  alongside the `encore` activity
- **`CLAUDE_TEMPO_LIFECYCLE_V2` feature flag (#132)** — removed. V2
  attachment-lease is now the only path; `lifecycleV2Enabled()` helper,
  `BaseAttachmentOptions.lifecycleV2` field, and all `if (this.lifecycleV2)`
  branches in the Claude Code / Copilot / SDK adapters have been deleted
- **`updateMetadata({ status: 'terminated' })` compat shim (#132)** — the
  v0.25.1-deferred handler branch in `session.ts` is gone. Status-only
  metadata updates stay supported for presentation fields; phase transitions
  now exclusively go through the V2 wire surface (`destroyUpdate`,
  `adapterExitedSignal`, `forceDetachUpdate`, `claimAttachmentUpdate`).
  Test fixtures (~165 call sites across 13 files) migrated to
  `executeUpdate(destroyUpdate, { args: [{}] })`
- **`stop` MCP tool (#132)** — the v0.25.1-deferred deprecation hint tool is
  gone. Callers use `detach` / `destroy` / `restart` directly
- **`claude-tempo stop --terminate` CLI flag (#132)** — the `hardTerminate`
  escape hatch is gone. Bulk `stop` always routes through `destroyUpdate`
- **TUI `/stop` slash command (#132)** — renamed to `/destroy`, routed
  through `TempoClient.destroy()` (V2 destroy semantics, confirmed prompt)
- **Workflow `LEASE_MS` constant** — removed in favour of per-attachment
  `leaseMs`

### Operator notes

- **Wire protocol is reset as of v0.25.0-beta.1.** Previous versions are not
  compatible. Stop all sessions, `npm i -g claude-tempo@beta`,
  restart ensembles. No migration path for in-flight v0.24.x sessions.

---

## [0.24.0] - 2026-04-12

### Added

- **Ensemble startup hold** — `load_lineup(hold: true)` spawns all players with locked outboxes and a standby message; `release` (MCP tool + CLI) unlocks and delivers the real task, enabling controlled team pre-warming before a job begins (#91)
- **Pause / resume ensemble** — `pause_ensemble` / `resume_ensemble` MCP tools and `claude-tempo pause` / `resume` CLI commands lock all session outbox dispatch and pause the scheduler mid-session; `stop` entries bypass the lock; the ensemble Maestro owns pause ground truth (#91)
- **New MCP tools**: `release`, `pause_ensemble`, `resume_ensemble` (#91)
- **New CLI commands**: `claude-tempo release`, `claude-tempo pause`, `claude-tempo resume` (#91)
- **New TUI slash commands**: `/go` (release all held players), `/pause`, `/resume` (#91)
- **New session signals**: `releaseHeld` (unlock held outbox + deliver deferred message), `setPaused` (pause/resume outbox dispatch) (#91)
- **New session queries**: `outboxLocked` (boolean — held at startup), `paused` (boolean — currently paused) (#91)
- **New scheduler signal**: `setSchedulerPaused` (pause/resume fire delivery; skipped fires are not replayed) (#91)
- **New Maestro signal/query**: `maestroSetPaused` (ensemble-wide pause ground truth), `maestroPaused` (query current pause state) (#91)

### Fixed

- Hardcoded hold standby instruction now fires for any conductor when `hold=true`, regardless of whether the lineup has a `conductor:` section (#91)

---

## [0.23.0] - 2026-04-12

### Added

- **`ClaudeTempoIsConductor` search attribute** (Bool) — registered in schema, set at workflow startup and `continueAsNew`, with workflow ID fallback for indexing delay. Enables direct conductor lookup without scanning all sessions (#68)

### Changed

- **`TempoClient` extracted to `src/client/`** — interface and factory moved from `src/tui/client.ts` to `src/client/interface.ts` and `src/client/index.ts` for multi-interface reuse. `src/tui/client.ts` is now a thin re-export shim for backward compatibility (#68)
- **WIRE-PROTOCOL.md** — updated to document `ClaudeTempoIsConductor` search attribute and conductor lookup semantics (#68)

---

## [0.22.1] - 2026-04-11

### Fixed

- TUI `getPlayerMetadata` query name mismatch — was calling `metadata` instead of `getMetadata`, causing "Query not found" errors

---

## [0.22.0] - 2026-04-11

### Added

- **Ensemble chat feed** — aggregated maestro + conductor traffic as the default TUI view. Backed by the new `maestroEnsembleChat` per-ensemble Maestro query with delta-based caching (max 500 entries, refreshed every ~10s via `fetchEnsembleChat` activity). New wire protocol types: `EnsembleChatMessage`, `EnsembleChatQuery`, `EnsembleChatResult`, `ChatHighWater` (#58)
- **`@player` messaging** — type `@player message` in the ensemble view to address a player directly, with inline autocomplete palette (#58)
- **Copilot bridge in TUI** — `defaultAgent` config threaded through TUI; recruit wizard defaults to the configured agent type (claude/copilot) (#58)
- **Interactive overlays** — `/schedule`, `/gates`, `/stages`, `/worktree` overlays now support arrow-key navigation and action keys (n=new, d=delete, esc=close) (#58)
- **`/worktree create/remove`** — new subcommands route worktree provisioning requests to the conductor (#58)
- **`/encore` player picker** — filters the interactive picker to stale players only (#58)
- **`/help <command>`** — pass a command name to `/help` for a per-command usage overlay; e.g. `/help recruit` or `/help /recruit` (#58)
- **`NO_COLOR` support** — set `NO_COLOR=1` to disable all color output in the TUI and CLI, following https://no-color.org/ (#58)
- **Minimum terminal size check** — TUI exits with code 1 at launch if the terminal is below 80×24; soft in-app warning renders when resized below 60×15 (#58)
- 555 passing tests (#58)

### Changed

- Viewport height estimation uses `wordWrap()` — same function for both estimate and render, eliminating layout drift between static scrollback and live area (#58)
- Poll cycle deduplication skips redundant state dispatches when nothing has changed (#58)

### Fixed

- `/gates` and `/stages` now scoped to the active ensemble (were incorrectly querying all ensembles) (#58)
- `/encore` works without a conductor via direct API — no longer requires a conductor command relay (#58)
- `/recruit-conductor` uses `claude-tempo conduct` directly, bypassing the broken conductor-command relay path (#58)
- Direct (maestro/conductor) messages shown in full; third-party messages truncated at 500 chars. Previously all messages were truncated (#58)
- `@player` message dedup: sent text now matches server-returned text, eliminating duplicate echoes (#58)
- TUI message layout: top-aligned with a reserved 1-line gap above the footer; static and live areas use matching word-wrap and indentation (#58)
- `/schedule delete <name>` is the canonical schedule cancellation path — the previously documented `/unschedule` alias was never registered (#58)
- `exec()` replaced with `execFile()` in TUI ensemble creation to prevent shell injection (#58)
- TUI exits with code 1 on Temporal connection error (previously exited cleanly, masking failures) (#58)

### Removed

- Dead `/cue` slash command handler (use bare text or `@player` prefix instead)
- Redundant command aliases: `/home`, `/maestro`, `/exit`, `/dashboard`, `/unschedule`

---

## [0.21.1] - 2026-04-08

### Fixed

- Recruit and encore tools now use the configured `claudeBin` setting when spawning new player sessions. Previously, mid-session recruits ignored the custom binary path and fell back to the default `claude` command (#90)

## [0.21.0] - 2026-04-08

### Added

- Custom claude executable alias: `CLAUDE_TEMPO_CLAUDE_BIN` env var and `claude-tempo config set claude-bin` (#87)

## [0.20.1] - 2026-04-08

### Fixed

- `claude-tempo up` now detects an existing running conductor and prompts with options: join as player, reconnect, tear down and start fresh, or cancel. Prevents two sessions from silently sharing the same Temporal workflow (#85)

## [0.20.0] - 2026-04-08

### Added

- `claude-tempo upgrade [version]` command for graceful self-update — stops daemon, installs new version, restarts daemon (#79, #82)
- Complete TUI rewrite — multi-ensemble home screen, view router, adaptive polling (#58)
- TempoClient API layer replacing core-api.ts with Maestro-first fallback (#58)
- 13 new components: ChatView, CommandPalette, ConversationStream, ErrorView, MainView, Picker, PlayerDetailView, PromptArea, RecruitWizard, ScheduleWizard, Splash, StatusBar, StatusOverlay, TitleBar (#58)
- Slash command system with parser, registry, tab completion, persistent history (#58)
- `/status` command — dismissible overlay (`StatusOverlay`) showing all players with status, type, and current part (#58)
- `/unschedule` command wired — cancels a named schedule via the durable scheduler workflow (#58)
- `PlayerDetailView` — per-player panel with scrollable message history (#58)
- `ConversationStream` — live message area merging server conversation with optimistic sent-message echo (#58)
- `Picker` — interactive full-screen picker with player type grouping (groups items under shared headers) (#58)
- `CreateEnsembleWizard` — guided step-by-step flow for creating new ensembles (name → workDir → lineup → confirm), accessible from the splash screen and `/ensemble` (#58)
- Loading states for splash screen (connection checklist) and status bar (#58)
- Two-way conductor chat via Global Maestro relay (#58)
- Interactive wizards for recruiting and scheduling (#58)
- Message search, scrollback navigation, ensemble switching (#58)
- Splash screen with connection checklist and ensemble picker (#58)
- `claude-tempo tui` as default CLI command (#58)

### Changed

- TUI input area restyled to match Claude Code: `❯` prompt, inline hints, second divider line (#58)
- TUI message display: header line (player name + timestamp) above word-wrapped indented body (#58)
- `/up` command removed from TUI slash commands — ensemble creation is now handled by `CreateEnsembleWizard` via `/ensemble` (#58)
- `down` command now always stops the daemon, requires confirmation when no ensemble is specified, and exits with code 1 in non-TTY environments (#78, #83)

### Fixed

- `load_lineup` MCP tool now resolves shipped example lineups by name, in addition to saved lineups and file paths (#80, #81)
- Blocked detection no longer triggers on informational messages — broadcasts, schedule-fires, heartbeats, and system notifications now set `responseRequested: false`, preventing false positives (#75, #66)
- TUI input lag eliminated — animation timers removed, Yoga nodes flattened, stale ref fix (#58)
- `ErrorView` refactored to zero Yoga nodes — single `<Text>` root with nested virtual-text children, matching the `StatusOverlay`/`ConversationStream` pattern (#58)
- Live message lists capped at ~20 entries to prevent render slowdown (#58)
- Ensemble switching: maestro session identity stabilised, `/back` navigation and context-based messaging corrected (#58, #89)

## [0.19.0] - 2026-04-07

### Fixed

- Schedule targets now validated against player names at lineup load time; mismatches warn instead of silently failing (#74)
- `set_name` propagates renames to scheduler via new `updateScheduleTarget` signal (#74)
- `schedule` tool validates target player exists at creation time (#74)
- Conductor no longer blocks player recruitment on 15s timeout — workflow pre-created before spawn (#56)
- `load_lineup` migrated to outbox recruit pattern — eliminates spawn+poll loops (#56)

## [0.19.0-beta.0] - 2026-04-06

### Added

- **Global Maestro** — single `claudeGlobalMaestroWorkflow` (ID: `claude-maestro-global`) spanning all ensembles. Full inbox/outbox relay for third-party dashboards: 4 poll queries, 3 on-demand updates, 1 command relay. Daemon auto-starts it on boot. (#61)
- **Worker Daemon** — standalone background process (`src/daemon.ts`) running Temporal workers. Sessions are now pure MCP clients. Auto-starts on first use; PID at `~/.claude-tempo/daemon.pid`, logs at `~/.claude-tempo/daemon.log`. Managed via `claude-tempo daemon start|stop|status|logs`. (#57)
- Beta release workflow — prerelease tags publish to npm `beta` dist-tag.

### Changed

- Sessions no longer run in-process Temporal workers — all worker duties delegated to the daemon.

## [0.18.0] - 2026-04-06

### Added

- **Pipeline Stages** — Conductors can track fan-out/fan-in of parallel work via `stage`, `stages`, and `cancel_stage` tools. Define a stage with player names, cue the players, and the workflow auto-notifies when all players report. Supports `halt` (fail on first blocker) and `continue` (wait for all) failure policies. (#26)

### Fixed

- Ensemble MCP tool now displays `(blocked)` status tag (was already detected but not rendered)

## [0.17.1] - 2026-04-05

### Fixed

- **`load_lineup` conductor section** — `load_lineup` MCP tool now correctly applies the `conductor` section of YAML lineups, recruiting the conductor player as expected (#48)

## [0.17.0] - 2026-04-05

### Added

- **Maestro workflow** — durable `claudeMaestroWorkflow` that runs alongside the conductor, monitoring ensemble state in real time: tracks player joins/leaves, status changes (`active`/`stale`/`blocked`), and part updates. Accessible via Maestro signals/queries/updates (#45)
- **`scanEnsembleSessions` shared helper** — centralises Temporal ensemble querying, used by both the Maestro workflow and the `ensemble` MCP tool
- **Branch coordination rules** — conductor and player instructions injected at server startup, reminding conductors to provision worktrees and players to check their assigned branch before starting work
- **Wire protocol** — Maestro workflow signals, queries, and updates documented in `docs/WIRE-PROTOCOL.md`

## [0.16.3] - 2026-04-05

### Fixed

- **Copilot bridge graceful shutdown** — Bridge process now watches workflow status via Temporal query and terminates cleanly when the session ends, fixing a PID file leak on exit (#13)

## [0.16.2] - 2026-04-05

### Fixed

- **Flaky CI test** — `saveLineup` test now waits for Temporal search index to index the new workflow before querying, fixing a race condition that caused intermittent CI failures

## [0.16.1] - 2026-04-05

### Fixed

- **Conductor false-blocked detection** — `commandSignal` handler now updates `lastOutboundTime`, preventing conductors from being incorrectly marked `blocked` when processing Maestro commands
- **Docs** — Added `broadcast` and `encore` CLI commands to README reference table

## [0.16.0] - 2026-04-05

### Added

- **`blocked` session status** — Sessions that receive delivered messages but produce no outbound activity for 5+ minutes are automatically marked `blocked`. Auto-recovers to `active` when the session resumes output. Blocked sessions are excluded from broadcast (#34)

### Fixed

- **Encore session UUID** — Encore previously passed the player name to `--resume`, which triggers an interactive picker when multiple Claude Code sessions share a name. Now generates a UUID at recruit time (`--session-id`) and uses it for deterministic `--resume` on encore. Falls back to player name for legacy sessions (#44)

## [0.15.0] - 2026-04-05

### Added

- **`worktree` MCP tool** — Conductors can provision isolated git worktrees for players. `create` checks out a new branch in a sibling directory, installs dependencies, and notifies the player with the path; `remove` cleans up the worktree after the task completes and notifies the player; `list` shows all active worktree assignments. Worktree state is stored in the conductor workflow (`WorktreeEntry`) and survives `continueAsNew`. Cross-machine worktrees are not supported — conductor and player must be on the same host (#36).

### Changed

- Lineup player schema no longer accepts `isolation`/`branch` fields — worktree provisioning is now done via the `worktree` tool at the conductor level rather than inline at lineup load time

## [0.14.0] - 2026-04-05

### Added

- **Worktree isolation** — Lineup players support `isolation: worktree` (with a required `branch` field). When set, `load_lineup` auto-creates a git worktree and runs `npm install` before recruiting (#36)

### Fixed

- **`down` command scoping** — The `down` command previously ignored the ensemble argument and terminated all running workflows across all ensembles. Now filters by `ClaudeTempoEnsemble` search attribute and validates the ensemble name to prevent query injection (#37)

## [0.13.1] - 2026-04-05

### Fixed

- **Conductor naming** — Four locations hardcoded `'conductor'` as the player name, ignoring lineup and CLI overrides. Conductor name now flows correctly through `schema → loader → CLI → server`. Also fixes a latent bug where default conductors were unnecessarily prompted to call `set_name` (#39)

## [0.13.0] - 2026-04-05

### Added

- **Quality Gates** — Conductors can define named checklists of pass/fail criteria to track task completion. Three new MCP tools: `quality_gate` (create or replace a gate), `evaluate_gate` (mark criteria as passed or failed), and `gates` (list all gates, filterable by task or status). Gate aggregate status is derived automatically: all passed → `passed`; any failed → `failed`; otherwise `open`. Gates survive `continueAsNew`.

## [0.12.0] - 2026-04-05

### Added

- **Cron schedule support** — The `schedule` tool now accepts a `cron` parameter (e.g. `"0 9 * * 1-5"`) alongside an optional `timezone` (IANA, e.g. `"America/New_York"`). Cron schedules use `croner` for expression parsing and next-fire computation. `ScheduleEntry.type` gains a new `'cron'` value; `cronExpression` and `timezone` fields are stored on the entry.
- **`allowedTools` agent type frontmatter** — Agent type `.md` files may include an `allowedTools` array to restrict which tools a recruited session can use. Resolved by `agent_types` and passed through `RecruitOutboxEntry` to the spawn activity, which appends `--allowedTools` to the Claude Code launch command. The type's value is authoritative and overrides any lineup-level setting.

### Fixed

- **`at` + `every` schedule combination** — Specifying both `at` and `every` now correctly returns a validation error ("provide exactly one timing option") instead of silently ignoring `at`.

## [0.11.1] - 2026-04-05

### Changed

- Version bump to correct release sequencing — `0.11.0` was published prematurely (before the feature PR merged). This `0.11.1` release contains all the same changes as the intended `0.11.0` and is the canonical release of the broadcast/encore/recall feature set.

## [0.11.0] - 2026-04-05

### Added

- **`broadcast` MCP tool** — Send a message to all active players in the ensemble with a single call. Fan-out is implemented via outbox entries, so each delivery is individually durable. Optional `type` parameter limits recipients to a specific player type (e.g., `"tempo-soloist"`). Optional `includeStale` flag extends delivery to stale sessions (pending and terminated sessions are always excluded).
- **`encore` MCP tool** — Revive a stale player session. Restarts the Claude process and reconnects to the existing Temporal workflow, restoring recent message context (configurable via `contextMessages`, default 10). Validates session status before submitting — returns a clear error if the target is active (use `cue`), pending (wait), or terminated (use `recruit`). Cross-machine encore supported via the optional `host` parameter.
- **`recall` MCP tool** — Read your own message history from the Temporal workflow. Returns received messages by default (newest first, limit 20). Supports `includeSent: true` for a merged sent/received timeline, plus `limit` (max 100), `since` (ISO timestamp), and `from` (sender name) filters.
- **`EncoreOutboxEntry` type** — New outbox entry type (`type: 'encore'`) carrying `targetPlayerId`, optional `targetHostname`, and optional `contextMessageCount`. Processed by the outbox dispatch loop via a new encore activity.

## [0.10.0] - 2026-04-04

### Added

- **Player types** — Reusable agent definitions using Claude Code's standard subagent format (`.md` files with YAML frontmatter). Ensemble lineups can reference player types by name via a `type` field on players.
- **Three-tier agent type lookup** — project (`.claude/agents/`) → user (`~/.claude/agents/`) → shipped (`examples/agents/`). If found in Claude Code's standard dirs, recruits use `--agent <name>`; shipped examples fall back to `--system-prompt <path>`.
- **`who_am_i` MCP tool** — Players can query their own identity: name, player type, description, ensemble, role (conductor/player), recruited by, current part, directory, host, branch, and status.
- **`agent_types` MCP tool** — Conductors can discover available player types with name, description, and source (project/user/shipped).
- **`recruit` tool `type` parameter** — Recruit with `type: "tempo-composer"` to spawn a session using a predefined agent definition. Resolves and validates the type, passes through to the spawn flow.
- **Player identity in metadata** — `playerType`, `playerTypeDescription`, and `recruitedBy` fields on `SessionMetadata`, persisted in Temporal workflows and search attributes.
- **`ensemble` tool shows player types** — Output includes player type in parens, e.g., `**arch** (architect)`.
- **CLI `agent-types` command** — `list` (show available types), `show <name>` (print full definition), `init` (copy shipped examples to `~/.claude/agents/` for customization).
- **Saver preserves player types** — `save_lineup` includes `type` field in saved YAML for typed players.
- **Shipped player types** — 8 music-themed agent definitions: tempo-conductor (coordinator), tempo-composer (architect), tempo-soloist (engineer), tempo-tuner (QA), tempo-critic (reviewer), tempo-roadie (devops), tempo-improv (researcher), tempo-liner (documentation). All include opinionated Ensemble Collaboration sections with claude-tempo tool usage patterns.
- **Shipped ensemble lineups** — 4 pre-built team compositions: tempo-big-band (flagship full-lifecycle with all 8 player types, 6-phase pipeline), tempo-dev-team (feature development), tempo-review-squad (parallel code review), tempo-jam-session (exploratory/spike work).

### Changed

- `load_lineup` tool and `up --lineup` CLI now resolve player type references via `loadAndResolveLineup()`.
- MCP server instructions now include player type info when available.
- `examples/` directory included in npm package.

### Migration

- **Backward compatible**: the `type` field on players is optional. Existing lineups without `type` work unchanged. Players recruited without a type behave exactly as before.

## [0.9.0] - 2026-04-04

### Added

- **Outbox pattern** — MCP tools (`cue`, `report`, `stop`, `recruit`) no longer signal other workflows directly. Instead, they submit entries to the session's own workflow outbox via `executeUpdate`. A dispatch loop processes entries through activities, decoupling tools from cross-workflow signaling.
- **Cross-machine recruiting** — the `recruit` tool now accepts an optional `host` parameter to spawn sessions on a remote machine. Spawn activities are routed to per-host task queues (`claude-tempo-{hostname}`).
- **Per-host task queues** — dual worker architecture: a shared `claude-tempo` queue (workflows + delivery activities) and a per-host `claude-tempo-{hostname}` queue (`spawnProcess` activity only).
- **Outbox activity layer** (`src/activities/outbox.ts`) — `deliverCue`, `deliverReport`, `terminateSession`, `startRecruitedSession`, and `spawnProcess` activities handle all cross-workflow delivery.
- **`submitOutbox` workflow update** and **`outbox` query** for inspecting outbox state.

### Changed

- `cue`, `report`, `stop`, and `recruit` tools simplified — each is now validation + a single `executeUpdate` call.
- `report` tool no longer requires `client`, `config`, or `getPlayerId` parameters.
- `recruit` tool no longer spawns processes or polls for startup directly — this is handled asynchronously by the outbox dispatch loop.
- Outbox entries carry through `continueAsNew` (pending/processing entries only).

### Migration

- **Backward compatible**: all existing signals (`receiveMessage`, `playerReport`, `updateMetadata`, etc.) are preserved. Old clients can still signal workflows directly alongside the new outbox path.

## [0.8.0] - 2026-04-04

### Added

- **Pre-created workflows for recruits** — the conductor now creates the recruit's Temporal workflow with the initial message pre-loaded before spawning the process. This eliminates the race condition where slow-starting sessions (e.g., delayed by the dev channels prompt) would miss their initial instructions.
- **Session status lifecycle** — sessions now have a `status` field (`pending` → `active` → `stale`). Stale sessions stay alive instead of being terminated, preserving workflow state for resume. Status is visible via `ClaudeTempoStatus` search attribute in Temporal UI.
- **Windows Terminal tabs** — on Windows, recruited sessions open as new tabs in the current Windows Terminal window instead of separate cmd.exe windows. Tab titles show the player name.
- **`updateMetadata` signal** — sessions signal updated metadata (hostname, git info, status) when connecting, enabling conductor-created workflows to be updated with runtime details.

### Changed

- **Renamed `terminate` MCP tool to `stop`** — aligns with the CLI `stop` command. Both now use the same `updateMetadata({ status: 'terminated' })` mechanism.
- **Unified shutdown path** — removed the separate `shutdownSignal`. All shutdown (MCP `stop`, CLI `stop`, SIGINT) goes through `status: 'terminated'`. The workflow adds a termination message, waits for delivery, then completes.
- `claude-tempo status` now shows `(pending)` and `(stale)` indicators next to player names.
- Stale session detection no longer terminates workflows — marks status as `stale` instead.
- Pre-created workflows in `pending` status automatically transition to `stale` if the session doesn't connect within 3 minutes.


## [0.7.0] - 2026-04-04

### Added

- **Ensemble lineups** — define reusable ensemble configurations as YAML files with players, instructions, schedules, and custom agents. Lineups can be loaded from the CLI (`claude-tempo up --lineup`), from inside a session (`load_lineup`), or saved from a running ensemble (`save_lineup`).
- **`save_lineup` MCP tool** — snapshot the current ensemble state (players, schedules) as a YAML lineup file. Conductor only.
- **`load_lineup` MCP tool** — load a lineup to recruit players sequentially and create schedules. Accepts a saved lineup name or explicit file path.
- **`claude-tempo up --lineup`** — load an ensemble lineup during first-time setup.
- **`claude-tempo ensemble` CLI commands** — `save`, `list`, and `show` subcommands for managing saved lineups in `~/.claude-tempo/ensembles/`.
- **`systemPrompt` parameter on recruit tool** — pass a path to a `.md` file to use as the session's custom agent system prompt (`--system-prompt`). Enables custom agent files in lineups.
- **`target: "all"` schedule fan-out** — schedules can target `"all"` to deliver a message to every active player in the ensemble, skipping the conductor. Individual delivery failures are reported without failing the whole fire.

## [0.6.0] - 2026-04-03

### Added

- **Scheduling** — new `schedule`, `unschedule`, and `schedules` MCP tools for dynamic message scheduling. Supports one-shot delays (`delay: "10m"`), fixed times (`at: "2026-04-04T01:00:00Z"`), and recurring intervals (`every: "1h"`) with optional bounds (`until`, `count`). Uses a single durable `claudeSchedulerWorkflow` per ensemble with Temporal timers and `continueAsNew`. Scheduled messages use `[scheduled: name]` prefix and set `from` to the creator for natural reply semantics. Includes `isScheduled` metadata for dashboard integrations.
- **Schedule failure notifications** — when a target player is not found at fire time, the schedule creator is notified. Falls back to the conductor if the creator is also unavailable.
- **`claude-tempo status` shows schedules** — the status command now displays active schedules alongside session info per ensemble.

### Fixed

- **Recruited sessions no longer rename themselves** — the recruit tool previously sent a redundant `set_name` instruction via signal, which could cause the LLM to rename itself incorrectly if confused by concurrent messages. The name is now fully set via env var at startup, and MCP instructions tell pre-named sessions not to call `set_name`.

## [0.5.0] - 2026-04-03

### Fixed

- **Session discovery uses metadata queries instead of search attributes** — ensemble listing, session resolution, and CLI status/stop commands now query workflow metadata directly instead of relying on custom search attributes (`ClaudeTempoEnsemble`, `ClaudeTempoPlayerId`), which are eventually consistent and could be stale or missing. This fixes a bug where sessions (particularly conductors reconnecting via `WorkflowIdConflictPolicy.USE_EXISTING`) were invisible to the ensemble.
- **Recruit env var leakage** — recruited sessions no longer inherit the parent's `CLAUDE_TEMPO_CONDUCTOR` and `CLAUDE_TEMPO_PLAYER_NAME` env vars. Previously, a conductor recruiting a player would pass its own identity to the child, causing it to think it was the conductor.
- **Recruit sets `PLAYER_NAME`** — the recruit tool now passes the requested name via env var so the spawned session starts with the correct identity immediately, rather than relying on a `set_name` message the LLM may not act on.
- **"conductor" name collision guard** — non-conductor sessions are prevented from using "conductor" as a player name, which would collide with the conductor's deterministic workflow ID.
- **Terminate uses graceful shutdown** — the `terminate` tool now sends a shutdown signal instead of force-killing the workflow, and notifies the target session before shutting it down.
- Workflow upserts all search attributes at startup to keep the Temporal UI accurate, even when reconnecting to an existing workflow.

### Added

- **`conduct --resume` / `--replace`** — when a conductor is already running, `claude-tempo conduct` now requires an explicit choice: `--resume` reconnects to the existing workflow and resumes the Claude Code conversation, `--replace` stops the existing conductor and starts fresh.
- **`conductor` parameter on recruit tool** — explicitly controls whether the recruited session is a conductor, rather than relying on env var inheritance.
- **Test suite** — 33 tests using Temporal's `TestWorkflowEnvironment` with mocha. Covers workflow lifecycle, signals, queries, conductor behavior, multi-session ensemble discovery, session resolution after rename, conductor resume/replace, workflow ID collision, and end-to-end coordination scenarios.

### Changed

- Upgraded `@temporalio/*` packages from 1.11.7 to 1.15.0.
- Upgraded mocha to v11.

### Removed

- `sanitizeQueryValue` helper (no longer needed — visibility queries no longer include user-supplied values).

## [0.4.1] - 2026-04-02

### Added

- **`isMaestro` message flag** — messages sent from the Maestro dashboard carry `isMaestro: true`, signaling to agents that a human sent the message. Agents automatically receive an instruction to acknowledge receipt and share their planned next step.
- **Heartbeat probe** for orphaned session detection — workflows inject a `_ping` message after 1 hour of inactivity; if undelivered within the stale window, the session exits.
- **`stop` command** — stop sessions by name (`-n`), by ensemble, or all at once (`--all`). Sends graceful shutdown signals and cleans up bridge PID files.
- **`defaultAgent` config** — set a default agent type (`claude` or `copilot`) via `claude-tempo config set default-agent copilot`, `CLAUDE_TEMPO_DEFAULT_AGENT` env var, or `--agent` flag.
- **Global MCP registration** — `claude-tempo init` now registers globally via `claude mcp add` (use `--project` for per-directory `.mcp.json`).

### Changed

- Removed 24-hour workflow execution timeout — workflows now live until shutdown signal or stale detection.
- `continueAsNew` triggers only on `continueAsNewSuggested` (Temporal best practice), not arbitrary history length.
- `down` command now cleans up bridge PID files and removes both global and project-level MCP config.
- Revamped experimental Copilot CLI section in README to focus on CLI commands.

### Fixed

- `isGlobalMcpRegistered` uses word-boundary regex to avoid false-positives on similarly-named MCP servers.
- `defaultAgent` validated from all sources (env var, config file) — invalid values fall back to `claude`.

## [0.3.0] - 2026-04-01

### Added

- **`config` command** — interactive setup for Temporal connection settings (`claude-tempo config`), plus `config set` / `config show` for scripting. Settings persist in `~/.claude-tempo/config.json`.
- **Temporal Cloud support** — configure address, namespace, and API key via `config`, env vars, or CLI flags.
- **Temporal CLI config fallback** — reads `~/.config/temporalio/temporal.yaml` automatically so existing Temporal CLI users don't need to reconfigure.
- **`connection` subpath export** — `claude-tempo/connection` exposes `createTemporalConnection` for external consumers.
- **Agent type in session metadata** — `agentType` field on `SessionMetadata`; displayed as `[copilot]` tag in `status` and `ensemble` output.
- **Recruit inherits agent type** — Copilot sessions recruit copilot agents by default; Claude sessions recruit claude agents.
- **Config source display** — `config show` displays which source each value came from (flag, env, config, temporal-cli, default).

### Changed

- README overhauled for clarity: installation, quick start, core concepts, CLI reference, MCP tools, conductors, players. Copilot bridge docs collapsed into a `<details>` block.
- `-d` shorthand now maps to `--dir` (was `--background`).

### Fixed

- Child processes always receive `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` env vars, even when they match defaults.
- `recruit` forwards Temporal address and namespace to child sessions.
- Copilot bridge clears parent env vars (`CLAUDE_TEMPO_PLAYER_NAME`, `BRIDGE_MODE`, `CONDUCTOR`) when spawning children.
- Config file permissions set to `0600` on Unix (matches credential file conventions).
- TLS fallback uses `tls: true` for API key auth instead of `tls: {} as any`.

## [0.2.0] - 2026-03-31

### Added

- **Copilot CLI bridge** — GitHub Copilot CLI sessions can now join ensembles via the `@github/copilot-sdk`. The bridge spawns a Copilot session with claude-tempo as an MCP server and polls Temporal for messages.
- `--agent <claude|copilot>` CLI flag for `start` and `conduct` commands to select the agent backend.
- `agent` parameter on the `recruit` tool to spawn Copilot players from within an ensemble.
- Shell shortcuts for launching Copilot bridge sessions (documented in README).
- Session crash recovery — bridge tracks consecutive failures and attempts to recreate the Copilot session (up to 2 times) before exiting.
- `createSession` timeout (45s) prevents indefinite hangs on auth/network failures.
- PID file (`logs/{name}.pid`) for detached bridge processes, cleaned up on graceful shutdown.
- `engines` field in package.json (`node >=18`); Copilot features require Node 20+.
- `repository` field in package.json for npm package page linking.

### Changed

- `recruit` tool description updated to mention Copilot support.
- Bridge uses deterministic workflow IDs via `CLAUDE_TEMPO_PLAYER_NAME` env var, eliminating the time-window heuristic that could misidentify workflows when multiple bridges start simultaneously.

### Fixed

- Missing `TEMPORAL_ADDRESS` env var when `recruit` spawns a copilot bridge subprocess.
- `sessionAlive` flag now resets to `true` on successful interactions (was permanently stuck on `false` after transient errors).
- `process.env` spread no longer uses unsafe `as Record<string, string>` cast; undefined values are filtered out.
- Log file descriptor leak in CLI — `closeSync` now runs in a `finally` block so the fd is closed even if spawn fails.
- Lockfile inconsistency — `@github/copilot-sdk` correctly listed only in `optionalDependencies`.
- `--agent` flag documented for both `start` and `conduct` in README (was listed as "start only").

### Security

- Documented why `approveAll` permission handler is used in the bridge (headless session with no interactive terminal).

## [0.1.3] - 2026-03-28

### Added

- Explicit package exports for `types`, `config`, `spawn`, and `signals` subpaths.

## [0.1.2] - 2026-03-27

### Added

- CLI tool (`claude-tempo`) with commands: `up`, `conduct`, `start`, `status`, `server`, `init`, `down`, `preflight`.
- Cross-platform terminal spawning (Windows, macOS, Linux).

### Fixed

- Windows terminal spawning and npx MCP resolution.
- Player naming via `CLAUDE_TEMPO_PLAYER_NAME` env var.

## [0.1.1] - 2026-03-26

### Added

- Outbound message tracking (`recordSentMessage` signal, `allSentMessages` query).
- Stale session detection toggle (`disableStaleDetection` input flag).
- Conductor history persistence across `continueAsNew`.

### Fixed

- Server skips Temporal connection when `CLAUDE_TEMPO_ENSEMBLE` is not set.

## [0.1.0] - 2026-03-25

### Added

- Initial release: MCP server for multi-session Claude Code coordination via Temporal.
- Workflow-backed sessions with signals (`receiveMessage`, `setPart`, `setName`, `shutdown`) and queries (`getPart`, `getMetadata`, `pendingMessages`).
- Tools: `ensemble`, `cue`, `set_name`, `set_part`, `listen`, `recruit`, `report`, `terminate`.
- Conductor role with command/report history.
- Channel-based message delivery for Claude Code sessions.
