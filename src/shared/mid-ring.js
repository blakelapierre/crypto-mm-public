const rings = new Map();
const WINDOW = Number(process.env.RUNG_WINDOW_MS || 15 * 60 * 1000);
const GAP = Number(process.env.RUNG_SAMPLE_MS || 1000);

export function noteMid(symbol, mid, t = Date.now()) {
  sweepMidRings(t);
  const key = String(symbol || '').toUpperCase();
  const px = Number(mid);
  if (!key || !(px > 0)) return;
  const arr = rings.get(key) || [];
  const last = arr[arr.length - 1];
  if (last && t - last.t < GAP) last.p = px;
  else arr.push({ t, p: px });
  while (arr.length && t - arr[0].t > WINDOW) arr.shift();
  const cap = Math.ceil(WINDOW / Math.max(GAP, 500)) + 4;
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  rings.set(key, arr);
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
