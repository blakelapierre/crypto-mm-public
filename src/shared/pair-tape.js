const last = new Map();
const WINDOW = Number(process.env.TAPE_WINDOW_MS || 60 * 60 * 1000);

function rec(pair) {
  const k = String(pair || '').toUpperCase();
  if (!last.has(k)) last.set(k, { fills: [] });
  return last.get(k);
}

function prune(r, now = Date.now()) {
  const cut = now - WINDOW;
  r.fills = (r.fills || []).filter((x) => x.t >= cut);
}

export function noteTapeFill(pair, side, price, size) {
  const px = Number(price), q = Number(size);
  if (!(px > 0) || !(q > 0) || !pair) return;
  const r = rec(pair);
  r.fills.push({ t: Date.now(), side: String(side).toLowerCase(), px, q, n: px * q });
  prune(r);
}

function sums(r) {
  prune(r);
  let buyNot = 0, sellNot = 0, buyQ = 0, sellQ = 0;
  for (const x of r.fills) {
    if (x.side === 'buy') { buyNot += x.n; buyQ += x.q; }
    else { sellNot += x.n; sellQ += x.q; }
  }
  return { buyNot, sellNot, buyQ, sellQ, n: r.fills.length };
}

export function tapeEdgeBps(pair) {
  const s = sums(rec(pair));
  if (!(s.buyQ > 0) || !(s.sellQ > 0)) return null;
  const ab = s.buyNot / s.buyQ;
  const as_ = s.sellNot / s.sellQ;
  const mid = (ab + as_) / 2;
  if (!(mid > 0)) return null;
  return ((as_ - ab) / mid) * 10000;
}

export function tapeSizeMult(pair) {
  const e = tapeEdgeBps(pair);
  if (e == null) return 1;
  if (e < 0) return Number(process.env.NEG_EDGE_SIZE_MULT || 0.35);
  return Number(process.env.POS_EDGE_SIZE_MULT || 1.35);
}

export function tapeStats(pair) {
  const s = sums(rec(pair));
  return { edgeBps: tapeEdgeBps(pair), buyN: s.n, sellN: s.n, buyUsd: s.buyNot, sellUsd: s.sellNot };
}

export function bookEdgeBps() {
  let w = 0, acc = 0;
  for (const [pair] of last) {
    const e = tapeEdgeBps(pair);
    if (e == null) continue;
    const s = sums(rec(pair));
    const n = s.buyNot + s.sellNot;
    if (!(n > 0)) continue;
    acc += e * n;
    w += n;
  }
  if (!(w > 0)) return null;
  return acc / w;
}

const ripAt = new Map();
export function markRipSell(symbol) {
  ripAt.set(String(symbol || '').toUpperCase(), Date.now());
}
export function inRipCooldown(symbol) {
  const t = ripAt.get(String(symbol || '').toUpperCase()) || 0;
  return Date.now() - t < Number(process.env.RIP_COOLDOWN_MS || 180000);
}
