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
import { processPair, harvestLowWeightBids, setLiveMmAlloc, setLivePairState, holdInfo, quoteSnap, planBook, bookPlan, blockedLeave, previewGate, hardBidVeto } from './strategy.js';
import { pathToFileURL } from 'url';
let strat = { processPair, harvestLowWeightBids, setLiveMmAlloc, setLivePairState, holdInfo, quoteSnap, planBook, bookPlan, blockedLeave, previewGate, hardBidVeto };
async function reloadStrategy() {
  const href = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'strategy.js')).href + '?t=' + Date.now();
  const next = await import(href);
  strat = next;
  console.log('strategy reloaded');
}
process.on('SIGUSR2', () => { reloadStrategy().catch((e) => console.warn('reload', e.message)); });
import { createVolScan, setSizeUniverse, sizeWeightForSymbol, volStatsForSymbol, topMovers, topVolatiles, midHistory, scannerSnap, noteProductsAt } from '../../shared/vol-scan.js';
import { tapeEdgeBps, bookEdgeBps } from '../../shared/pair-tape.js';
import { saveMmSet } from '../../shared/mm-set.js';
import { realizedFeeBps, feeSnapshot } from '../../shared/fee-spread.js';
import { skimToBank, liquidateSymbols, seedNewInventory, bankHoldings, refreshBankHoldings } from '../../shared/bank.js';
import { queueExit, tickExits, exitBook, clearExit, sweepStranded, limitFails, dustList, strandedTakerSnap } from '../../shared/exit-book.js';
import { postStatus, postMids, pullLiveConfig, postVenueScan } from '../../shared/status-client.js';
import { logSession, logKpi } from '../../shared/fill-log.js';
import { planRotation } from '../../shared/rotate.js';
import { noteMid, midReturn, remember, seedPxLog } from '../../shared/mid-ring.js';
import { sellable, reservationSnap } from '../../shared/free-qty.js';
import { holdRealizedUsd, holdFills } from '../../shared/hold-pnl.js';
import { bindLiveConfig, liveConfigSnap, applyLiveConfig, persistLiveConfig } from '../../shared/live-config.js';
import { refreshFeeTier, feeTierSnap, etaNextTierHours, feeTierNextAt } from '../../shared/fee-tier.js';
import { snapshotApi, startApiTally } from '../../shared/api-timing.js';
import { startVenueRecon, feeReport } from '../../shared/venue-recon.js';

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
    seedPxLog(15 * 60 * 1000);
    {
      const cut = Date.now() - 15 * 60 * 1000;
      for (const a of mmAlloc) {
        for (const x of midHistory(a.symbol) || []) {
          if (x && x.t >= cut && Number(x.mid) > 0) remember(a.symbol, x.mid, x.t);
        }
      }
    }
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
      runMm._entered = enteredAt;
      runMm._watch = watch;
      function commitSet(reason) {
        runMm._setVersion = (runMm._setVersion || 0) + 1;
        runMm._setAt = Date.now();
        const pairs = mmAlloc.map((a) => ({
          symbol: a.symbol, pair: a.pair, role: 'in',
          enteredAt: enteredAt.get(a.pair) || Date.now(),
          rangePct: a.rangePct != null ? a.rangePct : null,
          ret15: a.ret15 != null ? a.ret15 : null,
          selectedBy: a.selectedBy || 'scanner',
        }));
        runMm._setPairs = pairs;
        saveMmSet(mmAlloc, { version: runMm._setVersion, updatedAt: runMm._setAt, pairs });
        if (reason) console.log('  SET v' + runMm._setVersion + ' ' + pairs.map((p) => p.symbol).join(',') + ' ' + reason);
      }
      for (const a of mmAlloc) {
        a.selectedBy = a.selectedBy || 'scanner';
        enteredAt.set(a.pair, Date.now());
      }
      commitSet('start');
      const enterPct = Number(process.env.VOL_ENTER_PCT || 2);
      const exitPct = Number(process.env.VOL_EXIT_PCT || 1.5);
      const maxPairs = Math.max(1, Number(process.env.MM_MAX_PAIRS_HARD || process.env.MM_MAX_PAIRS || cfg.mmMaxPairs || 4));
      const hardMax = maxPairs;
      const levels = Math.max(1, cfg.mmLevels || 1);
      await sleep(Number(process.env.VOL_ENTER_WAIT_MS || 0));
      while (true) {
        try {
          if (!runMm._productsAt) { runMm._productsAt = Date.now(); noteProductsAt(new Date().toISOString()); }
          if (Date.now() - runMm._productsAt > Number(process.env.PRODUCTS_REFRESH_MS || 1800000)) {
            try {
              const nextMap = await ex.getProducts();
              for (const k of Object.keys(productMap)) if (!nextMap[k]) delete productMap[k];
              Object.assign(productMap, nextMap);
              runMm._productsAt = Date.now();
              noteProductsAt(new Date().toISOString());
              console.log('products refresh n=' + Object.keys(productMap).length);
            } catch (e) { console.warn('products refresh', e.message); }
          }
          const ranked = volScan.ranking();
          const now = Date.now();
          let live = null;
          try { live = await getLive(); } catch { live = null; }
          const cash = live ? Number(live.freeQuote || 0) : 0;
          const inv = live ? Math.max(0, Number(live.totalEquity || 0) - cash) : 0;
          const minUsd = Math.max(cfg.minOrderUsd || 1, 1);
          const effPairs = Math.max(1, Math.min(Number(process.env.MM_MAX_PAIRS || 6), Math.floor((cash + inv) / (minUsd * Number(process.env.PAIR_CASH_K || 2.5)))));
          if (effPairs !== planRotation.eff) { planRotation.eff = effPairs; console.log('effPairs=' + effPairs); }
          process.env.MM_MAX_PAIRS_HARD = String(effPairs);
          selection.effPairs = effPairs;
          const holdMin = Number(process.env.ROTATE_MIN_HOLD_MS || 1800000) / 60000;
          const inSet = new Set(mmAlloc.map((a) => a.symbol));
          const rows = mmAlloc.map((a) => {
            const age = Math.round((now - (enteredAt.get(a.pair) || now)) / 60000);
            const exits = exitBook().some((e) => e.symbol === a.symbol);
            const st = pairState.get(a.pair);
            const openBids = ((st && st.ladder && st.ladder.buys) || []).filter((o) => o.status === 'open').length;
            const openAsks = ((st && st.ladder && st.ladder.sells) || []).filter((o) => o.status === 'open').length;
            const q = quoteSnap(a, st && st.ladder, live);
            const label = (!openBids && !openAsks)
              ? ('idle ' + age + 'm: bid=' + (q.bidWhy || 'ok') + ' ask=' + (q.askWhy || 'noInv'))
              : (exits ? 'exit queued' : 'quoting, held ' + age + 'm');
            return { symbol: a.symbol, state: 'in', why: label, quote: q };
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
          const idlePairs = new Set();
          const hardWhy = new Set(['cap', 'rip', 'tape', 'trend', 'peak']);
          function heldTradable(a) {
            const pos = live && live.positions && live.positions[a.symbol];
            const qty = Number(pos && pos.amount || 0) + Number(pos && pos.hold || 0);
            const bidPx = Number((pos && (pos.bestBid || pos.mid)) || 0);
            const quoteMin = Number((pos && pos.quoteMin) || a.quoteMin || 1);
            const baseMin = Number((pos && (pos.baseMin || pos.ordermin)) || a.ordermin || 0);
            return qty + 1e-12 >= baseMin && bidPx > 0 && qty * bidPx + 1e-12 >= quoteMin;
          }
          for (const a of mmAlloc) {
            const st = pairState.get(a.pair);
            const bids = ((st && st.ladder && st.ladder.buys) || []).filter((o) => o.status === 'open');
            if (bids.length || heldTradable(a)) continue;
            const why = typeof strat.hardBidVeto === 'function' ? strat.hardBidVeto(a, live) : '';
            if (!hardWhy.has(why)) continue;
            a._idleWhy = why;
            a._idleMs = Number(process.env.IDLE_RELEASE_MS || 900000);
            a._blockedMin = Math.round((now - (enteredAt.get(a.pair) || now)) / 60000);
            idlePairs.add(a.pair);
          }
          const blocked = typeof strat.blockedLeave === 'function' ? strat.blockedLeave(mmAlloc, live) : null;
          if (blocked && blocked.a) {
            blocked.a._idleWhy = blocked.why;
            blocked.a._idleMs = Number(process.env.SET_BLOCKED_MS || 600000);
            blocked.a._blockedMin = Math.round(blocked.age / 60000);
            idlePairs.add(blocked.a.pair);
          }
          if (Date.now() - (runMm._seedAt || 0) > 30000) {
            runMm._seedAt = Date.now();
            const cut = Date.now() - 15 * 60 * 1000;
            for (const r of ranked.slice(0, 16)) {
              for (const x of midHistory(r.symbol) || []) {
                if (x && x.t >= cut && Number(x.mid) > 0) remember(r.symbol, x.mid, x.t);
              }
            }
          }
          let { keep, leaving, additions } = planRotation({ mmAlloc, ranked, now, enteredAt, watch, live, cfg: { ...cfg, idlePairs, preview: (sym) => (typeof strat.previewGate === 'function' ? strat.previewGate(sym) : true) } });
          for (const a of leaving) {
            if (!idlePairs.has(a.pair)) continue;
            const nxt = additions.map((x) => x.symbol).join(',') || '-';
            console.log('  ROTATE blocked ' + a.symbol + ' ' + (a._idleWhy || '') + ' ' + (a._blockedMin || 0) + 'm -> ' + nxt);
          }
          if (leaving.length || additions.length) {
            if (leaving.length) console.log('MM exit ' + leaving.map((a) => a.symbol).join(',') + ' (>=' + (rotateMin / 60000) + 'm)');
            if (additions.length) console.log('MM enter ' + additions.map((a) => a.symbol + ' ' + Number(a.rangePct).toFixed(2) + '% ret=' + ((a.ret15 || 0) * 100).toFixed(2) + '%').join(', '));
            const leavePairs = new Set(leaving.map((a) => a.pair));
            const leaveSyms = leaving.map((a) => a.symbol);
            for (const a of leaving) {
              watch.set(a.pair, { ...a, leftAt: now });
              try { await ex.cancelPair(a.pair); } catch { /* ignore */ }
              if (ex.listOpen) {
                const still = await ex.listOpen();
                for (const o of still) {
                  if (o.product_id !== a.pair || !o.order_id) continue;
                  console.log('  CANCEL LEFTOVER ' + a.symbol + ' ' + o.order_id);
                  orderRegistry.set(o.order_id, {
                    orderId: o.order_id, pair: a.pair, symbol: a.symbol,
                    side: String(o.side || '').toLowerCase(), status: 'open', orphan: true,
                  });
                }
              }
              const ret15 = midReturn(a.symbol, 15 * 60 * 1000);
              const pos = live && live.positions && live.positions[a.symbol];
              const qty = Number(pos && pos.amount || 0) + Number(pos && pos.hold || 0);
              if (ret15 < Number(process.env.ROTATE_STOP_RET || -0.04) && qty > 0) {
                queueExit(a.symbol, a.pair, qty, Number((pos && (pos.bestBid || pos.mid)) || 0), { lotDecimals: a.lotDecimals, pairDecimals: a.pairDecimals, quoteMin: a.quoteMin || (pos && pos.quoteMin), baseMin: a.baseMin || a.ordermin || (pos && pos.baseMin) });
              }
              invalidateLiveCache();
              for (const rec of orderRegistry.values()) {
                if (rec.pair === a.pair && rec.status === 'open') rec.orphan = true;
              }
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
              mmAlloc.push({
                ...a,
                selectedBy: a.selectedBy || 'scanner',
                ret15: a.ret15,
                rangePct: a.rangePct,
                weight: 1 / next.length,
                invTargetQuote: a.invTargetQuote || invEach,
              });
              if (!enteredAt.has(a.pair)) { enteredAt.set(a.pair, now); clearExit(a.symbol); }
            }
            commitSet('rotate');
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
          await tickExits(ex, orderRegistry, exitLive, getLive);
        } catch (e) { console.warn('exit tick', e.message); }
        await sleep(Number(process.env.VOL_SCAN_MS) || cfg.volScanMs || 60000);
      }
    })();
    setInterval(() => {
      getLive().then((liveNow) => { sweepStranded(liveNow, mmAlloc); return tickExits(ex, orderRegistry, liveNow, getLive); }).catch((e) => console.warn('exit tick', e.message));
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
  function rebuildSelection(now) {
    const enteredAt = runMm._entered || new Map();
    const watch = runMm._watch || new Map();
    const stopLine = Number(process.env.ROTATE_STOP_RET || -0.04) + Number(process.env.STOP_MARGIN || 0.01);
    const inSet = new Set(mmAlloc.map((a) => a.symbol));
    const rows = mmAlloc.map((a) => {
      const age = Math.round((now - (enteredAt.get(a.pair) || now)) / 60000);
      return {
        symbol: a.symbol, state: 'in', role: 'in',
        why: 'quoting, held ' + age + 'm',
        rangePct: a.rangePct, ret15: a.ret15,
        selectedBy: a.selectedBy || 'scanner',
      };
    });
    const cool = Number(process.env.REENTER_COOLDOWN_MS || 1800000);
    for (const r of topVolatiles(8)) {
      if (!r || inSet.has(r.symbol)) continue;
      const ret15 = Number(r.ret || 0);
      let why = 'out: vol ' + Number(r.rangePct || 0).toFixed(2) + '%';
      const left = [...watch.values()].find((w) => w && (w.symbol === r.symbol || w.pair === r.pair));
      if (left && now - (left.leftAt || 0) < cool) why = 'out: watch ' + Math.max(1, Math.round((cool - (now - left.leftAt)) / 60000)) + 'm';
      else if (!(ret15 > stopLine)) why = 'out: ret15 ' + (ret15 * 100).toFixed(1) + '% < stop+margin';
      else if (typeof strat.previewGate === 'function' && !strat.previewGate(r.symbol)) why = 'out: veto';
      rows.push({ symbol: r.symbol, state: 'out', role: 'out', why, rangePct: r.rangePct, ret15 });
    }
    selection.rows = rows;
    selection.version = runMm._setVersion || 0;
    selection.updatedAt = runMm._setAt || 0;
  }
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
      const dustUsd = Number((dustList().untradeableUsd) || 0);
      const reconFloor = Math.max(Number(process.env.RECON_GAP_USD || 0.05), dustUsd);
      if (Math.abs(gap) > reconFloor) {
        if (!emitStatus.alerted) console.log('  RECON ALERT gap=' + gap.toFixed(4));
        emitStatus.alerted = true;
      } else emitStatus.alerted = false;
      const bankUsd = (bankHoldings() || []).reduce((s, h) => s + Number(h.value || 0), 0);
      console.log('  -- markets --');
      try { rebuildSelection(Date.now()); } catch { /* ignore */ }
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
          quote: quoteSnap(a, (pairState.get(a.pair) || {}).ladder, liveSnap),
          sellableQty: sellable(a.symbol),
          role: 'in',
          selectedBy: a.selectedBy || 'scanner',
          rangePct: a.rangePct != null ? a.rangePct : (vs && vs.rangePct),
          ret15: a.ret15 != null ? a.ret15 : null,
          why: ((selection.rows.find((r) => r.symbol === a.symbol && r.state === 'in') || {}).why) || 'in',
        });
      }
      const seenM = new Set(marketRows.map((m) => m.symbol));
      for (const e of exitBook()) {
        if (!e || seenM.has(e.symbol)) continue;
        seenM.add(e.symbol);
        marketRows.push({ symbol: e.symbol, role: 'exit', mid: e.mid || 'n/a', bids: 0, asks: e.orderId ? 1 : 0, bidUsd: 0, askUsd: Number(e.value || 0), w: '0', wNum: 0, orders: [], why: 'exit' });
      }
      for (const d of (dustList().untradeable || [])) {
        if (!d || seenM.has(d.symbol)) continue;
        seenM.add(d.symbol);
        marketRows.push({ symbol: d.symbol, role: 'dust', mid: 'n/a', bids: 0, asks: 0, bidUsd: 0, askUsd: 0, w: '0', wNum: 0, orders: [], why: 'dust', vol: '-', fee: '-', buyUsd: 0, sellUsd: 0 });
      }
      for (const rec of orderRegistry.values()) {
        if (!rec || rec.status !== 'open') continue;
        const sym = String(rec.symbol || String(rec.pair || '').split(/[-/]/)[0] || '').toUpperCase();
        if (!sym || seenM.has(sym)) continue;
        seenM.add(sym);
        const usd = Number(rec.price) * Number(rec.size);
        const buy = String(rec.side).toLowerCase() === 'buy';
        marketRows.push({ symbol: sym, role: 'orphan', mid: 'n/a', bids: buy ? 1 : 0, asks: buy ? 0 : 1, bidUsd: buy ? usd : 0, askUsd: buy ? 0 : usd, w: '0', wNum: 0, orders: [], why: 'orphan', vol: '-', fee: '-', buyUsd: 0, sellUsd: 0 });
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
      const workingBids = marketRows.filter((m) => m.role === 'in').reduce((s, m) => s + (Number(m.bidUsd) || 0), 0);
      const workingAsks = marketRows.filter((m) => m.role === 'in').reduce((s, m) => s + (Number(m.askUsd) || 0), 0);
      let regBids = 0;
      let regAsks = 0;
      for (const rec of orderRegistry.values()) {
        if (!rec || rec.status !== 'open') continue;
        const usd = Number(rec.price) * Number(rec.size);
        if (!(usd > 0)) continue;
        if (String(rec.side).toLowerCase() === 'buy') regBids += usd;
        else regAsks += usd;
      }
      const exitNotional = exitBook().filter((e) => e.orderId).reduce((s, e) => s + Number(e.size || e.qty || 0) * Number(e.price || e.mid || e.sinceMid || 0), 0);
      if (liveSnap && typeof strat.planBook === 'function') strat.planBook(liveSnap, mmAlloc, exitNotional);
      const plan = (typeof strat.bookPlan === 'function' && strat.bookPlan()) || {};
      const bookNotional = regBids + regAsks;
      const bookTargetFrac = Number(process.env.BOOK_TARGET_FRAC || 0.90);
      const invUsd = liveSnap ? Number(liveSnap.positionsValue || 0) : 0;
      const cashUsd = liveSnap ? Number(liveSnap.freeQuote || 0) : 0;
      const quoteHold = liveSnap ? Number(liveSnap.quoteHold || 0) : 0;
      const eqNow = Number((liveSnap && liveSnap.totalEquity) || (cashUsd + quoteHold + invUsd));
      const bookTarget = plan.bookTarget != null ? Number(plan.bookTarget) : eqNow * bookTargetFrac;
      const bookGap = Math.max(0, bookTarget - bookNotional);
      const tradableEq = Number(plan.tradableEq != null ? plan.tradableEq : eqNow);
      const bookPct = tradableEq > 0 ? bookNotional / tradableEq : 0;
      const hist = emitStatus.bookHist = emitStatus.bookHist || [];
      const nowMs = Date.now();
      hist.push({ t: nowMs, pct: bookPct, elig: ((plan.eligible || []).length > 0) });
      while (hist.length && nowMs - hist[0].t > 3600000) hist.shift();
      let wSum = 0;
      let acc = 0;
      for (let i = 1; i < hist.length; i++) {
        const dt = hist[i].t - hist[i - 1].t;
        acc += Number(hist[i - 1].pct) * dt;
        wSum += dt;
      }
      const bookPct1h = wSum > 0 ? acc / wSum : bookPct;
      let baseHold = 0;
      const posMap = (liveSnap && liveSnap.positions) || {};
      for (const [sym, p0] of Object.entries(posMap)) baseHold += Number(p0.hold || 0) * Number(p0.mid || mids[sym] || 0);
      const venueBook = quoteHold + baseHold;
      const clip = Number(process.env.CLIP_MAX_USD || 1.5);
      if (Math.abs(bookNotional - venueBook) > clip) {
        if (!emitStatus._driftAt) emitStatus._driftAt = nowMs;
        else if (nowMs - emitStatus._driftAt > 60000 && nowMs - (emitStatus._driftLog || 0) > 60000) {
          emitStatus._driftLog = nowMs;
          console.log('  BOOK DRIFT tracked=$' + bookNotional.toFixed(2) + ' venue=$' + venueBook.toFixed(2));
        }
      } else emitStatus._driftAt = 0;
      const needPairs = Number(plan.needPairs || 0);
      const bidTarget = Number(plan.bidTarget != null ? plan.bidTarget : plan.bidBudget || 0);
      const allocSum = Number(plan.allocSum || 0);
      let shortReason = '';
      if (bookTarget > 0 && bookNotional < bookTarget * 0.95) {
        if ((plan.eligible || []).length < needPairs) shortReason = 'pairs';
        else if (Number(plan.quoteTotal || 0) * Number(process.env.CASH_DEPLOY_FRAC || 0.97) + 0.05 < Math.max(0, bookTarget - Number(plan.askBook || 0))) shortReason = 'cash';
        else if (bidTarget > 0 && allocSum + 0.05 < bidTarget * 0.95) shortReason = 'cap';
        else if (regBids + clip < allocSum) shortReason = 'clips';
        else shortReason = 'veto';
        if (nowMs - (emitStatus._shortLog || 0) > 60000) {
          emitStatus._shortLog = nowMs;
          console.log('  BOOK SHORT reason=' + shortReason + ' have=$' + bookNotional.toFixed(2) + ' need=$' + bookTarget.toFixed(2));
        }
      }
      const xferN = (snap.transfers || []).length;
      if (emitStatus._xferN != null && xferN > emitStatus._xferN) {
        try { await refreshAlloc(); } catch { /* ignore */ }
      }
      emitStatus._xferN = xferN;
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
        '  book=$' + bookNotional.toFixed(2) + ' / target=$' + bookTarget.toFixed(2) +
        '  pct=' + (bookPct * 100).toFixed(0) + '%  budget=$' + Number(plan.bidBudget || 0).toFixed(2) +
        '  eligible=' + ((plan.eligible || []).join(',') || '-') +
        '  need=' + needPairs + (shortReason ? '  short=' + shortReason : '') +
        '  inventory=$' + invUsd.toFixed(2) + '  cash=$' + cashUsd.toFixed(2) +
        '  onBids=$' + quoteHold.toFixed(2) + '  equity=$' + eqNow.toFixed(2) +
        '  fills=' + fillCount);
      try { logKpi(snap, { cash: cashUsd, inv: invUsd, fills: fillCount }); } catch {}
      try { await refreshFeeTier(cfg); } catch {}
      saveMmSet(mmAlloc, { version: runMm._setVersion || 0, updatedAt: runMm._setAt || 0, pairs: runMm._setPairs || [] });
      const notional = marketRows.reduce((s, m) => s + Number(m.buyUsd || 0) + Number(m.sellUsd || 0), 0);
      emitStatus.gaps = emitStatus.gaps || [];
      emitStatus.gaps.push({ t: Date.now(), gap });
      emitStatus.gaps = emitStatus.gaps.filter((x) => Date.now() - x.t < 3600000);
      const gap1h = emitStatus.gaps.length ? gap - emitStatus.gaps[0].gap : 0;
      const bh = bankHoldings();
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
          equity: eqNow,
          bookNotional, bookTarget, bookGap, bookTargetFrac,
          bookPct, bookPct1h, venueBook, shortReason, needPairs,
          setVersion: runMm._setVersion || 0,
          tradableEq: plan.tradableEq, askBook: plan.askBook, bidBudget: plan.bidBudget, bidTarget,
          eligible: plan.eligible || [], alloc: plan.alloc || {}, allocSum,
          bankEquity: null, fills: fillCount,
          holdUsd: marketRows.reduce((s, m) => s + Number(m.heldUsd || 0), 0),
          holdGain: marketRows.reduce((s, m) => s + Number(m.heldGain || 0), 0),
          holdRealized: holdRealizedUsd(),
          holdFills: holdFills(),
        },
        api: snapshotApi(), feesHist: feeSnapshot(),
        fees: Object.assign(feeReport(), { pending: [...orderRegistry.values()].filter((r) => r.needFee).length }),
        scanner: scannerSnap(),
        edgeBps: bookEdgeBps(),
        recon: { gapUsd: gap, gapPct: Math.abs(gap) / Math.max(1, notional || 1), gap1hUsd: gap1h, alert: Math.abs(gap) > reconFloor, transfers: (snap && snap.transfers) || [], unattributed: snap && snap.unattributed },
        exits: exitBook(),
        dust: dustList(),
        reservations: reservationSnap(),
        strandedTaker: strandedTakerSnap(),
        limitFails: limitFails(),
        selection,
        bankUnreadable: bh == null,
        bankHoldings: (bh || []).map((h) => ({ ...h, value: h.asset === cfg.quote ? h.qty : h.qty * Number(mids[h.asset] || 0) })),
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
  async function refreshAlloc() {
    let live = null;
    try { live = await getLive(); } catch { live = null; }
    const exitN = exitBook().filter((e) => e.orderId).reduce((s, e) => s + Number(e.size || e.qty || 0) * Number(e.price || e.mid || e.sinceMid || 0), 0);
    if (typeof strat.planBook === 'function') strat.planBook(live, mmAlloc, exitN);
  }
  const fresh = sortAllocByWeight(mmAlloc.filter((a) => !pairState.has(a.pair)));
  if (fresh.length) {
    console.log('initial ladders high-w first n=' + fresh.length + ' ' + fresh.map((a) => a.symbol).join(','));
    await refreshAlloc();
    for (const a of fresh) {
      try { await strat.processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive); }
      catch (e) { console.error(a.symbol, e.message); }
    }
  }
  while (true) {
    sortAllocByWeight(mmAlloc);
    setLiveMmAlloc(mmAlloc);
    try { await refreshAlloc(); } catch (e) { console.warn('alloc', e.message); }
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
  startVenueRecon(cfg, orderRegistry, pnl);
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
