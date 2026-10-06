const reservations = [];
const balances = new Map();
const cool = new Map();
let haveBalances = false;

export function noteBalances(positions, asOf) {
  const seen = new Set();
  for (const [sym, p] of Object.entries(positions || {})) {
    const key = String(sym || '').toUpperCase();
    if (!key) continue;
    balances.set(key, Number(p.amount || 0));
    seen.add(key);
  }
  haveBalances = true;
  const cut = asOf || Date.now();
  for (let i = reservations.length - 1; i >= 0; i--) {
    if (reservations[i].at < cut) reservations.splice(i, 1);
  }
}

export function reserveSell(symbol, size, orderId) {
  const sym = String(symbol || '').toUpperCase();
  const n = Number(size);
  if (!sym || !(n > 0)) return;
  reservations.push({ sym, size: n, at: Date.now(), id: orderId || null });
}

export function dropReservation(orderId) {
  if (!orderId) return;
  for (let i = reservations.length - 1; i >= 0; i--) {
    if (reservations[i].id === orderId) reservations.splice(i, 1);
  }
}

export function reserved(symbol) {
  const sym = String(symbol || '').toUpperCase();
  let s = 0;
  for (const r of reservations) if (r.sym === sym) s += r.size;
  return s;
}

export function sellable(symbol, available) {
  const sym = String(symbol || '').toUpperCase();
  if (available == null && !haveBalances) return Infinity;
  const base = available == null ? (balances.get(sym) || 0) : Number(available);
  return Math.max(0, base - reserved(sym));
}

export function freeQty(symbol, available) {
  return sellable(symbol, available);
}

export function coolSide(pair, side) {
  cool.set(String(pair) + '|' + String(side).toLowerCase(), Date.now());
}

export function cooled(pair, side) {
  const t = cool.get(String(pair) + '|' + String(side).toLowerCase()) || 0;
  return Date.now() - t < Number(process.env.FUNDS_COOL_MS || 60000);
}
