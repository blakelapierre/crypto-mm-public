import { logFill, logFeeUpdate } from './fill-log.js';
import { assumedMakerFeeBps } from './fee-spread.js';
import { postFill } from './status-client.js';
import { consumeHoldSale } from './hold-pnl.js';
import { midRing } from './mid-ring.js';

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
      if (detail.fee != null && detail.fee !== '') rec.fee = Number(detail.fee) || 0;
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
      if (String(rec.side).toLowerCase()==='sell') consumeHoldSale(rec.symbol || (rec.pair||'').split(/[-/]/)[0], rec.price, rec.size, rec.fee, rec.pair);
      logFill(rec, { orderId, venueFee, feeSource: venueFee > 0 ? 'venue' : 'pending' });
      rec.pnlRecorded = true;
      rec.needFee = !(venueFee > 0);
    } else if (rec.needFee && rec.fee > 0 && pnl && pnl.adjustFee) {
      pnl.adjustFee(rec, rec.fee, rec.feeAccounted || 0);
      rec.feeAccounted = Number(rec.fee || 0);
      rec.needFee = false;
      logFeeUpdate(orderId, rec.fee, {
        pair: rec.pair,
        notional: rec.filledValue || (Number(rec.price || 0) * Number(rec.size || 0)),
      });
      postFill({
        orderId, pair: rec.pair, symbol: rec.symbol, side: rec.side, level: rec.level,
        price: rec.price, size: rec.size, fee: rec.fee, filledValue: rec.filledValue,
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
      logFill(rec, { orderId, venueFee: Number(rec.fee || 0), feeSource: rec.fee > 0 ? 'venue' : 'pending' });
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
    if (r.needFee) return true;
    if (r.status !== 'open') return false;
    if (wsOn && !forceRest) return false;
    return true;
  });
  for (const [id, rec] of todo) {
    const st = await ex.getOrderStatus(id, rec.venue || cfg.exchange);
    if (st && st.status) markOrderFromExchange(orderRegistry, id, st.status, pnl, st);
  }
}
