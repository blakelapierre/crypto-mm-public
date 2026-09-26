import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envStr, envNum } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { pollOpenOrders } from '../../shared/orders.js';
import { normalizeAsset, safeSpend, safeQuoteSize, calculateVolume } from '../../shared/sizing.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { processPair } from '../ladder/strategy.js';

loadProjectEnv('configs/comp.env');
const cfg = baseConfig();
cfg.exchange = 'kraken';
cfg.quote = envStr('QUOTE', 'USD');
cfg.symbols = envStr('SYMBOLS', 'GNOT,SN64').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
cfg.invFraction = envNum('INV_FRACTION', 0.5);
const orderRegistry = new Map();
const pairState = new Map();
const ex = createExchange(cfg, orderRegistry);

async function resolveKrakenPairs(symbols, quote) {
  const pairs = await krakenPublic('AssetPairs');
  const out = [];
  for (const sym of symbols) {
    let found = null;
    for (const [k, v] of Object.entries(pairs)) {
      const b = normalizeAsset((v.base || '').replace(/^X/, '').replace(/^Z/, ''));
      const q = normalizeAsset((v.quote || '').replace(/^X/, '').replace(/^Z/, ''));
      const alt = String(v.altname || '').toUpperCase();
      if ((b === sym && q === quote) || alt === `${sym}${quote}` || alt === `${sym}/${quote}`) {
        found = { symbol: sym, pair: k, altname: v.altname, pairDecimals: v.pair_decimals ?? 5, lotDecimals: v.lot_decimals ?? 8, ordermin: parseFloat(v.ordermin || '0') || 0 };
        break;
      }
    }
    if (!found) { console.warn(`No Kraken ${sym}/${quote}`); continue; }
    out.push(found);
    console.log(`Resolved ${sym} → ${found.pair}`);
  }
  if (!out.length) throw new Error('No GNOT/SN64 USD pairs');
  return out;
}

async function freeUsd() {
  const bal = await krakenPrivate(cfg, 'Balance');
  let usd = 0;
  for (const [asset, s] of Object.entries(bal || {})) {
    const amt = parseFloat(s);
    if (amt <= 0) continue;
    const n = normalizeAsset(asset);
    if (n === 'USD' || asset === 'ZUSD' || asset === 'USD') usd += amt;
  }
  return usd;
}

async function heldBase(symbol) {
  const bal = await krakenPrivate(cfg, 'Balance');
  let amt = 0;
  for (const [asset, s] of Object.entries(bal || {})) {
    if (normalizeAsset(asset) === symbol) amt += parseFloat(s) || 0;
  }
  return amt;
}

async function seedInventory(markets, usd) {
  const perCoinInv = safeSpend(cfg, usd * cfg.invFraction) / markets.length;
  for (const m of markets) {
    const book = await ex.getBook(m.pair, 'kraken');
    if (!book) continue;
    const held = await heldBase(m.symbol);
    const gap = perCoinInv - held * book.mid;
    if (gap < cfg.minOrderUsd) continue;
    const vol = calculateVolume(cfg, book.mid, safeQuoteSize(cfg, gap), m.ordermin, m.lotDecimals);
    await ex.marketBuy(m.pair, vol, gap, 'kraken');
    await sleep(cfg.rateLimitMs);
  }
}

async function main() {
  console.log(`BOT=comp symbols=${cfg.symbols.join(',')} quote=${cfg.quote}`);
  if (String(cfg.quote).toUpperCase() !== 'USD') throw new Error(`quote ${cfg.quote} expected USD`);
  if (!cfg.krakenApiKey || !cfg.krakenApiSecret) throw new Error('Set KRAKEN keys');
  const markets = await resolveKrakenPairs(cfg.symbols, cfg.quote);
  if (cfg.cancelAllOrdersOnStartup) await ex.cancelAll('kraken');
  const usd = await freeUsd();
  await seedInventory(markets, Math.max(usd, cfg.totalCapitalOverride || 0) || usd || 100);
  await sleep(cfg.settleWaitMs);
  const sizeUsd = Math.max(cfg.minOrderUsd, ((Math.max(usd, 1) * (1 - cfg.invFraction)) / (markets.length * cfg.mmLevels)) * cfg.orderSizeHaircut);
  (async () => {
    while (true) {
      try { await pollOpenOrders(ex, orderRegistry, cfg); } catch (e) { console.warn(e.message); }
      await sleep(cfg.orderPollMs);
    }
  })();
  process.on('SIGINT', () => process.exit(0));
  while (true) {
    for (const m of markets) {
      try { await processPair(cfg, ex, orderRegistry, pairState, m, sizeUsd); }
      catch (e) { console.error(m.symbol, e.message); }
      await sleep(cfg.rateLimitMs);
    }
    await sleep(cfg.updateIntervalMs);
  }
}
main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
