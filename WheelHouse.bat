@echo off
title WheelHouse Launcher
color 0A

echo.
echo  ========================================
echo       WheelHouse - Starting Up
echo  ========================================
echo.

cd /d "%~dp0"

:: Kill any existing Node processes on port 8888
echo [1/5] Clearing port 8888...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8888 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill any existing Python streamer on port 8889
echo        Clearing port 8889...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8889 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill any orphaned node processes from previous runs
taskkill /F /IM node.exe >nul 2>&1

:: Small delay to let ports clear
timeout /t 2 /nobreak >nul

:: Check if node_modules exists
echo [2/5] Checking Node dependencies...
if not exist "node_modules" (
    echo        Installing npm packages...
    call npm install >nul 2>&1
)

:: Check if Electron is installed
if not exist "node_modules\electron" (
    echo        Installing Electron...
    call npm install electron electron-builder --save-dev >nul 2>&1
)

:: Check if Python streamer is set up
echo [3/5] Checking Python streamer...
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

:: Verify port is clear
echo [4/5] Verifying ports are free...
netstat -ano | findstr :8888 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo        WARNING: Port 8888 still in use!
    echo        Waiting 3 more seconds...
    timeout /t 3 /nobreak >nul
)

:: Start Python streamer in background
echo [5/5] Starting services...
echo        Starting Schwab streaming service...
pushd wheelhouse-streamer
start "WheelHouse Streamer" /min cmd /c "call venv\Scripts\activate.bat && python streamer.py"
popd

:: Brief pause to let streamer initialize
timeout /t 2 /nobreak >nul

echo.
echo  ========================================
echo       Services starting...
echo  ========================================
echo.
echo   - Schwab Streamer: ws://localhost:8889
echo   - WheelHouse App:  http://localhost:8888
echo.
echo  ========================================
echo.

:: Start Electron (detached so this window can close)
start "" npm start

:: Give it a moment then exit
timeout /t 2 /nobreak >nul
exit
