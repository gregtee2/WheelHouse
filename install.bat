@echo off
REM === KEEP WINDOW OPEN WRAPPER ===
if not defined INSTALL_WRAPPER (
    set "INSTALL_WRAPPER=1"
    cmd /k "%~f0" %*
    exit /b
)

setlocal EnableDelayedExpansion
title WheelHouse - Installer
color 0A

echo.
echo  ===============================================
echo     WheelHouse - One-Click Installer
echo     Options Strategy Analyzer
echo  ===============================================
echo.

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM ===================================================
REM Step 1: Check for Node.js
REM ===================================================
echo [1/2] Checking for Node.js...

where node >nul 2>&1
if errorlevel 1 (
    echo    Node.js not found. Installing automatically...
    echo.
    call :InstallNodeJS
    if errorlevel 1 (
        goto :NodeInstallFailed
    )
    
    REM Add Node.js to PATH for this session
    set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm"
    
    REM Verify it worked
    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  Node.js was installed but PATH needs a restart.
        echo  Please CLOSE this window, RESTART your computer,
        echo  then run install.bat again.
        echo.
        pause
        exit /b 0
    )
    echo    Node.js installed successfully!
) else (
    for /f "tokens=*" %%a in ('node -v') do echo    Found Node.js %%a
)

REM ===================================================
REM Step 2: Install npm dependencies
REM ===================================================
echo.
echo [2/2] Installing dependencies...

if exist "package.json" (
    call npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed!
        echo.
        pause
        exit /b 1
    )
    echo    Dependencies installed!
) else (
    echo    No package.json found - skipping npm install
)

REM ===================================================
REM Installation Complete
REM ===================================================
echo.
echo  ===============================================
echo     Installation Complete!
echo  ===============================================
echo.
echo  To start WheelHouse, double-click:
echo     start.bat
echo.
echo  Or run: node server.js
echo.
pause
exit /b 0

REM ===================================================
REM Function: Install Node.js
REM ===================================================
:InstallNodeJS
echo  Downloading Node.js installer...

REM Use PowerShell to download
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi' -OutFile '%TEMP%\node_installer.msi'}"

if not exist "%TEMP%\node_installer.msi" (
    echo  ERROR: Failed to download Node.js
    echo  Please install Node.js manually from https://nodejs.org
    exit /b 1
)

echo  Installing Node.js (this may take a minute)...
msiexec /i "%TEMP%\node_installer.msi" /passive /norestart

REM Clean up
del "%TEMP%\node_installer.msi" >nul 2>&1

exit /b 0

:NodeInstallFailed
echo.
echo  ===============================================
echo  Node.js installation failed.
echo  Please install manually from https://nodejs.org
echo  Then run this installer again.
echo  ===============================================
echo.
pause
exit /b 1
