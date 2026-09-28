const MAX = 80;
const byPair = new Map();
const all = [];

function push(bucket, row) {
  bucket.push(row);
  while (bucket.length > MAX) bucket.shift();
}

export function noteFeeFill(fee, notional, pair = null) {
  const f = Number(fee) || 0;
  const n = Number(notional) || 0;
  if (!(n > 0)) return;
  const row = { fee: f, notional: n, t: Date.now() };
  push(all, row);
  const key = pair ? String(pair).toUpperCase() : null;
  if (key) {
    if (!byPair.has(key)) byPair.set(key, []);
    push(byPair.get(key), row);
  }
}

function bpsFrom(rows) {
  if (!rows || !rows.length) return null;
  const n = rows.reduce((s, x) => s + x.notional, 0);
  const f = rows.reduce((s, x) => s + x.fee, 0);
  if (!(n > 0)) return null;
  return (f / n) * 10000;
}

export function realizedFeeBps(pair = null) {
  if (pair) {
    const key = String(pair).toUpperCase();
    const rows = byPair.get(key) || [];
    const local = bpsFrom(rows);
    if (local != null && rows.length >= 3) return local;
  }
  return bpsFrom(all);
}

export function spreadBpsForPair(cfg, pair = null) {
  const fee = realizedFeeBps(pair);
  const base = cfg.mmSpreadBps || 15;
  if (fee == null) return base;
  const edge = cfg.minEdgeBps || 20;
  const lo = cfg.minHalfSpreadBps || 10;
  const hi = cfg.maxHalfSpreadBps || 200;
  return Math.min(hi, Math.max(lo, fee + edge));
}

export function joinTouchForPair(cfg, pair = null) {
  if (!cfg.joinTouch) return false;
  const fee = realizedFeeBps(pair);
  if (fee != null && fee >= 15) return false;
  return true;
}

export function applySpreadFromFees(cfg, pair = null) {
  return spreadBpsForPair(cfg, pair);
}
