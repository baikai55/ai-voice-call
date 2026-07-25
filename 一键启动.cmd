@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo   AI语音通话 - 一键启动
echo ========================================
echo.

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\usr\bin\openssl.exe" set "PATH=%ProgramFiles%\Git\usr\bin;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js first.
  pause
  exit /b 1
)

echo [1/5] Free port 8787 / 8788 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports=@(8787,8788); foreach($port in $ports){ $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach($p in $conns){ if($p -and $p -ne 0){ Write-Host ('kill ' + $p + ' port ' + $port); Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } } }; $names=@('workerd','wrangler'); foreach($n in $names){ Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul

if not exist "local-server.mjs" (
  echo [ERROR] local-server.mjs missing
  pause
  exit /b 1
)

echo [2/5] Ensure local HTTPS certs ...
if not exist ".certs\cert.pem" (
  if exist "scripts\gen-local-cert.cmd" call "scripts\gen-local-cert.cmd"
)
if exist ".certs\cert.pem" (
  echo   HTTPS cert ready
) else (
  echo   [WARN] no cert, phone mic may fail on HTTP
)

echo [3/5] Local Node server mode
echo [4/5] Addresses:
node "%~dp0scripts\print-lan-ip.mjs"
echo.

echo [5/5] Starting local-server.mjs ...
echo   PC:          http://127.0.0.1:8787
echo   Phone mic:   https://LAN-IP:8788  ^(recommended^)
echo   WeChat:      ... -^> open in browser, then use HTTPS
echo   Keep this window OPEN while using the app.
echo.

node "%~dp0local-server.mjs"
set "EC=%ERRORLEVEL%"

echo.
if not "%EC%"=="0" (
  echo Server exited with code %EC%
) else (
  echo Server stopped.
)
pause
