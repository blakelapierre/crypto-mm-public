import { setTimeout as sleep } from 'timers/promises';
import { formatPrice, calculateVolume } from '../../shared/sizing.js';
export function createVolTracker(window) {
  const mids = [];
  return {
    push(mid) { mids.push(mid); if (mids.length > window) mids.shift(); },
    sigma() {
      if (mids.length < 5) return 0.002;
      const rets = [];
      for (let i = 1; i < mids.length; i++) rets.push(Math.log(mids[i] / mids[i - 1]));
      const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
      const var_ = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
      return Math.max(Math.sqrt(var_), 0.0002);
    },
  };
}
export function quotesFromInventory(cfg, mid, inventoryUsd, equityUsd, sigma, pairDecimals) {
  const q = equityUsd > 0 ? inventoryUsd / equityUsd : 0;
  const reservation = mid * (1 - cfg.gamma * sigma * sigma * q);
  let halfBps = cfg.minHalfSpreadBps + cfg.kappa * sigma * 10000 + Math.abs(q) * 20;
  halfBps = Math.min(cfg.maxHalfSpreadBps, Math.max(cfg.minHalfSpreadBps, halfBps));
  const half = halfBps / 10000;
  return { reservation, halfBps, q, bid: formatPrice(reservation * (1 - half), pairDecimals), ask: formatPrice(reservation * (1 + half), pairDecimals) };
}
export async function manageInventoryQuotes(cfg, ex, orderRegistry, state, a, sizeUsd, liveEquity) {
  const book = await ex.getBook(a.pair);
  if (!book) return;
  if (!state.vol) state.vol = createVolTracker(cfg.volWindow);
  state.vol.push(book.mid);
  const q = quotesFromInventory(cfg, book.mid, state.inventoryUsd ?? 0, liveEquity || 1, state.vol.sigma(), a.pairDecimals);
  const size = calculateVolume(cfg, book.mid, sizeUsd, a.ordermin, a.lotDecimals);
  const needRequote = () => {
    if (!state.bidId && !state.askId) return true;
    const move = Math.abs(book.mid - (state.lastMid || book.mid)) / book.mid;
    return move >= cfg.requoteMoveBps / 10000;
  };
  if (state.bidId) {
    const rec = orderRegistry.get(state.bidId);
    if (rec?.status === 'filled') { state.inventoryUsd = (state.inventoryUsd || 0) + size * book.mid; state.bidId = null; }
    else if (rec?.status === 'cancelled') state.bidId = null;
  }
  if (state.askId) {
    const rec = orderRegistry.get(state.askId);
    if (rec?.status === 'filled') { state.inventoryUsd = (state.inventoryUsd || 0) - size * book.mid; state.askId = null; }
    else if (rec?.status === 'cancelled') state.askId = null;
  }
  if (!needRequote() && state.bidId && state.askId) return;
  if (state.bidId) await ex.cancelOrder(state.bidId);
  if (state.askId) await ex.cancelOrder(state.askId);
  const buy = await ex.limitOrder(a.pair, 'buy', q.bid, size, { level: 1 });
  await sleep(cfg.rateLimitMs);
  const sell = await ex.limitOrder(a.pair, 'sell', q.ask, size, { level: 1 });
  state.bidId = buy?.order_id || null;
  state.askId = sell?.order_id || null;
  state.lastBid = q.bid; state.lastAsk = q.ask; state.lastMid = book.mid;
}
