' KamHarn watchdog (run by Task Scheduler every 5 min): starts the hub supervisor if it is gone.
' VBS + conhost --headless so that no console window flashes (Windows Terminal as the default terminal
' ignores -WindowStyle Hidden). Registered by scripts\autostart.ps1.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "conhost.exe --headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\hub-service.ps1"" -Detach -Watchdog", 0, False
