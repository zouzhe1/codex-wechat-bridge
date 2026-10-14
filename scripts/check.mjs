import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(root, 'scripts');
const testsDir = path.join(root, 'tests');

let failed = false;
for (const file of readdirSync(scriptsDir).filter(f => f.endsWith('.mjs'))) {
  const r = spawnSync(process.execPath, ['--check', path.join(scriptsDir, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
if (failed) process.exit(1);

const tests = readdirSync(testsDir).filter(f => f.endsWith('.test.mjs')).map(f => path.join(testsDir, f));
const r = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
