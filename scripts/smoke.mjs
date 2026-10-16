import { readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(path.join(root, 'src'));
for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (checked.status) process.exit(checked.status || 1);
}
const imported = spawnSync(process.execPath, ['src/bots/as/index.js'], {
  cwd: root,
  env: { ...process.env, SMOKE: '1' },
  stdio: 'inherit',
});
if (imported.status) process.exit(imported.status || 1);
const stocks = spawnSync(process.execPath, ['src/bots/stocks/index.js'], {
  cwd: root,
  env: { ...process.env, SMOKE: '1', BOT_CONFIG: 'configs/stocks.env' },
  stdio: 'inherit',
});
if (stocks.status) process.exit(stocks.status || 1);
const tests = readdirSync(path.join(root, 'scripts')).filter((name) => /^test-as-v.*\.mjs$/.test(name) || name === 'test-stocks.mjs').sort();
for (const name of tests) {
  const ran = spawnSync(process.execPath, [path.join('scripts', name)], { cwd: root, stdio: 'inherit' });
  if (ran.status) process.exit(ran.status || 1);
}
console.log('smoke ok');
