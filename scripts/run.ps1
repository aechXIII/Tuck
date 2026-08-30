param(
  [Parameter(Mandatory = $false)]
  [switch]$Background
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
  Write-Error "Virtual environment not found. Run scripts\setup.ps1 first."
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm was not found. Install a supported Node.js version and run npm ci."
  exit 1
}

Write-Host "Building frontend..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Error "Frontend build failed. Run npm ci, then npm run build, and retry."
  exit 1
}

# Quick dependency check
$check = & .\.venv\Scripts\python.exe -c "import webview, packaging; import win32com.client; print('OK')" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Some dependencies missing or broken. Re-run scripts\setup.ps1."
}

if ($Background) {
  Start-Process -FilePath ".\.venv\Scripts\pythonw.exe" -ArgumentList "-m tuck" -WorkingDirectory (Get-Location)
} else {
  & .\.venv\Scripts\python.exe -m tuck
}
