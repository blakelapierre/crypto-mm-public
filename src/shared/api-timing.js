const recent = [];
const byKey = new Map();
const MAX_RECENT = 40;

export function noteApi(venue, label, ms, ok = true) {
  const rec = { venue, label: String(label).slice(0, 80), ms: Math.round(ms), ok, t: Date.now() };
  recent.push(rec);
  if (recent.length > MAX_RECENT) recent.shift();
  const k = venue + ' ' + rec.label;
  const s = byKey.get(k) || { n: 0, sum: 0, max: 0 };
  s.n += 1;
  s.sum += rec.ms;
  if (rec.ms > s.max) s.max = rec.ms;
  byKey.set(k, s);
  if (rec.ms >= 1000) console.warn('SLOW ' + rec.ms + 'ms ' + venue + ' ' + rec.label);
}

export function snapshotApi() {
  const last = recent.slice(-12);
  const routes = [...byKey.entries()]
    .map(([k, s]) => ({ key: k, n: s.n, avg: Math.round(s.sum / s.n), max: s.max }))
    .sort((a, b) => b.max - a.max)
    .slice(0, 12);
  const n = recent.length;
  const avg = n ? Math.round(recent.reduce((s, r) => s + r.ms, 0) / n) : 0;
  const max = recent.reduce((m, r) => Math.max(m, r.ms), 0);
  return { last, routes, avg, max, n };
}
