@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo   AI语音通话 - 一键启动
echo ========================================
echo.

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js first.
  pause
  exit /b 1
)

where pwsh >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell 7 ^(pwsh^) not found. Install PowerShell 7 first.
  pause
  exit /b 1
)

if not exist "local-server.mjs" (
  echo [ERROR] local-server.mjs missing
  pause
  exit /b 1
)

echo [1/3] Checking port 8787 ...
set "AI_VOICE_SERVER=%~dp0local-server.mjs"
pwsh -NoProfile -ExecutionPolicy Bypass -Command ^
  "$target=[IO.Path]::GetFullPath($env:AI_VOICE_SERVER); $owners=@(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue ^| Select-Object -ExpandProperty OwningProcess -Unique); foreach($ownerId in $owners){ if(-not $ownerId){ continue }; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerId) -ErrorAction SilentlyContinue; $cmd=[string]$proc.CommandLine; if($cmd.IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0){ Write-Host ('Stopping previous project server PID ' + $ownerId); Stop-Process -Id $ownerId -Force -ErrorAction Stop } else { Write-Error ('Port 8787 is occupied by another process (PID ' + $ownerId + '). Close it manually and retry.'); exit 2 } }; Start-Sleep -Milliseconds 500; if(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue){ Write-Error 'Port 8787 is still occupied.'; exit 3 }"
if errorlevel 1 (
  echo [ERROR] Cannot start while port 8787 is occupied.
  pause
  exit /b 1
)

echo [2/3] Address:
echo   PC: http://127.0.0.1:8787
echo   Phone: use the deployed Cloudflare HTTPS address
echo.

echo [3/3] Starting local-server.mjs ...
echo   Keep this window OPEN while using the local app.
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
