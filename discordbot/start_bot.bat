@echo off
setlocal
cd /d "%~dp0"

set "PIDFILE=%~dp0bot.pid"
set "PYEXE=%~dp0.venv\Scripts\pythonw.exe"
set "OUTLOG=%~dp0mention_bot.out.log"
set "ERRLOG=%~dp0mention_bot.err.log"

if exist "%PIDFILE%" (
    for /f "usebackq delims=" %%p in ("%PIDFILE%") do set "OLDPID=%%p"
    tasklist /FI "PID eq %OLDPID%" 2>nul | find /I "%OLDPID%" >nul
    if not errorlevel 1 (
        echo mention-bot already running with PID %OLDPID%.
        exit /b 0
    )
    del "%PIDFILE%" >nul 2>&1
)

if not exist "%PYEXE%" set "PYEXE=pythonw.exe"

powershell -NoProfile -WindowStyle Hidden -Command "$p = Start-Process -FilePath '%PYEXE%' -ArgumentList 'mention_bot.py' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%OUTLOG%' -RedirectStandardError '%ERRLOG%' -PassThru; $p.Id | Out-File -Encoding ascii '%PIDFILE%'"

exit /b 0
