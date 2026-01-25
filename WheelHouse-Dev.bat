@echo off
title WheelHouse Developer Mode
color 0E

echo.
echo  ========================================
echo    WheelHouse - DEV MODE (DevTools ON)
echo  ========================================
echo.

cd /d "%~dp0"

:: Kill any existing Node processes on port 8888
echo [1/3] Clearing port 8888...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8888 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Check dependencies
echo [2/3] Checking dependencies...
if not exist "node_modules\electron" (
    echo        Installing Electron...
    call npm install electron electron-builder --save-dev
)

:: Launch in dev mode (DevTools open)
echo [3/3] Launching with DevTools...
echo.

npm run dev

pause
