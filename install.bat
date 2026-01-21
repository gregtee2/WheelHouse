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
echo     Core Installation Complete!
echo  ===============================================
echo.

REM ===================================================
REM Optional: AI Trade Advisor (Ollama + Qwen)
REM ===================================================
echo  OPTIONAL: AI Trade Advisor
echo  -----------------------------------------------
echo  WheelHouse includes an AI-powered trade advisor
echo  that runs locally on your computer using Ollama.
echo.
echo  GPU Requirements:
echo    - NVIDIA GPU with 8GB+ VRAM (recommended)
echo    - Or: Apple Silicon Mac (M1/M2/M3)
echo    - Or: CPU-only (slower, ~30 sec per query)
echo.
echo  The AI model (Qwen 2.5 7B) requires:
echo    - ~5GB disk space
echo    - ~8GB VRAM (GPU) or ~16GB RAM (CPU)
echo.

REM Check for NVIDIA GPU
set "HAS_NVIDIA=0"
nvidia-smi >nul 2>&1
if not errorlevel 1 (
    set "HAS_NVIDIA=1"
    echo  Detected: NVIDIA GPU
    for /f "tokens=*" %%a in ('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2^>nul') do (
        echo    %%a
    )
    echo.
)

if "%HAS_NVIDIA%"=="0" (
    echo  Note: No NVIDIA GPU detected. AI will run on CPU (slower).
    echo.
)

set /p INSTALL_AI="Install AI Trade Advisor? (y/n): "
if /i "%INSTALL_AI%"=="y" (
    call :InstallOllama
) else (
    echo.
    echo  Skipping AI installation.
    echo  You can install later by running: ollama pull qwen2.5:7b
)

echo.
echo  ===============================================
echo     Setup Complete!
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
REM Function: Install Ollama + Qwen model
REM ===================================================
:InstallOllama
echo.
echo  [AI] Checking for Ollama...

where ollama >nul 2>&1
if errorlevel 1 (
    echo  [AI] Ollama not found. Downloading installer...
    
    REM Download Ollama installer
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%TEMP%\OllamaSetup.exe'}"
    
    if not exist "%TEMP%\OllamaSetup.exe" (
        echo  [AI] ERROR: Failed to download Ollama
        echo  [AI] You can install manually from https://ollama.com
        exit /b 1
    )
    
    echo  [AI] Installing Ollama...
    echo  [AI] Please follow the installer prompts.
    start /wait "" "%TEMP%\OllamaSetup.exe"
    
    REM Clean up
    del "%TEMP%\OllamaSetup.exe" >nul 2>&1
    
    REM Verify installation
    where ollama >nul 2>&1
    if errorlevel 1 (
        echo  [AI] Ollama installed but needs PATH update.
        echo  [AI] Please restart your computer and run:
        echo       ollama pull qwen2.5:7b
        exit /b 0
    )
) else (
    echo  [AI] Found Ollama
)

echo.
echo  [AI] Downloading Qwen 2.5 7B model (~5GB)...
echo  [AI] This may take several minutes...
echo.

REM Start Ollama service if not running
start /b ollama serve >nul 2>&1
timeout /t 3 /nobreak >nul

REM Pull the model
ollama pull qwen2.5:7b

if errorlevel 1 (
    echo.
    echo  [AI] Model download failed.
    echo  [AI] Try manually: ollama pull qwen2.5:7b
) else (
    echo.
    echo  [AI] AI Trade Advisor installed successfully!
)

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
