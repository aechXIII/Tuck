@echo off
setlocal
cd /d "%~dp0"

echo.
echo  Tuck setup
echo  ----------
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH.
  echo Install Python 3.10+ from https://www.python.org/downloads/
  echo Tick "Add python.exe to PATH" during install, then run setup.bat again.
  echo.
  pause
  exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" 2>nul
if errorlevel 1 (
  echo [ERROR] Python 3.10 or newer is required.
  python --version
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 (
    echo [ERROR] Could not create .venv
    pause
    exit /b 1
  )
)

echo Installing dependencies...
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo [ERROR] pip install failed.
  pause
  exit /b 1
)

python -c "import webview, packaging; import win32com.client; print('OK')" 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Packages installed but imports still fail.
  pause
  exit /b 1
)

echo.
echo Setup finished. Double-click run.bat to start Tuck.
echo.
pause
exit /b 0
