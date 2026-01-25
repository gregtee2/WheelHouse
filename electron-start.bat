@echo off
echo Starting WheelHouse Electron App...
echo.

cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

:: Check if electron is installed
if not exist "node_modules\electron" (
    echo Installing Electron...
    call npm install electron electron-builder --save-dev
    echo.
)

:: Start the app
echo Launching WheelHouse...
call npm start

pause
