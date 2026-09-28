import path from 'path';
import { fileURLToPath } from 'url';
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
import { createVolScan, setSizeUniverse, sizeWeightForSymbol, volStatsForSymbol } from '../../shared/vol-scan.js';
import { saveMmSet } from '../../shared/mm-set.js';
import { realizedFeeBps } from '../../shared/fee-spread.js';
import { skimToBank, liquidateSymbols, seedNewInventory } from '../../shared/bank.js';
import { postStatus } from '../../shared/status-client.js';

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
    ws = startCoinbaseUserWs(cfg, (id, st) => markOrderFromExchange(orderRegistry, id, st, pnl));
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
    console.log('vol scan every ' + ((cfg.volScanMs || 60000) / 1000) + 's window=' + (cfg.volWindowMin || 15) + 'm');
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
      await sleep(Math.max(cfg.volScanMs || 60000, 90000));
      while (true) {
        try {
          const next = volScan.ranking().slice(0, cfg.mmMaxPairs);
          if (next.length) {
            const nextPairs = new Set(next.map((a) => a.pair));
            const prev = new Set(mmAlloc.map((a) => a.pair));
            const changed = [...nextPairs].some((p) => !prev.has(p)) || [...prev].some((p) => !nextPairs.has(p));
            if (changed) {
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
                  const liveRot = await getLive();
                  console.log('bank skim 1% leaving ' + leaving.join(','));
                  await skimToBank(cfg, liveRot, Number(process.env.BANK_ROTATE_PCT || 0.01), leaving);
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
  while (true) {
    for (const a of mmAlloc) {
      try { await processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive); }
      catch (e) { console.error(a.symbol, e.message); }
      await sleep(150);
    }
    if (!runMm._lastPnl || Date.now() - runMm._lastPnl > 30000) {
      try { pnl.markHoldings(await getLive()); } catch { /* ignore */ }
      const mids = {};
      for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
      const snap = pnl.print(mids);
      console.log('  -- markets --');
      const marketRows = [];
      for (const a of mmAlloc) {
        const st = pairState.get(a.pair);
        const legs = st && st.ladder ? [...st.ladder.buys, ...st.ladder.sells] : [];
        const bids = legs.filter((o) => o.side === 'buy' && o.status === 'open').length;
        const asks = legs.filter((o) => o.side === 'sell' && o.status === 'open').length;
        const mid = st && st.lastMid;
        const vs = volStatsForSymbol(a.symbol);
        const fee = realizedFeeBps(a.pair);
        const w = sizeWeightForSymbol(a.symbol);
        marketRows.push({
          symbol: a.symbol,
          mid: mid ? Number(mid).toFixed(6) : 'n/a',
          bids, asks,
          vol: vs ? vs.rangePct.toFixed(2) + '%' : 'n/a',
          fee: fee != null ? fee.toFixed(1) + 'bps' : 'n/a',
          w: w.toFixed(2) + 'x',
        });
        console.log(
          '  ' + String(a.symbol).padEnd(8) +
            ' mid=' + (mid ? Number(mid).toFixed(6) : 'n/a') +
            '  bid/ask ' + bids + '/' + asks +
            '  w=' + w.toFixed(2) + 'x' +
            '  vol=' + (vs ? vs.rangePct.toFixed(2) + '%' : 'n/a') +
            '  fee=' + (fee != null ? fee.toFixed(1) + 'bps' : 'n/a')
        );
      }
      saveMmSet(mmAlloc);
      postStatus({ bot: process.env.BOT || 'ladder', exchange: cfg.exchange, quote: cfg.quote, pnl: snap, markets: marketRows });
      runMm._lastPnl = Date.now();
    }
    await sleep(cfg.updateIntervalMs);
  }
}

async function main() {
  console.log('BOT=' + (process.env.BOT || 'ladder') + ' exchange=' + cfg.exchange + ' dryRun=' + cfg.dryRun + ' quote=' + cfg.quote + ' symbols=' + (cfg.symbols || []).join(','));
  if (cfg.exchange === 'kraken' && (!cfg.krakenApiKey || !cfg.krakenApiSecret)) throw new Error('Missing Kraken keys');
  if (cfg.exchange === 'coinbase') console.log('JWT', ex.loadKeyInfo());
  const productMap = await ex.getProducts();
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
