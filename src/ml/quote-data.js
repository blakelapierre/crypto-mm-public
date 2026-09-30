import fs from 'fs';
import path from 'path';

export const Q_FEATURES = ['buy', 'level', 'offMid', 'sizeUsd', 'ret15', 'ret60', 'range60'];

function walkLogs() {
  const files = [];
  function walk(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.jsonl$/i.test(name) && /^(px-|debug-|fills-)/.test(name)) files.push(p);
    }
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    walk(path.join(dir, 'logs'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const env of [process.env.NN_LOG, process.env.DEBUG_LOG, process.env.PX_LOG_FILE]) {
    if (env && env !== '0') files.push(path.resolve(process.cwd(), env));
  }
  return [...new Set(files)];
}

function parse(line) { try { return JSON.parse(line); } catch { return null; } }

function dayStart(day) { return Date.parse(day + 'T00:00:00.000Z'); }

/** series[sym] = [{t,p}] */
function loadTape(files) {
  const series = new Map();
  let day = null;
  function push(sym, t, p) {
    if (!sym || !(p > 0) || !t) return;
    const k = String(sym).toUpperCase();
    const arr = series.get(k) || [];
    const last = arr[arr.length - 1];
    if (last && last.t === t) last.p = p;
    else arr.push({ t, p });
    series.set(k, arr);
  }
  for (const file of files) {
    if (!/px-/.test(path.basename(file))) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const row = parse(line);
      if (!Array.isArray(row)) continue;
      if (row[0] === 0 || row[0] === 'day') { day = row[1]; continue; }
      if (row[0] === 1 || row[0] === 'px') {
        const t = day ? dayStart(day) + Number(row[1]) : Number(row[1]);
        push(row[2], t, Number(row[3]));
      }
    }
  }
  return series;
}

function midAt(arr, t) {
  if (!arr || !arr.length) return 0;
  let best = arr[0];
  for (const x of arr) {
    if (x.t <= t) best = x;
    else break;
  }
  return best.p;
}

function stats(arr, t, win) {
  if (!arr) return { ret: 0, range: 0 };
  const loT = t - win;
  let a = null, hi = 0, lo = Infinity, last = 0;
  for (const x of arr) {
    if (x.t < loT) continue;
    if (x.t > t) break;
    if (!a) a = x.p;
    last = x.p;
    if (x.p > hi) hi = x.p;
    if (x.p < lo) lo = x.p;
  }
  const ret = a > 0 && last > 0 ? (last - a) / a : 0;
  const range = last > 0 && hi > 0 && lo < Infinity ? (hi - lo) / last : 0;
  return { ret, range };
}

export function buildQuoteExamples() {
  const files = walkLogs();
  const tape = loadTape(files);
  const xs = [];
  const ys = [];
  let day = null;
  for (const file of files) {
    if (!/debug-|fills-/.test(path.basename(file))) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lastMid = new Map();
    for (const line of text.split('\n')) {
      const row = parse(line);
      if (!Array.isArray(row)) continue;
      if (row[0] === 6 || row[0] === 'day') { day = row[1]; continue; }
      if (row[0] === 1) {
        const sym = String(row[2] || '').toUpperCase();
        if (sym && Number(row[8]) > 0) lastMid.set(sym, Number(row[8]));
        continue;
      }
      if (row[0] !== 3 && row[0] !== 'fill') continue;
      const pair = String(row[4] || '');
      const sym = String(row[5] || pair.split(/[-/]/)[0] || '').toUpperCase();
      const side = String(row[6] || '').toLowerCase();
      const px = Number(row[8]);
      const size = Number(row[9]);
      const fee = Number(row[10] || 0);
      let mid = Number(row[12]) || lastMid.get(sym) || 0;
      const t = day ? dayStart(day) + Number(row[1]) : Date.now();
      const arr = tape.get(sym);
      if (!(mid > 0)) mid = midAt(arr, t) || px;
      const notion = Number(row[13]) || px * size;
      if (!(px > 0 && size > 0 && mid > 0 && notion > 0)) continue;
      const s15 = stats(arr, t, 15000);
      const s60 = stats(arr, t, 60000);
      const fwd = arr ? (midAt(arr, t + 30000) - mid) / mid : 0;
      const buy = side === 'buy' ? 1 : 0;
      const off = (px - mid) / mid;
      const feeBps = (fee / notion) * 10000;
      const edge = buy ? ((mid - px) / mid) * 10000 - feeBps : ((px - mid) / mid) * 10000 - feeBps;
      const sign = buy ? 1 : -1;
      const sizeT = Math.max(-1, Math.min(1, (edge / 40) + sign * fwd * 20));
      const bidAdd = Math.max(-1, Math.min(1, -(fwd * 25)));
      const askAdd = Math.max(-1, Math.min(1, fwd * 25));
      xs.push([
        buy,
        Math.min(4, Number(row[7] || 1)) / 4,
        Math.max(-0.05, Math.min(0.05, off)) / 0.05,
        Math.max(0, Math.min(1, notion / 20)),
        Math.max(-1, Math.min(1, s15.ret * 50)),
        Math.max(-1, Math.min(1, s60.ret * 20)),
        Math.max(0, Math.min(1, s60.range * 20)),
      ]);
      ys.push([sizeT, bidAdd, askAdd]);
    }
  }
  return { xs, ys, files };
}
