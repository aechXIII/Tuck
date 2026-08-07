param(
  [Parameter(Mandatory = $false)]
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

& $Python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) {
  Write-Error "Python 3.10 or newer is required."
  exit 1
}

Write-Host "Setting up Tuck virtual environment..." -ForegroundColor Cyan

& $Python -m venv .venv
if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to create .venv. Ensure Python 3.10+ is installed and on PATH."
  exit 1
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -e ".[dev]"

if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to install dependencies. Check pyproject.toml [project.optional-dependencies] dev section."
  exit 1
}

Write-Host "OK: .venv is ready." -ForegroundColor Green
Write-Host "  Run:   .\scripts\run.ps1             (GUI)" -ForegroundColor White
Write-Host "  Build: .\scripts\build.ps1           (PyInstaller)" -ForegroundColor White
Write-Host "  Build: .\scripts\build.ps1 -Installer (PyInstaller + Inno Setup)" -ForegroundColor White
