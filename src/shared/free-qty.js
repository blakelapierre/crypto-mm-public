const reservations = [];
const balances = new Map();
const cool = new Map();
let haveBalances = false;

export function noteBalances(positions, asOf) {
  const prev = new Map(balances);
  const seen = new Set();
  for (const [sym, p] of Object.entries(positions || {})) {
    const key = String(sym || '').toUpperCase();
    if (!key) continue;
    balances.set(key, Number(p.amount || 0));
    seen.add(key);
  }
  for (const k of [...balances.keys()]) if (!seen.has(k)) balances.set(k, 0);
  haveBalances = true;
  const cut = asOf || Date.now();
  const grace = Number(process.env.RESERVE_GRACE_MS || 15000);
  const now = Date.now();
  const bySym = new Map();
  for (const r of reservations) {
    if (!bySym.has(r.sym)) bySym.set(r.sym, []);
    bySym.get(r.sym).push(r);
  }
  for (const [sym, rows] of bySym) {
    const before = prev.has(sym) ? Number(prev.get(sym)) : null;
    const after = Number(balances.get(sym) || 0);
    let left = before == null ? 0 : Math.max(0, before - after);
    rows.sort((a, b) => a.at - b.at);
    for (const r of rows) {
      if (r.at >= cut) continue;
      const i = reservations.indexOf(r);
      if (i < 0) continue;
      if (left + 1e-9 >= r.size * 0.5) {
        left -= r.size;
        reservations.splice(i, 1);
        continue;
      }
      if (now - Math.max(r.at, cut) >= grace) reservations.splice(i, 1);
    }
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

export function dropSymbolReservations(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return;
  for (let i = reservations.length - 1; i >= 0; i--) {
    if (reservations[i].sym === sym) reservations.splice(i, 1);
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
