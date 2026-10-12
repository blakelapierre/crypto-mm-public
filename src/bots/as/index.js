import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envNum, envBool, envStr } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { coinbaseRequest } from '../../shared/coinbase.js';
import { fetchLivePortfolio } from '../../shared/portfolio.js';
import { formatPrice, formatVolume } from '../../shared/sizing.js';
import { postStatus, postFill, pullVenueScan } from '../../shared/status-client.js';
import { logFill } from '../../shared/fill-log.js';
import { asQuote, realizedSigma, liqNotionalCap } from './quote.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/as-kraken.env');
process.env.BOT = process.env.BOT || 'as';
const cfg = baseConfig();
if (!cfg.postOnly) throw new Error('POST_ONLY is required');
const ex = createExchange(cfg, new Map());
const VENUE = cfg.exchange === 'coinbase' ? 'coinbase' : 'kraken';
const USERREF = String(envNum('AS_USERREF', 20261011));
const MAX_PAIRS = Math.max(1, envNum('MM_MAX_PAIRS', 2));
const GAMMA = envNum('AS_GAMMA', 40);
const KAPPA = envNum('AS_KAPPA', 1.5);
const TAU = envNum('AS_TAU_MIN', 15);
const MAX_HALF = envNum('MAX_HALF_BPS', 200) / 10000;
const MAX_SHIFT = envNum('AS_MAX_SHIFT_BPS', 150) / 10000;
const MIN_RANGE = envNum('VOL_ENTER_PCT', 0.4) / 100;
const LOOP = envNum('AS_LOOP_MS', 20000);
const LIVE = envBool('AS_LIVE', false) && !cfg.dryRun;
const LEV_UTIL = envNum('AS_LEV_UTIL', 0.8);
const CLIPS_PER_SIDE = Math.max(1, envNum('AS_CLIPS_PER_SIDE', 2));
const LIQ_MIN = envNum('AS_LIQ_MIN_PCT', 15) / 100;
const ML_STOP = envNum('AS_MARGIN_LEVEL_STOP', 300);
const ML_CUT = envNum('AS_MARGIN_LEVEL_CUT', 200);
const SESSION_LOSS = envNum('AS_MAX_SESSION_LOSS_PCT', 8) / 100;
const DAY_LOSS = envNum('AS_MAX_DAY_LOSS_PCT', 12) / 100;
const BOOK_TARGET = envNum('BOOK_TARGET_FRAC', 0.9);
const MIN_VOL = envNum('SCAN_MIN_VOL24_USD', 250000);
const MAX_SPREAD = envNum('SCAN_MAX_SPREAD_BPS', 40) / 10000;
const FEE_BPS = envNum('MAKER_FEE_BPS', VENUE === 'kraken' ? 16 : 40);
const statePath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.json');
const lockPath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.lock');
const fillPath = path.join(process.cwd(), 'logs', 'fills-as-' + VENUE + '.jsonl');

function ceiling(name) {
  const v = String(process.env[name] ?? 'max').trim().toLowerCase();
  if (!v || v === 'max') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const LEV_CAP = ceiling('AS_LEVERAGE');
const NOTIONAL_CAP = ceiling('AS_MAX_NOTIONAL');

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return {}; }
}
function saveState(st) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(st));
}
function lock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let previous = '';
  try { previous = fs.readFileSync(lockPath, 'utf8').trim(); } catch { /* first start */ }
  if (previous && previous !== String(process.pid)) {
    try { process.kill(Number(previous), 0); console.error('already running pid ' + previous); process.exit(0); }
    catch { /* stale */ }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  const unlock = () => { try { if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath); } catch { /* gone */ } };
  process.on('exit', unlock);
  process.on('SIGTERM', () => { unlock(); process.exit(0); });
  process.on('SIGINT', () => { unlock(); process.exit(0); });
  console.log('restart reason ' + (previous ? 'service' : 'start') + ' pid=' + process.pid);
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
  const tick = Number(inc) > 0 ? Number(inc) : 0.00000001;
  const n = side === 'buy' ? Math.floor(px / tick + 1e-8) * tick : Math.ceil(px / tick - 1e-8) * tick;
  return n;
}
function symbolOf(pair) {
  return String(pair || '').replace(/USD:BTNL$/i, '').replace(/USD$/i, '').replace(/^XBT/, 'BTC').toUpperCase();
}
function orderPairOf(rec, symbol) {
  if (VENUE === 'coinbase') return rec.pair;
  return (rec.altname || symbol + 'USD') + ':BTNL';
}
function median(xs) {
  if (!xs || !xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function halfFor(row, spreadBps) {
  const fee = FEE_BPS * 1.2;
  const touch = spreadBps > 0 ? 0.5 * spreadBps : 0;
  const bps = Math.max(fee, touch, 1);
  return Math.min(MAX_HALF, bps / 10000);
}
function levWant(row, side) {
  const max = side === 'sell' ? Number(row.maxLevSell || row.maxLev || 2) : Number(row.maxLevBuy || row.maxLev || 2);
  if (!(max >= 2)) return 0;
  return LEV_CAP ? Math.min(LEV_CAP, max) : max;
}
function clipFor(equity, lev) {
  const utilRoom = equity * Math.max(lev, 1) * LEV_UTIL;
  const liqRoom = VENUE === 'kraken' ? liqNotionalCap(equity, Math.max(lev, 1), LIQ_MIN) : equity;
  let room = Math.min(utilRoom, liqRoom);
  if (NOTIONAL_CAP) room = Math.min(room, NOTIONAL_CAP);
  return Math.max(1, room / (MAX_PAIRS * CLIPS_PER_SIDE));
}

async function probeLev(row, side, mid) {
  const want = levWant(row, side);
  const steps = (row.levSteps && row.levSteps.length ? row.levSteps : [want]).filter((n) => n <= want && n >= 2);
  const list = steps.length ? steps : [want];
  for (const lev of list) {
    try {
      await krakenOnce('AddOrder', {
        pair: row.orderPair, type: side, ordertype: 'limit', leverage: String(lev), oflags: 'post', validate: true,
        price: String(formatPrice(side === 'buy' ? mid * 0.5 : mid * 1.5, row.pairDecimals)),
        volume: String(Math.max(Number(row.ordermin) || 0, mid > 0 ? 1 / mid : 0)),
      });
      return lev;
    } catch (e) {
      if (/leverage/i.test(e.message)) continue;
      return lev;
    }
  }
  return list[list.length - 1] || 2;
}

function noteFill(state, row) {
  state.seenFills = state.seenFills || {};
  if (!row.venueFillId || state.seenFills[row.venueFillId]) return false;
  state.seenFills[row.venueFillId] = row.time;
  const ids = Object.keys(state.seenFills);
  if (ids.length > 400) delete state.seenFills[ids[0]];
  state.makerCapture = (state.makerCapture || 0) + (row.capture || 0);
  state.fees = (state.fees || 0) + (row.fee || 0);
  state.fillTimes = state.fillTimes || [];
  state.fillTimes.push(Date.parse(row.time) || Date.now());
  fs.mkdirSync(path.dirname(fillPath), { recursive: true });
  fs.appendFileSync(fillPath, JSON.stringify(row) + '\n');
  logFill({
    orderId: row.orderId, venue: VENUE, pair: row.symbol, symbol: row.symbol, side: row.side,
    price: row.price, size: row.size, fee: row.fee, venueFee: row.fee, filledValue: row.price * row.size,
  });
  postFill(row);
  console.log('  FILL ' + row.side + ' ' + row.symbol + ' ' + row.size + ' @ ' + row.price + ' ' + row.liquidity);
  return true;
}

async function pollFills(state, mids) {
  if (VENUE === 'kraken') {
    const start = state.fillCursor || Math.floor(Date.now() / 1000) - 6 * 3600;
    const closed = await krakenOnce('ClosedOrders', { start });
    let newest = start;
    for (const [id, o] of Object.entries((closed && closed.closed) || {})) {
      if (String(o.userref || '') !== USERREF) continue;
      const d = o.descr || {};
      const exec = Number(o.vol_exec || 0);
      const prev = (state.exec && state.exec[id]) || 0;
      if (exec > prev + 1e-12) {
        const px = Number(d.price || o.price || 0);
        const sym = symbolOf(d.pair);
        const mid = mids[sym] || px;
        const side = String(d.type || '').toLowerCase();
        const delta = exec - prev;
        const capture = (side === 'buy' ? mid - px : px - mid) * delta;
        noteFill(state, {
          venueFillId: id + ':' + exec, time: new Date((Number(o.closetm) || Date.now() / 1000) * 1000).toISOString(),
          symbol: sym, side, price: px, size: delta, fee: Number(o.fee || 0), feeCcy: 'USD',
          liquidity: 'maker', orderId: id, leverage: Number(String(d.leverage || '').split(':')[0]) || 0,
          posEffect: 'open', capture,
        });
      }
      state.exec = state.exec || {};
      state.exec[id] = exec;
      newest = Math.max(newest, Number(o.closetm) || 0);
    }
    state.fillCursor = Math.max(start, newest - 120);
    return;
  }
  const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/fills?limit=50');
  for (const f of data.fills || []) {
    const cid = String(f.client_order_id || '');
    if (!cid.startsWith('as-cb-') && !(state.knownIds && state.knownIds[f.order_id])) continue;
    const px = Number(f.price || 0);
    const sz = Number(f.size || 0);
    const sym = String(f.product_id || '').split('-')[0].toUpperCase();
    const side = String(f.side || '').toLowerCase();
    const mid = mids[sym] || px;
    noteFill(state, {
      venueFillId: f.trade_id || f.entry_id, time: f.trade_time || new Date().toISOString(),
      symbol: sym, side, price: px, size: sz, fee: Number(f.commission || 0), feeCcy: 'USDC',
      liquidity: String(f.liquidity_indicator || 'MAKER').toLowerCase().includes('taker') ? 'taker' : 'maker',
      orderId: f.order_id, leverage: 0, posEffect: 'open',
      capture: (side === 'buy' ? mid - px : px - mid) * sz,
    });
  }
}

async function pollTransfers(state) {
  if (VENUE !== 'kraken') return;
  const start = state.ledgerCursor || Math.floor(Date.parse(state.startTime || new Date().toISOString()) / 1000);
  for (const type of ['deposit', 'withdrawal', 'rollover', 'margin']) {
    let page;
    try { page = await krakenOnce('Ledgers', { start, type }); }
    catch { continue; }
    for (const [id, row] of Object.entries((page && page.ledger) || {})) {
      state.seenLedgers = state.seenLedgers || {};
      if (state.seenLedgers[id]) continue;
      state.seenLedgers[id] = true;
      const amt = Number(row.amount || 0);
      if (type === 'deposit' || type === 'withdrawal') state.transfers = (state.transfers || 0) + amt;
      else state.fundingBorrow = (state.fundingBorrow || 0) + Math.abs(Math.min(0, amt));
    }
  }
  state.ledgerCursor = Math.floor(Date.now() / 1000) - 60;
}

async function krakenBook(state) {
  const tb = await krakenOnce('TradeBalance', { asset: 'ZUSD' });
  const pos = await krakenOnce('OpenPositions', { docalcs: true });
  const open = await krakenOnce('OpenOrders', {});
  const positions = {};
  let upnl = 0;
  for (const p of Object.values(pos || {})) {
    const sym = symbolOf(p.pair);
    const vol = Number(p.vol || 0) - Number(p.vol_closed || 0);
    if (!(vol > 0)) continue;
    const row = positions[sym] || { long: 0, short: 0 };
    if (String(p.type).toLowerCase() === 'sell') row.short += vol;
    else row.long += vol;
    upnl += Number(p.net || 0);
    positions[sym] = row;
  }
  const mine = {};
  const known = state.knownIds || {};
  for (const [id, o] of Object.entries((open && open.open) || {})) {
    const sym = symbolOf((o.descr || {}).pair);
    const ours = String(o.userref || '') === USERREF || known[id];
    if (!ours) continue;
    const rec = { id, sym, side: String((o.descr || {}).type || '').toLowerCase(), price: Number((o.descr || {}).price || 0), ours: true };
    (mine[sym] = mine[sym] || []).push(rec);
    known[id] = { sym, side: rec.side };
  }
  state.knownIds = known;
  const hasPos = Object.keys(positions).length > 0;
  return {
    equity: Number(tb.eb || tb.e || 0), cash: Number(tb.mf || 0), positions, mine, foreign: new Set(),
    ml: hasPos ? Number(tb.ml || 0) : null, inventoryPnl: upnl,
  };
}

async function coinbaseBook(state, products) {
  const live = await fetchLivePortfolio(cfg, ex, products, 'coinbase');
  const orders = await ex.listOpen('coinbase');
  const known = state.knownIds || {};
  const foreign = new Set();
  const mine = {};
  for (const o of orders || []) {
    const sym = String(o.product_id || '').split('-')[0].toUpperCase();
    const cid = String(o.client_order_id || '');
    const ours = cid.startsWith('as-cb-') || known[o.order_id];
    const limit = ((o.order_configuration || {}).limit_limit_gtc) || {};
    const rec = { id: o.order_id, sym, side: String(o.side || '').toLowerCase(), price: Number(limit.limit_price || 0), ours };
    if (!ours) foreign.add(sym);
    else {
      (mine[sym] = mine[sym] || []).push(rec);
      known[o.order_id] = { sym, side: rec.side };
    }
  }
  state.knownIds = known;
  const positions = {};
  for (const [sym, p] of Object.entries(live.positions || {})) {
    const qty = Number(p.amount || 0);
    if (qty > 0) positions[sym] = { long: qty, short: 0, usd: Number(p.valueQuote || 0), mid: Number(p.mid || 0) };
  }
  return { equity: Number(live.totalEquity || 0), cash: Number(live.freeQuote || 0), positions, mine, foreign, ml: null, inventoryPnl: 0 };
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
    let bid = 0; let ask = 0; let vol = 0;
    try {
      const t = await krakenPublic('Ticker', { pair: row.pair });
      const tk = t[row.pair] || t[row.altname] || Object.values(t).find((x) => x && x.c) || {};
      bid = Number((tk.b || [])[0] || 0);
      ask = Number((tk.a || [])[0] || 0);
      vol = Number((tk.v || [])[1] || (tk.v || [])[0] || 0) * mid;
    } catch { /* range still usable */ }
    return { mid, bid, ask, sigma: realizedSigma(closes), range: mid > 0 ? (hi - lo) / mid : 0, vol };
  }
  const book = await ex.getBook(row.pair, 'coinbase');
  if (!book || !(book.mid > 0)) return null;
  let sigma = 0.0015;
  try {
    const end = Math.floor(Date.now() / 1000);
    const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/market/products/' + encodeURIComponent(row.pair) + '/candles?start=' + (end - 35 * 60) + '&end=' + end + '&granularity=ONE_MINUTE');
    const closes = (data.candles || []).map((c) => Number(c.close)).filter((n) => n > 0).reverse();
    if (closes.length >= 5) sigma = realizedSigma(closes);
  } catch { /* keep fallback */ }
  return { mid: book.mid, bid: book.bid, ask: book.ask, sigma, range: Math.max(MIN_RANGE, 0), vol: MIN_VOL };
}

function dusting(state, sym) {
  const until = (state.dust && state.dust[sym]) || 0;
  return until > Date.now();
}
function markDust(state, sym) {
  state.dustN = state.dustN || {};
  state.dustN[sym] = (state.dustN[sym] || 0) + 1;
  if (state.dustN[sym] >= 3) {
    state.dust = state.dust || {};
    state.dust[sym] = Date.now() + 6 * 3600 * 1000;
    console.log('  dust ' + sym + ' 6h');
  }
}

async function select(products, book, state) {
  const held = [];
  const push = (rec, symbol) => {
    if (!rec || held.some((r) => r.symbol === symbol) || dusting(state, symbol) || book.foreign.has(symbol)) return;
    held.push({ ...rec, symbol, orderPair: orderPairOf(rec, symbol) });
  };
  for (const [sym, pos] of Object.entries(book.positions || {})) {
    const usd = pos.usd || Math.abs(pos.long - pos.short) * (pos.mid || 0);
    if (usd >= 0.5 || (state.symbols || []).includes(sym)) push(products[sym], sym);
  }
  if (held.length >= MAX_PAIRS) return held;
  const scan = await pullVenueScan(VENUE);
  const rank = new Map(((scan && scan.ranked) || []).map((r, i) => [String(r.symbol || r.pair || '').toUpperCase(), i]));
  const candidates = [];
  for (const [symbol, rec] of Object.entries(products)) {
    if (held.some((r) => r.symbol === symbol) || book.foreign.has(symbol)) continue;
    if (VENUE === 'kraken' && !rec.shortable) continue;
    candidates.push({ ...rec, symbol, orderPair: orderPairOf(rec, symbol), scan: rank.has(symbol) ? rank.get(symbol) : 999 });
  }
  candidates.sort((a, b) => a.scan - b.scan || a.symbol.localeCompare(b.symbol));
  const ranked = [];
  for (const row of candidates.slice(0, 8)) {
    try {
      const s = await stats(row);
      if (!s) continue;
      const tick = row.quoteIncrement || 0.01;
      const spread = s.bid > 0 && s.ask > s.bid ? (s.ask - s.bid) / s.mid : 1;
      if (tick / s.mid > 0.001) continue;
      if (s.vol && s.vol < MIN_VOL) continue;
      if (spread > MAX_SPREAD) continue;
      if (s.range + 1e-12 < MIN_RANGE) continue;
      ranked.push({ ...row, range: s.range, spread });
    } catch { /* skip */ }
    await sleep(80);
  }
  const score = (r) => r.range / Math.max(r.spread, 1e-6);
  ranked.sort((a, b) => score(b) - score(a));
  return held.concat(ranked).slice(0, Math.max(MAX_PAIRS, held.length));
}

async function syncSide(row, side, target, size, mine, state, lev, reduceOnly, budget) {
  const cur = (mine || []).find((o) => o.side === side);
  const slot = state.orders[row.symbol] || {};
  const prev = side === 'buy' ? Number(slot.bidPx || 0) : Number(slot.askPx || 0);
  if (!(target > 0) || !(Number(size) > 0)) {
    if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
    if (side === 'buy') { slot.bid = null; slot.bidPx = 0; } else { slot.ask = null; slot.askPx = 0; }
    state.orders[row.symbol] = slot;
    return;
  }
  const notional = Number(size) * target;
  if (side === 'buy' && budget && notional > budget.left + 1e-9) {
    console.log('  skip ' + row.symbol + ' cash $' + budget.left.toFixed(2));
    return;
  }
  if (cur && prev > 0 && Math.abs(prev - target) / target < 0.0015 && Math.abs(Number(side === 'buy' ? slot.bidSz : slot.askSz) - Number(size)) < 1e-8) return;
  if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
  const clientOrderId = 'as-cb-' + randomUUID();
  console.log('  ' + side.toUpperCase() + ' ' + row.symbol + ' ' + size + ' @ ' + target + (lev ? ' ' + lev + 'x' : '') + (reduceOnly ? ' reduce' : ''));
  if (!LIVE) return;
  const meta = { level: 1, userref: Number(USERREF), leverage: lev || 0, clientOrderId };
  if (reduceOnly) meta.reduceOnly = true;
  const paramsNote = VENUE === 'kraken' ? row.orderPair : row.pair;
  const r = await ex.limitOrder(paramsNote, side, target, size, meta, VENUE);
  if (r && r.order_id) {
    state.knownIds = state.knownIds || {};
    state.knownIds[r.order_id] = { sym: row.symbol, side };
    if (side === 'buy') { slot.bid = r.order_id; slot.bidPx = target; slot.bidSz = size; if (budget) budget.left -= notional; }
    else { slot.ask = r.order_id; slot.askPx = target; slot.askSz = size; }
  } else {
    const why = (r && (r.error || r.skipped)) || 'no id';
    if (String(why).includes('belowMin')) markDust(state, row.symbol);
    console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + why);
    if (side === 'buy') slot.bid = null; else slot.ask = null;
  }
  state.orders[row.symbol] = slot;
}

async function quoteSymbol(row, book, state, clip, addOk, budget) {
  if (dusting(state, row.symbol)) return null;
  const s = await stats(row);
  if (!s) return null;
  const mid = s.mid;
  const pos = book.positions[row.symbol] || { long: 0, short: 0 };
  const net = (pos.long - pos.short) * mid;
  const q = clip > 0 ? net / clip : 0;
  const spreads = (state.spreads && state.spreads[row.symbol]) || [];
  if (s.bid > 0 && s.ask > s.bid) {
    spreads.push((s.ask - s.bid) / mid * 10000);
    while (spreads.length > 90) spreads.shift();
    state.spreads = state.spreads || {};
    state.spreads[row.symbol] = spreads;
  }
  const model = asQuote({
    mid, q, sigma: s.sigma || 0.001, gamma: GAMMA, kappa: KAPPA, tau: TAU,
    minHalf: halfFor(row, median(spreads)), maxHalf: MAX_HALF, maxShift: MAX_SHIFT,
  });
  if (!model) return null;
  const inc = row.quoteIncrement || (VENUE === 'kraken' ? 0.01 : 0.01);
  let bidPx = snap(model.bid, inc, 'buy');
  let askPx = snap(model.ask, inc, 'sell');
  if (!(bidPx < mid)) bidPx = snap(mid - inc, inc, 'buy');
  if (!(askPx > mid)) askPx = snap(mid + inc, inc, 'sell');
  if (VENUE !== 'kraken' && pos.long > 0) {
    const need = Number(row.quoteMin || 1) / pos.long;
    if (askPx < need) askPx = snap(need, inc, 'sell');
  }
  bidPx = formatPrice(bidPx, row.pairDecimals ?? 8);
  askPx = formatPrice(askPx, row.pairDecimals ?? 8);
  let lev = 0;
  if (VENUE === 'kraken') {
    const keyB = row.symbol + ':buy';
    const keyS = row.symbol + ':sell';
    state.levOk = state.levOk || {};
    if (!state.levOk[keyB]) state.levOk[keyB] = await probeLev(row, 'buy', mid);
    if (!state.levOk[keyS]) state.levOk[keyS] = await probeLev(row, 'sell', mid);
    lev = Math.max(state.levOk[keyB], state.levOk[keyS]);
  }
  const reduce = !!state.halted || (book.ml != null && book.ml < ML_STOP);
  const cut = book.ml != null && book.ml < ML_CUT;
  let buySz = 0; let sellSz = 0;
  const minUsd = Number(row.quoteMin || 1);
  if (cut && (pos.long > 0 || pos.short > 0)) {
    if (pos.long > 0) { sellSz = formatVolume(pos.long * 0.5, row.lotDecimals ?? 8); askPx = formatPrice(s.ask || askPx, row.pairDecimals ?? 8); }
    if (pos.short > 0) { buySz = formatVolume(pos.short * 0.5, row.lotDecimals ?? 8); bidPx = formatPrice(s.bid || bidPx, row.pairDecimals ?? 8); }
  } else if (VENUE === 'coinbase') {
    if (pos.long > 0 && askPx * pos.long + 1e-9 >= minUsd) sellSz = formatVolume(pos.long, row.lotDecimals ?? 8);
    if (addOk && q < 0.95 && budget.left + 1e-9 >= minUsd) buySz = formatVolume(Math.min(clip, budget.left) / bidPx, row.lotDecimals ?? 8);
  } else if (!reduce) {
    const cap = liqNotionalCap(book.equity, lev || 2, LIQ_MIN);
    const sz = Math.min(clip, cap) / mid;
    if (q < 0.95) buySz = formatVolume(Math.max(sz, Number(row.ordermin) || 0), row.lotDecimals ?? 8);
    if (q > -0.95) sellSz = formatVolume(Math.max(sz, Number(row.ordermin) || 0), row.lotDecimals ?? 8);
    if (buySz * bidPx > cap || sellSz * askPx > cap) {
      console.log('RAIL liq ' + row.symbol);
      if (buySz * bidPx > cap) buySz = 0;
      if (sellSz * askPx > cap) sellSz = 0;
    }
  } else {
    if (pos.short > 0) buySz = formatVolume(pos.short, row.lotDecimals ?? 8);
    if (pos.long > 0) sellSz = formatVolume(pos.long, row.lotDecimals ?? 8);
  }
  const buyLev = VENUE === 'kraken' ? (state.levOk[row.symbol + ':buy'] || lev) : 0;
  const sellLev = VENUE === 'kraken' ? (state.levOk[row.symbol + ':sell'] || lev) : 0;
  const mine = book.mine[row.symbol] || [];
  await syncSide(row, 'buy', buySz > 0 ? bidPx : 0, buySz, mine, state, buyLev, reduce || cut, budget);
  await syncSide(row, 'sell', sellSz > 0 ? askPx : 0, sellSz, mine, state, sellLev, reduce || cut, budget);
  const slot = state.orders[row.symbol] || {};
  return {
    symbol: row.symbol, mid, q, lev: lev || 0,
    shiftBps: Math.round(-model.shift * 10000), halfBps: Math.round(model.half * 10000),
    bids: slot.bid ? 1 : 0, asks: slot.ask ? 1 : 0,
    orders: [
      slot.bid ? { side: 'buy', price: slot.bidPx, size: slot.bidSz, status: 'open' } : null,
      slot.ask ? { side: 'sell', price: slot.askPx, size: slot.askSz, status: 'open' } : null,
    ].filter(Boolean),
    openOrders: [slot.bid, slot.ask].filter(Boolean),
  };
}

function lossPct(base, equity, transfers) {
  if (!(base > 0)) return 0;
  const adj = equity - base - (transfers || 0);
  return Math.max(0, -adj) / base;
}

async function main() {
  lock();
  console.log('as venue=' + VENUE + ' live=' + LIVE + ' lev=' + (LEV_CAP || 'max') + ' util=' + LEV_UTIL);
  let products = await ex.getProducts(VENUE);
  let productsAt = Date.now();
  const state = loadState();
  state.symbols = state.symbols || [];
  state.orders = state.orders || {};
  state.knownIds = state.knownIds || {};
  if (envBool('AS_RESUME', false)) state.halted = null;
  if (envBool('AS_NEW_SESSION', false) || !(state.startEquity > 0)) {
    state.startEquity = 0;
    state.startTime = new Date().toISOString();
    state.transfers = 0;
    state.makerCapture = 0;
    state.fees = 0;
    state.fundingBorrow = 0;
    state.equityMarks = [];
  }
  for (;;) {
    try {
      if (Date.now() - productsAt > 3600 * 1000) { products = await ex.getProducts(VENUE); productsAt = Date.now(); }
      const book = VENUE === 'kraken' ? await krakenBook(state) : await coinbaseBook(state, products);
      if (!(state.startEquity > 0) && book.equity > 0) state.startEquity = book.equity;
      const sessionLoss = lossPct(state.startEquity, book.equity, state.transfers);
      state.equityMarks = state.equityMarks || [];
      const now = Date.now();
      if (!state.equityMarks.length || now - state.equityMarks[state.equityMarks.length - 1].t > 60000) {
        state.equityMarks.push({ t: now, eq: book.equity });
      }
      state.equityMarks = state.equityMarks.filter((m) => now - m.t < 26 * 3600 * 1000);
      const dayBase = (state.equityMarks.find((m) => now - m.t >= 24 * 3600 * 1000) || state.equityMarks[0] || {}).eq || state.startEquity;
      const dayLoss = lossPct(dayBase, book.equity, 0);
      if (!state.halted && (sessionLoss >= SESSION_LOSS || dayLoss >= DAY_LOSS)) {
        state.halted = 'session-loss';
        console.log('RAIL ' + (sessionLoss >= SESSION_LOSS ? 'session-loss' : 'day-loss'));
      }
      if (book.ml != null && book.ml < ML_CUT) console.log('RAIL margin-cut ml=' + book.ml);
      else if (book.ml != null && book.ml < ML_STOP) console.log('RAIL margin-stop ml=' + book.ml);
      const addOk = !state.halted && !(book.ml != null && book.ml < ML_STOP);
      const levGuess = VENUE === 'kraken' ? 5 : 1;
      const clip = clipFor(book.equity, levGuess);
      const chosen = await select(products, book, state);
      const budget = { left: book.cash };
      const markets = [];
      const mids = {};
      for (const row of chosen) {
        const m = await quoteSymbol(row, book, state, clip, addOk, budget);
        if (m) { markets.push(m); mids[m.symbol] = m.mid; }
        await sleep(150);
      }
      state.symbols = [...new Set(markets.map((m) => m.symbol).concat(Object.keys(book.positions || {}).filter((s) => !dusting(state, s))))];
      try { await pollFills(state, mids); } catch (e) { console.warn('fills', e.message); }
      try { await pollTransfers(state); } catch (e) { console.warn('ledgers', e.message); }
      const equityAdj = book.equity - (state.startEquity || book.equity) - (state.transfers || 0);
      const inv = book.inventoryPnl || 0;
      const recon = equityAdj - ((state.makerCapture || 0) - (state.fees || 0) + inv - (state.fundingBorrow || 0));
      if (book.equity > 0 && Math.abs(recon) > book.equity * 0.01) console.log('RECON ' + recon.toFixed(2));
      const hour = Date.now() - 3600 * 1000;
      state.fillTimes = (state.fillTimes || []).filter((t) => t >= hour);
      const levBySymbol = {};
      for (const m of markets) if (m.lev) levBySymbol[m.symbol] = m.lev;
      const dust = Object.keys(state.dust || {}).filter((s) => state.dust[s] > Date.now());
      saveState(state);
      postStatus({
        bot: process.env.BOT, exchange: VENUE, quote: cfg.quote,
        pnl: {
          startEquity: state.startEquity, startTime: state.startTime, lastEquity: book.equity,
          transfers: state.transfers || 0, equityAdj, makerCapture: state.makerCapture || 0,
          fees: state.fees || 0, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
          recon, fills: Object.keys(state.seenFills || {}).length, fillsHour: state.fillTimes.length,
          netMaker: (state.makerCapture || 0) - (state.fees || 0), pricePnl: inv,
        },
        rails: {
          ml: book.ml, liqDistPct: LIQ_MIN * 100, sessionLossPct: sessionLoss * 100,
          dayLossPct: dayLoss * 100, halted: state.halted || null, levBySymbol,
        },
        dust, markets,
      });
      const line = markets.map((m) => m.symbol + ' q=' + m.q.toFixed(2) + ' ' + m.halfBps + 'bp').join(' ');
      console.log('  AS eq=$' + book.equity.toFixed(2) + ' free=$' + book.cash.toFixed(2) + ' adj=$' + equityAdj.toFixed(2) + ' maker=$' + (state.makerCapture || 0).toFixed(2) + ' fees=$' + (state.fees || 0).toFixed(2) + ' inv=$' + inv.toFixed(2) + ' fund=$' + (state.fundingBorrow || 0).toFixed(2) + ' fills=' + state.fillTimes.length + ' lev=' + (Object.values(levBySymbol)[0] || 0) + ' ml=' + (book.ml == null ? '-' : book.ml) + ' | ' + (line || 'no names'));
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
