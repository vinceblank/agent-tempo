# ADR 0016 — `claude --bg` agent-view integration (experimental opt-in spawn mode)

- **Status**: Accepted (experimental — gated behind `experimental: { spawn: true }` in lineup schema)
- **Date**: 2026-05-16
- **Authors**: tempo-architect (with research by tempo-researcher)
- **Related**: issue #596 (spike), branch `worktree-spike-bg-spawn` (commit `fd1f3d44`), [`docs/research/596-bg-spawn-research.md`](../research/596-bg-spawn-research.md) (canonical findings), ADR 0011 (player saveable state — alternate restart-context path)

## Context

Today every recruited interactive `claude-code` player opens a terminal window via `spawnInTerminal` (`src/spawn.ts`). A 7-player ensemble spawns 7 windows. The window-management overhead is the most-cited daily friction reported by ensemble operators with >3 active players.

Anthropic ships a per-user **Claude Code supervisor** with a publicly-readable on-disk surface:

- `~/.claude/daemon/roster.json` — versioned `proto: 1` roster of all supervisor-owned jobs
- `~/.claude/jobs/<short>/state.json` — per-job liveness (`state`, `detail`, `inFlight`, `updatedAt`, `firstTerminalAt`)
- `~/.claude/jobs/<short>/timeline.jsonl` — append-only state-transition log
- `~/.claude/projects/<encoded-cwd>/<full-uuid>.jsonl` — standard Claude Code transcript

The supervisor is invokable via three stable CLI verbs: `claude --bg <args>` (spawn), `claude attach <short>` (TTY-interactive only), `claude stop <short>` (graceful stop). `claude agents` is an ink TUI and **rejects `--json`** — Agent View is not a scriptable CLI surface. The world-readable JSON files are the only programmatic surface, but they are versioned and stable across the four CLI upgrades observed in `~/.claude/daemon.log` (2.1.140 → 2.1.143).

Researcher confirmed the supervisor self-restarts when the `claude` binary's mtime changes (auto-upgrade) and **re-adopts existing jobs** across the restart (daemon log: `bg adopt: adopted=N dead=M`). Since our adapter's MCP/Temporal channel is orthogonal to the pty, cue/report/recall continue uninterrupted across `claude` upgrade — a property `spawnInTerminal` cannot offer.

Spike at `fd1f3d44` (3 files, +63/-3) feature-gates `spawnInTerminal` → `spawnClaudeBg` behind `CLAUDE_TEMPO_BG_SPAWN=1`. The spike compiles but was never live-tested; this ADR graduates it to a real, opt-in, experimental product feature.

### Hard blocker surfaced by research

`claude --bg --resume <uuid>` **silently drops the resume** and spawns a fresh UUID. The dispatch's `launch.mode` in roster.json comes back as `"prompt"`, not `"resume"`. Implication: a restart with `transcript: 'replay'` loses prior context under `--bg`. This is a present-day limitation of Anthropic's CLI.

## Decision

**Graduate as experimental, opt-in, lineup-gated.** Restart-with-replay under `bg` returns an explicit error rather than silently degrading.

The full design is recorded inline below; six locked answers + a single-PR implementation plan + a documented restart-replay constraint.

### Q1: Spawn / discoverability — ~~pre-assigned UUID~~ stdout discovery (ERRATUM 2026-05-16)

> **Erratum (live-E2E discovery)**: the original `--session-id <uuid>` pre-assignment plan is **empirically broken on `claude 2.1.140`**. The supervisor ignores `--session-id` under `--bg`, emits the warning `"--bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)"`, and assigns its own UUID. Alternative #6 below ("stdout-parse the supervisor's `backgrounded · <short>` line"), originally rejected, is now the implemented design.
>
> **Implemented plan**:

- `claude --bg` is invoked WITHOUT `--session-id` (the supervisor would warn and ignore it anyway).
- `spawnClaudeBg` (`src/spawn.ts`) captures stdout and regex-parses the supervisor's adoption banner (`backgrounded · <8-hex-shortId> (idle …)`, regex exported as `BG_SHORT_ID_PATTERN`).
- The spawn activity (`src/activities/outbox.ts:spawnProcess`) calls `updateMetadataSignal({ spawnMode: 'bg', bgShortId })` on the target workflow once the parse returns.
- `SessionMetadata.bgFullUuid` is **unused** under stdout discovery (no API takes the full UUID under `--bg`; the supervisor's full UUID lives in `roster.json` if anyone ever needs it).
- `destroy` on a bg-spawned session reads `metadata.bgShortId` and fires a `claudeStop` activity (`src/activities/claude-stop.ts`). Per-host `hardTerminateAttachment` remains the fallback when `bgShortId` is absent (parse failed at spawn time) or when `claude stop` returns a non-`already-gone` error.
- If `spawnClaudeBg` returns `shortId: undefined` (banner missing or supervisor surface drift), `spawnProcess` throws an `ApplicationFailure.nonRetryable` carrying the captured stdout diagnostic so the operator can file an upstream-surface-drift bug.

### Q2: Permission preflight — dry-run probe with daemon-lifetime cache

- Probe via `claude --bg --dangerously-skip-permissions --help` against the target cwd, parse stderr/exit code. The supervisor's bypass-consent record is not transparently readable on disk (not in `~/.claude/settings*.json`, not in `~/.claude/projects/`), so a behavioral probe is more robust than reading internal state.
- Cache `(host, cwd) → ok` in an in-process `Map` on the per-host worker for the daemon lifetime. Probe once per cwd per daemon boot; subsequent recruits in the same cwd skip the probe.
- On probe failure, surface an actionable error: `"Run 'claude' once in <cwd> and accept the permission dialog, then retry recruit."`

### Q3: Restart semantics — explicit error, no silent degradation

- `transcript: 'replay'` + `spawnMode: 'bg'` on `restart` → `ApplicationFailure.nonRetryable('BgSpawnReplayUnsupported')` with message: `"claude --bg cannot resume prior context (upstream CLI limitation: --resume is silently dropped under --bg, see docs/ops/bg-spawn.md). Use loadFromState or transcript: 'none'."`
- `loadFromState: true | 'key'` (ADR 0011) works unchanged — delivered as a system-identity cue, not via `--resume`. This is the recommended restart-context path under `bg`.
- `transcript: 'none'` works unchanged — fresh session.
- Gate the new error path behind a workflow `patched('v1.x-bg-restart-guard')` marker so it lands cleanly on rolling deploy.

### Q4: Backward compat — lineup-level with per-player override, gated by experimental block

```yaml
# Top-level, sibling of `name`, `description`, `players`
experimental:
  spawn: true     # required to opt into bg spawn mode; absence = block enforcement

spawn: bg         # lineup-wide default (only legal when experimental.spawn === true)

players:
  - name: tempo-conductor
    type: tempo-conductor
    spawn: terminal   # per-player override
```

- Precedence: per-player `spawn` > lineup `spawn` > built-in default `'terminal'`.
- Lineup loader rejects `spawn: bg` (at lineup or player level) unless `experimental.spawn === true`. Error: `"spawn: bg requires 'experimental.spawn: true' at the top of the lineup."`
- `experimental` is a generic block — future experimental knobs (`experimental: { foo: true }`) reuse the pattern.
- The `CLAUDE_TEMPO_BG_SPAWN` env var from the spike is **removed**. Experimental opt-in lives in the lineup, not the env.

### Q5: Cross-adapter scope — `claude-code` only

- `claude-code-headless` (#520) already runs without a terminal window — no benefit.
- `claude-api` / `opencode` are headless subprocesses we manage directly — the supervisor would conflict with our adapter lifecycle.
- Lineup loader emits a warning (not an error) if `spawn: bg` is set on a non-`claude-code` player; the field is silently ignored for those adapters.

### Q6: Liveness — adapter-authoritative, supervisor at boundaries

- Adapter heartbeat (`tickHeartbeat` / `tickPhaseWatcher` per #249) remains the source of truth for `ClaudeTempoAttachmentState`.
- Supervisor `state.json` is consulted only at three boundaries:
  - **Spawn**: verify supervisor accepted the session before workflow proceeds past `booting`.
  - **Restart**: verify supervisor still has the slot before re-spawn.
  - **Destroy**: check `state ∈ {done, killed}` after `claude stop` to confirm termination, before falling back to hard-terminate.
- **No background reconciliation loop** between supervisor state and adapter phase. Avoids dual-truth conflicts. The supervisor's `tempo: idle | active` field is noted as a future cross-check signal for `awaiting` vs `processing` but is out of scope for this ADR.

## Implementation plan — single PR

The spike at `fd1f3d44` is 3 files, +63/-3. Graduation adds approximately +400/-60 LoC across:

- `src/ensemble/schema.ts` — zod fields: top-level `experimental?: { spawn?: boolean }`, top-level `spawn?: 'bg' | 'terminal'`, per-player `spawn?: 'bg' | 'terminal'`
- `src/ensemble/loader.ts` — precedence resolver + experimental-gate enforcement
- `src/types.ts` — extend `RecruitOutboxEntry` with `spawnMode?: 'bg' | 'terminal'` (additive)
- `src/activities/outbox.ts` — UUID pre-assignment, branch on `spawnMode`, stash `fullUuid`/`shortId` on metadata, permission preflight + cache, remove `BG_SPAWN` env-var gate
- `src/spawn.ts` — finalize `spawnClaudeBg` (already exists from spike), thread `--session-id <uuid>` arg
- `src/activities/claude-stop.ts` (new) — `claude stop <shortId>` activity
- `src/tools/destroy.ts` — route to `claude stop` first when metadata indicates `bg`; fall back to existing `hard-terminate`
- `src/tools/restart.ts` + `src/workflows/session.ts` — restart-replay guard behind `patched('v1.x-bg-restart-guard')`
- `src/config.ts` — remove `ENV.BG_SPAWN`

Single PR keeps the wire-protocol additive change (`spawnMode` on `RecruitOutboxEntry`) atomic.

### Tests

1. **Unit** (`tests/`): lineup schema accepts/rejects `experimental.spawn` + `spawn` combinations correctly; precedence resolution (player > lineup > default).
2. **Unit**: `spawnClaudeBg` arg ordering (`--bg` first, then `--session-id <uuid>`, then user args), env-var passthrough.
3. **Integration** (Mocha, `test/`): recruit with `spawn: bg` → verify `metadata.shortId` and `metadata.fullUuid` populated, verify destroy invokes the `claude stop` activity (mocked) before `hard-terminate`.
4. **Integration**: restart guard — `spawn: bg` + `transcript: 'replay'` returns `ApplicationFailure.nonRetryable('BgSpawnReplayUnsupported')`.
5. **Live E2E** (manual, mandatory before merge — spike was never live-tested): recruit → cue → report → restart with `loadFromState` → destroy, on a real daemon against a real `claude --bg`-capable host. Document the sequence + outcomes in the PR description.

### Docs

- `docs/concepts.md` — add a "Spawn mode" subsection under Adapter
- `docs/WIRE-PROTOCOL.md` — document new `spawnMode` field on `RecruitOutboxEntry` (additive, not breaking)
- `docs/ops/bg-spawn.md` (new) — per-user supervisor dependency, `claude agents` usage, **prominent documentation of the `--bg --resume` limitation** (researcher's observed behavior: silently drops resume, spawns fresh UUID), vocabulary mismatch troubleshooting (`job` = supervisor noun, `session`/`player` = agent-tempo noun, `agent` = Agent View UI noun — all the same OS process)
- `README.md` — one-line mention in features list once the `experimental` gate drops in a future release

## Consequences

### Positive

- **Window-count problem solved** for the common case (recruit-then-keep-running). Operators with large ensembles get the one win they ask for daily.
- **Survives `claude` CLI upgrades.** Supervisor self-restart on binary-mtime change re-adopts existing jobs; our adapter's MCP/Temporal channel is orthogonal to the pty, so cue/report/recall continue uninterrupted across upgrade. This is strictly better than `spawnInTerminal`, which loses the pty on upgrade.
- **Free OS-level crash recovery** via the supervisor's per-job state machine.
- **Additive wire-protocol change** — old workflows keep working, no major-version bump.

### Negative

- **Restart-with-replay is unavailable under `spawn: bg`.** Documented loudly; `loadFromState` (ADR 0011) is the supported alternative for context preservation.
- **New surface dependency** on supervisor's on-disk JSON. Mitigated by versioned `proto: 1` parsing + behavioral CLI surface (not internal state) for actions.
- **Per-host destroy routing** required — `claude stop` is process-local. The destroy activity must run on the `agent-tempo-{hostname}` task queue, routed via the `AgentTempoHostname` search attribute. Adds no new failure mode (already required for spawn).

### Neutral

- `claude-code-headless`, `claude-api`, `copilot`, `opencode` adapters unchanged.
- `experimental` block establishes a reusable pattern for future opt-in features.

## Risks

- **Upstream CLI surface drift.** Anthropic could ship `proto: 2` for roster.json or rename the `claude --bg` flag. Mitigations:
  - Parse defensively, gate on `proto === 1`. Any other proto → log warning and fall through to direct PID tracking (graceful degradation; supervisor-invisible but functional).
  - Never write to `~/.claude/daemon/` ourselves — read-only consumption. Actions go through documented CLI verbs (`claude --bg`, `claude stop`).
  - Optional future hardening: CI smoke test that parses `roster.json` against the proto-1 schema. Defer until we get burned at least once.
- **Cross-platform socket-shape variance.** Researcher tested Windows (named pipes) only; macOS/Linux likely use Unix sockets in `rendezvousSock` / `ptySock`. Not blocking for this ADR — we never touch the sockets, only invoke CLI verbs and read top-level roster fields. Per-host adoption logic (if ever added) must read `rendezvousSock` opaquely, not parse its shape.
- **`claude stop` not idempotent on unknown short id** — returns exit 1 with `No job matching '<id>'`. Destroy activity must treat that exit as "already gone, success" not as a retryable failure.

## Alternatives considered

1. **Gate spike on upstream `--resume` fix (path a).** Rejected: punts indefinitely on a present-day pain point; we do not control Anthropic's release cadence; the spike is already written.
2. **Shelve indefinitely (path c).** Rejected: discards working code and leaves the window-count problem unsolved.
3. **Per-recruit `useBg: true` recruit arg** instead of lineup-level field. Rejected: most users want this lineup-wide; per-recruit is a leakier abstraction with no carrier for "all my interactive players are bg by default."
4. **New adapter type `claude-code-bg`.** Rejected: explodes the adapter matrix, complicates `who_am_i` semantics; `spawn:` mode is orthogonal to adapter identity.
5. **Auto-degrade restart-replay to `terminal`** for that one restart. Rejected: silent mode-switch violates user intent; explicit error is more honest.
6. **Stdout-parse the supervisor's `backgrounded · <short>` line** to discover short id. ~~Rejected in favor of `--session-id <uuid>` pre-assignment — eliminates a parse step and lets the workflow own session-id allocation.~~ **Adopted as implemented design** (see Q1 erratum above) — pre-assignment is empirically broken on `claude 2.1.140`.
7. **File upstream bug at `anthropics/claude-code` for `--bg --resume` drop.** Out of scope per vinceblank — document the observed behavior in `docs/ops/bg-spawn.md` and move on.

---

🎼 *Authored by tempo-architect of the tempo-impl ensemble for @vinceblank.*
