@echo off
REM FinanzRadar - lokaler Start (Windows). Doppelklick genuegt. Fenster offen lassen.
cd /d "%~dp0"
set "FR_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%FR_PS%" set "FR_PS=powershell"
"%FR_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 pause
