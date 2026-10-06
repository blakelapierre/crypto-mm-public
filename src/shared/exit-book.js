import { invalidateLiveCache } from './portfolio.js';

const book = new Map();
const fails = { insufficient: [], decimals: [], postOnly: [], other: [] };
const takerLog = [];
let lastDust = [];

export function noteLimitFail(msg) {
  const s = String(msg || '');
  const k = /insufficient/i.test(s) ? 'insufficient' : /decimal/i.test(s) ? 'decimals' : /post.only|INVALID_LIMIT_PRICE/i.test(s) ? 'postOnly' : 'other';
  fails[k].push(Date.now());
}
export function limitFails() {
  const cut = Date.now() - 3600000;
  const n = (arr) => arr.filter((t) => t >= cut).length;
  return { insufficient1h: n(fails.insufficient), decimals1h: n(fails.decimals), postOnly1h: n(fails.postOnly), other1h: n(fails.other) };
}
export function noteStrandedFee(orderId, fee) {
  const row = [...takerLog].reverse().find((t) => t.orderId === orderId);
  if (row) row.fee = Number(fee) || 0;
}
export function dustList() { return lastDust; }
export function strandedTakerSnap() {
  const hour = Date.now() - 3600000;
  const recent = takerLog.filter((t) => t.ts >= hour);
  return {
    count1h: recent.length,
    countSession: takerLog.length,
    usdSession: takerLog.reduce((s, t) => s + Number(t.usd || 0), 0),
    feesSession: takerLog.reduce((s, t) => s + Number(t.fee || 0), 0),
    last: takerLog.slice(-5),
  };
}

function lotDec(row) { return row.lotDecimals == null ? 8 : Number(row.lotDecimals); }
function pxDec(row) { return row.pairDecimals == null ? 8 : Number(row.pairDecimals); }
function floorVol(v, d) {
  const dec = Number.isFinite(Number(d)) ? Number(d) : 8;
  const inc = 10 ** -dec;
  return Number((Math.floor(Number(v) / inc + 1e-9) * inc).toFixed(dec));
}
function ceilPx(px, d) {
  const dec = Number.isFinite(Number(d)) ? Number(d) : 8;
  const inc = 10 ** -dec;
  return Number((Math.ceil(Number(px) / inc - 1e-9) * inc).toFixed(dec));
}

export function queueExit(symbol, pair, qty, mid, meta = {}) {
  if (!symbol || !pair || !(Number(qty) > 0)) return;
  if (book.has(symbol)) return;
  book.set(symbol, {
    symbol, pair, qty: Number(qty), since: Date.now(), sinceMid: Number(mid) || 0,
    lastPostAt: 0, steps: 0, lotDecimals: meta.lotDecimals, pairDecimals: meta.pairDecimals,
    lastErr: '', price: 0, size: 0, taker: false, atTouchAt: 0,
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
  lastDust = dust;
  return dust;
}

export function exitBook() {
  const now = Date.now();
  return [...book.values()].map((row) => ({
    symbol: row.symbol, pair: row.pair, qty: row.qty, size: row.size, price: row.price,
    value: Number(row.size || row.qty || 0) * Number(row.price || row.sinceMid || 0),
    sinceMid: row.sinceMid, mid: row.mid || row.sinceMid,
    pnlUsd: row.sinceMid && row.price ? (Number(row.price) - Number(row.sinceMid)) * Number(row.size || row.qty || 0) : null,
    ageMin: Math.round((now - row.since) / 60000),
    steps: row.steps, lastErr: row.lastErr || '', taker: !!row.taker, orderId: row.orderId || '',
  }));
}
export function clearExit(symbol) { book.delete(symbol); }

export async function tickExits(ex, orderRegistry, live, getLive) {
  const half = Number(process.env.EXIT_HALF_BPS || 40) / 10000;
  const stepBps = Number(process.env.EXIT_STEP_BPS || 10) / 10000;
  const stepMs = Number(process.env.EXIT_STEP_MS || 120000);
  const maxAge = Number(process.env.EXIT_MAX_AGE_MS || 3600000);
  const minUsd = Number(process.env.MIN_ORDER_USD || 1);
  for (const row of [...book.values()]) {
    if (row.error) continue;
    const rec = row.orderId && orderRegistry.get(row.orderId);
    if (rec && rec.status === 'filled') { book.delete(row.symbol); continue; }
    const open = !!(rec && rec.status === 'open');
    const pos = live && live.positions && live.positions[row.symbol];
    const amount = Number(pos && pos.amount || 0);
    const hold = Number(pos && pos.hold || 0);
    const total = amount + hold;
    const midPx = Number((pos && pos.mid) || row.sinceMid || 0);
    row.mid = midPx;
    if (midPx > 0 && total * midPx < minUsd && !open) { book.delete(row.symbol); continue; }
    if (open && Date.now() - row.lastPostAt < stepMs && Date.now() - row.since < maxAge) continue;
    try {
      const b = await ex.getBook(row.pair);
      if (!b || !(b.mid > 0)) { row.lastErr = 'no book'; continue; }
      const aged = Date.now() - row.since > maxAge;
      const ask = Number(b.ask || b.mid);
      const inc = 10 ** -pxDec(row);
      let px = aged ? ask : Math.max(ask, b.mid * (1 + half - row.steps * stepBps));
      px = ceilPx(px, pxDec(row));
      const atAsk = Math.abs(px - ask) <= inc * 1.01;
      if (atAsk && !row.atTouchAt) row.atTouchAt = Date.now();
      if (!atAsk) row.atTouchAt = 0;
      const takerOn = ['1', 'true', 'yes'].includes(String(process.env.STRANDED_TAKER || '0').toLowerCase());
      const touchAge = row.atTouchAt ? Date.now() - row.atTouchAt : 0;
      if (takerOn && !row.taker && aged && touchAge >= Number(process.env.STRANDED_TAKER_AFTER_MIN || 30) * 60000) {
        const hourAgo = Date.now() - 3600000;
        const nHour = takerLog.filter((t) => t.ts >= hourAgo).length;
        if (nHour < Number(process.env.STRANDED_TAKER_PER_HOUR || 2)) {
          if (row.orderId) { try { await ex.cancelOrder(row.orderId); } catch { /* ignore */ } row.orderId = ''; }
          invalidateLiveCache();
          let fresh = live;
          if (typeof getLive === 'function') { try { fresh = await getLive(); } catch { /* keep */ } }
          const p2 = fresh && fresh.positions && fresh.positions[row.symbol];
          const freeNow = Number(p2 && p2.amount || 0);
          const capQty = Number(process.env.STRANDED_TAKER_MAX_USD || 5) / Math.max(midPx || b.mid, 1e-12);
          const qty = floorVol(Math.min(freeNow, capQty), lotDec(row));
          if (qty > 0 && qty * (midPx || b.mid) >= minUsd) {
            const r = await ex.marketSell(row.pair, qty, { reason: 'stranded' });
            const id = r && ((r.success_response && r.success_response.order_id) || r.order_id);
            row.taker = true;
            const usd = qty * (midPx || b.mid);
            takerLog.push({ ts: Date.now(), symbol: row.symbol, qty, usd, fee: 0, orderId: id || null });
            console.log('  STRANDED TAKER ' + row.symbol + ' qty=' + qty + ' usd=' + usd.toFixed(2) + ' age=' + Math.round((Date.now() - row.since) / 60000) + 'm');
            if (id) orderRegistry.set(id, { orderId: id, pair: row.pair, symbol: row.symbol, side: 'sell', price: b.bid || b.mid, size: qty, status: 'open', why: 'stranded', taker: true, needFee: true, venue: 'coinbase' });
          }
          continue;
        }
      }
      const openSize = open ? Number(row.size || (rec && rec.size) || 0) : 0;
      const target = floorVol(openSize + amount, lotDec(row));
      if (!(target > 0) || target * px < minUsd) continue;
      if (open && row.size && target + (10 ** -lotDec(row)) < Number(row.size)) {
        console.log('  EXIT keep ' + row.symbol + ' size=' + row.size + ' (would shrink to ' + target + ')');
        continue;
      }
      if (open && row.price && !(px + inc * 0.5 < Number(row.price)) && !(aged && Math.abs(Number(row.price) - ask) > inc)) continue;
      if (row.orderId) {
        try { await ex.cancelOrder(row.orderId); } catch { /* ignore */ }
        row.orderId = '';
        invalidateLiveCache();
        if (typeof getLive === 'function') {
          try { live = await getLive(); } catch { /* keep */ }
        }
      }
      const p3 = live && live.positions && live.positions[row.symbol];
      const size = floorVol(Number(p3 && p3.amount || target), lotDec(row));
      if (!(size > 0) || size * px < minUsd) continue;
      let r = await ex.limitOrder(row.pair, 'sell', px, size, { level: 1, why: 'exit' });
      if (!r || !r.order_id) {
        const retryPx = ceilPx(ask + inc, pxDec(row));
        r = await ex.limitOrder(row.pair, 'sell', retryPx, size, { level: 1, why: 'exit', _retried: true });
        if (r && r.order_id) px = retryPx;
      }
      if (r && r.order_id) {
        row.orderId = r.order_id;
        row.lastPostAt = Date.now();
        row.steps += 1;
        row.price = px;
        row.size = size;
        row.lastErr = '';
        orderRegistry.set(r.order_id, { orderId: r.order_id, pair: row.pair, symbol: row.symbol, side: 'sell', price: px, size, status: 'open', why: 'exit', mid: b.mid, placedAt: Date.now() });
        console.log('  EXIT sell ' + row.symbol + ' ' + size + ' @ ' + px);
      } else row.lastErr = 'no id';
    } catch (e) {
      row.lastErr = e.message;
      noteLimitFail(e.message);
      if (/decimal/i.test(e.message)) row.error = e.message;
      console.warn('exit ' + row.symbol, e.message);
    }
  }
}
