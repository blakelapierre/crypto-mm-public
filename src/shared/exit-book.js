const book = new Map();

export function queueExit(symbol, pair, qty, mid) {
  if (!symbol || !pair || !(Number(qty) > 0)) return;
  if (mid > 0 && qty * mid < Number(process.env.MIN_ORDER_USD || 1)) {
    console.log('  EXIT skip dust ' + symbol);
    return;
  }
  book.set(symbol, { symbol, pair, qty, since: Date.now(), lastPostAt: 0, steps: 0 });
  console.log('  EXIT queue ' + symbol + ' ' + qty);
}

export function exitBook() { return [...book.values()]; }

export function clearExit(symbol) { book.delete(symbol); }

export async function tickExits(ex, orderRegistry, live) {
  const half = Number(process.env.EXIT_HALF_BPS || 40) / 10000;
  const stepBps = Number(process.env.EXIT_STEP_BPS || 10) / 10000;
  const stepMs = Number(process.env.EXIT_STEP_MS || 120000);
  for (const row of [...book.values()]) {
    const rec = row.orderId && orderRegistry.get(row.orderId);
    if (rec && rec.status === 'filled') { book.delete(row.symbol); continue; }
    const pos = live && live.positions && live.positions[row.symbol];
    const free = Number(pos && pos.amount || row.qty);
    if (!(free > 0)) { book.delete(row.symbol); continue; }
    if (row.orderId && Date.now() - row.lastPostAt < stepMs) continue;
    try {
      const b = await ex.getBook(row.pair);
      if (!b || !(b.mid > 0)) continue;
      const aged = Date.now() - row.since > Number(process.env.EXIT_MAX_AGE_MS || 7200000);
      const px = aged ? Number(b.ask || b.mid) : Math.max(Number(b.ask || 0), b.mid * (1 + half - row.steps * stepBps));
      if (row.orderId) { try { await ex.cancelOrder(row.orderId); } catch { /* ignore */ } }
      const r = await ex.limitOrder(row.pair, 'sell', px, free, { level: 1, why: 'exit' });
      if (r && r.order_id) {
        row.orderId = r.order_id;
        row.lastPostAt = Date.now();
        row.steps += 1;
        orderRegistry.set(r.order_id, { orderId: r.order_id, pair: row.pair, symbol: row.symbol, side: 'sell', price: px, size: free, status: 'open', why: 'exit', mid: b.mid });
        console.log('  EXIT sell ' + row.symbol + ' @ ' + px);
      }
    } catch (e) { console.warn('exit ' + row.symbol, e.message); }
  }
}
