const reservations = [];
const balances = new Map();
const cool = new Map();
let haveBalances = false;
let snapshotAt = 0;

export function noteBalances(positions, asOf) {
  const seen = new Set();
  for (const [sym, p] of Object.entries(positions || {})) {
    const key = String(sym || '').toUpperCase();
    if (!key) continue;
    balances.set(key, Number(p.amount || 0));
    seen.add(key);
  }
  for (const k of [...balances.keys()]) if (!seen.has(k)) balances.set(k, 0);
  haveBalances = true;
  snapshotAt = asOf || Date.now();
  // Available already includes holds for orders placed before this snapshot.
  for (let i = reservations.length - 1; i >= 0; i--) {
    if (!(reservations[i].at > snapshotAt)) reservations.splice(i, 1);
  }
}

export function snapshotAgeMs() {
  return snapshotAt ? Date.now() - snapshotAt : Infinity;
}

export function reservationSnap() {
  const qty = {};
  const nBy = {};
  let oldest = 0;
  const now = Date.now();
  for (const r of reservations) {
    qty[r.sym] = (qty[r.sym] || 0) + r.size;
    nBy[r.sym] = (nBy[r.sym] || 0) + 1;
    const age = (now - r.at) / 1000;
    if (age > oldest) oldest = age;
  }
  return { count: reservations.length, qty, nBy, oldestSec: reservations.length ? oldest : 0, snapshotAt };
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

export function dropSymbolReservations(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return 0;
  let n = 0;
  for (let i = reservations.length - 1; i >= 0; i--) {
    if (reservations[i].sym === sym) { reservations.splice(i, 1); n += 1; }
  }
  return n;
}

export function clearReservations() {
  reservations.length = 0;
}

export function reserved(symbol) {
  const sym = String(symbol || '').toUpperCase();
  let s = 0;
  for (const r of reservations) if (r.sym === sym && r.at > snapshotAt) s += r.size;
  return s;
}

export function sellable(symbol, available) {
  const sym = String(symbol || '').toUpperCase();
  const held = reserved(sym);
  if (available == null && !haveBalances) return held > 0 ? 0 : Infinity;
  const base = available == null ? (balances.get(sym) || 0) : Number(available);
  return Math.max(0, base - held);
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
