@echo off
setlocal
cd /d "%~dp0"

set "PIDFILE=%~dp0bot.pid"

if not exist "%PIDFILE%" (
    exit /b 0
)

for /f "usebackq delims=" %%p in ("%PIDFILE%") do set "PID=%%p"

tasklist /FI "PID eq %PID%" 2>nul | find /I "%PID%" >nul
if errorlevel 1 (
    del "%PIDFILE%" >nul 2>&1
    exit /b 0
)

taskkill /PID %PID% /T /F >nul 2>&1
del "%PIDFILE%" >nul 2>&1

exit /b 0
