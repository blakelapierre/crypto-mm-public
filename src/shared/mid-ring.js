const rings = new Map();
const WINDOW = Number(process.env.RUNG_WINDOW_MS || 15 * 60 * 1000);
const GAP = Number(process.env.RUNG_SAMPLE_MS || 1000);

export function noteMid(symbol, mid, t = Date.now()) {
  const key = String(symbol || '').toUpperCase();
  const px = Number(mid);
  if (!key || !(px > 0)) return;
  const arr = rings.get(key) || [];
  const last = arr[arr.length - 1];
  if (last && t - last.t < GAP) last.p = px;
  else arr.push({ t, p: px });
  while (arr.length && t - arr[0].t > WINDOW) arr.shift();
  rings.set(key, arr);
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

export function trendMult(symbol) {
  const ret = midReturn(symbol);
  const k = Number(process.env.TREND_GAIN || 25);
  return Math.max(0.25, Math.min(2.2, 1 + ret * k));
}
