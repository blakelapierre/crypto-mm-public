import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envNum, envBool } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { fetchLivePortfolio } from '../../shared/portfolio.js';
import { formatPrice, formatVolume } from '../../shared/sizing.js';
import { postStatus, pullVenueScan } from '../../shared/status-client.js';
import { asQuote, realizedSigma } from './quote.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/as-kraken.env');
process.env.BOT = process.env.BOT || 'as';
const cfg = baseConfig();
const ex = createExchange(cfg, new Map());
const VENUE = cfg.exchange === 'coinbase' ? 'coinbase' : 'kraken';
const USERREF = String(envNum('AS_USERREF', 20261011));
const CLIP = envNum('CLIP_MAX_USD', 1.5);
const MAX_PAIRS = Math.max(1, envNum('MM_MAX_PAIRS', 2));
const GAMMA = envNum('AS_GAMMA', 40);
const KAPPA = envNum('AS_KAPPA', 1.5);
const TAU = envNum('AS_TAU_MIN', 15);
const MIN_HALF = envNum('MIN_HALF_BPS', 60) / 10000;
const MAX_HALF = envNum('MAX_HALF_BPS', 200) / 10000;
const MAX_SHIFT = envNum('AS_MAX_SHIFT_BPS', 150) / 10000;
const MIN_RANGE = envNum('VOL_ENTER_PCT', 0.4) / 100;
const LEV = envNum('AS_LEVERAGE', 2);
const LOOP = envNum('AS_LOOP_MS', 20000);
const LIVE = envBool('AS_LIVE', false) && !cfg.dryRun;
const statePath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.json');
const US = new Set(['BTC', 'ETH', 'ADA', 'AVAX', 'DOGE', 'LINK', 'LTC', 'SOL', 'SUI', 'XRP', 'AAVE', 'ALGO', 'BCH', 'CRV', 'DOT', 'HBAR', 'NEAR', 'PEPE', 'RENDER', 'SHIB', 'UNI', 'XLM', 'PENGU']);

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { symbols: [], orders: {} }; }
}
function saveState(st) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(st));
}
async function krakenOnce(name, params) {
  for (let i = 0; i < 5; i++) {
    try { return await krakenPrivate(cfg, name, params); }
    catch (e) {
      if (!/nonce|rate/i.test(e.message) || i === 4) throw e;
      await sleep(400 + i * 300);
    }
  }
}
function snap(px, inc, side) {
  const tick = Number(inc) > 0 ? Number(inc) : 0.01;
  const n = side === 'buy' ? Math.floor(px / tick + 1e-8) * tick : Math.ceil(px / tick - 1e-8) * tick;
  return n;
}
function symbolOf(pair) {
  return String(pair || '').replace(/USD:BTNL$/i, '').replace(/USD$/i, '').replace(/^XBT/, 'BTC').toUpperCase();
}
function orderPair(rec, symbol) {
  if (VENUE === 'coinbase') return rec.pair;
  return (rec.altname || symbol + 'USD') + ':BTNL';
}

async function krakenBook(state) {
  const tb = await krakenOnce('TradeBalance', { asset: 'ZUSD' });
  const pos = await krakenOnce('OpenPositions', { docalcs: true });
  const open = await krakenOnce('OpenOrders', {});
  const positions = {};
  for (const p of Object.values(pos || {})) {
    const sym = symbolOf(p.pair);
    const vol = Number(p.vol || 0) - Number(p.vol_closed || 0);
    if (!(vol > 0)) continue;
    const row = positions[sym] || { long: 0, short: 0 };
    if (String(p.type).toLowerCase() === 'sell') row.short += vol;
    else row.long += vol;
    positions[sym] = row;
  }
  const foreign = new Set();
  const mine = {};
  const known = new Set(state.symbols || []);
  for (const [id, o] of Object.entries((open && open.open) || {})) {
    const sym = symbolOf((o.descr || {}).pair);
    const ours = String(o.userref || '') === USERREF;
    const rec = { id, sym, side: String((o.descr || {}).type || '').toLowerCase(), price: Number((o.descr || {}).price || 0), ours };
    if (!ours) foreign.add(sym);
    else (mine[sym] = mine[sym] || []).push(rec);
  }
  for (const sym of Object.keys(positions)) if (!known.has(sym)) foreign.add(sym);
  return { equity: Number(tb.eb || tb.e || 0), cash: Number(tb.mf || 0), positions, foreign, mine };
}

async function coinbaseBook(state, products) {
  const live = await fetchLivePortfolio(cfg, ex, products, 'coinbase');
  const orders = await ex.listOpen('coinbase');
  const known = new Set();
  for (const o of Object.values(state.orders || {})) {
    if (o.bid) known.add(o.bid);
    if (o.ask) known.add(o.ask);
  }
  const foreign = new Set();
  const mine = {};
  for (const o of orders || []) {
    const sym = String(o.product_id || '').split('-')[0].toUpperCase();
    const ours = known.has(o.order_id);
    const limit = ((o.order_configuration || {}).limit_limit_gtc) || {};
    const rec = { id: o.order_id, sym, side: String(o.side || '').toLowerCase(), price: Number(limit.limit_price || 0), ours };
    if (!ours) foreign.add(sym);
    else (mine[sym] = mine[sym] || []).push(rec);
  }
  const positions = {};
  const owned = new Set(state.symbols || []);
  for (const [sym, p] of Object.entries(live.positions || {})) {
    const qty = Number(p.amount || 0);
    if (!(qty > 0)) continue;
    positions[sym] = { long: qty, short: 0 };
    const usd = Number(p.valueQuote || 0);
    if (!owned.has(sym) && usd < 0.9) foreign.add(sym);
  }
  return { equity: Number(live.totalEquity || 0), cash: Number(live.freeQuote || 0), positions, foreign, mine };
}

async function stats(row) {
  if (VENUE === 'kraken') {
    const data = await krakenPublic('OHLC', { pair: row.pair, interval: 1 });
    const key = Object.keys(data || {}).find((k) => k !== 'last');
    const rows = (key ? data[key] : []).slice(-31);
    const closes = rows.map((c) => Number(c[4])).filter((n) => n > 0);
    if (closes.length < 5) return null;
    const mid = closes[closes.length - 1];
    const win = rows.slice(-15);
    const hi = Math.max(...win.map((c) => Number(c[2])));
    const lo = Math.min(...win.map((c) => Number(c[3])));
    return { mid, sigma: realizedSigma(closes), range: mid > 0 ? (hi - lo) / mid : 0 };
  }
  const book = await ex.getBook(row.pair, 'coinbase');
  if (!book || !(book.mid > 0)) return null;
  return { mid: book.mid, sigma: 0.0015, range: Math.max(MIN_RANGE, 0) };
}

async function select(products, book, state) {
  const held = [];
  const push = (rec, symbol) => {
    if (!rec || held.some((r) => r.symbol === symbol)) return;
    held.push({ ...rec, symbol, orderPair: orderPair(rec, symbol) });
  };
  for (const [sym, pos] of Object.entries(book.positions || {})) {
    if (book.foreign.has(sym)) continue;
    if (!(pos.long > 0 || pos.short > 0)) continue;
    push(products[sym], sym);
  }
  for (const sym of state.symbols || []) {
    const pos = book.positions[sym];
    const mine = (book.mine[sym] || []).length > 0;
    if (book.foreign.has(sym) && !pos && !mine) continue;
    push(products[sym], sym);
  }
  if (held.length >= MAX_PAIRS) return held;
  const candidates = [];
  for (const [symbol, rec] of Object.entries(products)) {
    if (held.some((r) => r.symbol === symbol)) continue;
    if (VENUE === 'kraken' && !US.has(symbol)) continue;
    if (book.foreign.has(symbol)) continue;
    candidates.push({ ...rec, symbol, orderPair: orderPair(rec, symbol) });
  }
  candidates.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (VENUE === 'coinbase') {
    const scan = await pullVenueScan('coinbase');
    const rank = new Map(((scan && scan.ranked) || []).map((r, i) => [String(r.symbol || '').toUpperCase(), i]));
    candidates.sort((a, b) => (rank.has(a.symbol) ? rank.get(a.symbol) : 999) - (rank.has(b.symbol) ? rank.get(b.symbol) : 999));
  }
  const room = VENUE === 'kraken'
    ? Math.min(envNum('AS_MAX_NOTIONAL', 10), Math.max(CLIP, Number(book.cash || 0) * Math.max(LEV, 1) * 0.4))
    : Math.max(CLIP, Number(book.cash || 0));
  const ranked = [];
  let best = null;
  for (const row of candidates.slice(0, VENUE === 'kraken' ? candidates.length : 10)) {
    try {
      const s = await stats(row);
      const minNotional = (Number(row.ordermin) || 0) * (s && s.mid || 0);
      if (s && (!best || s.range > best.range)) best = { symbol: row.symbol, range: s.range, minNotional };
      if (s && s.range + 1e-12 >= MIN_RANGE && minNotional <= room) ranked.push({ ...row, range: s.range });
    } catch { /* quiet */ }
    await sleep(120);
  }
  if (!ranked.length && best) console.log('  no name  best ' + best.symbol + ' range ' + (best.range * 100).toFixed(2) + '% min $' + best.minNotional.toFixed(2));
  ranked.sort((a, b) => b.range - a.range);
  return held.concat(ranked).slice(0, Math.max(MAX_PAIRS, held.length));
}

async function syncSide(row, side, target, mine, state, q, posQty) {
  const cur = (mine || []).find((o) => o.side === side);
  const slot = state.orders[row.symbol] || {};
  const prev = side === 'buy' ? Number(slot.bidPx || 0) : Number(slot.askPx || 0);
  if (!(target > 0)) {
    if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
    if (side === 'buy') { slot.bid = null; slot.bidPx = 0; slot.bidSz = 0; }
    else { slot.ask = null; slot.askPx = 0; slot.askSz = 0; }
    state.orders[row.symbol] = slot;
    return;
  }
  if (cur && prev > 0 && Math.abs(prev - target) / target < 0.0015) return;
  const minNotional = (Number(row.ordermin) || 0) * target;
  const room = VENUE === 'kraken' ? envNum('AS_MAX_NOTIONAL', 10) : Math.max(CLIP, minNotional);
  if (minNotional > room) {
    console.log('  skip ' + row.symbol + ' min $' + minNotional.toFixed(2));
    return;
  }
  const notional = Math.max(CLIP, minNotional);
  let qty = notional / target;
  if (side === 'sell' && posQty > 0 && posQty * target <= CLIP * 1.5) qty = posQty;
  let size = formatVolume(qty, row.lotDecimals ?? 8);
  const minUsd = Number(row.quoteMin || process.env.MIN_ORDER_USD || 1);
  if (side === 'sell' && Number(size) * target + 1e-9 < minUsd && posQty * target + 1e-9 >= minUsd) {
    size = formatVolume(posQty, row.lotDecimals ?? 8);
  }
  if (!(Number(size) > 0) || (side === 'sell' && Number(size) * target + 1e-9 < minUsd)) {
    console.log('  skip ' + row.symbol + ' ' + side + ' $' + (Number(size) * target).toFixed(2));
    return;
  }
  if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
  console.log((LIVE ? '  ' : '  DRY ') + side.toUpperCase() + ' ' + row.symbol + ' ' + size + ' @ ' + target + ' q=' + q.toFixed(2));
  if (!LIVE) {
    if (side === 'buy') { slot.bid = 'dry'; slot.bidPx = target; slot.bidSz = size; }
    else { slot.ask = 'dry'; slot.askPx = target; slot.askSz = size; }
    state.orders[row.symbol] = slot;
    return;
  }
  const r = await ex.limitOrder(VENUE === 'kraken' ? row.orderPair : row.pair, side, target, size, {
    level: 1, userref: Number(USERREF), leverage: VENUE === 'kraken' ? LEV : 0,
  }, VENUE);
  if (r && r.order_id) {
    if (side === 'buy') { slot.bid = r.order_id; slot.bidPx = target; slot.bidSz = size; }
    else { slot.ask = r.order_id; slot.askPx = target; slot.askSz = size; }
  } else {
    if (side === 'buy') { slot.bid = null; slot.bidPx = 0; } else { slot.ask = null; slot.askPx = 0; }
    console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + ((r && (r.error || r.skipped)) || 'no id'));
  }
  state.orders[row.symbol] = slot;
}

async function quoteSymbol(row, book, state) {
  const s = await stats(row);
  if (!s) return null;
  const mid = s.mid;
  const pos = book.positions[row.symbol] || { long: 0, short: 0 };
  const q = CLIP > 0 ? ((pos.long - pos.short) * mid) / CLIP : 0;
  const model = asQuote({
    mid, q, sigma: s.sigma || 0.001, gamma: GAMMA, kappa: KAPPA, tau: TAU,
    minHalf: MIN_HALF, maxHalf: MAX_HALF, maxShift: MAX_SHIFT,
  });
  if (!model) return null;
  const inc = VENUE === 'kraken' ? 0.01 : (row.quoteIncrement || 0.01);
  let bidPx = snap(model.bid, inc, 'buy');
  let askPx = snap(model.ask, inc, 'sell');
  if (!(bidPx < mid)) bidPx = snap(mid - inc, inc, 'buy');
  if (!(askPx > mid)) askPx = snap(mid + inc, inc, 'sell');
  bidPx = formatPrice(bidPx, row.pairDecimals ?? 8);
  askPx = formatPrice(askPx, row.pairDecimals ?? 8);
  const canBuy = q < 0.95 && (VENUE === 'kraken' ? book.cash > CLIP / Math.max(LEV, 1) : book.cash + 1e-9 >= CLIP);
  const canSell = VENUE === 'kraken' ? q > -0.95 : pos.long * mid + 1e-9 >= Number(row.quoteMin || 1);
  const mine = book.mine[row.symbol] || [];
  await syncSide(row, 'buy', canBuy ? bidPx : 0, mine, state, q, pos.long);
  await syncSide(row, 'sell', canSell ? askPx : 0, mine, state, q, pos.long);
  const slot = state.orders[row.symbol] || {};
  return {
    symbol: row.symbol, mid, q,
    shiftBps: Math.round(-model.shift * 10000),
    halfBps: Math.round(model.half * 10000),
    bids: slot.bid ? 1 : 0,
    asks: slot.ask ? 1 : 0,
    orders: [
      slot.bid ? { side: 'buy', price: slot.bidPx, size: slot.bidSz, status: 'open' } : null,
      slot.ask ? { side: 'sell', price: slot.askPx, size: slot.askSz, status: 'open' } : null,
    ].filter(Boolean),
  };
}

async function main() {
  console.log('as venue=' + VENUE + ' live=' + LIVE + ' gamma=' + GAMMA + ' clip=$' + CLIP + ' ref=' + USERREF);
  const products = await ex.getProducts(VENUE);
  const state = loadState();
  state.symbols = state.symbols || [];
  state.orders = state.orders || {};
  let startEquity = 0;
  for (;;) {
    try {
      const book = VENUE === 'kraken' ? await krakenBook(state) : await coinbaseBook(state, products);
      if (!startEquity && book.equity > 0) startEquity = book.equity;
      const chosen = await select(products, book, state);
      const fresh = chosen.filter((r) => {
        const pos = book.positions[r.symbol];
        const held = pos && (pos.long + pos.short) > 0;
        if (held) return true;
        if (VENUE === 'coinbase' && book.cash + 1e-9 < CLIP) return false;
        return true;
      });
      state.symbols = fresh.map((r) => r.symbol);
      const markets = [];
      for (const row of fresh) {
        const m = await quoteSymbol(row, book, state);
        if (m) markets.push(m);
        await sleep(200);
      }
      state.symbols = markets.filter((m) => m.bids || m.asks || Math.abs(m.q) >= 0.2).map((m) => m.symbol);
      for (const [sym, pos] of Object.entries(book.positions || {})) {
        if (book.foreign.has(sym)) continue;
        if ((pos.long > 0 || pos.short > 0) && !state.symbols.includes(sym)) state.symbols.push(sym);
      }
      for (const sym of Object.keys(state.orders)) {
        if (!state.symbols.includes(sym)) delete state.orders[sym];
      }
      saveState(state);
      postStatus({
        bot: process.env.BOT,
        exchange: VENUE,
        quote: cfg.quote,
        pnl: { lastEquity: book.equity, startEquity, walletGain: startEquity ? book.equity - startEquity : 0, netMaker: 0, fees: 0, pricePnl: 0 },
        markets,
      });
      const line = markets.map((m) => m.symbol + ' q=' + m.q.toFixed(2) + ' ' + m.shiftBps + 'bp').join(' ');
      console.log('  AS $' + book.equity.toFixed(2) + ' free=$' + book.cash.toFixed(2) + ' ' + (line || 'no names'));
    } catch (e) {
      console.warn('as loop', e.message);
    }
    await sleep(LOOP);
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
