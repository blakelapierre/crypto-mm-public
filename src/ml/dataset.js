import fs from 'fs';
import path from 'path';

export const FEATURES = ['buy', 'level', 'offMid', 'sizeUsd', 'feeBps', 'invSign'];

function logsRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'logs');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), 'logs');
}

function listDebug(root) {
  const out = [];
  function walk(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name.startsWith('debug-') && name.endsWith('.jsonl')) out.push(p);
    }
  }
  walk(root);
  return out;
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** Examples: feature vec + target in [-1,1] = clipped fill edge after fee, signed for wallet. */
export function buildExamples() {
  const files = listDebug(logsRoot());
  const xs = [];
  const ys = [];
  const lastMid = new Map();
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const row = parse(line);
      if (!Array.isArray(row)) continue;
      const kind = row[0];
      if (kind === 1) {
        const sym = row[2];
        const mid = Number(row[8]);
        if (sym && mid > 0) lastMid.set(sym, mid);
      }
      if (kind !== 3 && kind !== 'fill') continue;
      const side = String(row[6] || '').toLowerCase();
      const px = Number(row[8]);
      const size = Number(row[9]);
      const fee = Number(row[10] || 0);
      const mid = Number(row[12]) || lastMid.get(row[5]) || 0;
      const notion = Number(row[13]) || (px && size ? px * size : 0);
      if (!(px > 0 && size > 0 && mid > 0 && notion > 0)) continue;
      const buy = side === 'buy' ? 1 : 0;
      const off = (px - mid) / mid;
      const feeBps = (fee / notion) * 10000;
      const edgeBps = buy ? ((mid - px) / mid) * 10000 - feeBps : ((px - mid) / mid) * 10000 - feeBps;
      const x = [
        buy,
        Math.min(4, Number(row[7] || 1)) / 4,
        Math.max(-0.05, Math.min(0.05, off)) / 0.05,
        Math.max(0, Math.min(1, notion / 20)),
        Math.max(0, Math.min(1, feeBps / 80)),
        buy ? 1 : -1,
      ];
      const y = Math.max(-1, Math.min(1, edgeBps / 80));
      xs.push(x);
      ys.push([y]);
    }
  }
  return { xs, ys };
}
