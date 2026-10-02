import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { startCoinbaseUserWs, startCoinbaseTickerWs } from '../../shared/coinbase.js';
import { markOrderFromExchange, pollOpenOrders } from '../../shared/orders.js';
import { createPnl } from '../../shared/pnl.js';
import {
  fetchLivePortfolio, waitForSettlement, buildLists, invalidateLiveCache,
} from '../../shared/portfolio.js';
import { liquidateSymbols, seedNewInventory } from '../../shared/bank.js';
import { postStatus, postMids, pullVenueMids, pullVenueScan } from '../../shared/status-client.js';
import { logSession } from '../../shared/fill-log.js';
import { snapshotApi, startApiTally } from '../../shared/api-timing.js';
import { processGrid, createGridState } from './strategy.js';
import { createVolScan, topMovers, topVolatiles } from '../../shared/vol-scan.js';
import { planRotation } from '../../shared/rotate.js';
import { saveMmSet } from '../../shared/mm-set.js';

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
  if (!process.env.GRID_COINBASE_API_KEY) console.warn('grid is using COINBASE_API_KEY (ladder wallet). Set GRID_COINBASE_API_KEY for the grid portfolio.');
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
  const mmAlloc = [];
  const volScan = createVolScan(cfg, productMap);
  const enteredAt = new Map();
  const watch = new Map();
  console.log('grid vol scan, same entry rules as ladder');
  try { await volScan.tick(); } catch (e) { console.warn('grid vol', e.message); }
  const first = planRotation({ mmAlloc, ranked: volScan.ranking(), now: Date.now(), enteredAt, watch, live, cfg });
  for (const a of first.additions) {
    mmAlloc.push(a);
    enteredAt.set(a.pair, Date.now());
    gridState.set(a.pair, createGridState());
  }
  if (!mmAlloc.length) {
    for (const a of lists.mmAlloc.slice(0, Number(process.env.MM_MAX_PAIRS || 4))) {
      mmAlloc.push(a);
      enteredAt.set(a.pair, Date.now());
      gridState.set(a.pair, createGridState());
    }
  }
  console.log('grid names ' + mmAlloc.map((a) => a.symbol).join(','));
  saveMmSet(mmAlloc);
  invalidateLiveCache();
  const getLive = () => fetchLivePortfolio(cfg, ex, productMap);

  if (cfg.exchange === 'coinbase') {
    startCoinbaseUserWs(cfg, (id, st, d) => markOrderFromExchange(orderRegistry, id, st, pnl, d));
    startCoinbaseTickerWs(mmAlloc.map((a) => a.pair), (tk) => {
      for (const a of mmAlloc) {
        if (String(a.pair).toUpperCase() === String(tk.pair || '').toUpperCase()) {
          const st = gridState.get(a.pair) || createGridState();
          st.lastMid = tk.mid;
          st.lastBid = tk.bid;
          st.lastAsk = tk.ask;
          gridState.set(a.pair, st);
          postMids([{ symbol: a.symbol, pair: a.pair, mid: tk.mid, bid: tk.bid, ask: tk.ask }]);
        }
      }
    });
  }

  for (const a of mmAlloc) gridState.set(a.pair, createGridState());

  let lastRotate = 0;
  const gap = Number(cfg.updateIntervalMs || 2000);
  while (true) {
    try {
      try { await pollOpenOrders(ex, orderRegistry, cfg, pnl); } catch (e) { console.warn('order poll', e.message); }
      if (Date.now() - lastRotate > Number(process.env.VOL_ROTATE_MS || 60000)) {
        lastRotate = Date.now();
        let ranked = [];
        const sharedScan = await pullVenueScan(cfg.exchange);
        if (sharedScan && sharedScan.ranked && Date.now() - Number(sharedScan.ts || 0) < 120000) {
          ranked = sharedScan.ranked;
          console.log('grid using shared ' + cfg.exchange + ' scan n=' + ranked.length);
        } else {
          try { await volScan.tick(); ranked = volScan.ranking(); } catch (e) { console.warn('grid vol', e.message); }
        }
        const plan = planRotation({ mmAlloc, ranked, now: Date.now(), enteredAt, watch, live, cfg });
      if (plan.leaving.length || plan.additions.length) {
        console.log('grid exit ' + plan.leaving.map((a) => a.symbol).join(',') + ' enter ' + plan.additions.map((a) => a.symbol).join(','));
        for (const a of plan.leaving) {
          watch.set(a.pair, { ...a, leftAt: Date.now() });
          try { await ex.cancelPair(a.pair); } catch { /* ignore */ }
          gridState.delete(a.pair);
          enteredAt.delete(a.pair);
        }
        if (plan.leaving.length) {
          try { await liquidateSymbols(cfg, ex, live, plan.leaving.map((a) => a.symbol), productMap); } catch (e) { console.warn('grid exit liq', e.message); }
        }
        mmAlloc.length = 0;
        for (const a of [...plan.keep, ...plan.additions]) {
          mmAlloc.push(a);
          if (!enteredAt.has(a.pair)) enteredAt.set(a.pair, Date.now());
          if (!gridState.has(a.pair)) gridState.set(a.pair, createGridState());
        }
        saveMmSet(mmAlloc);
        if (plan.additions.length) {
          try { await seedNewInventory(cfg, ex, plan.additions, await getLive()); } catch (e) { console.warn('grid seed', e.message); }
        }
        }
      }
      live = await getLive();
      pnl.markHoldings(live);
      let shared = [];
      try { shared = await pullVenueMids(cfg.exchange); } catch { shared = []; }
      const sharedBy = new Map(shared.map((r) => [String(r.symbol || '').toUpperCase(), r]));
      const budget = {
        left: Number(live && live.freeQuote || 0),
        base: Object.fromEntries(Object.entries(live && live.positions || {}).map(([k, p]) => [k, Number(p.amount || 0)])),
      };
      for (const a of mmAlloc) {
        let book = null;
        const sh = sharedBy.get(String(a.symbol).toUpperCase());
        if (sh && Number(sh.mid) > 0) book = { mid: Number(sh.mid), bid: Number(sh.bid || sh.mid), ask: Number(sh.ask || sh.mid), pair: a.pair };
        try {
          const liveBook = await ex.getBook(a.pair);
          if (liveBook && liveBook.mid) book = liveBook;
        } catch { /* shared mid is enough */ }
        const st = gridState.get(a.pair) || createGridState();
        if (!book && st.lastMid) book = { mid: st.lastMid, bid: st.lastBid || st.lastMid, ask: st.lastAsk || st.lastMid, pair: a.pair };
        if (!book || !(book.mid > 0)) { console.warn('grid skip ' + a.symbol + ' no book'); continue; }
        if (!a.pairDecimals) a.pairDecimals = 8;
        if (book.mid) postMids([{ symbol: a.symbol, pair: a.pair, mid: book.mid, bid: book.bid, ask: book.ask }]);
        gridState.set(a.pair, st);
        try { await processGrid(cfg, ex, a, st, book, getLive, orderRegistry, budget); }
        catch (e) { console.error('grid ' + a.symbol + ' ' + (e.message || e)); }
        await sleep(80);
      }
      const snap = pnl.snapshot();
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
        pnl: snap, equity: live && live.totalEquity, cash: live && live.freeQuote, markets, api: snapshotApi(),
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
