@echo off
echo Starting WheelHouse on port 8888...
cd /d "%~dp0"
npx serve -l 8888
pause
