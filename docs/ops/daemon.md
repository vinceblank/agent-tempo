# Daemon operations — supervision, exit codes, and the 2026-07-14 restart incident

## Exit-code contract

Ratified by the architect ruling (`docs/research/daemon-resilience-architect-ruling.md`
§3) and enforced by all three process-supervisor units (`packaging/systemd/agent-tempo.service`,
`packaging/launchd/com.agent.tempo.plist`, `packaging/windows/install-task.ps1`):

| Code | Meaning | Supervisor action |
|---|---|---|
| `0` | Clean shutdown **requested** (SIGTERM/SIGINT, drain complete) | Do not restart |
| `1` | Abnormal: worker give-up, boot-guard refusal, drain timeout, unhandled fatal | Restart |

**Invariant: any exit not initiated by a shutdown signal is non-zero.** Do not
invent codes 2..N — no consumer keys on them.

External supervision should key `Restart=on-failure`-style policies on this
contract; belt-and-braces `Restart=always` + `RestartSec=5` is acceptable,
but a clean `daemon stop` must not fight the supervisor (launchd: prefer the
`SuccessfulExit=false` KeepAlive dict form).

**Windows exception — this guarantee does not currently hold there.** The
`agent-tempo-daemon-recheck` scheduled task (see "Worker supervision" and
the per-platform table below) re-invokes plain `daemon start` every 5
minutes and is a pure liveness poll: `evaluateStartPreflight`
(`src/cli/daemon-command.ts`) only checks `status.running` / an orphan scan
— it never reads `daemon.last-exit.json` or otherwise distinguishes "clean
`daemon stop`" from "crashed." `daemon stop` alone does not unregister the
recheck task (only `daemon uninstall` does). Net effect: on Windows, a
clean `daemon stop` **will** be relaunched by the recheck task within 5
minutes unless the caller also runs `daemon uninstall` first. Tracked as a
known gap, not yet fixed — do not rely on `daemon stop` alone to keep the
daemon down on Windows.

Historical note: before this contract, a fatal worker error exited **0**
("Daemon stopped") — which is why the 2026-07-13 incident froze all ensembles
for ~14.5h: even a correctly-installed `Restart=on-failure` unit would not
have restarted it.

## Worker supervision (in-process)

Each of the daemon's two Temporal workers (shared queue: workflows +
delivery activities; per-host queue: spawn/terminate) runs under an
independent supervisor loop (`src/daemon-worker-supervisor.ts`):

- **Fatal `run()` failure** → the dead worker's NativeConnection is closed
  and a fresh Worker + connection is built after capped backoff (1s → 30s).
  The HTTP/SSE surface and the other worker keep serving.
- **Create/connect failure** (Temporal unreachable) → indefinite
  capped-backoff reconnect with a rate-limited log beacon. **Never** counts
  toward the restart budget and never gives up — restarting the local
  Temporal server is a routine operation.
- **Restart budget**: 5 restarts per rolling 10 minutes, counted only for
  fatal failures after a successful create. A run that survives ≥10 minutes
  clears the window. Budget exhausted → `[agent-tempo:ALARM] worker '<name>'
  gave up …`, `daemon.last-exit.json` is written, and the daemon exits `1`.

Live state is served on `GET /v1/health` as `workers` (see
`docs/SSE-PROTOCOL.md` §4.1). The heartbeat file (`daemon.heartbeat`)
refreshes its mtime every 60s **regardless of worker health** — for
dispatch-capability monitoring, `health.workers` is the only truth.

## `daemon.last-exit.json`

One-shot post-mortem marker for an abnormal exit, written BEFORE the process
dies and surfaced once on the next CLI invocation. Schema and semantics
(first-writer-wins, closed `reason` enum, reader-clears) are owned by
`src/utils/last-exit.ts` — see `docs/design/daemon-last-exit-schema.md`.
A clean exit (code 0) writes nothing: absence of the file IS the
"shut down cleanly" signal.

Writers in the daemon:

| `reason` | Write site |
|---|---|
| `worker-give-up` | supervisor `onGiveUp` (src/daemon.ts) — includes `worker`, `restarts`, `lastFatalMessage`, `lastHeartbeatAt`, `bootedAt` |
| `boot-guard-refused` | SA-preflight refusal and #786 protocol-guard refusal |
| `drain-timeout` | the 15s `hardExit` safety-net timer |
| `unhandled-fatal` | the entry-point guard's catch |
| `stale-pid-unexplained` | (CLI-side writer — dead PID found with no self-written marker) |

## Per-platform supervisor reliability (as verified, not as designed)

Design intent treated each platform's native crash-restart (systemd
`Restart=`, launchd `KeepAlive`, Windows Task Scheduler `RestartCount`) as
the primary recovery mechanism, with a periodic re-check as a
belt-and-suspenders backup. **Live testing on Windows during the 2026-07-14
restart window (see incident log below) found this assumption wrong for
that platform** — treat the table below as the current ground truth, updated
as each platform gets its own real-world exercise.

| Platform | Native crash-restart | Status |
|---|---|---|
| Windows (Task Scheduler `RestartCount`/`RestartInterval`) | Restarts on the task's own process exiting abnormally through its **own return path**. Does **NOT** reliably restart on an externally forced kill (`TerminateProcess` — `Stop-Process -Force`, most OOM-kills, most real crashes). Confirmed live: killed the tracked pid, waited 80s past the 60s `RestartInterval`, daemon stayed down; task state reverted to `Ready` with `LastTaskResult 0xFFFFFFFF` instead of queuing a restart. | **BEST-EFFORT ONLY.** The 5-minute periodic recheck task (`agent-tempo-daemon-recheck`) is the actual load-bearing recovery mechanism on Windows — worst-case detection ≤5 min, not the sub-minute figure `RestartCount` alone would suggest. |
| Linux (systemd `Restart=always` + `RestartSec=5`) | Not yet exercised against a real force-kill in production. | **UNVERIFIED.** Flag for the next real-world exercise on this platform. |
| macOS (launchd `KeepAlive` dict form, `SuccessfulExit: false`) | Not yet exercised against a real force-kill in production. | **UNVERIFIED.** Flag for the next real-world exercise on this platform. |

**Operational implication**: don't rely on "I installed supervision" alone as
proof a crash will be caught quickly. On Windows specifically, budget for up
to 5 minutes of downtime after any crash that isn't a clean process exit —
which, in practice, is most of the crash types this whole program exists to
catch (OOM, forced termination, host-level process kills).

## The `daemon install` post-register self-check

Added to `packaging/windows/install-task.ps1` after the incident below: the
script now runs `Start-ScheduledTask` immediately after registering both
tasks and polls (up to 30s) for an actual daemon process to appear, failing
loudly (`exit 1`) if none shows up. This exists because the failure mode
found live was **completely silent** — Task Scheduler reported the task as
successfully registered and later showed `State: Running` on trigger, while
no process ever spawned and no error surfaced anywhere. "The task object
looks valid" is not sufficient evidence that supervision actually works;
only an end-to-end trigger-and-observe check catches this class of bug.

## 2026-07-14 restart-window incident log

During the first real `agent-tempo daemon install` + kill-and-recover smoke
test ever run against a live Windows machine (all prior verification was
unit tests + CI, which cannot exercise a real Task Scheduler), three
findings surfaced — logged as bug-2673/2674/2675 in `.wolf/buglog.json`:

1. **False-positive install success** (bug-2673): `-RepetitionDuration
   ([TimeSpan]::MaxValue)` threw a Task Scheduler XML validation error on
   registration, but because `Register-ScheduledTask` errors are
   non-terminating by default, the script's unconditional success message
   printed anyway — silently leaving `agent-tempo-daemon-recheck`
   unregistered while claiming otherwise. Fixed: bounded 10-year duration +
   `-ErrorAction Stop`/`try`/`catch` on both task registrations.

2. **Silent non-function** (bug-2674): `Get-Command agent-tempo` resolved to
   `agent-tempo.ps1` instead of `agent-tempo.cmd` for a linked/npm-installed
   package (PowerShell's unqualified-name resolution doesn't strictly follow
   Windows' PATHEXT order). Task Scheduler's `-Execute` field cannot launch a
   `.ps1` file directly — the task registered fine, later showed `State:
   Running` on trigger, and never spawned anything. No error anywhere. Fixed:
   explicit `Get-Command agent-tempo.cmd` resolution.

3. **RestartCount force-kill unreliability** (bug-2675): see the table
   above. Not a bug in our code — a genuine Windows Task Scheduler
   limitation, documented as a platform characteristic rather than "fixed."

All three were caught specifically **because** the smoke test was run for
real against production Task Scheduler during the restart window, not
because of anything CI or unit tests could have found — reinforcing that
"install + smoke test" belongs in any future restart runbook, not just this
first one.

**Cost**: roughly 6 minutes of additional daemon downtime beyond the planned
restart window while diagnosing and fixing #1 and #2 live (ensembles stayed
registered throughout; no workflows were touched or lost). Judged worth it —
both bugs would otherwise have shipped invisibly into every future `daemon
install` run on Windows.
