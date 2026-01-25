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
echo [1/4] Clearing port 8888...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8888 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill any orphaned node processes from previous runs
taskkill /F /IM node.exe >nul 2>&1

:: Small delay to let ports clear
timeout /t 2 /nobreak >nul

:: Check if node_modules exists
echo [2/4] Checking dependencies...
if not exist "node_modules" (
    echo        Installing npm packages...
    call npm install >nul 2>&1
)

:: Check if Electron is installed
if not exist "node_modules\electron" (
    echo        Installing Electron...
    call npm install electron electron-builder --save-dev >nul 2>&1
)

:: Verify port is clear
echo [3/4] Verifying port 8888 is free...
netstat -ano | findstr :8888 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo        WARNING: Port 8888 still in use!
    echo        Waiting 3 more seconds...
    timeout /t 3 /nobreak >nul
)

:: Launch WheelHouse
echo [4/4] Launching WheelHouse...
echo.
echo  ========================================
echo       App starting - window will open
echo  ========================================
echo.

:: Start Electron (detached so this window can close)
start "" npm start

:: Give it a moment then exit
timeout /t 2 /nobreak >nul
exit
