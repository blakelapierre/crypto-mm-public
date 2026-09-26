import { calculateVolume, safeQuoteSize } from '../../shared/sizing.js';
export function edgeBps(buyAsk, sellBid) {
  if (!buyAsk || !sellBid) return 0;
  return ((sellBid - buyAsk) / buyAsk) * 10000;
}
export function requiredBps(cfg) { return cfg.minEdgeBps + cfg.feeBpsCoinbase + cfg.feeBpsKraken; }
export async function scanAndTrade(cfg, ex, symbol, cb, kr, grossUsd) {
  const need = requiredBps(cfg);
  const cbBook = await ex.getBook(cb.pair, 'coinbase');
  const krBook = await ex.getBook(kr.pair, 'kraken');
  if (!cbBook || !krBook) return 0;
  const a = { dir: 'buy_cb_sell_kr', edge: edgeBps(cbBook.ask, krBook.bid), buyVenue: 'coinbase', sellVenue: 'kraken', buyPair: cb.pair, sellPair: kr.pair, buyPx: cbBook.ask, sellPx: krBook.bid, lotDecimals: cb.lotDecimals, ordermin: Math.max(cb.ordermin || 0, kr.ordermin || 0) };
  const b = { dir: 'buy_kr_sell_cb', edge: edgeBps(krBook.ask, cbBook.bid), buyVenue: 'kraken', sellVenue: 'coinbase', buyPair: kr.pair, sellPair: cb.pair, buyPx: krBook.ask, sellPx: cbBook.bid, lotDecimals: kr.lotDecimals, ordermin: Math.max(cb.ordermin || 0, kr.ordermin || 0) };
  const best = a.edge >= b.edge ? a : b;
  if (best.edge < need || grossUsd >= cfg.maxGrossExposure) return 0;
  const notional = Math.min(cfg.maxNotionalPerTrade, cfg.maxGrossExposure - grossUsd);
  if (notional < cfg.minOrderUsd) return 0;
  const mid = (best.buyPx + best.sellPx) / 2;
  const vol = calculateVolume(cfg, mid, safeQuoteSize(cfg, notional), best.ordermin, best.lotDecimals);
  await ex.marketBuy(best.buyPair, vol, notional, best.buyVenue);
  await ex.marketSell(best.sellPair, vol, best.sellVenue);
  return notional;
}
