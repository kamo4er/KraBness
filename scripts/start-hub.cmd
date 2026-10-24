@echo off
rem Start the KraBness hub: web UI on http://127.0.0.1:7420 (and on the PC Tailscale address)
cd /d "%~dp0.."
if not exist "apps\web\dist\index.html" call npm run web:build
call npm run hub
pause
