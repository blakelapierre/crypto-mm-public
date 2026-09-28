const recent = [];
const byKey = new Map();
const MAX_RECENT = 40;
let total = 0;
let cacheHits = 0;
const started = Date.now();

export function noteApi(venue, label, ms, ok = true) {
  const rec = { venue, label: String(label).slice(0, 80), ms: Math.round(ms), ok, t: Date.now() };
  recent.push(rec);
  if (recent.length > MAX_RECENT) recent.shift();
  total += 1;
  const k = venue + ' ' + rec.label;
  const s = byKey.get(k) || { n: 0, sum: 0, max: 0 };
  s.n += 1;
  s.sum += rec.ms;
  if (rec.ms > s.max) s.max = rec.ms;
  byKey.set(k, s);
  if (rec.ms >= 1000) console.warn('SLOW ' + rec.ms + 'ms ' + venue + ' ' + rec.label);
}

export function noteApiCacheHit() {
  cacheHits += 1;
}

export function snapshotApi() {
  const last = recent.slice(-12);
  const routes = [...byKey.entries()]
    .map(([k, s]) => ({ key: k, n: s.n, avg: Math.round(s.sum / s.n), max: s.max }))
    .sort((a, b) => b.n - a.n);
  const win = recent.length;
  const avg = win ? Math.round(recent.reduce((s, r) => s + r.ms, 0) / win) : 0;
  const max = recent.reduce((m, r) => Math.max(m, r.ms), 0);
  const elapsedSec = Math.max(1, (Date.now() - started) / 1000);
  return {
    last, routes, avg, max,
    n: total,
    cacheHits,
    elapsedSec: Math.round(elapsedSec),
    perMin: Number((total / (elapsedSec / 60)).toFixed(1)),
  };
}

export function printApiTally() {
  const s = snapshotApi();
  console.log('-- API tally n=' + s.n + ' http  cacheHits=' + s.cacheHits + '  ' + s.perMin + '/min  window avg=' + s.avg + 'ms max=' + s.max + 'ms --');
  for (const r of s.routes.slice(0, 15)) {
    console.log('  ' + String(r.n).padStart(4) + '  avg=' + String(r.avg).padStart(4) + 'ms  max=' + String(r.max).padStart(4) + 'ms  ' + r.key);
  }
  return s;
}

export function startApiTally(ms = 10000) {
  printApiTally();
  const id = setInterval(() => { try { printApiTally(); } catch { /* ignore */ } }, ms);
  if (id.unref) id.unref();
  return id;
}
