export function createPnl() {
  const books = new Map();
  let startEquity = null;
  let lastEquity = null;
  let feesPaid = 0;

  function book(symbol) {
    const key = String(symbol || '?').toUpperCase();
    if (!books.has(key)) {
      books.set(key, { boughtQty: 0, boughtCost: 0, soldQty: 0, soldProceeds: 0, realized: 0, fees: 0, fills: 0 });
    }
    return books.get(key);
  }
  function symbolOf(rec) {
    if (rec.symbol) return String(rec.symbol).toUpperCase();
    const p = String(rec.pair || '');
    if (p.includes('-')) return p.split('-')[0].toUpperCase();
    return p.replace(/USD[C]?$/i, '').toUpperCase();
  }
  function recordFill(rec) {
    if (!rec) return;
    const qty = Number(rec.size);
    const px = Number(rec.price);
    const fee = Number(rec.fee || 0) || 0;
    if (!(qty > 0) || !(px > 0)) return;
    const b = book(symbolOf(rec));
    b.fills += 1; b.fees += fee; feesPaid += fee;
    const notional = rec.filledValue > 0 ? Number(rec.filledValue) : qty * px;
    if (String(rec.side).toLowerCase() === 'buy') {
      b.boughtQty += qty;
      b.boughtCost += notional + fee;
      return;
    }
    const proceeds = Math.max(0, notional - fee);
    const avg = b.boughtQty > 0 ? b.boughtCost / b.boughtQty : px;
    const used = Math.min(qty, b.boughtQty);
    if (used > 0) {
      b.realized += proceeds * (used / qty) - avg * used;
      const left = b.boughtQty - used;
      b.boughtCost = left > 0 ? b.boughtCost * (left / b.boughtQty) : 0;
      b.boughtQty = left;
    }
    b.soldQty += qty;
    b.soldProceeds += proceeds;
  }
  function markWallet(equity) {
    const n = Number(equity);
    if (!Number.isFinite(n)) return;
    if (startEquity == null) startEquity = n;
    lastEquity = n;
  }
  function snapshot(mids = {}) {
    let realized = 0; let unrealized = 0; const rows = [];
    for (const [symbol, b] of books) {
      const mid = Number(mids[symbol] || 0);
      const avg = b.boughtQty > 0 ? b.boughtCost / b.boughtQty : 0;
      const u = b.boughtQty > 0 && mid > 0 ? mid * b.boughtQty - b.boughtCost : 0;
      realized += b.realized; unrealized += u;
      rows.push({ symbol, fills: b.fills, fees: b.fees, boughtQty: b.boughtQty, avgCost: avg, soldQty: b.soldQty, realized: b.realized, unrealized: u, total: b.realized + u });
    }
    const wallet = startEquity != null && lastEquity != null ? lastEquity - startEquity : null;
    return { rows, realized, unrealized, fees: feesPaid, fillTotal: realized + unrealized, startEquity, lastEquity, walletGain: wallet };
  }
  function print(mids = {}, tag = 'MM gain') {
    const s = snapshot(mids);
    console.log(`\n-- ${tag} --`);
    if (s.walletGain != null) {
      console.log(`  WALLET  start=${s.startEquity.toFixed(4)}  now=${s.lastEquity.toFixed(4)}  gain=${s.walletGain >= 0 ? '+' : ''}${s.walletGain.toFixed(4)}`);
    }
    if (!s.rows.length) { console.log('  fills: none yet'); return s; }
    for (const r of s.rows) {
      console.log(`  ${r.symbol.padEnd(6)} fills=${r.fills}  fees=${r.fees.toFixed(4)}  real=${r.realized.toFixed(4)}  unrl=${r.unrealized.toFixed(4)}  net=${r.total.toFixed(4)}`);
    }
    console.log(`  ALL    fees=${s.fees.toFixed(4)}  real=${s.realized.toFixed(4)}  unrl=${s.unrealized.toFixed(4)}  net=${s.fillTotal.toFixed(4)}`);
    return s;
  }
  return { recordFill, markWallet, snapshot, print };
}
