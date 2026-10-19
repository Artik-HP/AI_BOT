@echo off
cd /d "%~dp0"
node scripts\open-web.js
if errorlevel 1 pause
