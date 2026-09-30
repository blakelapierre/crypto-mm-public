import fs from 'fs';
import path from 'path';

const SHAPES = [
  ['day', 'date'],
  ['px', 'ts', 's', 'mid'],
];

let dest = null;
let dayKey = null;
const last = new Map();

function botName() {
  return String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
}

export function pxLogPath() {
  if (['0', 'off', 'false'].includes(String(process.env.PX_LOG || '1').toLowerCase())) return null;
  const rel = process.env.PX_LOG_FILE || ('logs/px-' + botName() + '.jsonl');
  return path.resolve(process.cwd(), rel);
}

function packTs(isoMs) {
  const d = new Date(isoMs);
  const key = d.toISOString().slice(0, 10);
  const start = Date.parse(key + 'T00:00:00.000Z');
  if (dayKey !== key) {
    dayKey = key;
    append([0, key]);
  }
  return isoMs - start;
}

function append(row) {
  const p = pxLogPath();
  if (!p) return;
  if (!dest) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    dest = p;
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
      fs.appendFileSync(p, JSON.stringify(['shapes', SHAPES]) + '\n');
    }
  }
  fs.appendFileSync(dest, JSON.stringify(row) + '\n');
}

export function rotatePxLog() {
  const p = pxLogPath();
  dest = null;
  dayKey = null;
  last.clear();
  if (!p || !fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(p), 'archives');
  fs.mkdirSync(dir, { recursive: true });
  const arch = path.join(dir, path.basename(p).replace(/\.jsonl$/i, '') + '-' + stamp + '.jsonl');
  try {
    fs.renameSync(p, arch);
    console.log('rotated ' + p + ' -> ' + arch);
  } catch (e) { console.warn('px rotate', e.message); }
}

/** Compact mid sample for active names. Default 1s or ≥1bp move. */
export function logPx(symbol, mid, t = Date.now()) {
  const key = String(symbol || '').toUpperCase();
  const px = Number(mid);
  if (!key || !(px > 0)) return;
  const gap = Number(process.env.PX_LOG_MS || 1000);
  const prev = last.get(key);
  if (prev && t - prev.t < gap && Math.abs(px - prev.p) / prev.p < 0.0001) return;
  last.set(key, { t, p: px });
  try { append([1, packTs(t), key, px]); } catch { /* ignore */ }
}
