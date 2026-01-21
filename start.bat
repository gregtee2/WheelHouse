@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo   WheelHouse Launcher
echo ============================================
echo.

REM Kill any orphaned process on port 8888 ONLY (won't affect T2AutoTron on 3000)
echo Checking for orphaned processes on port 8888...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8888 ^| findstr LISTENING 2^>nul') do (
    echo   Found orphaned process PID %%a - killing...
    taskkill /F /PID %%a >nul 2>&1
)
echo   Port 8888 is clear.
echo.

echo Starting WheelHouse server...
start "" http://localhost:8888
node server.js
pause