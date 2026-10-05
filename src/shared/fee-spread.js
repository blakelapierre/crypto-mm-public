const MAX = 80;
const byPair = new Map();
const all = [];

function push(bucket, row) {
  bucket.push(row);
  while (bucket.length > MAX) bucket.shift();
}

const venue = [];

export function noteVenueFee(fee, notional, pair = null) {
  const f = Number(fee) || 0;
  const n = Number(notional) || 0;
  if (!(f > 0) || !(n > 0)) return;
  noteFeeFill(f, n, pair);
  push(venue, { fee: f, notional: n, t: Date.now() });
}

export function venueFeeStats() {
  const notional = venue.reduce((s, x) => s + x.notional, 0);
  const fee = venue.reduce((s, x) => s + x.fee, 0);
  return { n: venue.length, fee, notional, bps: bpsFrom(venue) };
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

export function assumedMakerFeeBps(cfg = {}) {
  return Number(process.env.MAKER_FEE_BPS || cfg.makerFeeBps || 35);
}

export function realizedFeeBps(pair = null) {
  if (venue.length >= 20) {
    const real = bpsFrom(venue);
    if (real != null) return real;
  }
  let got = null;
  if (pair) {
    const key = String(pair).toUpperCase();
    const rows = byPair.get(key) || [];
    const local = bpsFrom(rows);
    if (local != null && rows.length >= 3) got = local;
  }
  if (got == null) got = bpsFrom(all);
  const floor = assumedMakerFeeBps();
  if (got == null || got < floor * 0.5) return floor;
  return got;
}

export function spreadBpsForPair(cfg, pair = null) {
  const fee = realizedFeeBps(pair);
  const base = Number(cfg.mmSpreadBps || 15);
  const edge = Number(cfg.minEdgeBps || process.env.MIN_EDGE_BPS || 20);
  const hi = Number(cfg.maxHalfSpreadBps || 250);
  const raw = (fee || assumedMakerFeeBps(cfg)) + edge;
  return Math.min(hi, raw);
}

export function joinTouchForPair(cfg, pair = null) {
  if (!cfg.joinTouch) return false;
  const fee = realizedFeeBps(pair);
  const edge = Number(cfg.minEdgeBps || process.env.MIN_EDGE_BPS || 20);
  if ((fee || assumedMakerFeeBps(cfg)) + edge >= 20) return false;
  return true;
}

export function applySpreadFromFees(cfg, pair = null) {
  return spreadBpsForPair(cfg, pair);
}

export function feeSnapshot() {
  const n = all.length;
  const notional = all.reduce((s, x) => s + x.notional, 0);
  const fee = all.reduce((s, x) => s + x.fee, 0);
  const pairs = [...byPair.entries()].map(([pair, rows]) => ({
    pair, n: rows.length, bps: bpsFrom(rows), fee: rows.reduce((s, x) => s + x.fee, 0),
  })).sort((a, b) => (b.fee || 0) - (a.fee || 0));
  return { n, fee, notional, bps: bpsFrom(all), pairs };
}
