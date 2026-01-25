@echo off
title WheelHouse Web Server
color 0B

echo.
echo  ========================================
echo    WheelHouse - Web Server Only
echo    (No Electron, use browser)
echo  ========================================
echo.

cd /d "%~dp0"

:: Kill any existing Node processes on port 8888
echo [1/2] Clearing port 8888...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8888 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Start server
echo [2/2] Starting server...
echo.
echo  Open browser to: http://localhost:8888
echo  Press Ctrl+C to stop
echo.
echo  ========================================
echo.

npm run start:web
