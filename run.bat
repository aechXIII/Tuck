@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Virtual environment missing. Running setup...
  call setup.bat
  if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Setup did not create .venv
    pause
    exit /b 1
  )
)

call ".venv\Scripts\activate.bat"
".venv\Scripts\python.exe" -c "import webview, packaging; import win32com.client" 2>nul
if errorlevel 1 (
  echo Dependencies missing or broken. Re-running setup...
  call setup.bat
)

echo Starting Tuck...
".venv\Scripts\python.exe" -m tuck
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Tuck exited with code %ERR%.
  echo.
  pause
)
exit /b %ERR%
