import { spawn } from 'node:child_process';

/** Windows balloon tip (no deps). Returns true when a toast was attempted. */
export function toast(title, message, { timeoutMs = 6000 } = {}) {
  if (process.platform !== 'win32') return false;
  const esc = s => String(s).replace(/'/g, "''");
  const script = [
    "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');",
    "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing');",
    '$n=New-Object System.Windows.Forms.NotifyIcon;',
    '$n.Icon=[System.Drawing.SystemIcons]::Information;',
    '$n.Visible=$true;',
    `$n.ShowBalloonTip(5000,'${esc(title)}','${esc(message)}',[System.Windows.Forms.ToolTipIcon]::Info);`,
    `Start-Sleep -Seconds ${Math.ceil(timeoutMs / 1000)}; $n.Dispose();`,
  ].join('');
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { stdio: 'ignore', windowsHide: true }).unref?.();
    return true;
  } catch { return false; }
}
