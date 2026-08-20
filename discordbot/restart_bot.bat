@echo off
setlocal
cd /d "%~dp0"

call "%~dp0stop_bot.bat"
call "%~dp0start_bot.bat"

exit /b 0
