param(
  [switch]$Clean,
  [switch]$SkipSidecar,
  [string]$PythonExecutable = ".\.venv\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path -LiteralPath $PythonExecutable)) {
  Write-Error "Python executable not found: $PythonExecutable. Run scripts\setup.ps1 first."
  exit 1
}
foreach ($tool in @("npm", "cargo")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Error "$tool was not found on PATH."
    exit 1
  }
}

if ($Clean) {
  foreach ($path in @(
      ".\dist", ".\build\sidecar-venv", ".\build\sidecar-pyinstaller",
      ".\packaging\staging", ".\src-tauri\target\release\bundle"
    )) {
    if (Test-Path -LiteralPath $path) { Remove-Item -Recurse -Force -LiteralPath $path }
  }
}

if (-not $SkipSidecar) {
  Write-Host "==> Building the Python sidecar, CLI, and bundled media tools" -ForegroundColor Cyan
  & $PythonExecutable scripts/build_sidecar.py --python $PythonExecutable
  if ($LASTEXITCODE -ne 0) { Write-Error "build_sidecar.py failed."; exit 1 }
}

if (-not (Test-Path -LiteralPath ".\packaging\staging\app\tuck-sidecar.exe")) {
  Write-Error "packaging\staging\app\tuck-sidecar.exe missing. Run without -SkipSidecar."
  exit 1
}

Write-Host "==> Building the Tauri Windows bundle" -ForegroundColor Cyan
# emit the signed updater artifacts only when a signing key is present. a local
# build without one still succeeds, it just skips the .sig / updater package
$tauriArgs = @()
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
  Write-Host "    signing key present -> emitting updater artifacts" -ForegroundColor Cyan
  $tauriArgs = @("--", "--config", '{"bundle":{"createUpdaterArtifacts":true}}')
}
& npm run tauri build @tauriArgs
if ($LASTEXITCODE -ne 0) { Write-Error "npm run tauri build failed."; exit 1 }

$installer = Get-ChildItem -LiteralPath ".\src-tauri\target\release\bundle\nsis" -Filter "*-setup.exe" `
  -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
  Write-Error "No NSIS installer found under src-tauri\target\release\bundle\nsis."
  exit 1
}

Write-Host "==> Verifying the built installer" -ForegroundColor Cyan
& $PythonExecutable scripts/verify_package.py --platform windows --artifact $installer.FullName
if ($LASTEXITCODE -ne 0) { Write-Error "verify_package.py failed."; exit 1 }

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash.ToLower()
Write-Host ""
Write-Host "OK  $($installer.FullName)" -ForegroundColor Green
Write-Host "    SHA-256 $hash" -ForegroundColor Green
Write-Host "    $([math]::Round($installer.Length / 1MB, 1)) MB" -ForegroundColor Green
