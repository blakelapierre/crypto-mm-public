export function markOrderFromExchange(orderRegistry, orderId, statusRaw) {
  const st = String(statusRaw || '').toUpperCase();
  const rec = orderRegistry.get(orderId);
  if (!rec) return;
  if (st === 'FILLED' || st === 'CLOSED') {
    if (rec.status !== 'filled') rec.status = 'filled';
  } else if (['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED'].includes(st)) rec.status = 'cancelled';
}
export async function pollOpenOrders(ex, orderRegistry, cfg) {
  const openIds = [...orderRegistry.entries()].filter(([, r]) => r.status === 'open').map(([id, r]) => ({ id, venue: r.venue || cfg.exchange }));
  for (const { id, venue } of openIds) {
    const st = await ex.getOrderStatus(id, venue);
    if (st?.status) markOrderFromExchange(orderRegistry, id, st.status);
  }
}
