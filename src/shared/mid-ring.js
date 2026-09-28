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
