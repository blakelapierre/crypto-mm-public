import { setTimeout as sleep } from 'timers/promises';
import { STABLECOINS } from './env.js';
import { normalizeAsset, safeSpend, safeQuoteSize, calculateVolume, formatVolume } from './sizing.js';
import { coinbaseRequest } from './coinbase.js';
import { krakenPrivate } from './kraken.js';
import { getMarketCapRanking } from './coingecko.js';
import { loadMmSet } from './mm-set.js';

async function staggerMap(items, fn, gapMs) {
  await Promise.all(items.map((item, i) => sleep(i * Math.max(0, gapMs)).then(() => fn(item))));
}

const liveCache = new Map();
export async function fetchLivePortfolio(cfg, ex, productMap, venue = cfg.exchange) {
  const ttl = Number(process.env.ACCOUNT_CACHE_MS || 8000);
  const key = String(venue || cfg.exchange);
  const hit = liveCache.get(key);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.live;
  const quote = cfg.quote.toUpperCase();
  const positions = {};
  let freeQuote = 0;
  let quoteHold = 0;
  if (venue === 'coinbase') {
    let cursor = null;
    const accounts = [];
    do {
      let p = '/api/v3/brokerage/accounts?limit=250';
      if (cursor) p += '&cursor=' + encodeURIComponent(cursor);
      const data = await coinbaseRequest(cfg, 'GET', p);
      accounts.push(...(data.accounts || []));
      cursor = data.has_next ? data.cursor : null;
    } while (cursor);
    for (const a of accounts) {
      const cur = (a.currency || '').toUpperCase();
      const avail = parseFloat((a.available_balance && a.available_balance.value) || 0);
      const hold = parseFloat((a.hold && a.hold.value) || 0);
      const amt = avail + hold;
      if (!cur || amt <= 0) continue;
      if (cur === quote) { freeQuote += avail; quoteHold += hold; continue; }
      if (STABLECOINS.has(cur) && cur !== quote) continue;
      const sym = normalizeAsset(cur);
      if (!positions[sym]) positions[sym] = { amount: 0, valueQuote: 0, mid: 0 };
      positions[sym].amount += amt;
    }
  } else if (venue === 'kraken') {
    const bal = await krakenPrivate(cfg, 'Balance');
    for (const [asset, s] of Object.entries(bal || {})) {
      const avail = parseFloat(s);
      if (avail <= 0) continue;
      const sym = normalizeAsset(asset);
      if (sym === quote || asset === 'Z' + quote) { freeQuote += avail; continue; }
      if (STABLECOINS.has(sym)) continue;
      if (!positions[sym]) positions[sym] = { amount: 0, valueQuote: 0, mid: 0 };
      positions[sym].amount += avail;
    }
  } else {
    return { freeQuote: cfg.totalCapitalOverride || 100, quoteHold: 0, positions: {}, positionsValue: 0, totalEquity: cfg.totalCapitalOverride || 100 };
  }
  let positionsValue = 0;
  const pairList = [];
  const want = [];
  for (const [sym, pos] of Object.entries(positions)) {
    const info = productMap[sym];
    if (!info) { console.warn('  position ' + sym + ' amt=' + pos.amount + ' has no ' + cfg.quote + ' product'); continue; }
    pairList.push(info.pair);
    want.push([sym, pos, info]);
  }
  const books = ex.getBooks ? await ex.getBooks(pairList, venue) : new Map();
  for (const [sym, pos, info] of want) {
    const book = books.get(info.pair) || null;
    if (!book) continue;
    pos.mid = book.mid;
    pos.valueQuote = pos.amount * book.mid;
    Object.assign(pos, info);
    if (pos.valueQuote < cfg.dustUsd) { delete positions[sym]; continue; }
    positionsValue += pos.valueQuote;
  }
  let totalEquity = freeQuote + quoteHold + positionsValue;
  if (venue === 'kraken' && process.env.KRAKEN_TRADE_BALANCE === '1') {
    try {
      const tb = await krakenPrivate(cfg, 'TradeBalance');
      const eb = parseFloat((tb && (tb.eb || tb.e)) || 0);
      if (eb > 0) totalEquity = eb;
    } catch { /* keep */ }
  }
  const liveOut = { freeQuote, quoteHold, positions, positionsValue, totalEquity };
  liveCache.set(key, { at: Date.now(), live: liveOut });
  return liveOut;
}

export async function waitForSettlement(cfg, ex, productMap, label, venue) {
  console.log('\nSettle: ' + label);
  await sleep(cfg.settleWaitMs);
  const polls = (venue === 'kraken' || cfg.exchange === 'kraken') ? Math.min(cfg.settlePolls || 3, 2) : (cfg.settlePolls || 3);
  let live = null;
  for (let i = 0; i < polls; i++) {
    live = await fetchLivePortfolio(cfg, ex, productMap, venue);
    console.log('  ' + (i + 1) + '/' + polls + ' free=' + live.freeQuote.toFixed(2) + ' pos=' + (live.positionsValue || 0).toFixed(2) + ' eq=' + live.totalEquity.toFixed(2));
    if (i < polls - 1) await sleep(cfg.settlePollIntervalMs);
  }
  return live;
}

export async function buildLists(cfg, productMap, totalEquity) {
  const forced = (cfg.symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean);
  const tradable = [];
  function resolveInfo(sym) {
    if (productMap[sym]) return productMap[sym];
    const hit = Object.entries(productMap).find(([k, v]) => {
      const pair = String(v.pair || '').toUpperCase();
      return k.toUpperCase() === sym || pair.startsWith(sym) || pair.includes(sym + 'USD');
    });
    return hit ? hit[1] : null;
  }
  if (forced.length) {
    console.log('SYMBOLS forced: ' + forced.join(',') + '  products=' + Object.keys(productMap).length);
    for (const sym of forced) {
      const info = resolveInfo(sym);
      if (!info) { console.warn('No ' + cfg.quote + ' product for ' + sym); continue; }
      tradable.push({ symbol: sym, market_cap: 1, ...info });
      console.log('  ' + sym + ' -> ' + info.pair + ' venue=' + info.venue);
    }
  } else {
    const ranking = await getMarketCapRanking(Math.max(cfg.portfolioCoins, cfg.mmMaxPairs) * 3);
    for (const row of ranking) {
      if (STABLECOINS.has(row.symbol)) continue;
      const info = productMap[row.symbol];
      if (!info) continue;
      tradable.push({ symbol: row.symbol, market_cap: row.market_cap, ...info });
    }
  }
  if (!tradable.length) throw new Error(forced.length ? 'No products for ' + forced.join(',') : 'No pairs');
  const saved = forced.length ? [] : loadMmSet();
  let mmList;
  if (forced.length) mmList = tradable;
  else if (saved.length) {
    mmList = [];
    for (const sym of saved) {
      const info = resolveInfo(sym);
      if (info) mmList.push({ symbol: sym, market_cap: 1, ...info });
    }
    console.log('MM start from saved set: ' + mmList.map((a) => a.symbol).join(','));
  } else mmList = tradable.slice(0, cfg.mmMaxPairs);
  const skipPort = forced.length > 0 || saved.length > 0;
  const portfolio = skipPort ? [] : tradable.slice(0, cfg.portfolioCoins);
  const mcap = portfolio.reduce((s, c) => s + c.market_cap, 0) || 1;
  const portfolioTarget = skipPort ? 0 : safeSpend(cfg, totalEquity * cfg.portfolioFraction);
  const portfolioAlloc = portfolio.map((c) => ({ ...c, weight: c.market_cap / mcap, targetQuote: portfolioTarget * (c.market_cap / mcap) }));
  if (skipPort) console.log('startup inventory only on MM set (no mcap sleeve)');
  const mmCapital = safeSpend(cfg, totalEquity * (skipPort ? 1 : 1 - cfg.portfolioFraction));
  const mmInvTotal = cfg.mmEnabled ? mmCapital * cfg.mmInventoryFraction * cfg.inventorySafetyMultiplier : 0;
  const mmInvEach = mmList.length ? mmInvTotal / mmList.length : 0;
  const mmAlloc = mmList.map((c) => ({ ...c, weight: 1 / mmList.length, invTargetQuote: mmInvEach }));
  const combined = new Map();
  for (const a of portfolioAlloc) {
    combined.set(a.symbol, { ...a, portTarget: a.targetQuote, invTarget: 0, combinedTarget: a.targetQuote, inPortfolio: true, inMm: false });
  }
  for (const a of mmAlloc) {
    const prev = combined.get(a.symbol);
    if (prev) { prev.invTarget = a.invTargetQuote; prev.combinedTarget = prev.portTarget + a.invTargetQuote; prev.inMm = true; }
    else combined.set(a.symbol, { ...a, portTarget: 0, invTarget: a.invTargetQuote, combinedTarget: a.invTargetQuote, inPortfolio: false, inMm: true });
  }
  return { portfolioAlloc, mmAlloc, mmCapital, portfolioTarget, combinedTargets: [...combined.values()] };
}

export function getMmOrderSizeUsd(cfg, mmCapital) {
  const n = Math.max(1, (cfg.mmLevels || 1) * (cfg.mmMaxPairs || 1));
  const side = mmCapital * Math.min(cfg.mmInventoryFraction, 1 - cfg.mmInventoryFraction);
  const per = (side / n) * cfg.orderSizeHaircut;
  return Math.max(per, cfg.minOrderUsd);
}

export async function rebalanceCombined(cfg, ex, combinedTargets, live) {
  console.log('\nCombined rebalance');
  const wanted = new Set(combinedTargets.map((a) => a.symbol));
  const gap = Number(process.env.SELL_STAGGER_MS || cfg.rateLimitMs || 200);
  console.log('wallet:');
  for (const [sym, pos] of Object.entries(live.positions || {})) {
    console.log('  ' + sym + ' amt=' + pos.amount + ' val=' + (pos.valueQuote || 0).toFixed(2) + ' ' + (wanted.has(sym) ? 'MM' : 'ORPHAN'));
  }
  console.log('  cash ' + cfg.quote + '=' + (live.freeQuote || 0).toFixed(2) + ' eq=' + (live.totalEquity || 0).toFixed(2));
  const excessSells = [];
  for (const a of combinedTargets) {
    const heldVal = (live.positions[a.symbol] && live.positions[a.symbol].valueQuote) || 0;
    const heldAmt = (live.positions[a.symbol] && live.positions[a.symbol].amount) || 0;
    const target = a.combinedTarget;
    const excess = heldVal - target;
    const tol = Math.max(target * cfg.rebalanceTolerancePct, cfg.minOrderUsd);
    console.log(a.symbol + ': held ' + heldVal.toFixed(2) + ' target ' + target.toFixed(2));
    if (excess <= tol || heldAmt <= 0) continue;
    const sellAmt = formatVolume(heldAmt * (excess / heldVal), a.lotDecimals);
    if (sellAmt < (a.ordermin || 0) * cfg.volumeSafetyMargin) continue;
    excessSells.push({ a, sellAmt });
  }
  await staggerMap(excessSells, async ({ a, sellAmt }) => {
    console.log('  MARKET SELL ' + sellAmt + ' ' + a.symbol + ' (excess)');
    try { await ex.marketSell(a.pair, sellAmt); } catch (e) { console.warn('  sell ' + a.symbol + ' skip: ' + e.message); }
  }, gap);
  const orphans = [];
  for (const [sym, pos] of Object.entries(live.positions || {})) {
    if (wanted.has(sym)) continue;
    const heldVal = pos.valueQuote || 0;
    const heldAmt = pos.amount || 0;
    console.log(sym + ': held ' + heldVal.toFixed(2) + ' target 0 (not in MM set)');
    if (heldVal < cfg.minOrderUsd || heldAmt <= 0) continue;
    if (!pos.pair) { console.warn('  ' + sym + ' no ' + cfg.quote + ' pair'); continue; }
    const sellAmt = formatVolume(heldAmt, pos.lotDecimals);
    if (sellAmt < (pos.ordermin || 0) * cfg.volumeSafetyMargin) continue;
    orphans.push({ sym, pos, sellAmt });
  }
  await staggerMap(orphans, async ({ sym, pos, sellAmt }) => {
    console.log('  MARKET SELL ' + sellAmt + ' ' + sym + ' (orphan)');
    try { await ex.marketSell(pos.pair, sellAmt); } catch (e) { console.warn('  sell ' + sym + ' skip: ' + e.message); }
  }, gap);
  let budget = safeSpend(cfg, live.freeQuote);
  for (const a of combinedTargets) {
    const heldVal = (live.positions[a.symbol] && live.positions[a.symbol].valueQuote) || 0;
    const target = a.combinedTarget;
    const gapBuy = target - heldVal;
    const tol = Math.max(target * cfg.rebalanceTolerancePct, cfg.minOrderUsd);
    if (gapBuy <= tol || budget < cfg.minOrderUsd) continue;
    const spendPlan = Math.min(gapBuy, budget * 0.98);
    const book = await ex.getBook(a.pair);
    if (!book) continue;
    const vol = calculateVolume(cfg, book.mid, safeQuoteSize(cfg, spendPlan), a.ordermin, a.lotDecimals);
    try {
      if (await ex.marketBuy(a.pair, vol, spendPlan)) budget -= spendPlan;
    } catch (e) { console.warn('  buy ' + a.symbol + ' skip: ' + e.message); }
    await sleep(cfg.rateLimitMs);
  }
}

export async function rebalanceBuysAfterSettle(cfg, ex, combinedTargets, live) {
  let budget = safeSpend(cfg, live.freeQuote);
  for (const a of combinedTargets) {
    const heldVal = (live.positions[a.symbol] && live.positions[a.symbol].valueQuote) || 0;
    const target = a.combinedTarget;
    const gap = target - heldVal;
    const tol = Math.max(target * cfg.rebalanceTolerancePct, cfg.minOrderUsd);
    if (gap <= tol || budget < cfg.minOrderUsd) continue;
    const spendPlan = Math.min(gap, budget * 0.98);
    const book = await ex.getBook(a.pair);
    if (!book) continue;
    const vol = calculateVolume(cfg, book.mid, safeQuoteSize(cfg, spendPlan), a.ordermin, a.lotDecimals);
    try {
      if (await ex.marketBuy(a.pair, vol, spendPlan)) budget -= spendPlan;
    } catch (e) { console.warn('  buy ' + a.symbol + ' skip: ' + e.message); }
    await sleep(cfg.rateLimitMs);
  }
}
