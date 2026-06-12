# #777 repro harness — pins the rig + 2 CPU burners to cores 0-1 (mask 3),
# mimicking a 2-core CI runner. Children (Temporal dev server, workers)
# inherit the affinity. The signal-buffer-race wedge fires near-
# deterministically under this profile (iteration 0 on first capture);
# a 4-core-saturation rig structurally cannot fire it.
#
# Usage (from repo root, after npm run build):
#   powershell -File scripts/repro/777-signal-buffer-race.ps1
$root = Resolve-Path "$PSScriptRoot\..\.."
$burners = 1..2 | ForEach-Object {
  Start-Process node -ArgumentList '-e','const e=Date.now()+600000;while(Date.now()<e){Math.sqrt(Math.random())}' -PassThru -WindowStyle Hidden
}
$burners | ForEach-Object { $_.ProcessorAffinity = 3 }
$p = Start-Process node -ArgumentList 'scripts/repro/777-signal-buffer-race.js' -WorkingDirectory $root -PassThru -NoNewWindow `
  -RedirectStandardOutput "$root\repro-777.out" -RedirectStandardError "$root\repro-777.err"
$p.ProcessorAffinity = 3
Write-Host "rig pid $($p.Id), burners $($burners.Id -join ',') — pinned to mask 3; watch repro-777.out"
$p.WaitForExit()
$burners | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Get-Content "$root\repro-777.out" -Tail 10
