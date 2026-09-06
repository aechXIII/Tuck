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

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Error "cargo was not found. Install Rust stable and retry."
  exit 1
}

Write-Host "Starting Tauri development shell..." -ForegroundColor Cyan
if ($Background) {
  Start-Process -FilePath "npm" -ArgumentList "run tauri dev" -WorkingDirectory (Get-Location)
} else {
  & npm run tauri dev
}
