param(
  [Parameter(Mandatory = $false)]
  [switch]$Clean,
  [Parameter(Mandatory = $false)]
  [switch]$Installer,
  [Parameter(Mandatory = $false)]
  [string]$PythonExecutable = ".\.venv\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path -LiteralPath $PythonExecutable)) {
  Write-Error "Python executable not found: $PythonExecutable. Run scripts\setup.ps1 first."
  exit 1
}

# Check pywin32
Write-Host "Checking pywin32 installation..." -ForegroundColor Cyan
$pywin32Check = & $PythonExecutable -c "import win32com.client; import pythoncom; import pywintypes; print('OK')" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "pywin32 is not installed correctly in the venv. Run: .\.venv\Scripts\python.exe -m pip install pywin32"
  exit 1
}
Write-Host "  pywin32: OK" -ForegroundColor Green

Write-Host "Checking pywebview installation..." -ForegroundColor Cyan
$webviewCheck = & $PythonExecutable -c "import webview; print('OK')" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error "pywebview is not installed correctly in the venv. Run scripts\setup.ps1."
  exit 1
}
Write-Host "  pywebview: OK ($webviewCheck)" -ForegroundColor Green

if ($Clean) {
  if (Test-Path ".\build") { Remove-Item -Recurse -Force ".\build" }
  if (Test-Path ".\dist") { Remove-Item -Recurse -Force ".\dist" }
}

Write-Host "Building Tuck with PyInstaller..." -ForegroundColor Cyan
& $PythonExecutable -m PyInstaller --noconfirm scripts/tuck.spec

if ($LASTEXITCODE -ne 0) {
  Write-Error "PyInstaller build failed."
  exit 1
}

if (-not (Test-Path ".\dist\Tuck\Tuck.exe")) {
  Write-Error "Expected dist\Tuck\Tuck.exe (onedir build) missing."
  exit 1
}
Write-Host "OK: dist\Tuck\Tuck.exe" -ForegroundColor Green

if (-not (Test-Path ".\dist\Tuck\TuckCli.exe")) {
  Write-Error "Expected dist\Tuck\TuckCli.exe (onedir build, console) missing."
  exit 1
}
Write-Host "OK: dist\Tuck\TuckCli.exe" -ForegroundColor Green

$webAssets = Get-ChildItem -LiteralPath ".\tuck\web" -File |
  Sort-Object Name |
  Select-Object -ExpandProperty Name
foreach ($asset in $webAssets) {
  $assetPath = ".\dist\Tuck\_internal\tuck\web\$asset"
  if (-not (Test-Path $assetPath)) {
    Write-Error "Expected packaged web UI asset missing: $assetPath"
    exit 1
  }
}
Write-Host "OK: packaged web UI ($($webAssets.Count) assets)" -ForegroundColor Green

# Check pywin32 runtime files
Write-Host "Checking for pywin32 runtime files in dist..." -ForegroundColor Cyan
$pywin32Artifacts = @(
  (Get-ChildItem -Path ".\dist\Tuck" -Filter "pythoncom*.dll" -Recurse -ErrorAction SilentlyContinue),
  (Get-ChildItem -Path ".\dist\Tuck" -Filter "pywintypes*.dll" -Recurse -ErrorAction SilentlyContinue)
) | Where-Object { $_ }
if ($pywin32Artifacts.Count -gt 0) {
  Write-Host "  pywin32 runtime: OK ($($pywin32Artifacts.Count) files found)" -ForegroundColor Green
} else {
  Write-Warning "  WARNING: No pywin32 runtime files (pythoncom*.dll, pywintypes*.dll) found in dist."
  Write-Warning "  Shortcut creation in frozen builds may fail with ImportError."
  Write-Warning "  Ensure pywin32 is installed in the venv before building."
}

if ($Installer) {
  $webViewBootstrapper = ".\scripts\MicrosoftEdgeWebView2Setup.exe"
  if (-not (Test-Path $webViewBootstrapper)) {
    Write-Host "Downloading Evergreen WebView2 Runtime Bootstrapper..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $webViewBootstrapper
  }
  if (-not (Test-Path $webViewBootstrapper)) {
    Write-Error "WebView2 Runtime Bootstrapper download failed."
    exit 1
  }

  $iscc = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $iscc) {
    Write-Warning "Inno Setup 6 not found. Install from https://jrsoftware.org/isdl.php"
    exit 1
  }

  Write-Host "Compiling installer..." -ForegroundColor Cyan
  & $iscc "scripts\installer.iss"

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Inno Setup failed."
    exit 1
  }

  $verLine = Select-String -Path "scripts\installer.iss" -Pattern '#define MyAppVersion' | Select-Object -First 1
  $ver = if ($verLine) { ($verLine.Line -replace '.*"(.+)".*','$1') } else { "unknown" }
  Write-Host "OK: scripts\Output\Tuck-Setup-$ver-x64.exe" -ForegroundColor Green
}
