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
import { processPair, harvestLowWeightBids, setLiveMmAlloc, setLivePairState, holdInfo } from './strategy.js';
import { pathToFileURL } from 'url';
let strat = { processPair, harvestLowWeightBids, setLiveMmAlloc, setLivePairState, holdInfo };
async function reloadStrategy() {
  const href = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'strategy.js')).href + '?t=' + Date.now();
  const next = await import(href);
  strat = next;
  console.log('strategy reloaded');
}
process.on('SIGUSR2', () => { reloadStrategy().catch((e) => console.warn('reload', e.message)); });
import { createVolScan, setSizeUniverse, sizeWeightForSymbol, volStatsForSymbol, topMovers, topVolatiles, midHistory } from '../../shared/vol-scan.js';
import { tapeEdgeBps, bookEdgeBps } from '../../shared/pair-tape.js';
import { saveMmSet } from '../../shared/mm-set.js';
import { realizedFeeBps, feeSnapshot } from '../../shared/fee-spread.js';
import { skimToBank, liquidateSymbols, seedNewInventory, bankHoldings, refreshBankHoldings } from '../../shared/bank.js';
import { queueExit, tickExits, exitBook, clearExit, sweepStranded, limitFails } from '../../shared/exit-book.js';
import { postStatus, postMids, pullLiveConfig, postVenueScan } from '../../shared/status-client.js';
import { logSession, logKpi } from '../../shared/fill-log.js';
import { planRotation } from '../../shared/rotate.js';
import { noteMid, midReturn } from '../../shared/mid-ring.js';
import { holdRealizedUsd, holdFills } from '../../shared/hold-pnl.js';
import { bindLiveConfig, liveConfigSnap, applyLiveConfig, persistLiveConfig } from '../../shared/live-config.js';
import { refreshFeeTier, feeTierSnap, etaNextTierHours, feeTierNextAt } from '../../shared/fee-tier.js';
import { snapshotApi, startApiTally } from '../../shared/api-timing.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/ladder.env');
const cfg = baseConfig();
bindLiveConfig(cfg);
{
  const raw = process.env.SYMBOLS || (cfg.symbols || []).join(',');
  cfg.symbols = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (String(process.env.BOT || '').toLowerCase() === 'comp' && !cfg.symbols.length) cfg.symbols = ['GNOT'];
}
const orderRegistry = new Map();
const selection = { effPairs: 0, rows: [] };
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
  const livePairs = new Set(mmAlloc.map((a) => a.pair));
  for (const [id, rec] of orderRegistry) {
    if (rec.why !== 'adopted' || rec.status !== 'open') continue;
    if (!livePairs.has(rec.pair)) {
      try { await ex.cancelOrder(id); } catch { /* ignore */ }
      rec.status = 'cancelled';
      console.log('  drop adopted ' + rec.pair + ' not in MM set');
      continue;
    }
    let st = pairState.get(rec.pair);
    if (!st) {
      const a = mmAlloc.find((x) => x.pair === rec.pair);
      st = { ladder: { buys: [], sells: [] }, symbol: a && a.symbol, lastMid: 0 };
      pairState.set(rec.pair, st);
    }
    const leg = { level: 1, side: rec.side, price: rec.price, size: rec.size, orderId: id, status: 'open' };
    (rec.side === 'sell' ? st.ladder.sells : st.ladder.buys).push(leg);
  }
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
  {
    const scanMap = (cfg.symbols && cfg.symbols.length)
      ? Object.fromEntries(Object.entries(productMap).filter(([sym, info]) => {
          const want = new Set(cfg.symbols.map((s) => String(s).toUpperCase()));
          return want.has(String(sym).toUpperCase());
        }))
      : productMap;
    const volScan = createVolScan(cfg, Object.keys(scanMap).length ? scanMap : productMap);
    const rotateMin = Number(process.env.ROTATE_MIN_HOLD_MS || 1800000);
    console.log('vol scan every ' + ((cfg.volScanMs || 60000) / 1000) + 's window=' + (cfg.volWindowMin || 15) + 'm hold=' + (rotateMin / 60000) + 'm');
    (async () => {
      while (true) {
        try {
          const n = await volScan.tick();
          const top = volScan.ranking().slice(0, 8);
          postVenueScan(cfg.exchange, volScan.ranking());
          if (top.length) console.log('vol ' + top.map((r) => r.symbol + ' ' + r.rangePct.toFixed(2) + '%').join('  ') + ' (n=' + n + ')');
        } catch (e) { console.warn('vol scan', e.message); }
        await sleep(cfg.volScanMs || Number(process.env.VOL_SCAN_MS) || 60000);
      }
    })();
    if (liveVol) (async () => {
      const enteredAt = new Map();
      const watch = new Map();
      for (const a of mmAlloc) enteredAt.set(a.pair, Date.now());
      const enterPct = Number(process.env.VOL_ENTER_PCT || 2);
      const exitPct = Number(process.env.VOL_EXIT_PCT || 1.5);
      const maxPairs = Math.max(1, Number(process.env.MM_MAX_PAIRS_HARD || process.env.MM_MAX_PAIRS || cfg.mmMaxPairs || 4));
      const hardMax = maxPairs;
      const levels = Math.max(1, cfg.mmLevels || 1);
      await sleep(Number(process.env.VOL_ENTER_WAIT_MS || 0));
      while (true) {
        try {
          const ranked = volScan.ranking();
          const now = Date.now();
          let live = null;
          try { live = await getLive(); } catch { live = null; }
          const cash = live ? Number(live.freeQuote || 0) : 0;
          const inv = live ? Math.max(0, Number(live.totalEquity || 0) - cash) : 0;
          const minUsd = Math.max(cfg.minOrderUsd || 1, 1);
          const effPairs = Math.max(1, Math.min(Number(process.env.MM_MAX_PAIRS || 5), Math.floor((cash + inv) / (minUsd * Number(process.env.PAIR_CASH_K || 2.5)))));
          if (effPairs !== planRotation.eff) { planRotation.eff = effPairs; console.log('effPairs=' + effPairs); }
          process.env.MM_MAX_PAIRS_HARD = String(effPairs);
          selection.effPairs = effPairs;
          const holdMin = Number(process.env.ROTATE_MIN_HOLD_MS || 1800000) / 60000;
          const inSet = new Set(mmAlloc.map((a) => a.symbol));
          const rows = mmAlloc.map((a) => {
            const age = Math.round((now - (enteredAt.get(a.pair) || now)) / 60000);
            const exits = exitBook().some((e) => e.symbol === a.symbol);
            return { symbol: a.symbol, state: 'in', why: exits ? 'exit queued' : (age < holdMin ? 'holding ' + age + '/' + holdMin + 'm' : 'quoting, held ' + age + 'm') };
          });
          for (const r of ranked.slice(0, 8)) {
            if (inSet.has(r.symbol)) continue;
            const hot = Number(r.rangePct || 0) >= Number(process.env.VOL_ENTER_PCT || 2);
            rows.push({ symbol: r.symbol, state: 'out', why: hot ? 'out: pair cap ' + effPairs : 'out: vol ' + Number(r.rangePct || 0).toFixed(2) + '% < ' + Number(process.env.VOL_ENTER_PCT || 2) + '%' });
          }
          selection.rows = rows;
          function costOf(row) {
            const mid = Number(row.last || 0);
            const minV = (row.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
            const minUsd = Math.max(cfg.minOrderUsd || 1, mid > 0 ? minV * mid : cfg.minOrderUsd || 1);
            return minUsd * 2;
          }
          const { keep, leaving, additions } = planRotation({ mmAlloc, ranked, now, enteredAt, watch, live, cfg });
          if (leaving.length || additions.length) {
            if (leaving.length) console.log('MM exit ' + leaving.map((a) => a.symbol).join(',') + ' (>=' + (rotateMin / 60000) + 'm)');
            if (additions.length) console.log('MM enter ' + additions.map((a) => a.symbol + ' ' + Number(a.rangePct).toFixed(2) + '% ret=' + ((a.ret15 || 0) * 100).toFixed(2) + '%').join(', '));
            const leavePairs = new Set(leaving.map((a) => a.pair));
            const leaveSyms = leaving.map((a) => a.symbol);
            for (const a of leaving) {
              watch.set(a.pair, { ...a, leftAt: now });
              try { await ex.cancelPair(a.pair); } catch { /* ignore */ }
              const pos = live && live.positions && live.positions[a.symbol];
              if (pos && Number(pos.amount) > 0) queueExit(a.symbol, a.pair, pos.amount);
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
              if (!enteredAt.has(a.pair)) { enteredAt.set(a.pair, now); clearExit(a.symbol); }
            }
            saveMmSet(mmAlloc);
            setSizeUniverse(mmAlloc.map((x) => x.symbol));
            if (cfg.exchange === 'coinbase' && (leaveSyms.length || additions.length)) {
              try {
                if (leaveSyms.length) {
                  const liveNow = await getLive();
                  skimToBank(cfg, liveNow, Number(process.env.BANK_ROTATE_PCT || 0), leaveSyms, 'run', getLive)
                    .then(() => refreshBankHoldings(cfg).catch(() => {}))
                    .catch((e) => console.warn('rotate bank', e.message));
                  await liquidateSymbols(cfg, ex, await getLive(), leaveSyms);
                }
                if (additions.length) await seedNewInventory(cfg, ex, additions.map((a) => mmAlloc.find((x) => x.pair === a.pair)).filter(Boolean), await getLive());
              } catch (e) { console.warn('rotate bank/liq', e.message); }
            }
          }
        } catch (e) { console.warn('vol rotate', e.message); }
        try {
          const exitLive = await getLive();
          sweepStranded(exitLive, mmAlloc);
          await tickExits(ex, orderRegistry, exitLive);
        } catch (e) { console.warn('exit tick', e.message); }
        await sleep(cfg.volRotateMs || Number(process.env.VOL_ROTATE_MS) || 60000);
      }
    })();
    setInterval(() => {
      getLive().then((liveNow) => { sweepStranded(liveNow, mmAlloc); return tickExits(ex, orderRegistry, liveNow); }).catch((e) => console.warn('exit tick', e.message));
    }, Number(process.env.EXIT_TICK_MS || 15000));
  }
  const stop = () => {
    try { persistLiveConfig(process.env.BOT_CONFIG || 'configs/ladder.env'); } catch (e) { console.warn('persist env', e.message); }
    saveMmSet(mmAlloc);
    const mids = {};
    for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
    const snap = pnl.print(mids, 'MM gain on stop');
    const fills = (snap && snap.rows || []).reduce((s, r) => s + Number(r.fills || 0), 0);
    try { logKpi(snap || {}, { fills }); } catch {}
    ws.close(); process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  async function emitStatus() {
    if (emitStatus.busy) return;
    emitStatus.busy = true;
    try {
      try {
        const pending = await pullLiveConfig(process.env.BOT || 'ladder');
        if (pending && pending.values) applyLiveConfig(pending.values);
      } catch { /* ignore */ }
      let liveSnap = null;
      try { liveSnap = await getLive(); pnl.markHoldings(liveSnap); } catch { /* ignore */ }
      const mids = {};
      for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
      const snap = pnl.print(mids);
      const gap = Number(snap && snap.otherPnl || 0);
      if (Math.abs(gap) > Number(process.env.RECON_GAP_USD || 0.05)) {
        if (!emitStatus.alerted) console.log('  RECON ALERT gap=' + gap.toFixed(4));
        emitStatus.alerted = true;
      } else emitStatus.alerted = false;
      const bankUsd = (bankHoldings() || []).reduce((s, h) => s + Number(h.value || 0), 0);
      console.log('  -- markets --');
      const marketRows = [];
      for (const a of mmAlloc) {
        const st = pairState.get(a.pair);
        const legs = st && st.ladder ? [...st.ladder.buys, ...st.ladder.sells] : [];
        const seenId = new Set();
        const openB = legs.filter((o) => {
          if (!(o.side === 'buy' && o.status === 'open')) return false;
          const id = String(o.orderId || '');
          if (id && seenId.has(id)) return false;
          if (id) seenId.add(id);
          return true;
        });
        const openA = legs.filter((o) => {
          if (!(o.side === 'sell' && o.status === 'open')) return false;
          const id = String(o.orderId || '');
          if (id && seenId.has('s' + id)) return false;
          if (id) seenId.add('s' + id);
          return true;
        });
        const bids = openB.length;
        const asks = openA.length;
        const bidUsd = openB.reduce((s, o) => s + Number(o.size) * Number(o.price), 0);
        const askUsd = openA.reduce((s, o) => s + Number(o.size) * Number(o.price), 0);
        const mid = st && st.lastMid;
        const vs = volStatsForSymbol(a.symbol);
        const fee = realizedFeeBps(a.pair);
        const w = sizeWeightForSymbol(a.symbol);
        const book = (snap.rows || []).find((r) => r.symbol === a.symbol) || {};
        const basis = pnl.avgBuy ? pnl.avgBuy(a.symbol) : 0;
        const feeFrac = (realizedFeeBps(a.pair) != null ? realizedFeeBps(a.pair) : 35) / 10000;
        const orders = [...openB, ...openA].map((o) => {
          const usd = Number(o.size) * Number(o.price);
          let proj = null;
          if (String(o.side).toLowerCase() === 'sell' && Number(o.size) > 0) {
            const buyPx = basis > 0 ? basis : (Number(mid) > 0 ? Number(mid) * (1 - feeFrac) : 0);
            if (buyPx > 0) {
              const gross = (Number(o.price) - buyPx) * Number(o.size);
              const fees = feeFrac * Number(o.price) * Number(o.size) + feeFrac * buyPx * Number(o.size);
              proj = gross - fees;
            }
          }
          return {
            side: o.side, level: o.level, size: o.size, price: o.price, status: o.status,
            usd, proj, id: o.orderId ? String(o.orderId).slice(0, 8) : '',
          };
        });
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
          fills: book.fills || 0,
          edgeBps: tapeEdgeBps(a.pair),
          invUsd: Number((liveSnap && liveSnap.positions && liveSnap.positions[a.symbol] && liveSnap.positions[a.symbol].valueQuote) || 0),
          heldUsd: holdInfo(a.symbol, Number(mid) || 0).usd,
          heldGain: holdInfo(a.symbol, Number(mid) || 0).gain,
          rising: midReturn(a.symbol) > 0,
          why: (selection.rows.find((r) => r.symbol === a.symbol) || {}).why || 'in set',
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
      const fillCount = (snap.rows || []).reduce((s, r) => s + Number(r.fills || 0), 0);
      const wallet = [];
      const qAmt = cashUsd + quoteHold;
      wallet.push({ asset: cfg.quote, amount: qAmt, mid: 1, value: qAmt });
      const pos = (liveSnap && liveSnap.positions) || {};
      for (const [sym, p0] of Object.entries(pos)) {
        const amt = Number(p0.amount || 0) + Number(p0.hold || 0);
        const mid = Number(p0.mid || mids[sym] || 0);
        const value = Number(p0.valueQuote != null ? p0.valueQuote : amt * mid);
        wallet.push({ asset: sym, amount: amt, mid, value });
      }
      wallet.sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
      console.log('  WORKING bids=$' + workingBids.toFixed(2) + ' asks=$' + workingAsks.toFixed(2) +
        '  inventory=$' + invUsd.toFixed(2) + '  cash=$' + cashUsd.toFixed(2) +
        '  onBids=$' + quoteHold.toFixed(2) + '  equity=$' + Number((liveSnap && liveSnap.totalEquity) || (cashUsd + quoteHold + invUsd)).toFixed(2) +
        '  fills=' + fillCount);
      try { logKpi(snap, { cash: cashUsd, inv: invUsd, fills: fillCount }); } catch {}
      try { await refreshFeeTier(cfg); } catch {}
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
        working: {
          bids: workingBids, asks: workingAsks, inventory: invUsd, cash: cashUsd, cashHold: quoteHold,
          equity: Number((liveSnap && liveSnap.totalEquity) || 0),
          bankEquity: null, fills: fillCount,
          holdUsd: marketRows.reduce((s, m) => s + Number(m.heldUsd || 0), 0),
          holdGain: marketRows.reduce((s, m) => s + Number(m.heldGain || 0), 0),
          holdRealized: holdRealizedUsd(),
          holdFills: holdFills(),
        },
        api: snapshotApi(), feesHist: feeSnapshot(),
        edgeBps: bookEdgeBps(),
        recon: { gapUsd: gap, gapPct: Math.abs(gap) / Math.max(1, volNow || 1), alert: Math.abs(gap) > Number(process.env.RECON_GAP_USD || 0.05), transfers: (snap && snap.transfers) || [] },
        exits: exitBook(),
        limitFails: limitFails(),
        selection,
        bankHoldings: (bankHoldings() || []).map((h) => ({ ...h, value: h.asset === cfg.quote ? h.qty : h.qty * Number(mids[h.asset] || 0) })),
        liveConfig: liveConfigSnap(),
        feeTier: feeTierSnap(),
        tierNextAt: feeTierNextAt(),
        tierEtaH: etaNextTierHours((marketRows.reduce((s, m) => s + Number(m.buyUsd || 0) + Number(m.sellUsd || 0), 0)) / Math.max((snap.elapsedMs || 1) / 3600000, 1 / 60)),
        moversVol: topVolatiles(12).map((r) => ({
          symbol: r.symbol, rangePct: r.rangePct, ret: r.ret,
          spark: (midHistory(r.symbol) || []).map((x) => ({ t: x.t, p: x.mid })),
        })),
        moversPrice: topMovers(12).map((r) => ({
          symbol: r.symbol, rangePct: r.rangePct, ret: r.ret,
          spark: (midHistory(r.symbol) || []).map((x) => ({ t: x.t, p: x.mid })),
        })),
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
      try { await strat.processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive); }
      catch (e) { console.error(a.symbol, e.message); }
    }
  }
  while (true) {
    sortAllocByWeight(mmAlloc);
    setLiveMmAlloc(mmAlloc);
    try { await strat.harvestLowWeightBids(cfg, ex, mmAlloc, pairState, getLive); } catch (e) { console.warn('harvest', e.message); }
    await Promise.all(mmAlloc.map((a, i) => sleep(i * Math.min(gap, 40)).then(() =>
      strat.processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive).catch((e) => console.error(a.symbol, e.message))
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
  else if (ex.listOpen) {
    const open = await ex.listOpen();
    for (const o of open) {
      const id = o.order_id;
      if (!id) continue;
      const side = String(o.side || '').toLowerCase();
      const cfg0 = o.order_configuration || {};
      const lim = cfg0.limit_limit_gtc || cfg0.sor_limit_ioc || {};
      orderRegistry.set(id, { orderId: id, pair: o.product_id, side, price: lim.limit_price, size: lim.base_size, status: 'open', why: 'adopted' });
    }
    if (open.length) console.log('adopted open orders ' + open.length);
  }
  let live = await fetchLivePortfolio(cfg, ex, productMap);
  if (cfg.exchange === 'coinbase' && !cfg.dryRun) {
    console.log('bank skim ' + Number(process.env.BANK_START_PCT || 0) + ' -> trade bot bank (bg)');
    const skimLive = live;
    skimToBank(cfg, skimLive, Number(process.env.BANK_START_PCT || 0.005), null, 'startup', () => fetchLivePortfolio(cfg, ex, productMap))
      .then(() => refreshBankHoldings(cfg))
      .catch((e) => console.warn('startup bank skim', e.message));
  }
  let lists = await buildLists(cfg, productMap, live.totalEquity, live);
  const keep = new Set(lists.mmAlloc.map((a) => a.symbol));
  const dump = Object.keys(live.positions || {}).filter((s) => !keep.has(s));
  if (dump.length && cfg.exchange !== 'print') {
    console.log('startup sweep non-MM: ' + dump.join(','));
    sweepStranded(live, lists.mmAlloc);
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
