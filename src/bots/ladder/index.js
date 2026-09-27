import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { startCoinbaseUserWs } from '../../shared/coinbase.js';
import { markOrderFromExchange, pollOpenOrders } from '../../shared/orders.js';
import { createPnl } from '../../shared/pnl.js';
import {
  fetchLivePortfolio, waitForSettlement, buildLists, getMmOrderSizeUsd,
  rebalanceCombined, rebalanceBuysAfterSettle,
} from '../../shared/portfolio.js';
import { processPair } from './strategy.js';

loadProjectEnv('configs/ladder.env');
const cfg = baseConfig();
const orderRegistry = new Map();
const pairState = new Map();
const pnl = createPnl();
const ex = createExchange(cfg, orderRegistry);

async function runMm(mmAlloc, orderSizeUsd, productMap) {
  console.log('\nladder MM');
  let ws = { close() {} };
  if (cfg.exchange === 'coinbase') {
    ws = startCoinbaseUserWs(cfg, (id, st) => markOrderFromExchange(orderRegistry, id, st, pnl));
  }
  const getLive = () => fetchLivePortfolio(cfg, ex, productMap);
  (async () => {
    while (true) {
      try { await pollOpenOrders(ex, orderRegistry, cfg, pnl); } catch (e) { console.warn('order poll', e.message); }
      await sleep(cfg.orderPollMs);
    }
  })();
  process.on('SIGINT', () => {
    const mids = {};
    for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
    pnl.print(mids, 'MM gain on stop');
    ws.close(); process.exit(0);
  });
  while (true) {
    for (const a of mmAlloc) {
      try { await processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive); }
      catch (e) { console.error(a.symbol, e.message); }
      await sleep(150);
    }
    if (!runMm._lastPnl || Date.now() - runMm._lastPnl > 30000) {
      try { pnl.markWallet((await getLive()).totalEquity); } catch { /* ignore */ }
      const mids = {};
      for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
      pnl.print(mids);
      runMm._lastPnl = Date.now();
    }
    await sleep(cfg.updateIntervalMs);
  }
}

async function main() {
  console.log(`BOT=ladder exchange=${cfg.exchange} dryRun=${cfg.dryRun} quote=${cfg.quote}`);
  if (cfg.exchange === 'kraken' && (!cfg.krakenApiKey || !cfg.krakenApiSecret)) throw new Error('Missing Kraken keys');
  if (cfg.exchange === 'coinbase') console.log('JWT', ex.loadKeyInfo());
  const productMap = await ex.getProducts();
  if (cfg.cancelAllOrdersOnStartup && cfg.exchange !== 'print') await ex.cancelAll();
  let live = await fetchLivePortfolio(cfg, ex, productMap);
  let lists = await buildLists(cfg, productMap, live.totalEquity);
  await rebalanceCombined(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after combined');
  lists = await buildLists(cfg, productMap, live.totalEquity);
  await rebalanceBuysAfterSettle(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after buy pass');
  lists = await buildLists(cfg, productMap, live.totalEquity);
  pnl.markWallet(live.totalEquity);
  const orderSizeUsd = getMmOrderSizeUsd(cfg, lists.mmCapital);
  if (cfg.mmEnabled) await runMm(lists.mmAlloc, orderSizeUsd, productMap);
}
main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
