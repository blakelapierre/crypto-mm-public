import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { startCoinbaseUserWs, startCoinbaseTickerWs } from '../../shared/coinbase.js';
import { markOrderFromExchange, pollOpenOrders } from '../../shared/orders.js';
import { createPnl } from '../../shared/pnl.js';
import {
  fetchLivePortfolio, waitForSettlement, buildLists, invalidateLiveCache,
} from '../../shared/portfolio.js';
import { liquidateSymbols } from '../../shared/bank.js';
import { postStatus } from '../../shared/status-client.js';
import { logSession } from '../../shared/fill-log.js';
import { snapshotApi, startApiTally } from '../../shared/api-timing.js';
import { processGrid, createGridState } from './strategy.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/grid.env');
process.env.BOT = process.env.BOT || 'grid';
const cfg = baseConfig();
{
  const raw = process.env.SYMBOLS || (cfg.symbols || []).join(',');
  cfg.symbols = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}
const orderRegistry = new Map();
const gridState = new Map();
const pnl = createPnl();
const ex = createExchange(cfg, orderRegistry);

async function main() {
  logSession({ exchange: cfg.exchange, quote: cfg.quote });
  startApiTally();
  const productMap = await ex.getProducts();
  if (cfg.cancelAllOrdersOnStartup && cfg.exchange !== 'print') await ex.cancelAll();
  let live = await fetchLivePortfolio(cfg, ex, productMap);
  let lists = await buildLists(cfg, productMap, live.totalEquity, live);
  const keep = new Set(lists.mmAlloc.map((a) => a.symbol));
  const dump = Object.keys(live.positions || {}).filter((s) => !keep.has(s));
  if (dump.length) {
    console.log('grid flatten ' + dump.join(','));
    await liquidateSymbols(cfg, ex, live, dump, productMap);
    live = await waitForSettlement(cfg, ex, productMap, 'grid flatten');
    lists = await buildLists(cfg, productMap, live.totalEquity, live);
  }
  const mmAlloc = lists.mmAlloc;
  console.log('grid names ' + mmAlloc.map((a) => a.symbol).join(','));
  invalidateLiveCache();
  const getLive = () => fetchLivePortfolio(cfg, ex, productMap);

  if (cfg.exchange === 'coinbase') {
    startCoinbaseUserWs(cfg, (id, st, d) => markOrderFromExchange(orderRegistry, id, st, pnl, d));
    startCoinbaseTickerWs(mmAlloc.map((a) => a.pair), (tk) => {
      for (const a of mmAlloc) {
        if (String(a.pair).toUpperCase() === String(tk.pair || '').toUpperCase()) {
          const st = gridState.get(a.pair) || createGridState();
          st.lastMid = tk.mid;
          gridState.set(a.pair, st);
        }
      }
    });
  }

  for (const a of mmAlloc) gridState.set(a.pair, createGridState());

  const gap = Number(cfg.updateIntervalMs || 2000);
  while (true) {
    try {
      try { await pollOpenOrders(ex, orderRegistry, cfg, pnl); } catch (e) { console.warn('order poll', e.message); }
      live = await getLive();
      pnl.mark(live);
      for (const a of mmAlloc) {
        let book = null;
        try { book = await ex.getBook(a.pair); } catch { book = null; }
        const st = gridState.get(a.pair) || createGridState();
        if (!book && st.lastMid) book = { mid: st.lastMid, pair: a.pair };
        if (!book) continue;
        gridState.set(a.pair, st);
        await processGrid(cfg, ex, a, st, book, getLive, orderRegistry);
        await sleep(80);
      }
      const snap = pnl.snapshot(live);
      const markets = mmAlloc.map((a) => {
        const st = gridState.get(a.pair) || {};
        const bid = st.bid && st.bid.status === 'open' ? Number(st.bid.price) * Number(st.bid.size) : 0;
        const ask = st.ask && st.ask.status === 'open' ? Number(st.ask.price) * Number(st.ask.size) : 0;
        return {
          symbol: a.symbol, pair: a.pair, mid: st.lastMid, vol: '', w: '', fee: '',
          bids: st.bid && st.bid.status === 'open' ? 1 : 0,
          asks: st.ask && st.ask.status === 'open' ? 1 : 0,
          bidUsd: bid, askUsd: ask, buyUsd: 0, sellUsd: 0,
          orders: [st.bid, st.ask].filter((o) => o && o.status === 'open'),
        };
      });
      postStatus({
        bot: 'grid', exchange: cfg.exchange, quote: cfg.quote,
        pnl: snap, markets, api: snapshotApi(),
        working: { bids: markets.reduce((s, m) => s + m.bidUsd, 0), asks: markets.reduce((s, m) => s + m.askUsd, 0) },
      });
    } catch (e) {
      console.warn('grid loop', e.message);
    }
    await sleep(gap);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
