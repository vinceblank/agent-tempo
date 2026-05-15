# Dev mode + mock adapter + isolated daemon stack

- **Status**: Design — pending PR breakdown to engineer
- **Date**: 2026-04-27
- **Author**: tempo-architect
- **Conductor brief**: Enable autonomous, end-to-end validation of agent-tempo (especially the web dashboard, #340) by an AI operator using `mcp__claude-in-chrome__*`, without polluting the operator's production daemon and without requiring human "trust this folder" prompts.
- **Related**:
  - `src/adapters/README.md`, `src/adapters/base.ts`, `src/adapters/sdk/base.ts`
  - `src/adapters/copilot/adapter.ts` (closest existing precedent)
  - `src/daemon.ts`, `src/cli/daemon.ts`, `src/connection.ts`, `src/config.ts`
  - ADR 0012 (claude-api adapter), ADR 0013 (web dashboard)
  - `docs/design/session-lifecycle-rebuild-v2.md` §4 (adapter contract), §4.6 (worked SDK example)

## 1. Problem

Today the conductor (an AI operator running `agent-tempo`) has a hard ceiling on what it can validate end-to-end:

1. **Real player sessions need a human-in-the-loop.** Spawning a Claude Code session pops the "trust this folder" prompt the first time. The conductor can't approve it; vinceblank has to.
2. **There is one daemon per machine.** Any dashboard / TUI / wire-protocol experiment the conductor runs hits the same `~/.agent-tempo/` directory, the same `agent-tempo` task queue on Temporal's `default` namespace, and the same HTTP port (8473). Test traffic and production traffic share the same workflow visibility, the same `Maestro` workflow, the same SSE stream.
3. **The dashboard testing the conductor *did* manage last night** (#375, #376) was against vinceblank's prod daemon. Every click polluted real ensemble state.

The fix has to address all three at once. A mock adapter without an isolated daemon still pollutes prod. An isolated daemon without a mock adapter still needs human trust prompts. Designing them together as one stack lets a developer (human or AI) spin up a fully sealed environment, drive multi-player scenarios, and tear it down with zero blast radius.

This generalizes beyond the dashboard:

- **CI Playwright e2e** can drive scripted scenarios instead of read-only smoke
- **Future TUI work** validates against deterministic player traces
- **Wire-protocol changes** verify end-to-end without manual ensemble setup
- **Bug repros** capture as scripted scenarios, replay later

## 2. Architecture overview — the three pieces

```
┌──────────────────────────────────────────────────────────────────────┐
│  Developer / AI conductor                                            │
│                                                                      │
│    $ agent-tempo --dev up --lineup tempo-mock-jam                   │
│                                                                      │
│           │                                                          │
│           │ ┌─────────────────────────────────────────────────────┐  │
│           ▼ ▼                                                     │  │
│    ┌───────────────────┐    ┌───────────────────────────────────┐ │  │
│    │  Dev daemon       │    │  Temporal namespace                │ │  │
│    │  ~/.agent-tempo- │◄──►│  agent-tempo-dev                  │ │  │
│    │  dev/             │    │  (auto-created on dev daemon boot) │ │  │
│    │  Port 8474        │    └───────────────────────────────────┘ │  │
│    │  Bus + HTTP + SSE │                                          │  │
│    └────────┬──────────┘                                          │  │
│             │ recruit                                             │  │
│             ▼                                                     │  │
│    ┌───────────────────┐    ┌───────────────────┐                 │  │
│    │  mock adapter     │    │  mock adapter     │   ...           │  │
│    │  player "alice"   │    │  player "bob"     │                 │  │
│    │  mode=scripted    │    │  mode=echo        │                 │  │
│    │  script=foo.yaml  │    │                   │                 │  │
│    └───────────────────┘    └───────────────────┘                 │  │
│                                                                   │  │
│                                                                   │  │
│  Browser (Chrome MCP)                                             │  │
│    http://localhost:8474/dashboard ────────────────────────────────  │
│                                                                      │
│  Production daemon (untouched)                                       │
│    ~/.agent-tempo/  Port 8473  Namespace "default"                  │
└──────────────────────────────────────────────────────────────────────┘
```

The three pieces are deliberately **co-designed but separately useful**:

- **Dev profile** (§5) is useful even without a mock adapter — a developer can spin up a clean prod-shaped daemon for any kind of experimentation.
- **Mock adapter** (§4) is useful even outside dev mode — but production registration is gated off and recruit rejects it, so in practice it only lights up when the dev profile is active.
- **Namespace isolation** (§6) is what guarantees **zero blast radius** — even if the developer accidentally typo'd the prod port, dev workflows live in a different namespace and prod can't see them.

## 3. Design tenets

1. **Strict additivity to the wire protocol.** Zero new signals, queries, or updates on `claudeSessionWorkflow`. The mock adapter uses the same `claimAttachment` / `heartbeat` / `markDelivered` / `pendingMessages` / outbox surface as Claude Code and Copilot. This means: no `WIRE-PROTOCOL.md` change, no workflow versioning concern, no ripple to existing adapters.
2. **One profile, four isolation axes.** A single `--dev` flag flips home dir, port, namespace, and task queue together. No knob soup, no possibility of "dev mode but accidentally writing to the prod task queue".
3. **Defense-in-depth on production safety.** Four independent layers must all fail for the mock adapter to talk to a prod ensemble. Build-time exclusion, import-time gate, recruit-time rejection, runtime banner.
4. **No new IPC surface in v1.** Scripted YAML covers replayable scenarios; the existing cue surface (with a `__MOCK__:` directive prefix) covers interactive driving from another player. An HTTP control endpoint is a Phase 2 ergonomic enhancement, not a v1 prerequisite.
5. **Reuse the existing adapter base class.** The mock extends `SdkAttachment` — claim, heartbeat, phase watcher, runId pinning, processing-pair semantics, terminal handling all inherited. Concrete adapter is small (~200–300 LoC) and focused on response generation.
6. **Don't over-engineer the test driver.** The conductor's primary use case is "spin it up, drive the dashboard, validate". Optimizing for that loop wins over building a perfect test harness on day one.

## 4. The mock adapter

### 4.1 Class choice and descriptor

`MockAttachment extends SdkAttachment` from `src/adapters/sdk/base.ts`.

Rationale: pull-delivery semantics. The mock polls `pendingMessages`, "computes" a response per its mode, and posts the response back via outbox — exactly the lifecycle shape the SDK base is built for. Critically, `SdkAttachment.deliver()` wraps message handling in `processingStart` / `processingEnd` signals, so the dashboard sees the mock's session correctly transition `attached → processing → attached` per turn. **End-to-end visual fidelity to a real session is non-negotiable** — dashboards bugs that only surface during real LLM turns are exactly what we want to catch.

```ts
// src/adapters/mock/index.ts
export const mockDescriptor: AdapterDescriptor = {
  adapterId: 'mock',
  adapterClass: 'sdk',
  blocksOnLLMTurn: true,        // mock pretends to think — visible processing window
  heartbeatMs: 30_000,          // SDK class cadence per design §4.3
};
```

### 4.2 Modes

A single class, four modes selected at construction via the `CLAUDE_TEMPO_MOCK_MODE` env var:

| Mode         | Behavior                                                                                       | Primary use                                            |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `echo`       | Cue back to sender with `"echo: <original message>"`. Default mode.                            | Smoke tests, simplest possible round-trip              |
| `scripted`   | Match incoming message against rules in a YAML scenario file; apply matching response actions. | Replayable scenarios, regression captures, e2e flows   |
| `silent`     | Drain `pendingMessages` (so the workflow doesn't accumulate), respond never.                   | Test pause/resume, timeout, stale phase, encore flows  |
| `chaos`      | Randomly inject delays, throws, or skipped responses based on env-tuned probabilities.         | Stress-test reconnect / timeout / supervisor logic     |

Mode selection happens once at adapter boot. No dynamic mode-switching mid-session — keeps state minimal. A test that needs to switch behavior partway through restarts the player.

### 4.3 Scripted scenario format

YAML at the path given by `CLAUDE_TEMPO_MOCK_SCRIPT` (absolute path, OR a bare scenario name resolved against `scenarios/` at the repo root — see §4.9 below). Schema validated via Zod (in `src/adapters/mock/scenario.ts`):

```yaml
# Example: scenarios/handoff.yaml
name: simple-handoff
description: alice receives a task, asks bob for a part, reports done

# Optional: response delay so dashboard shows a believable processing window.
# If omitted, default 500ms.
defaultDelayMs: 1500

rules:
  # Trigger phrases match against the body of the most recent inbound message.
  # Match strategy: substring (case-insensitive). First matching rule wins.
  - when: "what's the time"
    do:
      - cue:
          to: "@sender"          # special token: replies to whoever sent the inbound message
          message: "It's mock-time"

  - when: "implement feature"
    do:
      - cue:
          to: "bob"
          message: "@bob: please scaffold the test file"
      - report:
          type: "update"
          text: "delegated test scaffolding to bob"
      - delayMs: 3000             # simulated thinking time before the next action
      - report:
          type: "result"
          text: "feature implemented; awaiting review"

  # Catch-all: if nothing matches, default to echo.
  - when: "*"
    do:
      - cue:
          to: "@sender"
          message: "echo: $message"   # $message → original inbound message body
```

Action types in `do:` are a closed set, mapping 1:1 to MCP tools the adapter calls via the same outbox surface a real session uses:

- `cue: { to, message }` — submits a `CueOutboxEntry`
- `report: { type, text }` — submits a `ReportOutboxEntry`
- `recruit: { name, workDir, agent? }` — submits a `RecruitOutboxEntry`
- `release: {}` — submits a `ReleaseOutboxEntry`
- `delayMs: <number>` — `abortableSleep` between actions; visible in workflow history
- `crash: { message }` — `process.exit(1)` after logging; for testing supervisor recovery

Validation rules (enforced by Zod):

- `to:` must be a valid player name OR the literal `@sender` OR the literal `@conductor`
- `delayMs:` ≤ 60000 (don't accidentally hold up a scenario forever)
- Total actions per rule ≤ 20 (prevents runaway scenarios)
- File size ≤ 64 KiB (prevents config bombs)

### 4.4 Interactive driving via cue prefix

The conductor (or any player) can drive a mock player live without writing a YAML scenario. Cues whose body starts with `__MOCK__:` are interpreted as inline directives by the mock adapter, **regardless of the configured mode**:

```
__MOCK__: cue alice "hi from bob"
__MOCK__: report result "task complete"
__MOCK__: delay 2000
__MOCK__: crash "oops"
```

Implementation: in `MockAttachment.deliver()`, check the inbound body for the prefix before consulting mode logic. If matched, parse the directive (small recursive-descent parser, ~50 LoC) and dispatch to the same action set as scripted mode. If not, fall through to mode-specific handling.

This is deliberately **not** a new wire protocol surface — it's a string convention the mock adapter happens to honor. Real Claude Code and Copilot adapters never see these messages because they go to mock players, never to real ones. The prefix is conspicuous enough that no human user will type it accidentally.

**Prefix safety guarantee:** the `__MOCK__:` directive is interpreted **only by the mock adapter**. Production adapters (Claude Code, Copilot, claude-api) never inspect message bodies for it — they pass all message content through to their respective LLM as-is. This means a `__MOCK__:` directive accidentally cross-pollinated into a production chat history is **inert**: the receiving real player just sees it as plain text and reasons about it like any other message. Combined with the production safety gates in §7 (mock adapter cannot be registered or recruited outside dev mode), the prefix is safe-by-default — the only way it triggers behaviour is when the receiver is itself a mock adapter, which only exists in dev mode.

Why no IPC surface in v1: the conductor can drive scenarios using `cue` from any player it controls. Adding HTTP / Unix socket / file-watch control would duplicate that capability without a clear additional use case. Phase 2 can add a dashboard control panel ("inject directive into player X") if friction warrants.

### 4.5 Outbox semantics

The mock adapter uses `submitOutboxUpdate` exactly like a real session — never bypasses the outbox. This is non-negotiable:

- The outbox is the **only** path through which cross-workflow messaging happens.
- Bypassing it would mean mock sessions deliver messages via a different code path than real sessions — defeating the whole point of using the mock for end-to-end validation.
- Outbox entries are visible in workflow history and the SSE event stream, so dashboard testing sees real outbox activity.

The mock holds the same pinned `WorkflowHandle` (returned by `startV2Lifecycle`) any other adapter holds, and posts outbox entries through it.

### 4.6 Configuration surface

New env vars (registered in `src/config.ts` `ENV` constant for grep-ability):

| Env var                          | Required when                  | Default               | Notes                                                |
| -------------------------------- | ------------------------------ | --------------------- | ---------------------------------------------------- |
| `CLAUDE_TEMPO_MOCK_MODE`         | Mock adapter spawned           | `echo`                | One of `echo` / `scripted` / `silent` / `chaos`      |
| `CLAUDE_TEMPO_MOCK_SCRIPT`       | `MOCK_MODE=scripted`           | (none — boot fails)   | Absolute path to scenario YAML                       |
| `CLAUDE_TEMPO_MOCK_CHAOS_SEED`   | Optional                       | `Date.now()`          | Pin RNG for reproducible chaos runs                  |
| `CLAUDE_TEMPO_MOCK_CHAOS_DELAY`  | `MOCK_MODE=chaos`              | `0.1`                 | Probability of injected delay per message (0.0–1.0)  |
| `CLAUDE_TEMPO_MOCK_CHAOS_THROW`  | `MOCK_MODE=chaos`              | `0.05`                | Probability of injected throw per message            |

These flow through the recruit pre-flight: when `agent: 'mock'` is requested, recruit accepts optional `mockMode` / `mockScript` / `mockChaosSeed` params and translates them into env vars on the spawn activity input.

### 4.7 Subprocess entry point

Following the Copilot pattern, `src/adapters/mock/adapter.ts` is dual-purpose:

- Imported by the registry → exposes the class for `MockAttachment` reference
- Run as a subprocess (`node dist/adapters/mock/adapter.js`) → calls `run()` gated by `require.main === module`

The spawn activity (`src/spawn.ts`) gets a new branch: when `agent: 'mock'`, it spawns the subprocess directly via `child_process.spawn(process.execPath, [adapterPath], { detached: true, stdio: 'inherit', env })`. **No terminal window** — mock players have no UI, they're headless workers. This is one of the key wins: the conductor can recruit them without any "trust this folder" prompt or visible Ghostty / WT / iTerm window.

The mock subprocess shares its stdout/stderr with the daemon's log file via `stdio: 'inherit'` so log lines appear in `~/.agent-tempo-dev/daemon.log` for debugging.

### 4.8 Scenario discovery — `scenarios/` at the repo root

Scripted YAMLs live in `scenarios/` at the repo root, parallel to `examples/ensembles/`. Shipped to the npm tarball via `package.json#files`. Each scenario file is a single YAML document conforming to the §4.3 schema, with a top-level `name:` and `description:`.

Resolution rules for `--mockScript` / `CLAUDE_TEMPO_MOCK_SCRIPT`:

1. **Absolute path** (starts with `/`, `C:\`, etc.) → used verbatim. Fails if file doesn't exist.
2. **Bare name** (no slashes, no extension) → resolved as `<package-root>/scenarios/<name>.yaml`. Lets the conductor write `--mockScript handoff` instead of an absolute path.
3. **Relative path** (contains `/` or `\` but not absolute) → resolved against `process.cwd()`. For developers iterating on a scenario in their workspace.

CLI ergonomics for discovery:

```bash
$ agent-tempo --dev scenarios list           # prints name + description for every shipped scenario
$ agent-tempo --dev scenarios show handoff   # prints the full YAML for inspection
$ agent-tempo --dev recruit alice --agent mock --mockMode scripted --mockScript handoff
```

This makes the scenario library **discoverable** rather than tribal-knowledge — a fresh conductor session can `scenarios list` to see what's available without reading source. Same pattern as how `examples/ensembles/` lineups are discoverable via `agent-tempo lineups list`.

**Why repo root, not `examples/`:** scenarios are first-class artifacts (referenced by name, used by the validation harness, shipped to users), not illustrative examples. Putting them in `examples/` would imply they're optional sample code; putting them at the repo root signals "this is part of the library."

### 4.9 What the mock adapter does NOT do

- **No actual LLM calls.** Every response is deterministic per its mode + scenario.
- **No file I/O on the workspace.** Mock players don't read or write files; they have no `Bash` / `Read` / `Write` capability. Scenarios that need file ops are out of scope — use a real adapter.
- **No tool calls.** The mock adapter does not register MCP tools or call them. Its only outputs are outbox entries (cue, report, recruit, release).
- **No persistence.** Each mock player starts fresh; there's no "memory" across runs unless the scenario YAML encodes it.

These are intentional limits. The mock is a dashboard / wire-protocol / coordination test fixture, not a stand-in for a real Claude session's reasoning.

## 5. Dev profile

### 5.1 The four isolation axes

| Axis                  | Production default                    | Dev profile default                     | Resolved by                            |
| --------------------- | ------------------------------------- | --------------------------------------- | -------------------------------------- |
| Home dir              | `~/.agent-tempo/`                    | `~/.agent-tempo-dev/`                  | `CLAUDE_TEMPO_HOME` constant           |
| HTTP port             | `8473`                                | `8474`                                  | `CLAUDE_TEMPO_DAEMON_PORT` env default |
| Temporal namespace    | `default`                             | `agent-tempo-dev`                      | `TEMPORAL_NAMESPACE` env default       |
| Task queue            | `agent-tempo`                        | `agent-tempo-dev`                      | `CLAUDE_TEMPO_TASK_QUEUE` env default  |

All four flip together when the `--dev` flag (or `CLAUDE_TEMPO_DEV_MODE=1` env) is set. **The user never sets these individually for dev work.** If they want to override one (e.g. run the dev daemon on a custom port), they can — the existing `CliOverrides` and env precedence chain still wins. But the default path is "one switch, four axes".

### 5.2 The dev-mode gate — single source of truth

A new `src/config.ts` helper:

```ts
export function isDevMode(): boolean {
  const v = process.env.CLAUDE_TEMPO_DEV_MODE;
  return v === '1' || v === 'true';
}
```

This is the one function every other layer consults. The `--dev` CLI flag's job is to set `CLAUDE_TEMPO_DEV_MODE=1` before invoking the verb's handler. Subprocesses spawned by the daemon (mock adapter, etc.) inherit the env var automatically.

### 5.3 Profile-aware paths

Two functions in `src/config.ts` replace the existing `CLAUDE_TEMPO_HOME` constant:

```ts
function resolveTempoHome(): string {
  if (process.env.CLAUDE_TEMPO_HOME_OVERRIDE) {
    return process.env.CLAUDE_TEMPO_HOME_OVERRIDE;
  }
  return isDevMode()
    ? join(homedir(), '.agent-tempo-dev')
    : join(homedir(), '.agent-tempo');
}

export const CLAUDE_TEMPO_HOME = resolveTempoHome();
export const CONFIG_FILE_PATH = join(CLAUDE_TEMPO_HOME, 'config.json');
```

`CLAUDE_TEMPO_HOME_OVERRIDE` exists for the rare case a developer wants three+ isolated environments on one machine. v1 doesn't optimize for this; the env var is the escape hatch.

The same pattern applies to `getConfig()` defaults: `temporalNamespace`, `taskQueue`, and the daemon port (in `src/cli/daemon.ts`'s `DAEMON_PORT_DEFAULT`) all consult `isDevMode()` for their default branch.

### 5.4 CLI ergonomics

```
# Spin up the dev stack
$ agent-tempo --dev up --lineup tempo-mock-jam

# Or start the dev daemon alone
$ agent-tempo --dev daemon up

# Anything you'd do against prod, prefixed with --dev
$ agent-tempo --dev ensemble
$ agent-tempo --dev recruit alice --workDir /tmp/scratch --agent mock --mockMode scripted --mockScript ./scenarios/handoff.yaml
$ agent-tempo --dev cue alice "what's the time"
$ agent-tempo --dev dashboard

# Tear down
$ agent-tempo --dev daemon stop
```

The `--dev` flag is a **top-level** CLI option (parsed before the verb) so every existing verb works in dev mode without per-command plumbing. Implementation: a single check in `src/cli.ts`'s arg parser before verb dispatch.

Banner: every CLI invocation in dev mode prints a single conspicuous header line:

```
[DEV MODE] using ~/.agent-tempo-dev/ · port 8474 · namespace agent-tempo-dev
```

Daemon also prints this on startup so `~/.agent-tempo-dev/daemon.log` self-identifies.

### 5.5 Lifetime

**Long-lived.** Same lifecycle as the prod daemon: started once, runs until explicitly stopped. Reasons:

- Cold-starting per validation session is slow (Temporal connection, namespace check, worker bootstrap, HTTP server, reconcile-on-boot all add latency).
- The conductor wants to drive multiple scenarios in succession without per-scenario teardown.
- Dev workflows in the dev namespace persist in Temporal until completed, terminated, or aged out — a long-lived dev daemon polls them naturally; a short-lived one would need to handle "what about workflows from the previous run".

The existing daemon stop / status / heartbeat machinery applies as-is. `agent-tempo --dev daemon status` reports against the dev daemon; `agent-tempo daemon status` reports against prod. They never confuse each other because their PID files live in different home dirs.

### 5.6 Conflict avoidance

- **Dev daemon vs prod daemon on the same machine:** different home dirs (so different PID files, different lock files), different ports, different namespaces. They coexist — but **not as automatically as one might hope** — see §5.7 below for the orphan-detector caveat surfaced during PR-1 implementation.
- **Two dev daemons on the same machine:** the existing `tryAcquireLockFile` mechanism in `src/cli/daemon.ts` prevents this — second starter sees the lock, waits, finds the first daemon's PID file, and connects to it. Same behavior as prod. v1 explicitly does **not** support multiple parallel dev daemons; users who need that set `CLAUDE_TEMPO_HOME_OVERRIDE` per environment.
- **Dev daemon vs prod daemon talking to the same Temporal:** namespace-scoped. Dev workflows live in `agent-tempo-dev`; prod's `default` namespace can't see them via `workflow.list()` queries.

### 5.7 Cross-profile orphan-detector coexistence

> **Folded in from PR-1 implementation discovery.** The original §5.6 claim "they naturally coexist" was incomplete — true at the home-dir / port / namespace layers, but NOT at the orphan-detector layer. Documented here so future engineers don't re-discover it.

The existing zombie-daemon reaper (`scanClaudeTempoDaemons` + `selectOrphans` in `src/cli/daemon.ts`, originally introduced in #157) matches **any** `node dist/daemon.js` process on the host via the `DAEMON_CMDLINE_RE` regex. It then calls `selectOrphans` to filter out the PID tracked by the *current* profile's PID file. **Without further changes, that filter doesn't know about the opposite profile's PID** — so the dev daemon sees the prod daemon as an "untracked zombie" and `--dev daemon stop` would SIGTERM the user's prod daemon. Same hazard in reverse.

**The fix (extend `selectOrphans` to accept a known-PIDs array; thread the opposite profile's PID through every call site)** is required for cross-profile safety:

```ts
// Before:
export function selectOrphans(scanned: DaemonProcessInfo[], trackedPid: number | undefined): DaemonProcessInfo[]

// After:
export function selectOrphans(scanned: DaemonProcessInfo[], knownPids: ReadonlySet<number>): DaemonProcessInfo[]
//   where knownPids contains: own profile's tracked PID + opposite profile's tracked PID (best-effort read)
```

Call sites (`stopDaemon`, `daemon start` pre-flight scan) read both PID files at the start of their work and pass the combined set. Read failures (opposite profile's PID file missing or unreadable) are non-fatal; the union just shrinks.

**Weak-evidence suppression for partial-state cases:** if the opposite profile shows mixed signals (port file present but PID file missing — typical post-crash state), the zombie reaper **suppresses entirely** rather than guess. Defensive bias: leaving one zombie beats wrongly killing the user's other daemon. `daemon start` similarly skips orphan scan in this state and prompts the operator with `--force` to override.

This isn't a one-off patch — it's a structural lesson: **any host-wide enumeration that filters by "is mine" must also know "what isn't mine but isn't a zombie either"**. Future host-scoped utilities (e.g. log rotation, port-conflict detection) need to consult the same cross-profile PID set or risk the same class of bug.

Acceptance criteria the implementation must meet:

1. `--dev daemon stop` MUST NOT kill the prod daemon, ever.
2. `agent-tempo daemon stop` MUST NOT kill the dev daemon, ever.
3. Genuine zombies (matching the daemon cmdline regex but not in either profile's PID file) MUST still be reaped — except in the weak-evidence partial-state case described above.
4. Unit tests must cover: (a) cross-profile coexistence, (b) genuine-zombie reap, (c) weak-evidence suppression, (d) opposite-profile PID file read failure (non-fatal).

## 6. Temporal namespace isolation

### 6.1 Namespace name

`agent-tempo-dev`. Reasons: explicit (no chance of collision with another product using `dev`), prefix-stable (so future namespaces like `agent-tempo-staging` slot in cleanly), and matches the home-dir naming pattern.

### 6.2 Auto-provisioning on dev daemon boot

The dev daemon attempts to create its namespace on startup if it doesn't exist. Production daemons never auto-create — namespaces are operator-managed there.

Implementation skeleton (in `src/daemon.ts`, called before worker start, gated on `isDevMode()`):

```ts
async function ensureDevNamespace(connection: Connection, namespace: string): Promise<void> {
  const wfService = connection.workflowService;
  try {
    await wfService.registerNamespace({
      namespace,
      // Workflow execution retention for dev — short, to keep the namespace tidy.
      workflowExecutionRetentionPeriod: { seconds: 86400 },  // 1 day
      description: 'agent-tempo dev profile — auto-created. Safe to drop.',
    });
    log(`registered Temporal namespace "${namespace}"`);
  } catch (err) {
    const code = (err as any)?.details?.code ?? (err as any)?.code;
    // ALREADY_EXISTS is the happy path — namespace was created by an earlier boot.
    if (code === 'ALREADY_EXISTS' || /already exists/i.test(String(err))) {
      return;
    }
    // PERMISSION_DENIED on managed Temporal Cloud — log + fall through to
    // letting the worker bootstrap fail loudly with a useful message.
    log(`could not register namespace "${namespace}" (continuing — may already exist or perms denied):`, err);
  }
}
```

Idempotent. Bounded. Non-fatal: if namespace registration fails for any reason, the worker bootstrap will fail with a clear `Namespace not found` error from Temporal — the user is told what to do (`temporal operator namespace create -n agent-tempo-dev`).

### 6.3 Why namespace and not "tag with dev=true"

Considered alternative: keep one namespace, tag dev workflows with a search attribute like `ClaudeTempoEnv=dev`. Rejected because:

- Visibility queries (`workflow.list`) would require operators to remember to filter by tag — easy to forget, leaks dev state into prod tooling.
- The Maestro workflow is namespace-wide; one Maestro per namespace is the existing invariant. Keeping dev in its own namespace means dev gets its own Maestro, untouched by prod ensemble state.
- Temporal CLI / UI (`temporal workflow list`) defaults to a namespace; switching is one flag (`-n agent-tempo-dev`). With tag-based isolation, every CLI call needs a search-attribute filter — friction.

Namespace isolation is the natural Temporal idiom and what Temporal's own docs recommend for "different environments / tenants in the same cluster".

## 7. Production safety — defense in depth

Four independent gates. **All four must fail** for the mock adapter to talk to a prod ensemble:

### Gate 1 — Build-time exclusion

`package.json#files` whitelists what ships in the npm tarball. `src/adapters/mock/` is **not** in the list. The compiled `dist/adapters/mock/` is built from source for tests, but the publish pipeline either:

- Excludes `dist/adapters/mock/` via a publish-time `npm pack` filter, OR
- Skips compiling `src/adapters/mock/*` in the production tsconfig (preferred — tighter; nothing to forget at publish time)

Engineer's call which one to implement; both prevent the mock adapter from ever shipping to a user's machine.

### Gate 2 — Import-time registration gate

In `src/adapters/index.ts`:

```ts
import { isDevMode } from '../config';
// ...

registry.register(claudeCodeDescriptor);
registry.register(copilotDescriptor);

if (isDevMode()) {
  // Dynamic import so that production builds (which exclude src/adapters/mock/)
  // don't fail with a missing-module error at import time.
  import('./mock').then(({ mockDescriptor }) => {
    registry.register(mockDescriptor);
    console.error('[agent-tempo] DEV MODE: mock adapter registered');
  }).catch((err) => {
    console.error('[agent-tempo] DEV MODE: mock adapter unavailable —', err);
  });
}
```

Production builds don't have the file at all (gate 1), so even if `CLAUDE_TEMPO_DEV_MODE=1` is set, the import fails and the adapter isn't registered.

### Gate 3 — Recruit-time rejection

`src/tools/recruit.ts` pre-flight:

```ts
if (parsed.agent === 'mock' && !isDevMode()) {
  return fail('agent: "mock" is only available in dev mode. Restart with --dev to enable.');
}
```

Even if a user manually tampered with their build to register the mock adapter outside dev mode, recruit rejects the request with a clear, actionable error.

### Gate 4 — Runtime banner

Every `--dev`-prefixed CLI invocation prints `[DEV MODE]` on a dedicated line; the daemon log self-identifies on every startup. Operators can grep the log for `DEV MODE` to verify they're running the right environment. The dashboard can render a `DEV MODE` ribbon when the daemon's `/v1/health` endpoint reports `devMode: true` (Phase 2 polish; not required for v1).

### What still leaks if all four gates fail (theoretical)

Even in the worst case, namespace isolation (§6) means dev workflows never appear in prod's `workflow.list()` queries. The blast radius of a complete gate failure is "two daemons fight for the same Temporal namespace and trample each other's state" — bad, but recoverable, and not catastrophic. The four gates make this combinatorically unlikely.

## 8. End-to-end dashboard validation flow

This is the conductor's primary use case. After PR 2 lands:

```
# 1. Start the dev daemon (auto-creates namespace, binds 8474)
$ agent-tempo --dev daemon up

# 2. Recruit two mock players for a multi-player scenario
$ agent-tempo --dev recruit alice \
    --workDir /tmp/dev-scratch \
    --agent mock \
    --mockMode scripted \
    --mockScript $(pwd)/examples/mock-scenarios/handoff.yaml

$ agent-tempo --dev recruit bob \
    --workDir /tmp/dev-scratch \
    --agent mock \
    --mockMode echo

# 3. Drive the scenario by sending a cue
$ agent-tempo --dev cue alice "implement feature X"

# 4. Conductor opens the dashboard via Chrome MCP
   mcp__claude-in-chrome__navigate http://localhost:8474/dashboard

# 5. Conductor walks the dashboard, validating that:
#    - alice transitioned attached → processing → attached
#    - bob received a cue from alice
#    - alice's outbox shows the report entries
#    - the SSE stream pushed the events in real time
#    - the ensemble view matches the actual workflow state

# 6. Tear down
$ agent-tempo --dev daemon stop
```

Production daemon at `~/.agent-tempo/` and `:8473` is **untouched** at every step.

PR 3 adds `agent-tempo --dev up --lineup tempo-mock-jam` which collapses steps 1–3 into one command using a pre-baked lineup YAML.

## 9. Implementation phasing — three PRs, each <500 LoC

### PR 1 — Dev profile infrastructure (~350 LoC)

**Scope:**
- `isDevMode()` helper in `src/config.ts`
- Profile-aware `CLAUDE_TEMPO_HOME` / `CONFIG_FILE_PATH` resolution
- Profile-aware defaults for `temporalNamespace`, `taskQueue`, `DAEMON_PORT_DEFAULT`
- `--dev` top-level CLI flag in `src/cli.ts`; sets `CLAUDE_TEMPO_DEV_MODE=1` before verb dispatch
- `[DEV MODE]` banner in CLI output and daemon startup log
- Auto-create `agent-tempo-dev` namespace on dev daemon boot (`src/daemon.ts`)

**Tests:**
- Unit: `isDevMode()` env var parsing edge cases
- Unit: profile-aware path resolution (mocked `homedir()`)
- Unit: namespace registration idempotency (mocked `workflowService.registerNamespace`)
- Integration: dev daemon starts, writes to `~/.agent-tempo-dev/daemon.pid`, binds 8474

**Wire-protocol changes:** none.

**Documentation:**
- `docs/dev-mode.md` — quick-start guide
- `CLAUDE.md` — note about dev profile in "Key Concepts"

**Engineer:** tempo-lead (per conductor's standing pickup pattern; matches their #340 ramp).

**Validation post-PR-1:** developer can spin up an isolated daemon, verify namespace isolation, confirm prod is untouched. **No mock adapter yet** — but the foundation is ready for PR 2.

### PR 2 — Mock adapter (echo + scripted modes) (~450 LoC)

**Scope:**
- `src/adapters/mock/adapter.ts` — `MockAttachment` extending `SdkAttachment`, with `echo` + `scripted` modes
- `src/adapters/mock/scenario.ts` — Zod schema for scenario YAML, parser, action dispatcher
- `src/adapters/mock/index.ts` — descriptor + `register()` glue
- `src/adapters/index.ts` — gated registration via `isDevMode()`
- `src/tools/recruit.ts` — extend `agent` enum with `'mock'` (gated), accept `mockMode` / `mockScript` params
- `src/spawn.ts` — new mock spawn branch (headless subprocess, no terminal window)
- `src/types.ts` — extend `AgentType` to `'claude' | 'copilot' | 'mock'`
- `src/adapters/base.ts` — `AdapterRegistry.resolveFromAgentType` extended one line
- `package.json#files` — exclude `src/adapters/mock/` and `dist/adapters/mock/` from publish

**Tests:**
- Unit: scenario YAML validation (valid + invalid fixtures)
- Unit: rule matching (substring + `*` catch-all + `@sender` resolution)
- Unit: `__MOCK__:` prefix parser
- Unit: recruit rejection of `agent: 'mock'` outside dev mode
- Integration: spawn mock player, send cue, verify echo round-trips through outbox
- Integration: spawn mock player with scripted scenario, drive a 3-rule sequence, assert outbox contents

**Wire-protocol changes:** none. (Adding `'mock'` to the `AgentType` union is additive; the registry already handles unknown adapter ids by mapping through `resolveFromAgentType`.)

**Documentation:**
- `src/adapters/mock/README.md` — adapter contract, scenario format, mode descriptions
- `docs/dev-mode.md` updated with mock adapter usage
- `scenarios/{handoff,echo-everything,silent-witness}.yaml` at repo root — three reference scenarios (shipped via `package.json#files`)
- `agent-tempo --dev scenarios list` / `scenarios show <name>` CLI subcommands for discovery

**Engineer:** tempo-lead.

**Validation post-PR-2:** **the conductor can begin autonomous bug-hunting.** Recruit mock players, drive cues, validate dashboard end-to-end. Phase 1 of the conductor's vision is achieved.

### PR 3 — Silent + chaos modes, scenario library, lineup support (~300 LoC)

**Scope:**
- `silent` mode (drains messages, never responds)
- `chaos` mode (probabilistic delay / throw / skip; seedable via `CLAUDE_TEMPO_MOCK_CHAOS_SEED`)
- `examples/ensembles/tempo-mock-jam.yaml` — pre-baked lineup of mock players for `--dev up`
- `scenarios/{stress-reconnect,multi-player-handoff,encore-flow}.yaml` — additional reference scenarios at repo root
- `agent-tempo --dev up --lineup tempo-mock-jam --scenario <name>` integration (uses existing `up` machinery; `--scenario` flag wires the scripted YAML through to the spawned mock player envs)

**Tests:**
- Unit: chaos RNG seeded reproducibility
- Integration: silent mode drains queue, dashboard sees messages-pending count drop
- Integration: chaos mode + reconnect — assert adapter recovers from injected throws

**Wire-protocol changes:** none.

**Documentation:**
- `docs/dev-mode.md` updated with new modes + lineup
- Scenarios documented inline (each YAML has a `description:` field rendered in `--dev scenarios list`)

**Engineer:** tempo-lead (or split off to a second engineer if velocity warrants).

**Validation post-PR-3:** **full autonomous validation harness.** Conductor runs one command (`agent-tempo --dev up --lineup tempo-mock-jam`), gets a multi-player ensemble, drives the dashboard via Chrome MCP, validates wire-protocol changes, captures bugs as scenarios.

### Out of scope for v1 (Phase 2 follow-ups)

- **HTTP control endpoint** for live mock injection (`POST /v1/mock/inject`). The `__MOCK__:` cue prefix covers the conductor's main use case; HTTP control adds a small ergonomic improvement but isn't on the critical path.
- **Dashboard `[DEV MODE]` ribbon** rendered from `/v1/health.devMode`. Daemon logs already self-identify; dashboard ribbon is polish.
- **Mock adapter as a tool surface** (mock player exposes its own MCP tools for direct test driving). Significant scope; not needed for the conductor's primary use case.
- **Multi-tenancy / multiple parallel dev environments.** v1 supports one dev daemon per machine. `CLAUDE_TEMPO_HOME_OVERRIDE` is the v1 escape hatch.
- **Mock adapter for SDK delivery testing** (mock as a Copilot-class double). Phase 2 if SDK adapter test coverage needs it.

## 10. Risks

| Risk                                                                                                  | Likelihood | Mitigation                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Mock adapter ships in production tarball                                                              | Low        | Gate 1 (build-time files exclusion); gate 4 (loud banner if anyone ever runs it)                                              |
| Mock adapter recruited against prod ensemble (defeats the whole point of dev mode)                    | Low        | Gate 3 (recruit pre-flight rejection); gate 2 (registration only in dev mode); gate 1 ensures it can't even be there to register |
| Dev daemon registers `agent-tempo-dev` namespace on a production Temporal cluster the user shares    | Low        | Auto-registration is silent on `ALREADY_EXISTS`; on `PERMISSION_DENIED` it logs + lets workers fail with a clear error        |
| Scripted scenario YAML evolves into a configuration language ("just one more action type…")           | Medium     | Closed action set (cue / report / recruit / release / delayMs / crash) — anything fancier requires a Phase 2 design decision  |
| `__MOCK__:` prefix accidentally typed by a real user                                                  | Low        | Real Claude Code adapters never see these messages because real users don't recruit mock players; the prefix is conspicuous   |
| Two dev daemons on the same machine collide                                                           | Low        | Existing `tryAcquireLockFile` machinery prevents it; v1 explicitly doesn't support parallel dev environments                  |
| **Cross-profile orphan-detector kills the wrong daemon** (`--dev daemon stop` SIGTERMs prod, or vice-versa) | **Medium → Mitigated in PR-1** | Surfaced during PR-1 implementation; original §5.6 wrong about "natural coexistence". Fix: `selectOrphans` extended with cross-profile known-PIDs set + weak-evidence suppression on partial state. See §5.7. |
| Mock adapter heartbeat / phase semantics drift from real adapters → dashboard bugs caught here pass real-world | Medium-High | **By design**: mock extends `SdkAttachment` so it inherits 100% of the lifecycle. Adapter conformance suite (when it lands per `docs/design/session-lifecycle-rebuild-v2.md` §4.5) parameterizes over every registered descriptor and the mock will be in that suite |
| Mock adapter accumulates testability hooks that production adapters then can't drop                   | Medium     | Mock is a **separate adapter**, not a flag on the real adapters. New methods land on `MockAttachment` only; the production adapter classes stay untouched |
| Production safety gate 2 silently fails (mock fails to import in dev mode)                            | Low        | The dynamic import logs both success and failure; gate 4 banner reminds operators which mode they're in                       |
| Dev profile defaults drift from prod over time (e.g. dev gets a feature prod doesn't have)            | Medium     | Single `isDevMode()` helper as the SSOT; future divergence requires explicit code that checks the helper, not implicit drift  |
| Dashboard testing finds bugs that only repro against mock players                                     | Medium     | Adapter conformance suite + cross-validation against a real Claude Code session before declaring a bug "real" rather than mock-specific |

## 11. Validation plan — when can the conductor start?

| Milestone                                                       | Capability                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **PR 1 merged**                                                 | Conductor can spin up a dev daemon, validate it's isolated, confirm prod is untouched. Cannot recruit mock players yet. |
| **PR 2 merged**                                                 | **Conductor begins autonomous bug-hunting.** Recruit mock players manually, drive cues, validate dashboard via Chrome MCP, capture bugs. |
| **PR 3 merged**                                                 | One-command stack-up via `--dev up --lineup`. Reference scenario library. Conductor's full vision delivered.            |
| **Phase 2 (HTTP control, dashboard ribbon, multi-tenancy)**     | Quality-of-life improvements. Not blockers for the core capability.                                                     |

## 12. Decision log

| Question                                                                                  | Decision                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock adapter style: scripted / stub / echo / programmable — or one configurable adapter?  | **One adapter, four modes** (`echo`, `scripted`, `silent`, `chaos`). Mode selected at boot via env. No mid-session mode switching.            |
| Test-only signal control: new `mockReply` signal?                                         | **No.** Use existing cue surface with `__MOCK__:` directive prefix. Zero wire-protocol surface added.                                        |
| Failure injection: support API rate-limit / crash / slow simulation?                      | **Yes**, in `chaos` mode only (probabilistic). `delayMs` action available in `scripted` mode for predictable slow responses.                  |
| Dev-mode gate: env var, CLI flag, separate npm package, build-time exclusion?             | **All four** (defense-in-depth). Build-time exclusion + import-time gate + recruit-time rejection + runtime banner.                          |
| Daemon approach: separate daemon or multi-tenant single daemon?                           | **Separate daemon process** with its own home dir, PID file, port, namespace, task queue. Multi-tenancy is a Phase 2 concern.                 |
| State isolation: separate home dir, tagged workflows, or fully separate Temporal cluster? | **Separate home dir + separate Temporal namespace.** No tagged-workflow approach.                                                            |
| CLI ergonomics: `agent-tempo --dev daemon up` vs `agent-tempo dev daemon up` vs `agent-tempo daemon up --dev`? | **Top-level `--dev` flag** parsed before verb dispatch. Every existing verb works in dev mode without per-command plumbing.                   |
| Lifetime: long-lived dev daemon vs spin-up-per-validation?                                | **Long-lived.** Same lifecycle as prod daemon. Cold-start latency would be punishing for iterative validation work.                          |
| Namespace name: `agent-tempo-dev` vs `dev`?                                              | **`agent-tempo-dev`.** Explicit, matches home-dir naming, leaves room for `agent-tempo-staging` etc. without future renaming.              |
| Provisioning: auto-create namespace or require manual setup?                              | **Auto-create on dev daemon boot.** Idempotent on `ALREADY_EXISTS`. Production daemons never auto-create.                                    |
| Conflict avoidance: how do two dev daemons on same machine handle each other?             | **Existing `tryAcquireLockFile` machinery prevents it.** v1 doesn't support parallel dev daemons; `CLAUDE_TEMPO_HOME_OVERRIDE` is the escape. |
| Mock adapter base class: `BaseAttachment` or `SdkAttachment`?                             | **`SdkAttachment`.** Pull-delivery semantics + `processingStart/End` pairing matches what the dashboard renders for real sessions.            |
| Should the mock adapter expose its own MCP tools?                                         | **No.** Mock adapter has no tools; its only outputs are outbox entries via the same surface real sessions use.                               |
| Should mock players be visible in `agent-tempo --dev ensemble`?                          | **Yes** — they're real workflows in the dev namespace. The dashboard / TUI / CLI treat them identically to any other player.                 |
| Should production code paths know about the mock adapter?                                 | **No.** The production registry never sees the mock descriptor; `AgentType` includes `'mock'` but recruit rejects it outside dev mode.       |
| Should `--dev` change the wire protocol in any way?                                       | **No.** Wire protocol is identical between dev and prod. This is a hard invariant — bugs caught in dev must repro in prod.                   |
| Where do scripted scenarios live in the repo?                                             | **`scenarios/` at the repo root**, parallel to `examples/ensembles/`. Shipped via `package.json#files`. Discoverable via `--dev scenarios list`. Not under `examples/` because they're first-class artifacts, not illustrative samples. |
| What happens if a `__MOCK__:` directive crosses into a production message stream?         | **Inert.** Production adapters never inspect message bodies for the prefix; only the mock adapter does. Combined with §7 gates (mock can't exist in prod), the prefix is safe-by-default.                |
| **Found during PR-1**: how do dev + prod daemon zombie-reapers avoid killing each other?  | **Cross-profile known-PIDs set in `selectOrphans`** + weak-evidence suppression on partial state (port file present, PID file missing). Original design was wrong to assume "natural coexistence" at the host-process layer. See §5.7. |

## 13. References

- `src/adapters/README.md` — adapter contract documentation
- `src/adapters/base.ts` — `BaseAttachment`, `AdapterRegistry`, lifecycle skeleton
- `src/adapters/sdk/base.ts` — `SdkAttachment` (mock's parent class)
- `src/adapters/copilot/adapter.ts` — closest existing precedent for an SDK-class adapter with subprocess entry point
- `src/daemon.ts` — daemon entry, namespace registration callsite (gate added in §6.2)
- `src/cli/daemon.ts` — daemon start/stop/lock-file machinery (reused unchanged for dev daemon)
- `src/connection.ts` — Temporal connection factory (no changes needed; namespace passed through `Config`)
- `src/config.ts` — config resolution chain (extended with `isDevMode()` and profile-aware defaults)
- `src/tools/recruit.ts` — recruit pre-flight, agent enum (gate 3 added here)
- `src/spawn.ts` — process spawning (mock branch added)
- `docs/design/session-lifecycle-rebuild-v2.md` §4 (adapter extensibility), §4.5 (conformance suite — mock adapter participates)
- ADR 0012 (claude-api adapter) — design template precedent
- ADR 0013 (web dashboard) — dashboard surface this stack validates
- `docs/WIRE-PROTOCOL.md` — confirms zero protocol changes (this design adds nothing)
