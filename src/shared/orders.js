export function markOrderFromExchange(orderRegistry, orderId, statusRaw, pnl = null, detail = null) {
  const st = String(statusRaw || '').toUpperCase();
  const rec = orderRegistry.get(orderId);
  if (!rec) return;
  if (st === 'FILLED' || st === 'CLOSED') {
    if (rec.status !== 'filled') {
      rec.status = 'filled';
      if (detail) {
        if (detail.filledSize) rec.size = detail.filledSize;
        if (detail.avgPrice) rec.price = detail.avgPrice;
        rec.filledValue = detail.filledValue || 0;
        rec.fee = detail.fee || 0;
      }
      console.log(`  FILL ${String(orderId).slice(0, 8)} ${rec.side} ${rec.pair}` + (rec.fee ? ` fee=${Number(rec.fee).toFixed(4)}` : ''));
      if (pnl) pnl.recordFill(rec);
    }
  } else if (['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED'].includes(st)) rec.status = 'cancelled';
}

export async function pollOpenOrders(ex, orderRegistry, cfg, pnl = null) {
  const openIds = [...orderRegistry.entries()].filter(([, r]) => r.status === 'open').map(([id, r]) => ({ id, venue: r.venue || cfg.exchange }));
  for (const { id, venue } of openIds) {
    const st = await ex.getOrderStatus(id, venue);
    if (st?.status) markOrderFromExchange(orderRegistry, id, st.status, pnl, st);
  }
}
