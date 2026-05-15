# Mock adapter

A dev-mode-only SDK-class adapter used for autonomous validation harnesses
(dashboard testing, wire-protocol regression checks, scenario replay) that
can't tolerate a real LLM call. See [ADR 0014](../../../docs/adr/0014-dev-mode-mock-adapter.md)
for the design.

> **Production safety**. Four independent gates keep this off production
> paths. See `docs/adr/0014-dev-mode-mock-adapter.md` §7. The npm `prepack`
> script (`scripts/strip-mock-adapter.js`) deletes `dist/adapters/mock/`
> before the published tarball is built — so a user who `npm install`s
> claude-tempo will not have this code on their machine at all.

## Modes (PR-2 ships `echo` + `scripted`)

| Mode         | Behavior                                                                                                  | Primary use                                            |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `echo`       | Replies to the sender with `[ECHO] <original message>`. Default.                                          | Smoke tests, simplest possible round-trip              |
| `scripted`   | Matches each inbound message against rules in a YAML scenario; runs the matching rule's action sequence. | Replayable scenarios, regression captures, e2e flows   |
| `silent`     | (PR-3) Drains messages, never responds.                                                                   | Test pause/resume, timeout, stale phase, encore flows  |
| `chaos`      | (PR-3) Probabilistic delay / throw / skip.                                                                | Stress-test reconnect / timeout / supervisor logic     |

Mode is selected at boot via `AGENT_TEMPO_MOCK_MODE` env. There is no
mid-session switching — restart the player to change modes.

## Scenario format

YAML at the path given by `AGENT_TEMPO_MOCK_SCENARIO`. Resolution rules:

1. **Absolute path** — used verbatim.
2. **Bare name** (no path separators) — `<package-root>/scenarios/<name>.yaml`.
3. **Relative path** — `process.cwd()`-relative.

```yaml
name: my-scenario
description: short blurb shown by `claude-tempo --dev scenarios list`
defaultDelayMs: 500          # optional; inserted between actions in a rule

rules:
  - when: "trigger phrase"   # case-insensitive substring match on inbound text
    do:
      - cue:
          to: "@sender"      # @sender → inbound msg's `from`; @conductor; or a name
          message: "ack: $message"   # $message → original inbound text
      - delayMs: 1500
      - report:
          type: "result"
          text: "done"
  - when: "*"                # catch-all (must be the last rule)
    do:
      - cue: { to: "@sender", message: "[no rule matched]" }
```

### Action set (closed)

| Action     | Shape                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| `cue`      | `{ to: <playerId\|@sender\|@conductor>, message: <string> }`                |
| `report`   | `{ type: <result\|blocker\|question\|update>, text: <string> }`             |
| `recruit`  | `{ name: <string>, workDir: <string>, agent?: <claude\|copilot\|mock> }`    |
| `release`  | `{ target: <playerId\|@sender\|@conductor> }`                               |
| `delayMs`  | `<positive integer ≤ 60000>`                                                |
| `crash`    | `{ message: <string> }` — `process.exit(1)`; for supervisor-recovery tests  |

Validation:
- Targets must match `[a-zA-Z0-9_-]+` OR be `@sender` / `@conductor`.
- Up to 20 actions per rule.
- Up to 64 KiB per scenario file.
- `delayMs` cap is 60 s.

## `__MOCK__:` cue prefix

Any cue body starting with `__MOCK__:` is parsed as inline directives and
dispatched **regardless of mode**. The same closed action set applies, in a
shell-like syntax:

```
__MOCK__: cue alice "hello bob"
__MOCK__: report result "task complete"
__MOCK__: delay 2000
__MOCK__: release alice
__MOCK__: crash supervisor reset test
```

Multiple directives can be stacked (one per line). Unknown verbs and bad
arguments are logged but don't abort the batch.

**Production-safety guarantee.** Real adapters (claude-code, copilot) never
inspect message bodies for this prefix — `tests/adapters/mock/prefix-safety.test.ts`
asserts the property by source inspection. Combined with the four gates
that keep the mock off production paths in the first place, an accidentally
cross-pollinated `__MOCK__:` directive is inert plain text.

## Discoverability

```bash
$ claude-tempo --dev scenarios list
$ claude-tempo --dev scenarios show echo-roundtrip
$ claude-tempo --dev recruit alice --workDir /tmp/dev --agent mock --mockMode scripted --mockScenario echo-roundtrip
```

The `scenarios list / show` subcommands work even outside dev mode (so a
user can grep what's available before flipping the gate); `recruit ... --agent mock`
is gated.

## What the mock does NOT do

- **No actual LLM calls.** Every response is deterministic per the mode + scenario.
- **No file I/O on the workspace.** Mock players have no Bash/Read/Write capability.
- **No tool calls.** The mock only emits outbox entries (cue / report / recruit / release).
- **No persistence.** Each spawn starts fresh; scenarios encode any "memory".

These are intentional limits. The mock is a coordination + dashboard test
fixture, not a stand-in for a real Claude session's reasoning.
