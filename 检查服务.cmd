@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Checking Parent Chat service on 8787 ...
echo.
echo --- TCP listeners ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State,OwningProcess | Format-Table -Auto"
echo.
echo --- /api/health ---
curl.exe -s -m 5 http://127.0.0.1:8787/api/health
echo.
echo.
echo --- HOME page ---
curl.exe -s -m 5 -o NUL -w "HOME HTTP %%{http_code} time=%%{time_total}s\n" http://127.0.0.1:8787/
echo.
pause