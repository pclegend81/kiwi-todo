@echo off
cd /d "%~dp0"
echo Starting KIWI Todo local server at http://localhost:8765 ...
start "KIWI-Todo-Server" python -m http.server 8765
timeout /t 2 >nul
start "" http://localhost:8765/index.html
echo Browser opened. Close the "KIWI-Todo-Server" window to stop the server.
pause >nul
