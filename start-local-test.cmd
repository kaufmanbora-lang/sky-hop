@echo off
setlocal
cd /d "%~dp0"
set "SKYHOP_PYTHON=C:\Users\borys\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if not exist "%SKYHOP_PYTHON%" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python not found. Open README.md for manual launch instructions.
    pause
    exit /b 1
  )
  set "SKYHOP_PYTHON=python"
)

start "Sky Hop local server" /min "%SKYHOP_PYTHON%" -m http.server 4173 --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" "http://localhost:4173/?desktop=1"

echo Sky Hop is running at http://localhost:4173/?desktop=1
echo Close the minimized Sky Hop server window to stop the local server.
endlocal
