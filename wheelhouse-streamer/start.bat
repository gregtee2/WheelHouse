@echo off
echo Starting WheelHouse Streamer...

REM Activate virtual environment
if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
) else (
    echo ERROR: Virtual environment not found. Run install.bat first.
    pause
    exit /b 1
)

REM Run streamer
python streamer.py

pause
