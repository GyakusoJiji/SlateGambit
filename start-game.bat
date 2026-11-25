@echo off
rem Slate Gambit をワンクリックで起動する(開発サーバーを起動してブラウザを開く)
chcp 65001 >nul
cd /d "%~dp0"

rem すでに 5173 番で動いていればサーバーは起動しない
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if errorlevel 1 (
  if not exist node_modules call npm install
  start "Slate Gambit server" /min cmd /c "npm run dev -- --port 5173 --strictPort"
  timeout /t 4 /nobreak >nul
)
start "" http://localhost:5173/
