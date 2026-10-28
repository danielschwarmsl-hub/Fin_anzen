@echo off
REM FinanzRadar – lokaler Start (Windows). Doppelklick genuegt. Fenster offen lassen.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
