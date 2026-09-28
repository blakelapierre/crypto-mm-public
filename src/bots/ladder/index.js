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
  rebalanceCombined, rebalanceBuysAfterSettle,
} from '../../shared/portfolio.js';
import { processPair } from './strategy.js';
import { createVolScan, setSizeUniverse, sizeWeightForSymbol, volStatsForSymbol } from '../../shared/vol-scan.js';
import { saveMmSet } from '../../shared/mm-set.js';
import { realizedFeeBps } from '../../shared/fee-spread.js';
import { skimToBank, liquidateSymbols, seedNewInventory } from '../../shared/bank.js';
import { postStatus } from '../../shared/status-client.js';
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

async function runMm(mmAlloc, orderSizeUsd, productMap) {
  console.log('\nladder MM');
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
      let lastRotateAt = Date.now();
      await sleep(Math.max(cfg.volScanMs || 60000, 90000));
      while (true) {
        try {
          if (Date.now() - lastRotateAt < rotateMin) {
            await sleep(Math.min(15000, rotateMin));
            continue;
          }
          const ranked = volScan.ranking();
          const bandN = cfg.mmMaxPairs + Number(process.env.ROTATE_HYSTERESIS || 2);
          const band = new Set(ranked.slice(0, bandN).map((r) => r.pair));
          const next = mmAlloc.filter((a) => band.has(a.pair));
          for (const r of ranked) {
            if (next.length >= cfg.mmMaxPairs) break;
            if (!next.some((x) => x.pair === r.pair)) next.push(r);
          }
          if (next.length) {
            const nextPairs = new Set(next.map((a) => a.pair));
            const prev = new Set(mmAlloc.map((a) => a.pair));
            const changed = [...nextPairs].some((p) => !prev.has(p)) || [...prev].some((p) => !nextPairs.has(p));
            if (changed) {
              lastRotateAt = Date.now();
              console.log('MM rotate -> ' + next.map((a) => a.symbol).join(','));
              const leaving = mmAlloc.filter((a) => !nextPairs.has(a.pair)).map((a) => a.symbol);
              for (const [pair] of pairState) {
                if (!nextPairs.has(pair)) {
                  try { await ex.cancelPair(pair); } catch { /* ignore */ }
                  pairState.delete(pair);
                }
              }
              const invEach = mmAlloc[0] ? mmAlloc[0].invTargetQuote : 0;
              mmAlloc.length = 0;
              for (const a of next) mmAlloc.push({ ...a, weight: 1 / next.length, invTargetQuote: invEach });
              saveMmSet(mmAlloc);
              setSizeUniverse(mmAlloc.map((x) => x.symbol));
              if (cfg.exchange === 'coinbase' && leaving.length) {
                try {
                  console.log('bank skim 1% leaving ' + leaving.join(','));
                  await skimToBank(cfg, await getLive(), Number(process.env.BANK_ROTATE_PCT || 0.01), leaving);
                  await liquidateSymbols(cfg, ex, await getLive(), leaving);
                  await seedNewInventory(cfg, ex, mmAlloc, await getLive());
                } catch (e) { console.warn('rotate bank/liq', e.message); }
              }
            }
          }
        } catch (e) { console.warn('vol rotate', e.message); }
        await sleep(cfg.volRotateMs || Number(process.env.VOL_ROTATE_MS) || 180000);
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
        marketRows.push({
          symbol: a.symbol, mid: mid ? Number(mid).toFixed(6) : 'n/a',
          bids, asks, bidUsd, askUsd,
          buyUsd: book.buyUsd || 0, sellUsd: book.sellUsd || 0,
          vol: vs ? vs.rangePct.toFixed(2) + '%' : 'n/a',
          fee: fee != null ? fee.toFixed(1) + 'bps' : 'n/a',
          w: w.toFixed(2) + 'x', wNum: w, orders,
        });
      }
      marketRows.sort((a, b) => (Number(b.wNum) || 0) - (Number(a.wNum) || 0));
      for (const m of marketRows) {
        console.log('  ' + String(m.symbol).padEnd(8) + ' mid=' + m.mid + '  bid/ask ' + m.bids + '/' + m.asks +
          '  bid$=' + Number(m.bidUsd).toFixed(2) + ' ask$=' + Number(m.askUsd).toFixed(2) +
          '  vol buy=$' + Number(m.buyUsd || 0).toFixed(2) + ' sell=$' + Number(m.sellUsd || 0).toFixed(2) +
          '  w=' + m.w + '  range=' + m.vol + '  fee=' + m.fee);
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
      postStatus({
        bot: process.env.BOT || 'ladder', exchange: cfg.exchange, quote: cfg.quote,
        pnl: snap, markets: marketRows, wallet,
        working: { bids: workingBids, asks: workingAsks, inventory: invUsd, cash: cashUsd },
        api: snapshotApi(),
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
  const fresh = mmAlloc.filter((a) => !pairState.has(a.pair));
  if (fresh.length) {
    console.log('initial ladders concurrent n=' + fresh.length);
    await Promise.all(fresh.map((a, i) => sleep(i * gap).then(() =>
      processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive).catch((e) => console.error(a.symbol, e.message))
    )));
  }
  while (true) {
    await Promise.all(mmAlloc.map((a, i) => sleep(i * Math.min(gap, 80)).then(() =>
      processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive).catch((e) => console.error(a.symbol, e.message))
    )));
    await sleep(cfg.updateIntervalMs);
  }
}

async function main() {
  startApiTally(Number(process.env.API_TALLY_MS || 10000));
  console.log('BOT=' + (process.env.BOT || 'ladder') + ' exchange=' + cfg.exchange + ' dryRun=' + cfg.dryRun + ' quote=' + cfg.quote + ' symbols=' + (cfg.symbols || []).join(','));
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
      await skimToBank(cfg, live, Number(process.env.BANK_START_PCT || 0.005));
      live = await fetchLivePortfolio(cfg, ex, productMap);
    } catch (e) { console.warn('startup bank skim', e.message); }
  }
  let lists = await buildLists(cfg, productMap, live.totalEquity);
  const keep = new Set(lists.mmAlloc.map((a) => a.symbol));
  const dump = Object.keys(live.positions || {}).filter((s) => !keep.has(s));
  if (dump.length && cfg.exchange !== 'print') {
    console.log('startup sell non-MM: ' + dump.join(','));
    await liquidateSymbols(cfg, ex, live, dump);
    live = await waitForSettlement(cfg, ex, productMap, 'after flatten non-MM');
    lists = await buildLists(cfg, productMap, live.totalEquity);
  }
  await rebalanceCombined(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after combined');
  lists = await buildLists(cfg, productMap, live.totalEquity);
  await rebalanceBuysAfterSettle(cfg, ex, lists.combinedTargets, live);
  live = await waitForSettlement(cfg, ex, productMap, 'after buy pass');
  lists = await buildLists(cfg, productMap, live.totalEquity);
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
