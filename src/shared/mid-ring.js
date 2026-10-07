import fs from 'fs';
import { logPx, pxLogPath } from './px-log.js';

const rings = new Map();
const WINDOW = Number(process.env.RUNG_WINDOW_MS || 15 * 60 * 1000);
const GAP = Number(process.env.RUNG_SAMPLE_MS || 1000);

export function remember(symbol, mid, t = Date.now()) {
  const key = String(symbol || '').toUpperCase();
  const px = Number(mid);
  if (!key || !(px > 0) || !(t > 0)) return;
  const arr = rings.get(key) || [];
  const last = arr[arr.length - 1];
  if (last && t + 1 < last.t) {
    const i = arr.findIndex((x) => x.t > t);
    const prev = i > 0 ? arr[i - 1] : null;
    if (prev && t - prev.t < GAP) prev.p = px;
    else if (i < 0) arr.push({ t, p: px });
    else arr.splice(i, 0, { t, p: px });
  } else if (last && t - last.t < GAP) last.p = px;
  else arr.push({ t, p: px });
  const now = Date.now();
  while (arr.length && now - arr[0].t > WINDOW) arr.shift();
  const cap = Math.ceil(WINDOW / Math.max(GAP, 500)) + 4;
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  rings.set(key, arr);
}

export function noteMid(symbol, mid, t = Date.now()) {
  sweepMidRings(t);
  remember(symbol, mid, t);
  const key = String(symbol || '').toUpperCase();
  const px = Number(mid);
  if (!key || !(px > 0)) return;
  logPx(key, px, t);
}

/** Replay recent px-log samples into the ring without writing them again. */
export function seedPxLog(windowMs = Number(process.env.LIVE_WEIGHT_MS || 60000)) {
  const p = pxLogPath();
  if (!p || !fs.existsSync(p)) return 0;
  let n = 0;
  try {
    const st = fs.statSync(p);
    const take = Math.min(st.size, 512 * 1024);
    const start = Math.max(0, st.size - take);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    let day = null;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Array.isArray(row) && row[0] === 0 && row[1]) day = row[1];
      } catch { /* partial */ }
    }
    if (!day && start > 0) {
      let pos = start;
      while (pos > 0 && !day) {
        const back = Math.min(65536, pos);
        pos -= back;
        const b2 = Buffer.alloc(back);
        const fd2 = fs.openSync(p, 'r');
        fs.readSync(fd2, b2, 0, back, pos);
        fs.closeSync(fd2);
        for (const line of b2.toString('utf8').split('\n')) {
          try {
            const row = JSON.parse(line);
            if (Array.isArray(row) && row[0] === 0 && row[1]) day = row[1];
          } catch { /* partial */ }
        }
      }
    }
    const now = Date.now();
    const cut = now - windowMs;
    for (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(row)) continue;
      if (row[0] === 0 && row[1]) { day = row[1]; continue; }
      if (row[0] !== 1 || !day) continue;
      const t0 = Date.parse(String(day) + 'T00:00:00.000Z');
      const t = t0 + Number(row[1] || 0);
      if (!(t >= cut && t <= now + 2000)) continue;
      remember(row[2], row[3], t);
      n += 1;
    }
  } catch (e) { console.warn('seed px', e.message); }
  if (n) console.log('seed px mids n=' + n);
  return n;
}

let lastSweep = 0;
export function sweepMidRings(now = Date.now()) {
  if (now - lastSweep < 60 * 1000) return;
  lastSweep = now;
  for (const [k, arr] of rings) {
    while (arr.length && now - arr[0].t > WINDOW) arr.shift();
    if (!arr.length) rings.delete(k);
  }
}

export function midRing(symbol) {
  return rings.get(String(symbol || '').toUpperCase()) || [];
}

export function midReturn(symbol, windowMs = WINDOW) {
  const arr = midRing(symbol);
  if (arr.length < 4) return 0;
  const cut = Date.now() - windowMs;
  const pts = arr.filter((x) => x.t >= cut);
  if (pts.length < 4) return 0;
  const a = Number(pts[0].p), b = Number(pts[pts.length - 1].p);
  if (!(a > 0 && b > 0)) return 0;
  return (b - a) / a;
}

export function shortRun(symbol) {
  return midReturn(symbol, Number(process.env.SHORT_RUN_MS || 180000));
}

export function midRangePct(symbol, windowMs = Number(process.env.LIVE_WEIGHT_MS || 60000)) {
  const arr = midRing(symbol);
  const cut = Date.now() - windowMs;
  const pts = arr.filter((x) => x.t >= cut && Number(x.p) > 0);
  if (pts.length < 3) return 0;
  const mids = pts.map((x) => Number(x.p));
  const lo = Math.min(...mids), hi = Math.max(...mids), last = mids[mids.length - 1];
  return last > 0 ? ((hi - lo) / last) * 100 : 0;
}

const trendEma = new Map();
export function trendMult(symbol) {
  const ret = midReturn(symbol);
  const k = Number(process.env.TREND_GAIN || 25);
  const raw = Math.max(0.25, Math.min(2.2, 1 + ret * k));
  const key = String(symbol || '').toUpperCase();
  const prev = trendEma.get(key);
  const a = Number(process.env.TREND_EMA || 0.15);
  const sm = prev == null ? raw : prev + a * (raw - prev);
  trendEma.set(key, sm);
  return sm;
}
