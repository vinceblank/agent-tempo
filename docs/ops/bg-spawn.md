# Operating `claude --bg` spawn mode (experimental)

> **Experimental opt-in.** Lineup must declare `experimental.spawn: true` and
> `spawn: bg` (lineup-wide or per-player). See
> [`docs/adr/0016-bg-spawn.md`](../adr/0016-bg-spawn.md) for the full design.

## What it does

When a player is recruited with `spawn: bg`, agent-tempo invokes
`claude --bg --session-id <uuid>` instead of opening a terminal window via
`spawnInTerminal`. Anthropic's **per-user Claude Code supervisor** takes
ownership of the pty and the session appears in:

- `claude agents` (the supervisor's TUI)
- `~/.claude/daemon/roster.json` (versioned `proto: 1` roster)
- `~/.claude/jobs/<short>/state.json` + `timeline.jsonl`

cue/report/recall continue to flow over Temporal — the MCP/Temporal channel
is orthogonal to who owns the pty — so the supervised session is a
first-class tempo player. It just lives in Agent View instead of a terminal
tab.

## Why use it

- **No per-recruit terminal window.** Recruiting 7 players no longer spawns
  7 windows. This is the #1 daily-friction complaint from ensemble
  operators per the research that motivated #596.
- **Survives `claude` CLI upgrades.** The supervisor self-restarts when the
  binary's mtime changes and **re-adopts existing jobs** (look for
  `bg adopt: adopted=N dead=M` in `~/.claude/daemon.log`). Agent-tempo's
  MCP channel is orthogonal to the pty, so cue/report/recall continue
  uninterrupted across upgrade — a property `spawnInTerminal` cannot
  offer.
- **Free OS-level crash recovery** via the supervisor's per-job state
  machine.

## Prerequisites

1. **Recent `claude` CLI.** The supervisor surface was stable across
   2.1.140 → 2.1.143 (observed at research time). Older CLIs may not have
   `claude --bg` at all; the recruit will surface
   `claude --bg preflight rejected` on first use in a given cwd.
2. **Interactive consent in the target cwd, once.** Anthropic's supervisor
   refuses bypass modes (`--dangerously-skip-permissions`) that were never
   accepted interactively in that cwd. Agent-tempo dry-runs
   `claude --bg --dangerously-skip-permissions --help` on first recruit
   per `(host, cwd)` and surfaces:
   ```
   Run 'claude' once in <cwd> and accept the permission dialog, then retry recruit.
   ```
   The result is cached for the daemon's lifetime — subsequent recruits in
   the same cwd skip the probe.

## Opting in

Lineup YAML:

```yaml
name: tempo-bg-jam
description: "Experimental — every player launches via claude --bg."

experimental:
  spawn: true     # gate — required for ANY 'bg' to resolve

spawn: bg         # lineup-wide default

conductor:
  name: conductor
  type: tempo-conductor

players:
  - name: tempo-eng
    type: my-tempo-engineer
    workDir: /workspace/agent-tempo
  - name: tempo-qa
    type: my-tempo-qa
    workDir: /workspace/agent-tempo
    spawn: terminal   # per-player override — keeps QA in a terminal
```

Precedence: **per-player `spawn` > lineup `spawn` > built-in default
`'terminal'`.** Absence of `experimental.spawn: true` rejects ANY
`spawn: bg` at load time with:
```
spawn: bg requires 'experimental.spawn: true' at the top of the lineup.
```

## ⚠️ Known limitation — `restart` with `transcript: 'replay'`

> **`claude --bg --resume <uuid>` is broken upstream.**
>
> We observed that the supervisor **silently drops the resume** and spawns
> a fresh UUID. `dispatch.launch.mode` in `roster.json` comes back as
> `"prompt"`, not `"resume"`. Filed against agent-tempo as a documented
> behavior, not a bug we can work around CLI-side.

Because of this, `restart` with `transcript: 'replay'` is **unavailable**
under `spawn: bg`. Calling it raises:
```
ApplicationFailure.nonRetryable('BgSpawnReplayUnsupported',
  "claude --bg cannot resume prior context (upstream CLI limitation:
  --resume is silently dropped under --bg, see docs/ops/bg-spawn.md).
  Use loadFromState or transcript: 'none'.")
```

**Use `loadFromState` (ADR 0011) instead.** That path delivers saved
context as a system-identity cue, independent of `--resume`, and works
fine under `bg`:

```ts
// Before restart, snapshot what you want preserved.
await client.tempo.callTool('save_state', {
  slotKey: 'pre-restart',
  content: 'Working on PR #607; tests green; need to add changelog entry.',
});

// Restart with loadFromState — fresh session, but seeded with the saved slot.
await client.tempo.callTool('restart', {
  player: 'tempo-eng',
  loadFromState: 'pre-restart',
});
```

`transcript: 'none'` (fresh session, no context) also works unchanged.

## Vocabulary cheat sheet

The supervisor and agent-tempo disagree on what to call the thing:

| What you see | Anthropic noun | agent-tempo noun | UI noun |
|---|---|---|---|
| The OS process | `job` (in `~/.claude/jobs/`) | `session` / `player` | `agent` (Agent View) |
| Identifier | short id (8 hex chars) | `playerId` (workflow id) | "agent" name |
| State machine | `state`/`detail` in `state.json` | `attachmentPhase` (workflow) | colored dot |

All three refer to the same OS process. If a `claude agents` row exists for
a player you destroyed, that's a supervisor-side leak — file an issue with
the contents of `~/.claude/jobs/<short>/state.json` attached.

## Destroying a bg-spawned session

`destroy` reads `SessionMetadata.bgShortId` and fires `claude stop <shortId>`
on the per-host activity queue (`agent-tempo-{hostname}`). The activity:

- treats exit 0 as success → workflow flips `phase: 'gone'` immediately
- treats exit 1 with `No job matching '<id>'` as success (idempotent — the
  supervisor already retired the job)
- treats anything else as failure → falls back to `hardTerminateAttachment`
  (the legacy PID-scan path) as defense in depth

You should not need to invoke `claude stop` manually; if you do, the
agent-tempo workflow will notice on its next destroy attempt and accept the
"already gone" exit code without complaint.

## Liveness — who owns the truth?

- **Adapter heartbeat** (`tickHeartbeat` / `tickPhaseWatcher`, post-#249)
  remains the source of truth for `ClaudeTempoAttachmentState`. Don't
  expect Agent View to be authoritative for the agent-tempo phase machine.
- Supervisor `state.json` is consulted only at three boundaries: **spawn**
  (verify supervisor accepted us), **restart** (verify supervisor still has
  our slot), and **destroy** (confirm `state ∈ {done, killed}` after
  `claude stop`). No background reconciliation loop runs between the two.

## Cross-platform notes

- **Windows**: Anthropic's supervisor uses named pipes for `rendezvousSock` /
  `ptySock`. Agent-tempo never touches those — we only invoke the documented
  CLI verbs and read top-level `roster.json` / `state.json` fields.
- **macOS / Linux**: presumed Unix sockets in the same fields. Untested by
  agent-tempo at the time of #596 graduation. File an issue with your
  platform's `roster.json` contents if anything surprises you.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Recruit fails with `claude --bg preflight rejected` | Never accepted bypass-permissions in this cwd | `cd <cwd>; claude` and accept the dialog once |
| `restart … transcript: 'replay'` errors with `BgSpawnReplayUnsupported` | Upstream `--bg --resume` is broken | Use `loadFromState` instead |
| `destroy` succeeds but `claude agents` still shows the job | Supervisor-side delay (~1–2s); benign | Wait, or `claude stop <short>` manually |
| `destroy` logs `claude-stop … outcome=error` then `hard-terminate … strategy=none` | Supervisor wedged; PID-scan can't find the process tree (parented under supervisor) | Restart the supervisor: `pkill -f 'claude.*bg'` (POSIX) / `taskkill /F /IM claude.exe` (Windows) and `claude --bg --help` to wake it back up |
| `~/.claude/daemon.log` shows `proto: 2` | Anthropic shipped a new roster version | Open an issue; agent-tempo gates on `proto === 1` and falls through gracefully, but UX may degrade |

## Related

- [ADR 0011 — player saveable state](../adr/0011-player-saveable-state.md) —
  the recommended restart-context alternative under `bg`.
- [ADR 0016 — bg-spawn](../adr/0016-bg-spawn.md) — full design,
  alternatives considered, and consequences.
- Issue #596 — graduation tracker.
