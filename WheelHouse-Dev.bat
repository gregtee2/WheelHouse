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
echo [1/4] Clearing port 8888...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8888 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill any existing Python streamer on port 8889
echo        Clearing port 8889...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8889 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: Check dependencies
echo [2/4] Checking dependencies...
if not exist "node_modules\electron" (
    echo        Installing Electron...
    call npm install electron electron-builder --save-dev
)

:: Check if Python streamer is set up
echo [3/4] Checking Python streamer...
if not exist "wheelhouse-streamer\venv" (
    echo        Setting up Python streamer...
    pushd wheelhouse-streamer
    python -m venv venv >nul 2>&1
    call venv\Scripts\activate.bat
    pip install -r requirements.txt >nul 2>&1
    call deactivate
    popd
    echo        Python streamer installed!
)

:: Start Python streamer in VISIBLE window for debugging
echo [4/4] Starting services...
echo        Starting Schwab streaming service (visible)...
pushd wheelhouse-streamer
start "WheelHouse Streamer" cmd /k "call venv\Scripts\activate.bat && python streamer.py"
popd

:: Brief pause to let streamer initialize
timeout /t 2 /nobreak >nul

echo.
echo  ========================================
echo       DEV MODE - Services starting
echo  ========================================
echo.
echo   - Schwab Streamer: ws://localhost:8889 (visible window)
echo   - WheelHouse App:  http://localhost:8888 (DevTools)
echo.
echo  ========================================
echo.

:: Launch in dev mode (DevTools open)
npm run dev

pause
