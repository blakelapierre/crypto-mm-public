const book = new Map();

export function queueExit(symbol, pair, qty) {
  if (!symbol || !pair || !(qty > 0)) return;
  book.set(symbol, { symbol, pair, qty, since: Date.now() });
  console.log('  EXIT queue ' + symbol + ' ' + qty);
}

export function exitBook() { return [...book.values()]; }

export async function tickExits(ex, orderRegistry) {
  const half = Number(process.env.EXIT_HALF_BPS || 40) / 10000;
  for (const row of book.values()) {
    if (Date.now() - row.since < Number(process.env.EXIT_STEP_MS || 120000) && row.orderId) continue;
    try {
      const b = await ex.getBook(row.pair);
      if (!b || !(b.mid > 0)) continue;
      const px = Math.max(Number(b.ask || 0), b.mid * (1 + half));
      if (row.orderId) { try { await ex.cancelOrder(row.orderId); } catch { /* ignore */ } }
      const r = await ex.limitOrder(row.pair, 'sell', px, row.qty, { level: 1, why: 'exit' });
      if (r && r.order_id) {
        row.orderId = r.order_id;
        orderRegistry.set(r.order_id, { orderId: r.order_id, pair: row.pair, symbol: row.symbol, side: 'sell', price: px, size: row.qty, status: 'open', why: 'exit' });
        console.log('  EXIT sell ' + row.symbol + ' @ ' + px);
      }
    } catch (e) { console.warn('exit ' + row.symbol, e.message); }
  }
}
