@echo off
echo ============================================
echo   WheelHouse Streamer - Setup
echo ============================================

REM Check Python version
python --version 2>nul
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.10+
    pause
    exit /b 1
)

REM Create virtual environment if not exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

REM Activate and install
echo Installing dependencies...
call venv\Scripts\activate.bat
pip install -r requirements.txt

echo.
echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo Next steps:
echo   1. Create local_config.json with your Schwab credentials:
echo      {"app_key": "YOUR_KEY", "app_secret": "YOUR_SECRET"}
echo.
echo   2. Run: start.bat
echo.
pause
