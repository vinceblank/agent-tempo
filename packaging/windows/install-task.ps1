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
#  2. `agent-tempo-daemon-recheck`'s periodic trigger — re-invokes plain
#     `daemon start` (no --foreground) every 5 minutes. Idempotent and
#     cheap when a daemon is already healthy (a single PID-file stat — see
#     `evaluateStartPreflight` in src/cli/daemon-command.ts, already proven
#     safe under concurrent invocation). When it isn't healthy (mechanism 1
#     exhausted, or `agent-tempo-daemon` itself somehow stopped running),
#     this spawns a fresh DETACHED daemon (same as a manual `daemon start`)
#     — unsupervised until the next `agent-tempo-daemon` AtLogOn/restart
#     cycle picks it up via the "already-running" pid-file check, but alive
#     within 5 minutes instead of "until the user next logs in or runs a
#     CLI command." Bounds the worst-case recovery window to ~5 minutes
#     even if mechanism 1 is exhausted.
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

# Resolve agent-tempo.cmd (the npm-installed shim on PATH).
$claudeTempo = (Get-Command agent-tempo -ErrorAction SilentlyContinue).Source
if (-not $claudeTempo) {
  Write-Error "agent-tempo not found on PATH. Install it first (`npm i -g agent-tempo`)."
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

Register-ScheduledTask `
  -TaskName $TaskName `
  -Description $TaskDescription `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal | Out-Null

Write-Output "Registered scheduled task: $TaskName"
Write-Output "  Exec:  $claudeTempo daemon start --foreground"
Write-Output "  User:  $env:USERNAME (Interactive, limited)"
Write-Output "  Trigger: at logon (+ restart on crash, up to 3x/min)"

# ── Task 2: the periodic idempotent recheck (belt-and-suspenders) ──

$recheckAction = New-ScheduledTaskAction `
  -Execute $claudeTempo `
  -Argument 'daemon start'

$recheckTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$recheckSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $RecheckTaskName `
  -Description $RecheckTaskDescription `
  -Action $recheckAction `
  -Trigger $recheckTrigger `
  -Settings $recheckSettings `
  -Principal $principal | Out-Null

Write-Output "Registered scheduled task: $RecheckTaskName"
Write-Output "  Exec:  $claudeTempo daemon start"
Write-Output "  Trigger: every 5 minutes (idempotent no-op when healthy)"
