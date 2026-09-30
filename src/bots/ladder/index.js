import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { startCoinbaseUserWs, startCoinbaseTickerWs } from '../../shared/coinbase.js';
import { startKrakenUserWs, startKrakenTickerWs, toWsPair } from '../../shared/kraken.js';
import { markOrderFromExchange, pollOpenOrders } from '../../shared/orders.js';
import { createPnl } from '../../shared/pnl.js';
import {
  fetchLivePortfolio, waitForSettlement, buildLists, getMmOrderSizeUsd,
  rebalanceCombined, rebalanceBuysAfterSettle, ensureQuoteForBids, invalidateLiveCache,
} from '../../shared/portfolio.js';
import { processPair, harvestLowWeightBids, setLiveMmAlloc, setLivePairState } from './strategy.js';
import { createVolScan, setSizeUniverse, sizeWeightForSymbol, volStatsForSymbol, topMovers, topVolatiles } from '../../shared/vol-scan.js';
import { tapeEdgeBps, bookEdgeBps } from '../../shared/pair-tape.js';
import { saveMmSet } from '../../shared/mm-set.js';
import { realizedFeeBps, feeSnapshot } from '../../shared/fee-spread.js';
import { skimToBank, liquidateSymbols, seedNewInventory, bankHoldings, refreshBankHoldings } from '../../shared/bank.js';
import { postStatus, postMids } from '../../shared/status-client.js';
import { logSession } from '../../shared/fill-log.js';
import { noteMid, midReturn, trendMult, shortRun } from '../../shared/mid-ring.js';
import { snapshotApi, startApiTally } from '../../shared/api-timing.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/ladder.env');
const cfg = baseConfig();
{
  const raw = process.env.SYMBOLS || (cfg.symbols || []).join(',');
  cfg.symbols = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (String(process.env.BOT || '').toLowerCase() === 'comp' && !cfg.symbols.length) cfg.symbols = ['GNOT', 'SN64'];
}
const orderRegistry = new Map();
const pairState = new Map();
const pnl = createPnl();
const ex = createExchange(cfg, orderRegistry);

function sortAllocByWeight(arr) {
  arr.sort((a, b) => sizeWeightForSymbol(b.symbol) - sizeWeightForSymbol(a.symbol));
  return arr;
}

async function runMm(mmAlloc, orderSizeUsd, productMap) {
  console.log('\nladder MM');
  invalidateLiveCache();
  sortAllocByWeight(mmAlloc);
  setLiveMmAlloc(mmAlloc);
  setSizeUniverse(mmAlloc.map((a) => a.symbol));
  let ws = { close() {} };
  if (cfg.exchange === 'coinbase') {
    ws = startCoinbaseUserWs(cfg, (id, st, d) => markOrderFromExchange(orderRegistry, id, st, pnl, d));
    const tickPairs = mmAlloc.map((a) => a.pair).filter(Boolean);
    const ticker = startCoinbaseTickerWs(tickPairs, (tk) => {
      for (const [pair, st] of pairState) {
        const p = String(pair || '').toUpperCase();
        const n = String(tk.pair || '').toUpperCase();
        if (p === n || p.replace('-USDC', '-USD') === n.replace('-USDC', '-USD')) {
          st.lastMid = tk.mid; st.lastBid = tk.bid; st.lastAsk = tk.ask;
          if (st.symbol) { noteMid(st.symbol, tk.mid); postMids([{ symbol: st.symbol, pair, mid: tk.mid, bid: tk.bid, ask: tk.ask }]); }
        }
      }
    });
    const prevClose = ws.close.bind(ws);
    ws.close = () => { try { ticker.close(); } catch { /* ignore */ } prevClose(); };
  } else if (cfg.exchange === 'kraken') {
    ws = startKrakenUserWs(cfg, (id, st, d) => markOrderFromExchange(orderRegistry, id, st, pnl, d));
    const tickPairs = mmAlloc.map((a) => a.wsname || toWsPair(a.pair)).filter(Boolean);
    const ticker = startKrakenTickerWs(tickPairs, (tk) => {
      for (const [pair, st] of pairState) {
        const p = String(pair || '').toUpperCase();
        const n = String(tk.pair || '').replace('/', '').toUpperCase();
        if (p === n || p.includes(n) || n.includes(p.replace('USD', ''))) {
          st.lastMid = tk.mid; st.lastBid = tk.bid; st.lastAsk = tk.ask;
          if (st.symbol) postMids([{ symbol: st.symbol, pair, mid: tk.mid, bid: tk.bid, ask: tk.ask }]);
        }
      }
    });
    const prevClose = ws.close.bind(ws);
    ws.close = () => { try { ticker.close(); } catch { /* ignore */ } prevClose(); };
  }
  const getLive = () => fetchLivePortfolio(cfg, ex, productMap);
  (async () => {
    while (true) {
      try { await pollOpenOrders(ex, orderRegistry, cfg, pnl); } catch (e) { console.warn('order poll', e.message); }
      await sleep(cfg.orderPollMs);
    }
  })();
  const liveVol = !(cfg.symbols && cfg.symbols.length) && String(cfg.mmSelect || process.env.MM_SELECT || 'vol').toLowerCase() === 'vol';
  if (liveVol) {
    const volScan = createVolScan(cfg, productMap);
    const rotateMin = Number(process.env.VOL_ROTATE_MIN_MS || 900000);
    console.log('vol scan every ' + ((cfg.volScanMs || 60000) / 1000) + 's window=' + (cfg.volWindowMin || 15) + 'm rotateMin=' + (rotateMin / 1000) + 's');
    (async () => {
      while (true) {
        try {
          const n = await volScan.tick();
          const top = volScan.ranking().slice(0, 8);
          if (top.length) console.log('vol ' + top.map((r) => r.symbol + ' ' + r.rangePct.toFixed(2) + '%').join('  ') + ' (n=' + n + ')');
        } catch (e) { console.warn('vol scan', e.message); }
        await sleep(cfg.volScanMs || Number(process.env.VOL_SCAN_MS) || 60000);
      }
    })();
    (async () => {
      const enteredAt = new Map();
      const watch = new Map();
      for (const a of mmAlloc) enteredAt.set(a.pair, Date.now());
      const enterPct = Number(process.env.VOL_ENTER_PCT || 2);
      const exitPct = Number(process.env.VOL_EXIT_PCT || 1.5);
      const hardMax = Number(process.env.MM_MAX_PAIRS_HARD || cfg.mmMaxPairs || 8);
      const levels = Math.max(1, cfg.mmLevels || 1);
      await sleep(Math.max(cfg.volScanMs || 60000, 30000));
      while (true) {
        try {
          const ranked = volScan.ranking();
          const now = Date.now();
          let live = null;
          try { live = await getLive(); } catch { live = null; }
          const free = live ? Number(live.freeQuote || 0) : 0;
          function costOf(row) {
            const mid = Number(row.last || 0);
            const minV = (row.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
            const minUsd = Math.max(cfg.minOrderUsd || 1, mid > 0 ? minV * mid : cfg.minOrderUsd || 1);
            return minUsd * levels * 2;
          }
          const keep = [];
          const leaving = [];
          for (const a of mmAlloc) {
            const meta = volStatsForSymbol(a.symbol);
            const range = meta ? Number(meta.rangePct || 0) : 0;
            const age = now - (enteredAt.get(a.pair) || now);
            const rip = shortRun(a.symbol);
            const weak = range < exitPct && rip < Number(process.env.SHORT_RUN_ENTER || 0.008);
            if (weak && age >= rotateMin) leaving.push(a);
            else keep.push(a);
          }
          keep.sort((x, y) => sizeWeightForSymbol(y.symbol) - sizeWeightForSymbol(x.symbol));
          while (keep.length > hardMax) leaving.push(keep.pop());
          const have = new Set(keep.map((a) => a.pair));
          const additions = [];
          let budget = free * Number(process.env.VOL_ENTER_CASH_FRAC || 0.85);
          const scored = ranked.map((r) => {
            const ret = midReturn(r.symbol);
            const tr = trendMult(r.symbol);
            return { ...r, ret15: ret, trend: tr, pick: Number(r.rangePct || 0) * tr };
          }).sort((a, b) => b.pick - a.pick);
          for (const r of scored) {
            if (have.has(r.pair)) continue;
            if (keep.length + additions.length >= hardMax) break;
            const rip = shortRun(r.symbol);
            const watched = watch.has(r.pair);
            if (Number(r.rangePct || 0) < enterPct && !(watched && rip >= Number(process.env.SHORT_RUN_ENTER || 0.008))) continue;
            if (!(r.pair && r.symbol)) continue;
            const need = costOf(r);
            if (budget < need) continue;
            additions.push(r);
            budget -= need;
          }
          if (leaving.length || additions.length) {
            if (leaving.length) console.log('MM exit ' + leaving.map((a) => a.symbol).join(',') + ' (>=' + (rotateMin / 60000) + 'm)');
            if (additions.length) console.log('MM enter ' + additions.map((a) => a.symbol + ' ' + Number(a.rangePct).toFixed(2) + '% ret=' + ((a.ret15 || 0) * 100).toFixed(2) + '%').join(', '));
            const leavePairs = new Set(leaving.map((a) => a.pair));
            const leaveSyms = leaving.map((a) => a.symbol);
            for (const a of leaving) {
              watch.set(a.pair, { ...a, leftAt: now });
              try { await ex.cancelPair(a.pair); } catch { /* ignore */ }
              pairState.delete(a.pair);
              enteredAt.delete(a.pair);
            }
            for (const [pair, w] of watch) {
              if (now - (w.leftAt || 0) > Number(process.env.WATCH_MS || 30 * 60 * 1000)) watch.delete(pair);
            }
            mmAlloc.length = 0;
            const next = [...keep, ...additions];
            const invEach = next[0] && keep[0] ? keep[0].invTargetQuote : 0;
            for (const a of next) {
              mmAlloc.push({ ...a, weight: 1 / next.length, invTargetQuote: a.invTargetQuote || invEach });
              if (!enteredAt.has(a.pair)) enteredAt.set(a.pair, now);
            }
            saveMmSet(mmAlloc);
            setSizeUniverse(mmAlloc.map((x) => x.symbol));
            if (cfg.exchange === 'coinbase' && (leaveSyms.length || additions.length)) {
              try {
                if (leaveSyms.length) {
                  await skimToBank(cfg, await getLive(), Number(process.env.BANK_ROTATE_PCT || 0.01), leaveSyms, 'run', getLive);
                  await liquidateSymbols(cfg, ex, await getLive(), leaveSyms);
                }
                if (additions.length) await seedNewInventory(cfg, ex, additions.map((a) => mmAlloc.find((x) => x.pair === a.pair)).filter(Boolean), await getLive());
              } catch (e) { console.warn('rotate bank/liq', e.message); }
            }
          }
        } catch (e) { console.warn('vol rotate', e.message); }
        await sleep(cfg.volRotateMs || Number(process.env.VOL_ROTATE_MS) || 60000);
      }
    })();
  }
  process.on('SIGINT', () => {
    saveMmSet(mmAlloc);
    const mids = {};
    for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
    pnl.print(mids, 'MM gain on stop');
    ws.close(); process.exit(0);
  });
  async function emitStatus() {
    if (emitStatus.busy) return;
    emitStatus.busy = true;
    try {
      let liveSnap = null;
      try { liveSnap = await getLive(); pnl.markHoldings(liveSnap); } catch { /* ignore */ }
      const mids = {};
      for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
      const snap = pnl.print(mids);
      console.log('  -- markets --');
      const marketRows = [];
      for (const a of mmAlloc) {
        const st = pairState.get(a.pair);
        const legs = st && st.ladder ? [...st.ladder.buys, ...st.ladder.sells] : [];
        const openB = legs.filter((o) => o.side === 'buy' && o.status === 'open');
        const openA = legs.filter((o) => o.side === 'sell' && o.status === 'open');
        const bids = openB.length;
        const asks = openA.length;
        const bidUsd = openB.reduce((s, o) => s + Number(o.size) * Number(o.price), 0);
        const askUsd = openA.reduce((s, o) => s + Number(o.size) * Number(o.price), 0);
        const mid = st && st.lastMid;
        const vs = volStatsForSymbol(a.symbol);
        const fee = realizedFeeBps(a.pair);
        const w = sizeWeightForSymbol(a.symbol);
        const book = (snap.rows || []).find((r) => r.symbol === a.symbol) || {};
        const orders = [...openB, ...openA].map((o) => ({
          side: o.side, level: o.level, size: o.size, price: o.price, status: o.status,
          usd: Number(o.size) * Number(o.price), id: o.orderId ? String(o.orderId).slice(0, 8) : '',
        }));
        const bestBid = openB.reduce((m, o) => Math.max(m, Number(o.price) || 0), 0);
        const bestAsk = openA.reduce((m, o) => {
          const px = Number(o.price);
          return px > 0 && (m === 0 || px < m) ? px : m;
        }, 0);
        const midN = Number(mid) || ((bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : 0);
        const spreadBps = (bestBid > 0 && bestAsk > 0 && midN > 0) ? ((bestAsk - bestBid) / midN) * 10000 : null;
        marketRows.push({
          symbol: a.symbol, mid: mid ? Number(mid).toFixed(6) : 'n/a',
          bids, asks, bidUsd, askUsd, bestBid, bestAsk, spreadBps,
          buyUsd: book.buyUsd || 0, sellUsd: book.sellUsd || 0,
          vol: vs ? vs.rangePct.toFixed(2) + '%' : 'n/a',
          fee: fee != null ? fee.toFixed(1) + 'bps' : 'n/a',
          w: w.toFixed(2) + 'x', wNum: w, orders,
          pricePnl: book.price || 0, makerPnl: book.maker || 0, fees: book.fees || 0,
          edgeBps: tapeEdgeBps(a.pair),
        });
      }
      marketRows.sort((a, b) => (Number(b.wNum) || 0) - (Number(a.wNum) || 0));
      for (const m of marketRows) {
        console.log('  ' + String(m.symbol).padEnd(8) + ' mid=' + m.mid + '  bid/ask ' + m.bids + '/' + m.asks +
          '  bid$=' + Number(m.bidUsd).toFixed(2) + ' ask$=' + Number(m.askUsd).toFixed(2) +
          '  vol buy=$' + Number(m.buyUsd || 0).toFixed(2) + ' sell=$' + Number(m.sellUsd || 0).toFixed(2) +
          '  w=' + m.w + '  range=' + m.vol + '  fee=' + m.fee +
          (m.spreadBps != null ? '  spr=' + Number(m.spreadBps).toFixed(1) + 'bps' : '') +
          (m.edgeBps != null ? '  edge=' + Number(m.edgeBps).toFixed(0) + 'bps' : ''));
      }
      const workingBids = marketRows.reduce((s, m) => s + (Number(m.bidUsd) || 0), 0);
      const workingAsks = marketRows.reduce((s, m) => s + (Number(m.askUsd) || 0), 0);
      const invUsd = liveSnap ? Number(liveSnap.positionsValue || 0) : 0;
      const cashUsd = liveSnap ? Number(liveSnap.freeQuote || 0) : 0;
      const quoteHold = liveSnap ? Number(liveSnap.quoteHold || 0) : 0;
      const wallet = [];
      const qAmt = cashUsd + quoteHold;
      wallet.push({ asset: cfg.quote, amount: qAmt, mid: 1, value: qAmt });
      const pos = (liveSnap && liveSnap.positions) || {};
      for (const [sym, p0] of Object.entries(pos)) {
        const amt = Number(p0.amount || 0);
        const mid = Number(p0.mid || mids[sym] || 0);
        const value = Number(p0.valueQuote != null ? p0.valueQuote : amt * mid);
        wallet.push({ asset: sym, amount: amt, mid, value });
      }
      wallet.sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
      console.log('  WORKING bids=$' + workingBids.toFixed(2) + ' asks=$' + workingAsks.toFixed(2) +
        '  inventory=$' + invUsd.toFixed(2) + '  cash=$' + cashUsd.toFixed(2));
      saveMmSet(mmAlloc);
      const hours = Math.max((snap.elapsedMs || 0) / 3600000, 1 / 60);
      const volNow = marketRows.reduce((s, m) => s + Number(m.buyUsd || 0) + Number(m.sellUsd || 0), 0);
      const proj = {
        hours,
        vol: volNow / hours,
        maker: Number(snap.makerPnl || 0) / hours,
        fees: Number(snap.fees || 0) / hours,
        wallet: Number(snap.walletGain || 0) / hours,
        price: Number(snap.pricePnl || 0) / hours,
      };
      postStatus({
        bot: process.env.BOT || 'ladder', exchange: cfg.exchange, quote: cfg.quote,
        pnl: snap, markets: marketRows, wallet, proj,
        working: { bids: workingBids, asks: workingAsks, inventory: invUsd, cash: cashUsd },
        api: snapshotApi(), feesHist: feeSnapshot(),
        edgeBps: bookEdgeBps(),
        bankHoldings: bankHoldings(),
        movers: (() => {
          const map = new Map();
          for (const r of [...topVolatiles(12), ...topMovers(12)]) {
            const k = String(r.symbol || '').toUpperCase();
            if (!k) continue;
            const prev = map.get(k);
            if (!prev) map.set(k, { ...r, symbol: k });
            else {
              if (Number(r.rangePct || 0) > Number(prev.rangePct || 0)) prev.rangePct = r.rangePct;
              if (Math.abs(Number(r.ret || 0)) > Math.abs(Number(prev.ret || 0))) prev.ret = r.ret;
            }
          }
          return [...map.values()];
        })(),
      });
    } finally { emitStatus.busy = false; }
  }
  (async () => {
    while (true) {
      try { await emitStatus(); } catch (e) { console.warn('status tick', e.message); }
      await sleep(Number(process.env.PNL_PRINT_MS || 30000));
    }
  })();
  const gap = Number(process.env.ORDER_STAGGER_MS || cfg.rateLimitMs || 150);
  const fresh = sortAllocByWeight(mmAlloc.filter((a) => !pairState.has(a.pair)));
  if (fresh.length) {
    console.log('initial ladders high-w first n=' + fresh.length + ' ' + fresh.map((a) => a.symbol).join(','));
    for (const a of fresh) {
      try { await processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive); }
      catch (e) { console.error(a.symbol, e.message); }
    }
  }
  while (true) {
    sortAllocByWeight(mmAlloc);
    setLiveMmAlloc(mmAlloc);
    try { await harvestLowWeightBids(cfg, ex, mmAlloc, pairState, getLive); } catch (e) { console.warn('harvest', e.message); }
    await Promise.all(mmAlloc.map((a, i) => sleep(i * Math.min(gap, 40)).then(() =>
      processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive).catch((e) => console.error(a.symbol, e.message))
    )));
    await sleep(cfg.updateIntervalMs);
  }
}

async function main() {
  startApiTally(Number(process.env.API_TALLY_MS || 10000));
  console.log('BOT=' + (process.env.BOT || 'ladder') + ' exchange=' + cfg.exchange + ' dryRun=' + cfg.dryRun + ' quote=' + cfg.quote + ' symbols=' + (cfg.symbols || []).join(','));
  logSession({ exchange: cfg.exchange, quote: cfg.quote });
  if (cfg.exchange === 'kraken' && (!cfg.krakenApiKey || !cfg.krakenApiSecret)) throw new Error('Missing Kraken keys');
  if (cfg.exchange === 'coinbase') console.log('JWT', ex.loadKeyInfo());
  const productMap = await ex.getProducts();
  if (cfg.exchange === 'coinbase') {
    const allPairs = [...new Set(Object.values(productMap).map((x) => x.pair).filter(Boolean))];
    startCoinbaseTickerWs(allPairs, () => {});
    console.log('ticker warmup ' + allPairs.length + ' products');
    await sleep(Number(process.env.TICKER_WARMUP_MS || 2000));
  }
  if (cfg.cancelAllOrdersOnStartup && cfg.exchange !== 'print') await ex.cancelAll();
  let live = await fetchLivePortfolio(cfg, ex, productMap);
  if (cfg.exchange === 'coinbase' && !cfg.dryRun) {
    console.log('bank skim 0.5% -> trade bot bank');
    try {
      await skimToBank(cfg, live, Number(process.env.BANK_START_PCT || 0.005), null, 'startup', () => fetchLivePortfolio(cfg, ex, productMap));
      live = await waitForSettlement(cfg, ex, productMap, 'after startup bank skim');
    } catch (e) { console.warn('startup bank skim', e.message); }
  }
  let lists = await buildLists(cfg, productMap, live.totalEquity, live);
  const keep = new Set(lists.mmAlloc.map((a) => a.symbol));
  const dump = Object.keys(live.positions || {}).filter((s) => !keep.has(s));
  if (dump.length && cfg.exchange !== 'print') {
    console.log('startup sell non-MM: ' + dump.join(','));
    await liquidateSymbols(cfg, ex, live, dump, productMap);
    live = await waitForSettlement(cfg, ex, productMap, 'after flatten non-MM');
    invalidateLiveCache();
    live = await fetchLivePortfolio(cfg, ex, productMap);
    const leftover = dump.filter((s) => live.positions[s] && live.positions[s].amount > 0);
    if (leftover.length && cfg.exchange === 'coinbase' && !cfg.dryRun) {
      console.log('bank leftover orphans ' + leftover.join(','));
      try { await skimToBank(cfg, live, 1, leftover, 'startup', () => fetchLivePortfolio(cfg, ex, productMap)); }
      catch (e) { console.warn('orphan bank', e.message); }
      live = await waitForSettlement(cfg, ex, productMap, 'after orphan bank');
    }
    lists = await buildLists(cfg, productMap, live.totalEquity, live);
  }
  await rebalanceCombined(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after combined');
  lists = await buildLists(cfg, productMap, live.totalEquity, live);
  await rebalanceBuysAfterSettle(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after buy pass');
  lists = await buildLists(cfg, productMap, live.totalEquity, live);
  await ensureQuoteForBids(cfg, ex, lists.mmAlloc, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after bid-cash');
  lists = await buildLists(cfg, productMap, live.totalEquity, live);
  pnl.markHoldings(live);
  const orderSizeUsd = getMmOrderSizeUsd(cfg, lists.mmCapital);
  if (cfg.mmEnabled) await runMm(lists.mmAlloc, orderSizeUsd, productMap);
}

export { main, cfg };

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && path.resolve(process.argv[1]) === self;
if (invoked) {
  main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
