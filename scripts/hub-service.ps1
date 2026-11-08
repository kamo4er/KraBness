# KamHarn hub supervisor: runs the hub and starts it again whenever it exits
# (restart from the UI = the hub exits with code 75). Logs: data\logs\hub.log
#
#   hub-service.ps1                     run (autostart uses this, see scripts\autostart.ps1)
#   hub-service.ps1 -Takeover -Delay 40 wait, kill the hub that listens on the port, then supervise
#   hub-service.ps1 -Detach             start the supervisor detached and return at once
#   hub-service.ps1 -Stop               stop the supervised hub and the supervisor (the watchdog stays quiet)
#   hub-service.ps1 -Detach -Watchdog   what the scheduled watchdog runs every 5 min (see autostart.ps1):
#                                       starts the supervisor if it is gone, unless the hub was stopped with -Stop
#
# -Takeover and -Detach always relaunch the supervisor through WMI (Win32_Process.Create): its parent becomes
# WmiPrvSE, so it is not a descendant of the hub or of an agent shell and survives their tree kill / job close.
param([switch]$Takeover, [int]$Delay = 0, [switch]$Stop, [switch]$Detach, [switch]$Detached, [switch]$Watchdog, [int]$Port = 7420, [string]$DataDir = '')

$repo = Split-Path -Parent $PSScriptRoot
$dataDir = if ($DataDir) { $DataDir } else { Join-Path $repo 'data' }
$disabledFile = Join-Path $dataDir 'hub.disabled'

if ($Watchdog) {
  if (Test-Path $disabledFile) { exit 0 }
  # supervisor alive -> nothing to do (a cheap check, so the watchdog does not spawn processes every 5 min)
  $m = $null
  if ([System.Threading.Mutex]::TryOpenExisting("Local\KamHarnHubSupervisor-$Port", [ref]$m)) { $m.Dispose(); exit 0 }
}

if (($Takeover -or $Detach) -and -not $Detached) {
  $a = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Detached')
  if ($Takeover) { $a += '-Takeover' }
  if ($Watchdog) { $a += '-Watchdog' }
  if ($Delay -gt 0) { $a += @('-Delay', $Delay) }
  if ($Port -ne 7420) { $a += @('-Port', $Port) }
  if ($DataDir) { $a += @('-DataDir', "`"$DataDir`"") }
  # conhost --headless: with Windows Terminal as the default terminal, -WindowStyle Hidden does not hide the
  # Terminal window, it stays open while the supervisor runs, and closing it kills the supervisor
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'conhost.exe --headless powershell.exe ' + ($a -join ' ') }
  if ($r.ReturnValue -ne 0) { Write-Output "failed to start detached supervisor (code $($r.ReturnValue))"; exit 1 }
  Write-Output "supervisor started detached, pid $($r.ProcessId)"
  exit 0
}

$logDir = Join-Path $dataDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'hub.log'
$stopFile = Join-Path $dataDir 'hub.stop'

# While the hub runs, cmd.exe holds hub.log open exclusively (">>"), so the supervisor cannot write there:
# its own lines go to supervisor.log, and to hub.log too when the file is free (between hub runs).
$supLog = Join-Path $logDir 'supervisor.log'
function Log($m) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} [supervisor] {1}" -f (Get-Date), $m
  Add-Content -Path $supLog -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  Add-Content -Path $log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}
function Listener { Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }

# Kill a process tree without taskkill /T: /T matches children by parent PID only, and PIDs are reused,
# so an unrelated process whose long-dead parent had that PID (this supervisor itself, child of WmiPrvSE)
# would be killed too. A real child is created no earlier than its parent.
function Kill-Tree([int]$RootId) {
  $all = @(Get-CimInstance Win32_Process)
  $root = $all | Where-Object { $_.ProcessId -eq $RootId } | Select-Object -First 1
  if (-not $root) { return }
  $found = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    foreach ($c in $all) {
      if ($c.ParentProcessId -eq $p.ProcessId -and $c.ProcessId -ne $p.ProcessId -and $c.CreationDate -ge $p.CreationDate -and -not $found.Contains($c.ProcessId) -and $c.ProcessId -ne $PID) {
        [void]$found.Add($c.ProcessId); $queue.Enqueue($c)
      }
    }
  }
  $found.Reverse()
  foreach ($id in @($found) + $RootId) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

if ($Stop) {
  New-Item -ItemType File -Force -Path $stopFile | Out-Null
  New-Item -ItemType File -Force -Path $disabledFile | Out-Null
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/hub/restart" -ContentType 'application/json' -Body '{}' | Out-Null } catch { }
  Write-Output 'stop requested'
  exit 0
}

# one supervisor per user session
$mutex = New-Object System.Threading.Mutex($false, "Local\KamHarnHubSupervisor-$Port")
if (-not $mutex.WaitOne(0)) { Write-Output 'supervisor already running'; exit 0 }
Log ("supervisor started, pid {0}{1}" -f $PID, $(if ($Watchdog) { ' (watchdog: previous supervisor was gone)' } else { '' }))
# a normal start turns the watchdog back on
if (-not $Watchdog) { Remove-Item -Force -ErrorAction SilentlyContinue $disabledFile }

if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
if ($Takeover) {
  $l = Listener
  if ($l) {
    Log "takeover: killing pid $($l.OwningProcess) on port $Port"
    Kill-Tree $l.OwningProcess
  }
}
Remove-Item -Force -ErrorAction SilentlyContinue $stopFile

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
$hubDir = Join-Path $repo 'apps\hub'
$env:KAMHARN_SUPERVISED = '1'
$fast = 0

while ($true) {
  # the port may be held by a hub started by hand: wait instead of failing to bind
  $waited = 0
  while (Listener) {
    if ($waited % 60 -eq 0) { Log "port $Port is busy, waiting" }
    Start-Sleep -Seconds 5; $waited += 5
  }
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item -Force $log "$log.1" }

  # an update the hub has downloaded (data\updates\pending.json): swap the files now, while nothing holds them
  $justUpdated = $false
  $pending = Join-Path $dataDir 'updates\pending.json'
  if (Test-Path $pending) {
    $apply = Join-Path $PSScriptRoot 'apply-update.mjs'
    try {
      $staged = Join-Path (Get-Content -Raw $pending | ConvertFrom-Json).stage 'scripts\apply-update.mjs'
      if (Test-Path $staged) { $apply = $staged }
    } catch { }
    Log 'installing update'
    & $node $apply apply --root $repo --data $dataDir 2>&1 | ForEach-Object { Log "$_" }
    if ($LASTEXITCODE -eq 0) { $justUpdated = $true; Log 'update installed' }
    else { Log "update failed (code $LASTEXITCODE), the previous version is back" }
  }

  Log 'starting hub'
  $started = Get-Date
  $cmd = "/d /s /c `"`"$node`" `"$tsx`" src\main.ts >> `"$log`" 2>&1`""
  # Start-Process -Wait in PowerShell 5 waits for the whole process tree via a job object and can hang
  # after the hub has exited; wait for cmd.exe itself instead (the handle is grabbed so ExitCode survives)
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmd -WorkingDirectory $hubDir -WindowStyle Hidden -PassThru
  $null = $p.Handle
  $p.WaitForExit()
  $code = $p.ExitCode
  $ran = ((Get-Date) - $started).TotalSeconds
  Log ("hub exited with code {0} after {1:N0} s" -f $code, $ran)

  if (Test-Path $stopFile) { Remove-Item -Force $stopFile; Log 'stop requested, supervisor exits'; break }
  if ($justUpdated -and $code -ne 75 -and $ran -lt 90) {
    Log 'the new version exited right after start, rolling back'
    & $node (Join-Path $PSScriptRoot 'apply-update.mjs') rollback --root $repo --data $dataDir 2>&1 | ForEach-Object { Log "$_" }
  }
  if ($code -eq 75 -or $ran -gt 30) { $fast = 0; $pause = 1 }
  else { $fast++; $pause = [Math]::Min(60, [Math]::Pow(2, $fast)) }
  if ($pause -gt 1) { Log "crashed quickly $fast time(s) in a row, next start in $pause s" }
  Start-Sleep -Seconds $pause
}
