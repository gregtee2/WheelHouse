@echo off
cd /d "%~dp0"
echo Starting WheelHouse...
echo.
start "" http://localhost:8888
node server.js
pause