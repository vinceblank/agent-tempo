# Dev mode

claude-tempo's `--dev` flag flips four isolation axes at once so a developer
(human or AI) can spin up a sealed environment with **zero blast radius** on
the production daemon:

| Axis                  | Production default                    | Dev profile default                     |
| --------------------- | ------------------------------------- | --------------------------------------- |
| Home dir              | `~/.claude-tempo/`                    | `~/.claude-tempo-dev/`                  |
| HTTP port             | `8473`                                | `8474`                                  |
| Temporal namespace    | `default`                             | `claude-tempo-dev`                      |
| Task queue            | `claude-tempo`                        | `claude-tempo-dev`                      |

Design references: [ADR 0014](adr/0014-dev-mode-mock-adapter.md) and
[design/dev-mode-mock-adapter.md](design/dev-mode-mock-adapter.md).

## Quickstart

```bash
# Start the dev daemon — auto-creates the claude-tempo-dev namespace,
# binds 127.0.0.1:8474, writes its PID to ~/.claude-tempo-dev/daemon.pid.
$ claude-tempo --dev daemon up

# Recruit a mock player (requires --dev — see "Mock adapter" below).
$ claude-tempo --dev recruit alice \
    --workDir /tmp/dev-scratch \
    --agent mock \
    --mockMode scripted \
    --mockScenario echo-roundtrip

# Drive it.
$ claude-tempo --dev cue alice "hello"

# Open the dashboard (separate port from prod).
$ claude-tempo --dev dashboard

# Tear down. Production daemon at ~/.claude-tempo/ on :8473 is untouched.
$ claude-tempo --dev daemon stop
```

The `--dev` flag is **top-level** — it parses before the verb dispatch, so
every existing command (`recruit`, `cue`, `ensemble`, `dashboard`, …) works
in dev mode without per-command plumbing.

## What the `[DEV MODE]` banner means

Every dev-mode CLI invocation prints one line to stderr:

```
[DEV MODE] using ~/.claude-tempo-dev · port 8474 · namespace claude-tempo-dev · queue claude-tempo-dev
```

The dev daemon also writes the same line to `~/.claude-tempo-dev/daemon.log`
on startup. Grep the log for `DEV MODE` to confirm a daemon is running the
right profile. ADR 0014 §7 names this "gate 4" of the production-safety
defense in depth.

## Mock adapter (PR-2 of #340-followup)

The mock adapter is a dev-mode-only fixture for autonomous validation
harnesses — dashboard tests, wire-protocol regression checks, replayable
scenario playback. It posts every action through the standard outbox surface
(`cue` / `report` / `recruit` / `release`) so phase transitions, processing
windows, and SSE events look identical to a real Claude / Copilot session.

```bash
# Bare-name scenario resolution — picks scenarios/echo-roundtrip.yaml
$ claude-tempo --dev recruit alice --agent mock --mockMode scripted --mockScenario echo-roundtrip
```

Four modes (PR-2 shipped `echo` + `scripted`; PR-3 added `silent` + `chaos`):

- `mockMode: echo` (default) — replies `[ECHO] <text>` to the sender.
- `mockMode: scripted` — loads a scenario YAML and dispatches matching rules.
- `mockMode: silent` — drains `pendingMessages` (so the workflow doesn't
  accumulate state) but never enqueues an outbox reply. Use it to validate
  heartbeat-stale detection: the player should transition to `awaiting`
  after the staleness threshold (#249) and the dashboard should render the
  staleness indicator.
- `mockMode: chaos` — probabilistic failure injection. Configurable via env
  vars on the daemon process (inherited by every spawned mock subprocess):

  ```
  CLAUDE_TEMPO_MOCK_CHAOS_DELAY_MS=<n>     # fixed delay before each reply (ms)
  CLAUDE_TEMPO_MOCK_CHAOS_FAIL_RATE=<0..1> # probability of throwing per message (default 0.05)
  CLAUDE_TEMPO_MOCK_CHAOS_CRASH_RATE=<0..1> # probability of process.exit(1) per message (default 0.01)
  CLAUDE_TEMPO_MOCK_CHAOS_SEED=<int>       # PRNG seed (default Date.now())
  ```

  Crash takes precedence over fail when both rates resolve true on the same
  message. Each message consumes two PRNG draws regardless of outcome so a
  pinned `CHAOS_SEED` produces the same fail/crash sequence run-over-run.
  `chaos` mode echoes back as `[CHAOS-OK] <text>` (vs the plain
  `[ECHO] <text>` from echo mode) so dashboards can distinguish the two
  surfaces in a mixed-mode lineup.

### Scenario library

Three reference scenarios ship in the npm tarball at `<package>/scenarios/`:

```bash
$ claude-tempo --dev scenarios list
$ claude-tempo --dev scenarios show echo-roundtrip
```

| Scenario                     | Purpose                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `echo-roundtrip`             | Smallest possible scripted scenario — every inbound returns `[ECHO] $message`.      |
| `two-player-conversation`    | Cross-player coordination — alice asks bob about a topic, reports an update.        |
| `conductor-recruit-mock`     | Conductor-mock recruits a sub-player on demand. Validates recruit→spawn→claim.      |
| `multi-player-handoff`       | Three-way handoff (alice → bob + carol). Exercises orchestration depth.             |
| `recruit-cascade`            | Chain-recruit stress test — issues `recruit` outbox entries on demand.              |

See [`src/adapters/mock/README.md`](../src/adapters/mock/README.md) for the
full scenario format, action set, and `__MOCK__:` cue-prefix directive.

### One-command stack-up — `tempo-mock-jam` lineup

`examples/ensembles/tempo-mock-jam.yaml` ships a pre-baked all-mock ensemble
that exercises every PR-3 mode. Spin it up with one command:

```bash
$ claude-tempo --dev up --lineup tempo-mock-jam
```

The lineup recruits four mock players with mixed modes — `alice` (scripted,
multi-player-handoff), `bob` (echo), `silent-witness` (silent),
`chaos-monkey` (chaos). The conductor stays on the default agent so a human
or AI operator can drive the ensemble normally.

**Override the scripted player's scenario per-run** with the top-level
`--scenario` flag:

```bash
$ claude-tempo --dev up --lineup tempo-mock-jam --scenario echo-roundtrip
```

`--scenario` forces every `agent: "mock"` player in the loaded lineup into
`mockMode: "scripted"` with the named scenario regardless of per-player
`mockMode` declarations. Bare names (resolved against shipped `scenarios/`)
or absolute paths both work. Dev-mode-only — silently no-ops outside dev
mode because mock players can't exist there anyway (gate 3).

## Production safety

ADR 0014 §7 specifies four independent gates. **All four must fail** for
the mock adapter to talk to a prod ensemble:

1. **Build-time exclusion** (`scripts/strip-mock-adapter.js` runs as `prepack`)
   — `dist/adapters/mock/` is removed from the tarball before `npm publish`.
   `scripts/verify-tarball.js` asserts the absence and runs in `release.yml`
   between Build and Publish.
2. **Import-time registration gate** (`src/adapters/index.ts`) — the mock
   descriptor is only registered when `isDevMode()` returns `true`.
3. **Recruit-time rejection** (`src/tools/recruit.ts`) — `agent: 'mock'` is
   rejected with a clear error message outside dev mode.
4. **Runtime banner** (above) — every dev-mode invocation self-identifies.

If you suspect a regression in any of these, the relevant tests are:

- `tests/adapters/mock/build-exclusion.test.ts` (gate 1)
- `tests/adapters/mock/prefix-safety.test.ts` (gate 2 — registry import shape)
- `tests/adapters/mock/recruit-gate.test.ts` (gate 3)
- `tests/cli/dev-banner.test.ts` (gate 4)

## Multi-profile coexistence

Two daemons (prod + dev) on the same machine coexist via different home dirs,
ports, and namespaces. PR-1 added cross-profile awareness to the orphan
detector — `selectOrphans` consults both PID files so `--dev daemon stop`
can never SIGTERM the prod daemon (and vice versa). See ADR 0014 §5.7 for
details and acceptance criteria.

For three or more parallel environments, set `CLAUDE_TEMPO_HOME_OVERRIDE`
to a custom path. v1 doesn't enumerate multi-profile setups; remember which
override goes with which environment.
