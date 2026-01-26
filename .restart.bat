@echo off
            timeout /t 2 /nobreak >nul
            for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8888 ^| findstr LISTENING 2^>nul') do (
                taskkill /F /PID %%a >nul 2>&1
            )
            cd /d "C:\\WheelHouse"
            node server.js