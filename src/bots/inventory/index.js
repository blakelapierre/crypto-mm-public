import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { startCoinbaseUserWs } from '../../shared/coinbase.js';
import { markOrderFromExchange, pollOpenOrders } from '../../shared/orders.js';
import {
  fetchLivePortfolio, waitForSettlement, buildLists, getMmOrderSizeUsd,
  rebalanceCombined, rebalanceBuysAfterSettle,
} from '../../shared/portfolio.js';
import { manageInventoryQuotes } from './strategy.js';

loadProjectEnv('configs/inventory.env');
const cfg = baseConfig();
const orderRegistry = new Map();
const coinState = new Map();
const ex = createExchange(cfg, orderRegistry);

async function main() {
  console.log(`BOT=inventory AS/GLFT exchange=${cfg.exchange} quote=${cfg.quote} dryRun=${cfg.dryRun}`);
  if (cfg.exchange === 'kraken' && (!cfg.krakenApiKey || !cfg.krakenApiSecret)) {
    throw new Error('Missing Kraken keys');
  }
  const productMap = await ex.getProducts();
  if (cfg.cancelAllOrdersOnStartup && cfg.exchange !== 'print') await ex.cancelAll();
  let live = await fetchLivePortfolio(cfg, ex, productMap);
  let lists = await buildLists(cfg, productMap, live.totalEquity);
  await rebalanceCombined(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'combined');
  lists = await buildLists(cfg, productMap, live.totalEquity);
  await rebalanceBuysAfterSettle(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'buys');
  lists = await buildLists(cfg, productMap, live.totalEquity);
  const sizeUsd = getMmOrderSizeUsd(cfg, lists.mmCapital);
  for (const a of lists.mmAlloc) {
    const held = live.positions[a.symbol]?.valueQuote || 0;
    coinState.set(a.pair, { inventoryUsd: held - a.invTargetQuote });
  }
  let ws = { close() {} };
  if (cfg.exchange === 'coinbase') {
    ws = startCoinbaseUserWs(cfg, (id, st) => markOrderFromExchange(orderRegistry, id, st));
  }
  (async () => {
    while (true) {
      try { await pollOpenOrders(ex, orderRegistry, cfg); } catch (e) { console.warn(e.message); }
      await sleep(cfg.orderPollMs);
    }
  })();
  process.on('SIGINT', () => { ws.close(); process.exit(0); });
  while (true) {
    live = await fetchLivePortfolio(cfg, ex, productMap);
    for (const a of lists.mmAlloc) {
      try {
        const st = coinState.get(a.pair) || { inventoryUsd: 0 };
        const held = live.positions[a.symbol]?.valueQuote || 0;
        st.inventoryUsd = held - (a.invTargetQuote || 0);
        await manageInventoryQuotes(cfg, ex, orderRegistry, st, a, sizeUsd, live.totalEquity);
        coinState.set(a.pair, st);
      } catch (e) { console.error(a.symbol, e.message); }
      await sleep(cfg.rateLimitMs);
    }
    await sleep(cfg.updateIntervalMs);
  }
}
main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
