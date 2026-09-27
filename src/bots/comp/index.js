import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envStr, envNum } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { pollOpenOrders } from '../../shared/orders.js';
import { createPnl } from '../../shared/pnl.js';
import { fetchLivePortfolio, waitForSettlement } from '../../shared/portfolio.js';
import { formatVolume } from '../../shared/sizing.js';
import { processPair } from '../ladder/strategy.js';

loadProjectEnv('configs/comp.env');
const cfg = baseConfig();
cfg.exchange = 'kraken';
cfg.quote = envStr('QUOTE', 'USD');
cfg.symbols = envStr('SYMBOLS', 'GNOT,SN64').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
cfg.invFraction = envNum('INV_FRACTION', cfg.mmInventoryFraction || 0.5);
cfg.perSymbolFraction = envNum('PER_SYMBOL_FRACTION', 0.5);
cfg.perSymbolMargin = envNum('PER_SYMBOL_MARGIN', 0.01);

const orderRegistry = new Map();
const pairState = new Map();
const pnl = createPnl();
const ex = createExchange(cfg, orderRegistry);
const capOf = (eq) => eq * cfg.perSymbolFraction * (1 - cfg.perSymbolMargin);

function pickMarkets(productMap) {
  const out = [];
  for (const sym of cfg.symbols) {
    const info = productMap[sym];
    if (!info || info.venue !== 'kraken') { console.warn(`No Kraken ${sym}/${cfg.quote}`); continue; }
    out.push({ symbol: sym, ...info });
    console.log(`Resolved ${sym} -> ${info.pair}`);
  }
  if (!out.length) throw new Error(`No Kraken pairs for ${cfg.symbols.join(',')}`);
  return out;
}

async function seedInventory(markets, productMap) {
  console.log('\nSeed inventory');
  for (const m of markets) {
    const live = await fetchLivePortfolio(cfg, ex, productMap, 'kraken');
    const invTarget = capOf(live.totalEquity) * cfg.invFraction;
    const heldVal = live.positions[m.symbol]?.valueQuote || 0;
    const heldAmt = live.positions[m.symbol]?.amount || 0;
    const book = await ex.getBook(m.pair);
    if (!book) continue;
    console.log(`${m.symbol}: held $${heldVal.toFixed(2)} targetInv $${invTarget.toFixed(2)} cash $${live.freeQuote.toFixed(4)}`);
    if (heldVal > invTarget + cfg.minOrderUsd && heldAmt > 0) {
      const sellAmt = formatVolume(heldAmt * ((heldVal - invTarget) / heldVal), m.lotDecimals);
      if (sellAmt >= (m.ordermin || 0) * cfg.volumeSafetyMargin) {
        await ex.marketSell(m.pair, sellAmt);
        await sleep(cfg.settleWaitMs);
      }
      continue;
    }
    const gap = invTarget - heldVal;
    if (gap < cfg.minOrderUsd) continue;
    const spend = Math.min(gap, (live.freeQuote * cfg.capitalSafetyMargin) / markets.length);
    if (spend < cfg.minOrderUsd) continue;
    let vol = spend / book.ask;
    const minV = (m.ordermin || 0) * cfg.volumeSafetyMargin;
    if (vol < minV) vol = minV;
    vol = formatVolume(vol, m.lotDecimals);
    await ex.marketBuy(m.pair, vol, spend);
    await sleep(cfg.settleWaitMs);
  }
  return waitForSettlement(cfg, ex, productMap, 'after seed', 'kraken');
}

async function main() {
  console.log(`BOT=comp ${cfg.symbols.join('+')} quote=${cfg.quote} dryRun=${cfg.dryRun}`);
  if (String(cfg.quote).toUpperCase() !== 'USD') throw new Error(`quote must be USD`);
  if (!cfg.krakenApiKey || !cfg.krakenApiSecret) throw new Error('Set KRAKEN keys');
  const productMap = await ex.getProducts('kraken');
  const markets = pickMarkets(productMap);
  if (cfg.cancelAllOrdersOnStartup) await ex.cancelAll('kraken');
  let live = await fetchLivePortfolio(cfg, ex, productMap, 'kraken');
  live = await seedInventory(markets, productMap);
  pnl.markWallet(live.totalEquity);
  const sizeUsd = Math.max(cfg.minOrderUsd, ((capOf(live.totalEquity) * (1 - cfg.invFraction)) / cfg.mmLevels) * cfg.orderSizeHaircut);
  const getLive = () => fetchLivePortfolio(cfg, ex, productMap, 'kraken');
  (async () => {
    while (true) {
      try { await pollOpenOrders(ex, orderRegistry, cfg, pnl); } catch (e) { console.warn('poll', e.message); }
      await sleep(cfg.orderPollMs);
    }
  })();
  process.on('SIGINT', () => { pnl.print({}, 'MM gain on stop'); process.exit(0); });
  while (true) {
    for (const m of markets) {
      try { await processPair(cfg, ex, orderRegistry, pairState, m, sizeUsd, getLive); }
      catch (e) { console.error(m.symbol, e.message); }
      await sleep(cfg.rateLimitMs);
    }
    if (!main._lastPnl || Date.now() - main._lastPnl > 30000) {
      try { pnl.markWallet((await getLive()).totalEquity); } catch { /* ignore */ }
      const mids = {};
      for (const st of pairState.values()) if (st.symbol && st.lastMid) mids[st.symbol] = st.lastMid;
      pnl.print(mids);
      main._lastPnl = Date.now();
    }
    await sleep(cfg.updateIntervalMs);
  }
}
main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
