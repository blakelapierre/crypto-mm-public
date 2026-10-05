import { formatVolume } from './sizing.js';

const book = new Map();
const fails = { insufficient: 0, decimals: 0, postOnly: 0, other: 0 };

export function noteLimitFail(msg) {
  const s = String(msg || '');
  if (/insufficient/i.test(s)) fails.insufficient += 1;
  else if (/decimal/i.test(s)) fails.decimals += 1;
  else if (/post.only|INVALID_LIMIT_PRICE/i.test(s)) fails.postOnly += 1;
  else fails.other += 1;
}
export function limitFails() { return { ...fails }; }

export function queueExit(symbol, pair, qty, mid, meta = {}) {
  if (!symbol || !pair || !(Number(qty) > 0)) return;
  if (book.has(symbol)) return;
  book.set(symbol, {
    symbol, pair, qty: Number(qty), since: Date.now(), sinceMid: Number(mid) || 0,
    lastPostAt: 0, steps: 0, lotDecimals: meta.lotDecimals, pairDecimals: meta.pairDecimals, lastErr: '',
  });
  console.log('  EXIT queue ' + symbol + ' ' + qty);
}

export function sweepStranded(live, mmAlloc) {
  const keep = new Set((mmAlloc || []).map((a) => a.symbol));
  const dust = [];
  for (const [sym, pos] of Object.entries((live && live.positions) || {})) {
    if (keep.has(sym)) continue;
    const qty = Number(pos.amount || 0) + Number(pos.hold || 0);
    const mid = Number(pos.mid || 0);
    const value = qty * mid;
    if (!(value >= Number(process.env.MIN_ORDER_USD || 1)) || !pos.pair) {
      if (qty > 0) dust.push({ symbol: sym, qty, value });
      continue;
    }
    queueExit(sym, pos.pair, qty, mid, { lotDecimals: pos.lotDecimals, pairDecimals: pos.pairDecimals });
  }
  return dust;
}

export function exitBook() { return [...book.values()]; }
export function clearExit(symbol) { book.delete(symbol); }

export async function tickExits(ex, orderRegistry, live) {
  const half = Number(process.env.EXIT_HALF_BPS || 40) / 10000;
  const stepBps = Number(process.env.EXIT_STEP_BPS || 10) / 10000;
  const stepMs = Number(process.env.EXIT_STEP_MS || 120000);
  for (const row of [...book.values()]) {
    if (row.error) continue;
    const rec = row.orderId && orderRegistry.get(row.orderId);
    if (rec && rec.status === 'filled') { book.delete(row.symbol); continue; }
    const pos = live && live.positions && live.positions[row.symbol];
    const total = Number(pos && pos.amount || 0) + Number(pos && pos.hold || 0);
    const midPx = Number((pos && pos.mid) || row.sinceMid || 0);
    if (midPx > 0 && total * midPx < Number(process.env.MIN_ORDER_USD || 1)) { book.delete(row.symbol); continue; }
    const free = Number(pos && pos.amount || 0);
    if (!(free > 0)) continue;
    if (row.orderId && Date.now() - row.lastPostAt < stepMs) continue;
    try {
      const b = await ex.getBook(row.pair);
      if (!b || !(b.mid > 0)) { row.lastErr = 'no book'; continue; }
      const aged = Date.now() - row.since > Number(process.env.EXIT_MAX_AGE_MS || 7200000);
      const ask = Number(b.ask || b.mid);
      const px = aged ? ask : Math.max(ask, b.mid * (1 + half - row.steps * stepBps));
      const size = formatVolume(free * 0.995, row.lotDecimals == null ? 8 : row.lotDecimals);
      if (!(Number(size) > 0)) continue;
      if (row.orderId) { try { await ex.cancelOrder(row.orderId); } catch { /* ignore */ } }
      const r = await ex.limitOrder(row.pair, 'sell', px, size, { level: 1, why: 'exit' });
      if (r && r.order_id) {
        row.orderId = r.order_id;
        row.lastPostAt = Date.now();
        row.steps += 1;
        row.lastErr = '';
        orderRegistry.set(r.order_id, { orderId: r.order_id, pair: row.pair, symbol: row.symbol, side: 'sell', price: px, size, status: 'open', why: 'exit', mid: b.mid });
        console.log('  EXIT sell ' + row.symbol + ' ' + size + ' @ ' + px);
      } else {
        row.lastErr = 'no id';
      }
    } catch (e) {
      row.lastErr = e.message;
      noteLimitFail(e.message);
      if (/decimal/i.test(e.message)) row.error = e.message;
      console.warn('exit ' + row.symbol, e.message);
    }
  }
}
