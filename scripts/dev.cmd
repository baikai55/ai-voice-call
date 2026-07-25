@echo off
cd /d "%~dp0\.."
node scripts\print-lan-ip.mjs
call npm run dev
pause