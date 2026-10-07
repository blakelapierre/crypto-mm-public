import { logFill, logFeeUpdate } from './fill-log.js';
import { assumedMakerFeeBps } from './fee-spread.js';
import { noteVenueFee } from './fee-spread.js';
import { postFill } from './status-client.js';
import { consumeHoldSale } from './hold-pnl.js';
import { midRing } from './mid-ring.js';
import { noteStrandedFee } from './exit-book.js';
import { noteSellFill, dropReservation } from './free-qty.js';
import { invalidateLiveCache } from './portfolio.js';

function onSellFill(rec, orderId) {
  if (!rec || String(rec.side).toLowerCase() !== 'sell') return;
  dropReservation(orderId);
  const sym = rec.symbol || String(rec.pair || '').split(/[-/]/)[0];
  noteSellFill(sym, rec.size);
  try { invalidateLiveCache(); } catch { /* ignore */ }
}

export function markOrderFromExchange(orderRegistry, orderId, statusRaw, pnl = null, detail = null) {
  const st = String(statusRaw || '').toUpperCase();
  const rec = orderRegistry.get(orderId);
  if (!rec) return;
  if (st === 'FILLED' || st === 'CLOSED') {
    if (detail && (detail.taker || /market/i.test(String(detail.ordertype || detail.orderType || '')))) {
      rec.taker = true;
      rec.ordertype = detail.ordertype || 'market';
    }
    if (detail) {
      if (detail.filledSize) rec.size = detail.filledSize;
      if (detail.avgPrice) rec.price = detail.avgPrice;
      if (detail.filledValue) rec.filledValue = detail.filledValue;
      if (Number(detail.fee) > 0) rec.fee = Number(detail.fee);
    }
    if (rec.status !== 'filled') {
      rec.status = 'filled';
      const ring = midRing(rec.symbol || String(rec.pair || '').split(/[-/]/)[0]);
      if (!rec.mid && ring.length) rec.mid = ring[ring.length - 1].p;
      const notional = Number(rec.filledValue || 0) || (Number(rec.price || 0) * Number(rec.size || 0));
      const venueFee = Number(rec.fee) || 0;
      if (!(venueFee > 0) && notional > 0) rec.fee = notional * (assumedMakerFeeBps() / 10000);
      rec.feeAccounted = Number(rec.fee || 0);
      console.log('  FILL ' + String(orderId).slice(0, 8) + ' ' + rec.side + ' ' + rec.pair + ' fee=' + Number(rec.fee || 0).toFixed(4) + (venueFee > 0 ? '' : ' est'));
      if (pnl) pnl.recordFill(rec);
      onSellFill(rec, orderId);
      if (String(rec.side).toLowerCase()==='sell') consumeHoldSale(rec.symbol || (rec.pair||'').split(/[-/]/)[0], rec.price, rec.size, rec.fee, rec.pair);
      logFill(rec, { orderId, venueFee, feeSource: venueFee > 0 ? 'venue' : 'est' });
      rec.pnlRecorded = true;
      rec.needFee = !(venueFee > 0);
      rec.filledAt = rec.filledAt || Date.now();
    } else if (rec.needFee && detail && Number(detail.fee) > 0 && pnl && pnl.adjustFee) {
      const venueFee = Number(detail.fee);
      pnl.adjustFee(rec, venueFee, rec.feeAccounted || 0);
      rec.fee = venueFee;
      rec.feeAccounted = venueFee;
      rec.needFee = false;
      rec.feeSource = 'venue';
      if (detail.taker) rec.taker = true;
      const notional = rec.filledValue || (Number(rec.price || 0) * Number(rec.size || 0));
      noteVenueFee(venueFee, notional, rec.pair);
      logFeeUpdate(orderId, rec.fee, { pair: rec.pair, notional, src: 'venue' });
      if (rec.why === 'stranded') noteStrandedFee(orderId, venueFee);
      postFill({
        orderId, pair: rec.pair, symbol: rec.symbol, side: rec.side, level: rec.level,
        price: rec.price, size: rec.size, fee: rec.fee, filledValue: rec.filledValue,
        feeSource: 'venue', ts: rec.filledAt || Date.now(),
      });
    }
  } else if (['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED'].includes(st)) {
    const filled = Number(detail && detail.filledSize || 0);
    if (filled > 0 && rec.status !== 'filled') {
      rec.status = 'filled';
      rec.size = filled;
      if (detail.avgPrice) rec.price = detail.avgPrice;
      if (detail.fee) rec.fee = Number(detail.fee);
      if (pnl) pnl.recordFill(rec);
      onSellFill(rec, orderId);
      logFill(rec, { orderId, venueFee: Number(rec.fee || 0), feeSource: rec.fee > 0 ? 'venue' : 'est' });
    } else rec.status = 'cancelled';
  }
}

export async function pollOpenOrders(ex, orderRegistry, cfg, pnl = null) {
  const wsOn = !!cfg.useUserWebsocket;
  const forceRest = process.env.COINBASE_REST_STATUS === '1' || process.env.KRAKEN_REST_STATUS === '1';
  const entries = orderRegistry && typeof orderRegistry.entries === 'function'
    ? [...orderRegistry.entries()]
    : Object.entries(orderRegistry || {});
  const todo = entries.filter(([, r]) => {
    if (r.needFee) {
      if (r.filledAt && Date.now() - r.filledAt > 5 * 60 * 1000) return false;
      if (r.feeNext && Date.now() < r.feeNext) return false;
      return true;
    }
    if (r.status !== 'open') return false;
    if (wsOn && !forceRest) return false;
    return true;
  });
  for (const [id, rec] of todo) {
    const st = await ex.getOrderStatus(id, rec.venue || cfg.exchange);
    if (st && st.status) markOrderFromExchange(orderRegistry, id, st.status, pnl, st);
    if (rec.needFee) {
      rec.feeTries = (rec.feeTries || 0) + 1;
      rec.feeNext = Date.now() + Math.min(5 * 60 * 1000, 15000 * (2 ** Math.min(rec.feeTries, 5)));
    }
  }
}
