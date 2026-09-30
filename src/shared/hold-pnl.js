const pending = new Map();
let realized = 0;
const fills = [];

export function holdRealizedUsd() { return realized; }
export function holdFills() { return fills.slice(); }
export function holdBasis(symbol) {
  const lot = pending.get(String(symbol || '').toUpperCase());
  return lot && lot.mid > 0 ? lot.mid : 0;
}

export function noteHoldExit(symbol, mid, usd) {
  const key = String(symbol || '').toUpperCase();
  const m = Number(mid), u = Number(usd);
  if (!key || !(m > 0) || !(u > 0)) return;
  const qty = u / m;
  const prev = pending.get(key) || { mid: m, qty: 0 };
  pending.set(key, { mid: prev.qty > 0 ? (prev.mid * prev.qty + m * qty) / (prev.qty + qty) : m, qty: prev.qty + qty });
}

export function consumeHoldSale(symbol, price, size, fee, pair) {
  let key = String(symbol || '').toUpperCase();
  if (!key && pair) key = String(pair).split(/[-/]/)[0].toUpperCase();
  const lot = pending.get(key);
  if (!lot || !(lot.qty > 0)) return 0;
  const px = Number(price), qty = Number(size), f = Number(fee || 0);
  if (!(px > 0) || !(qty > 0)) return 0;
  const used = Math.min(qty, lot.qty);
  const pnl = (px - lot.mid) * used - f * (used / qty);
  realized += pnl;
  fills.push({ ts: Date.now(), symbol: key, price: px, size: used, fee: f * (used / qty), pnl });
  while (fills.length > 10) fills.shift();
  lot.qty -= used;
  if (lot.qty <= 1e-12) pending.delete(key);
  else pending.set(key, lot);
  return pnl;
}
