import { logFill } from './fill-log.js';
import { postFill } from './status-client.js';

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
      console.log('  FILL ' + String(orderId).slice(0, 8) + ' ' + rec.side + ' ' + rec.pair + (rec.fee ? ' fee=' + Number(rec.fee).toFixed(4) : ' fee=?'));
      if (pnl) pnl.recordFill(rec);
      logFill(rec, { orderId });
      rec.pnlRecorded = true;
      rec.needFee = !(rec.fee > 0);
    } else if (rec.needFee && rec.fee > 0 && pnl && pnl.adjustFee) {
      pnl.adjustFee(rec, rec.fee);
      rec.needFee = false;
      postFill({
        orderId, pair: rec.pair, symbol: rec.symbol, side: rec.side, level: rec.level,
        price: rec.price, size: rec.size, fee: rec.fee, filledValue: rec.filledValue,
      });
    }
  } else if (['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED'].includes(st)) rec.status = 'cancelled';
}

export async function pollOpenOrders(ex, orderRegistry, cfg, pnl = null) {
  const wsOn = !!cfg.useUserWebsocket;
  const forceRest = process.env.COINBASE_REST_STATUS === '1' || process.env.KRAKEN_REST_STATUS === '1';
  const todo = [...orderRegistry.entries()].filter(([, r]) => {
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
