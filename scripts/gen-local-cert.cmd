@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist ".certs" mkdir ".certs"
set "OPENSSL="
if exist "%ProgramFiles%\Git\usr\bin\openssl.exe" set "OPENSSL=%ProgramFiles%\Git\usr\bin\openssl.exe"
if exist "%ProgramFiles%\OpenSSL-Win64\bin\openssl.exe" set "OPENSSL=%ProgramFiles%\OpenSSL-Win64\bin\openssl.exe"
where openssl >nul 2>&1 && set "OPENSSL=openssl"
if "%OPENSSL%"=="" (
  echo [ERROR] openssl not found. Install Git for Windows or OpenSSL.
  exit /b 1
)
"%OPENSSL%" req -x509 -newkey rsa:2048 -keyout ".certs\key.pem" -out ".certs\cert.pem" -days 3650 -nodes -subj "/CN=localhost"
echo cert generated in .certs
