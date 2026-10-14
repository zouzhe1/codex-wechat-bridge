# Registers autostart for the WeChat bridge (supervisor watchdog) via the current
# user's Startup folder - no admin rights required (schtasks /SC ONLOGON needs elevation).
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1
# Note: ASCII-only content on purpose (PowerShell 5.1 misreads BOM-less UTF-8).
param()

$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot 'scripts'
$supervisor = Join-Path $scripts 'supervisor.mjs'
$wrapper = Join-Path $scripts 'bridge-run.cmd'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'ERROR: node is not on PATH; install Node.js 22+'; exit 1 }
if (-not (Test-Path $supervisor)) { Write-Host "ERROR: missing $supervisor"; exit 1 }
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Host 'Installing dependencies (npm install)...'
  Push-Location $PSScriptRoot
  try { npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }
}

# Wrapper cmd: quotes are safe inside a file - none of the PS5.1 native-quoting pitfalls.
# Note: build strings OUTSIDE the array literal - PowerShell splits '+' concatenation
# into separate array elements inside @( ), which would break the quoting.
$cdLine = 'cd /d "' + $PSScriptRoot + '"'
$runLine = '"' + $node + '" "' + $supervisor + '"'
$lines = @('@echo off', $cdLine, $runLine)
Set-Content -Path $wrapper -Value $lines -Encoding ASCII

# Hidden autostart: a .vbs launcher runs the supervisor with window style 0 (no console flash).
$startup = [Environment]::GetFolderPath('Startup')
$entry = Join-Path $startup 'codex-wechat-bridge.vbs'
$exeQuoted = '"' + $node + '" "' + $supervisor + '"'
$vbsEscaped = $exeQuoted.Replace('"', '""')
$vbs1 = 'Set sh = CreateObject("WScript.Shell")'
$vbs2 = 'sh.CurrentDirectory = "' + $PSScriptRoot + '"'
$vbs3 = 'sh.Run "' + $vbsEscaped + '", 0, False'
$vbsLines = @($vbs1, $vbs2, $vbs3)
Set-Content -Path $entry -Value $vbsLines -Encoding ASCII
# drop the legacy .cmd entry from earlier installs
$legacy = Join-Path $startup 'codex-wechat-bridge.cmd'
if (Test-Path $legacy) { Remove-Item $legacy -Force }

if (-not (Test-Path $entry)) { Write-Host "ERROR: failed to create startup entry: $entry"; exit 1 }
Write-Host "OK: autostart registered -> $entry"
Write-Host '    (on logon: supervisor -> worker; log: <repo>/worker.log)'
Write-Host 'Start now : node scripts/cli.mjs start'
Write-Host 'Uninstall : powershell -ExecutionPolicy Bypass -File uninstall.ps1'
