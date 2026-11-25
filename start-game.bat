@echo off
rem Launch Slate Gambit: start dev server (if not running) and open the browser
cd /d "%~dp0"
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if errorlevel 1 (
  if not exist node_modules call npm install
  start "Slate Gambit server" /min cmd /c "npm run dev -- --port 5173 --strictPort"
  ping -n 6 127.0.0.1 >nul
)
start "" http://localhost:5173/
