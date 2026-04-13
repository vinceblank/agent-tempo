# claude-tempo daemon — Windows Task Scheduler install script
#
# Registers a per-user scheduled task that starts the daemon at logon and
# keeps it running. User-level only (current user scope; does not require
# Administrator).
#
# Usage:
#   powershell -File install-task.ps1             # install (idempotent)
#   powershell -File install-task.ps1 -Uninstall  # remove

param(
  [switch]$Uninstall
)

$TaskName = 'claude-tempo-daemon'
$TaskDescription = 'claude-tempo daemon — Temporal workers + reconcile loop'

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Unregistered scheduled task: $TaskName"
  } else {
    Write-Output "No scheduled task named $TaskName was registered."
  }
  exit 0
}

# Resolve claude-tempo.cmd (the npm-installed shim on PATH).
$claudeTempo = (Get-Command claude-tempo -ErrorAction SilentlyContinue).Source
if (-not $claudeTempo) {
  Write-Error "claude-tempo not found on PATH. Install it first (`npm i -g claude-tempo`)."
  exit 1
}

# Replace any prior registration so re-runs are idempotent.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

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

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

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
Write-Output "  Trigger: at logon"
