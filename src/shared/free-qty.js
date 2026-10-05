const recent = [];
const cool = new Map();

export function reserveSell(symbol, size) {
  const sym = String(symbol || '').toUpperCase();
  const n = Number(size);
  if (!sym || !(n > 0)) return;
  recent.push({ sym, size: n, at: Date.now() });
}

export function reserved(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const ms = Number(process.env.RECENT_SELL_RESERVE_MS || 10000);
  const now = Date.now();
  let s = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (now - r.at > ms) recent.splice(i, 1);
    else if (r.sym === sym) s += r.size;
  }
  return s;
}

export function freeQty(symbol, available) {
  return Math.max(0, Number(available || 0) - reserved(symbol));
}

export function coolSide(pair, side) {
  cool.set(String(pair) + '|' + String(side).toLowerCase(), Date.now());
}

export function cooled(pair, side) {
  const t = cool.get(String(pair) + '|' + String(side).toLowerCase()) || 0;
  return Date.now() - t < Number(process.env.FUNDS_COOL_MS || 60000);
}
