@echo off
setlocal EnableDelayedExpansion
title WheelHouse
color 0B

echo.
echo  ===============================================
echo     WheelHouse - Options Strategy Analyzer
echo  ===============================================
echo.

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo  ERROR: Node.js not found!
    echo.
    echo  Please run install.bat first.
    echo.
    pause
    exit /b 1
)

REM Kill any existing Node.js processes on port 8888
echo  Checking for existing server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8888 ^| findstr LISTENING 2^>nul') do (
    echo  Stopping existing server (PID: %%a)...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM Start the server
echo  Starting WheelHouse server...
echo.

REM Open browser after a short delay
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8888"

REM Start the server (keeps window open)
node server.js

REM If server exits, pause
echo.
echo  Server stopped.
pause
