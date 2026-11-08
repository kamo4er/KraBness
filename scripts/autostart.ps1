# Start the KamHarn hub (under scripts\hub-service.ps1) when the user logs in to Windows,
# plus a watchdog task that restarts the supervisor within 5 min if it ever dies.
# No admin rights needed: HKCU Run key + a per-user scheduled task.   autostart.ps1 [-Remove]
param([switch]$Remove)

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'KamHarnHub'
$task = 'KamHarnHubWatchdog'
if ($Remove) {
  Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output 'autostart and watchdog removed'
  exit 0
}
$script = Join-Path $PSScriptRoot 'hub-service.ps1'
$value = "conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
Set-ItemProperty -Path $key -Name $name -Value $value
Write-Output "autostart: $value"

$vbs = Join-Path $PSScriptRoot 'hub-watchdog.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
$t = Get-ScheduledTask -TaskName $task
Write-Output ("watchdog task: {0}, every 5 min, state {1}" -f $task, $t.State)
