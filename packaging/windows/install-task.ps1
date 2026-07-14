# agent-tempo daemon — Windows Task Scheduler install script
#
# Registers TWO per-user scheduled tasks. User-level only (current user
# scope; does not require Administrator):
#
#   agent-tempo-daemon          — the supervised daemon itself. AtLogOn
#                                  trigger, action `daemon start
#                                  --foreground`, with RestartCount/
#                                  RestartInterval so Task Scheduler
#                                  restarts it on a crash (non-zero exit).
#   agent-tempo-daemon-recheck  — a periodic (every 5 min) idempotent
#                                  health-check/self-heal safety net,
#                                  action `daemon start` (no --foreground).
#
# Two SEPARATE tasks because Windows Task Scheduler ties one action set to
# ALL of a task's triggers — there is no way to make "AtLogOn" and "every 5
# minutes" run different actions within a single task definition.
#
# CRITICAL — `daemon start --foreground` now actually runs the daemon IN
# the task's own tracked process (see src/cli/daemon-command.ts). Before
# this fix, --foreground was silently ignored: `daemon start` always forked
# the real daemon as a detached grandchild and the tracked process exited
# almost instantly, so Task Scheduler logged a "successful" quick task, not
# a crash — RestartCount/RestartInterval never fired on a LATER mid-session
# crash of the real (untracked) daemon, because by then Task Scheduler's
# tracked process had already exited on purpose, hours earlier. This is the
# actual root cause of the 2026-07-13 ~14.5h silent-freeze incident
# (docs/research/daemon-supervision-alerting-design.md).
#
# Two layered recovery mechanisms, by design:
#  1. RestartCount/RestartInterval on `agent-tempo-daemon` — Task
#     Scheduler's own crash-restart of ITS tracked (now real, foreground)
#     process. Fast (within RestartInterval), but bounded — gives up after
#     RestartCount attempts within one interval, which a crash-loop
#     exhausts.
#
#     *** KNOWN LIMITATION (confirmed live, 2026-07-14 restart window,
#     bug-2675): RestartCount/RestartInterval does NOT reliably fire when
#     the tracked process is externally FORCE-terminated (TerminateProcess
#     — e.g. `Stop-Process -Force`, an OOM-kill, or most real crashes).
#     Smoke-tested: killed the tracked pid, waited 80s (well past the 60s
#     RestartInterval), daemon stayed down; Task Scheduler's own state
#     reverted to Ready with LastTaskResult 0xFFFFFFFF instead of queuing a
#     restart. This appears to be a known, documented-in-community-reports
#     Windows Task Scheduler behavior: RestartCount is reliable for a task
#     whose action exits abnormally through its OWN return path, not for an
#     externally forced kill. PRACTICAL CONSEQUENCE: on Windows, mechanism 1
#     is BEST-EFFORT ONLY — mechanism 2 below is the actual load-bearing
#     crash recovery, not a belt-and-suspenders backup as originally
#     designed. See docs/ops/daemon.md for the full writeup. systemd's
#     `Restart=always` and launchd's `KeepAlive` have NOT yet been
#     force-kill-tested against a real supervisor in production — treat
#     their reliability under external SIGKILL as unverified until their own
#     next real-world exercise. ***
#
#  2. `agent-tempo-daemon-recheck`'s periodic trigger — re-invokes plain
#     `daemon start` (no --foreground) every 5 minutes. Idempotent and
#     cheap when a daemon is already healthy (a single PID-file stat — see
#     `evaluateStartPreflight` in src/cli/daemon-command.ts, already proven
#     safe under concurrent invocation). When it isn't healthy (mechanism 1
#     exhausted or unreliable per the limitation above, or
#     `agent-tempo-daemon` itself somehow stopped running), this spawns a
#     fresh DETACHED daemon (same as a manual `daemon start`) — unsupervised
#     until the next `agent-tempo-daemon` AtLogOn/restart cycle picks it up
#     via the "already-running" pid-file check, but alive within 5 minutes
#     instead of "until the user next logs in or runs a CLI command." THIS
#     IS THE MECHANISM THAT ACTUALLY BOUNDS WORST-CASE RECOVERY TO ~5
#     MINUTES on Windows, given mechanism 1's confirmed unreliability against
#     force-kills.
#
# Usage:
#   powershell -File install-task.ps1             # install (idempotent)
#   powershell -File install-task.ps1 -Uninstall  # remove

param(
  [switch]$Uninstall
)

$TaskName = 'agent-tempo-daemon'
$RecheckTaskName = 'agent-tempo-daemon-recheck'
$TaskDescription = 'agent-tempo daemon — Temporal workers + reconcile loop'
$RecheckTaskDescription = 'agent-tempo daemon — 5-minute idempotent health-check / self-heal (see agent-tempo-daemon)'

if ($Uninstall) {
  foreach ($name in @($TaskName, $RecheckTaskName)) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Output "Unregistered scheduled task: $name"
    } else {
      Write-Output "No scheduled task named $name was registered."
    }
  }
  exit 0
}

# Resolve agent-tempo.cmd (the npm-installed shim on PATH) — EXPLICITLY by
# the .cmd extension, not the bare `agent-tempo` command name.
#
# BUG FOUND LIVE (2026-07-14 restart window): `(Get-Command agent-tempo
# -ErrorAction SilentlyContinue).Source` resolved to `agent-tempo.ps1`, not
# `agent-tempo.cmd`, when npm creates all three shims (`agent-tempo`,
# `agent-tempo.cmd`, `agent-tempo.ps1`) for a package — e.g. via `npm link`.
# PowerShell's `Get-Command` on an unqualified name doesn't strictly follow
# Windows' PATHEXT executable-resolution order; it can prefer a `.ps1`
# script over a `.cmd` batch file. Task Scheduler's Action `-Execute` field
# CANNOT directly launch a `.ps1` file — `.ps1` isn't a natively executable
# file type for `CreateProcess`, it requires a PowerShell host
# (`powershell.exe -File ...`) to run. The registered task silently
# accepted the bad path (no schema error — it's just a string), then at
# trigger time showed `State: Running` in Task Scheduler while never
# actually spawning a daemon process. No log output, no error, no crash —
# just silent non-function. Exactly the class of gap CI can't catch (no
# real Task Scheduler in the sandbox).
$claudeTempo = (Get-Command agent-tempo.cmd -ErrorAction SilentlyContinue).Source
if (-not $claudeTempo) {
  Write-Error 'agent-tempo.cmd not found on PATH. Install it first (npm i -g agent-tempo).'
  exit 1
}

# Replace any prior registration so re-runs are idempotent.
foreach ($name in @($TaskName, $RecheckTaskName)) {
  $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
}

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

# ── Task 1: the supervised daemon (AtLogOn + crash-restart) ──

$action = New-ScheduledTaskAction `
  -Execute $claudeTempo `
  -Argument 'daemon start --foreground'

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Description $TaskDescription `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -ErrorAction Stop | Out-Null
} catch {
  Write-Error "Failed to register scheduled task '$TaskName': $_"
  exit 1
}

Write-Output "Registered scheduled task: $TaskName"
Write-Output "  Exec:  $claudeTempo daemon start --foreground"
Write-Output "  User:  $env:USERNAME (Interactive, limited)"
Write-Output "  Trigger: at logon (+ restart on crash, up to 3x/min)"

# ── Task 2: the periodic idempotent recheck (belt-and-suspenders) ──

$recheckAction = New-ScheduledTaskAction `
  -Execute $claudeTempo `
  -Argument 'daemon start'

# `-RepetitionDuration ([TimeSpan]::MaxValue)` was found (2026-07-14 restart
# window smoke test) to throw "The task XML contains a value which is
# incorrectly formatted or out of range" from Register-ScheduledTask, even
# though the rendered ISO-8601 duration (P99999999DT23H59M59S) LOOKS like a
# valid, merely-very-large value — Task Scheduler's actual accepted range is
# narrower than what TimeSpan::MaxValue produces. Worse: because
# Register-ScheduledTask errors are NON-TERMINATING by default, the script
# printed "Registered scheduled task: agent-tempo-daemon-recheck" anyway —
# a false-positive success message masking a real registration failure.
# Fixed by (a) using a large-but-actually-valid duration (10 years — plenty
# for "indefinitely" in practice; the task can simply be re-installed if the
# machine somehow stays up past that), and (b) -ErrorAction Stop + try/catch
# so a real failure surfaces as a real failure, not a printed lie.
$recheckTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$recheckSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

try {
  Register-ScheduledTask `
    -TaskName $RecheckTaskName `
    -Description $RecheckTaskDescription `
    -Action $recheckAction `
    -Trigger $recheckTrigger `
    -Settings $recheckSettings `
    -Principal $principal `
    -ErrorAction Stop | Out-Null
} catch {
  Write-Error "Failed to register scheduled task '$RecheckTaskName': $_"
  exit 1
}

Write-Output "Registered scheduled task: $RecheckTaskName"
Write-Output "  Exec:  $claudeTempo daemon start"
Write-Output "  Trigger: every 5 minutes (idempotent no-op when healthy)"

# ── Post-register self-check: does the task ACTUALLY spawn a process? ──
#
# Added after the 2026-07-14 live incident where bug-2674 (the .ps1-vs-.cmd
# shim bug) produced EXACTLY this failure mode: Register-ScheduledTask
# succeeded, Get-ScheduledTask reported the task as valid, Start-ScheduledTask
# reported the task State as "Running" — and NOTHING actually launched. No
# error anywhere in the install path. The only way to catch this class of
# bug is to actually trigger the task and confirm a real daemon process
# exists afterward — a "the task object looks fine" check is not sufficient.
#
# Note on interpreting a PASS here when a daemon was ALREADY running before
# this script ran: `daemon start --foreground` hits the existing
# "already-running" PID-file check (see evaluateStartPreflight in
# src/cli/daemon-command.ts) and returns near-instantly without becoming the
# tracked process — so this self-check still confirms end-to-end health
# (task exists, resolves to a real executable, invocation doesn't error),
# but does NOT re-prove the launch-from-cold path in that specific case. A
# full cold-start proof requires the daemon to actually be down when this
# runs, which `agent-tempo daemon install` does not force (it should not
# stop a healthy daemon just to test itself).
Write-Output ""
Write-Output "Verifying the daemon task actually launches a process..."
Start-ScheduledTask -TaskName $TaskName
$verified = $false
$verifiedPid = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]daemon\.js' } |
    Select-Object -First 1
  if ($proc) {
    $verified = $true
    $verifiedPid = $proc.ProcessId
    break
  }
}
if ($verified) {
  Write-Output "Self-check PASSED: daemon process confirmed running after Start-ScheduledTask (pid $verifiedPid)."
} else {
  Write-Error (
    "Self-check FAILED: no daemon process found within 30s of Start-ScheduledTask -TaskName '$TaskName'. " +
    "The task registered without error but may not actually be able to launch the daemon " +
    "(known cause: Get-Command resolving to a non-executable shim like .ps1 instead of .cmd - " +
    "already fixed once, but re-verify the resolved binary path above is a real .cmd/.exe, not .ps1). " +
    "Do NOT assume supervision is working until this passes."
  )
  exit 1
}
