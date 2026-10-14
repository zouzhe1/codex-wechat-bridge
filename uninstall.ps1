# Removes the Startup-folder autostart entry and stops the running bridge.
# ASCII-only content on purpose (PowerShell 5.1 misreads BOM-less UTF-8).
param()

$ErrorActionPreference = 'Continue'
$startup = [Environment]::GetFolderPath('Startup')
$entry = Join-Path $startup 'codex-wechat-bridge.vbs'
$legacy = Join-Path $startup 'codex-wechat-bridge.cmd'
if (Test-Path $entry) { Remove-Item $entry -Force; Write-Host "OK: startup entry removed -> $entry" }
elseif (Test-Path $legacy) { Remove-Item $legacy -Force; Write-Host "OK: legacy startup entry removed -> $legacy" }
else { Write-Host 'Startup entry not present (already uninstalled?).' }

$cli = Join-Path $PSScriptRoot 'scripts\cli.mjs'
if (Test-Path $cli) { node $cli stop 2>$null | Out-Null; Write-Host 'OK: bridge stop requested.' }
