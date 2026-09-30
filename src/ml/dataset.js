import fs from 'fs';
import path from 'path';

export const FEATURES = ['buy', 'level', 'offMid', 'sizeUsd', 'feeBps', 'invSign'];

function roots() {
  const out = [];
  const extra = (process.env.NN_LOG_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    out.push(path.join(dir, 'logs'));
    out.push(path.join(dir, 'logs', 'archives'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const e of extra) out.push(path.resolve(e));
  for (const env of [process.env.DEBUG_LOG, process.env.FILL_LOG]) {
    if (env && env !== '0') out.push(path.dirname(path.resolve(process.cwd(), env)));
  }
  return [...new Set(out)];
}

function listLogs() {
  const files = [];
  const seen = new Set();
  function add(p) {
    const abs = path.resolve(p);
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    files.push(abs);
  }
  function walk(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.jsonl$/i.test(name)) continue;
      if (/debug-|fills-/.test(name)) add(p);
    }
  }
  for (const r of roots()) walk(r);
  for (const env of [process.env.DEBUG_LOG, process.env.FILL_LOG, process.env.NN_LOG]) {
    if (env && env !== '0' && env !== 'off') add(path.resolve(process.cwd(), env));
  }
  return files.sort();
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function asFill(row) {
  if (!Array.isArray(row)) return null;
  if (row[0] === 3 || row[0] === 'fill') {
    return {
      pair: row[4],
      symbol: row[5],
      side: row[6],
      level: row[7],
      price: row[8],
      size: row[9],
      fee: row[10],
      mid: row[12],
      notional: row[13],
    };
  }
  return null;
}

function asPlace(row) {
  if (!Array.isArray(row)) return null;
  if (row[0] === 1 || row[0] === 'place') {
    return { symbol: row[2], mid: row[8], price: row[6] };
  }
  return null;
}

export function buildExamples() {
  const files = listLogs();
  console.log('nn logs', files.length, files.map((f) => path.basename(f)).slice(0, 12).join(','));
  const xs = [];
  const ys = [];
  const lastMid = new Map();
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const row = parse(line);
      const place = asPlace(row);
      if (place && place.symbol && Number(place.mid) > 0) {
        lastMid.set(String(place.symbol).toUpperCase(), Number(place.mid));
      }
      const fill = asFill(row);
      if (!fill) continue;
      const pair = String(fill.pair || '');
      const sym = String(fill.symbol || pair.split(/[-/]/)[0] || '').toUpperCase();
      const side = String(fill.side || '').toLowerCase();
      const px = Number(fill.price);
      const size = Number(fill.size);
      const fee = Number(fill.fee || 0);
      let mid = Number(fill.mid);
      if (!(mid > 0) && sym) mid = lastMid.get(sym) || 0;
      if (!(mid > 0)) mid = px;
      const notion = Number(fill.notional) || (px > 0 && size > 0 ? px * size : 0);
      if (!(px > 0 && size > 0 && mid > 0 && notion > 0)) continue;
      if (sym && Number(fill.mid) > 0) lastMid.set(sym, Number(fill.mid));
      const buy = side === 'buy' ? 1 : 0;
      const off = (px - mid) / mid;
      const feeBps = notion > 0 ? (fee / notion) * 10000 : 0;
      const edgeBps = buy
        ? ((mid - px) / mid) * 10000 - feeBps
        : ((px - mid) / mid) * 10000 - feeBps;
      xs.push([
        buy,
        Math.min(4, Number(fill.level || 1)) / 4,
        Math.max(-0.05, Math.min(0.05, off)) / 0.05,
        Math.max(0, Math.min(1, notion / 20)),
        Math.max(0, Math.min(1, feeBps / 80)),
        buy ? 1 : -1,
      ]);
      ys.push([Math.max(-1, Math.min(1, edgeBps / 80))]);
    }
  }
  return { xs, ys, files };
}
