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
import { refreshFeeTier } from '../../shared/fee-tier.js';
import { asQuote, realizedSigma, liqNotionalCap, halfSpread, exitBound, clampToBand, halveToward, backoffSec, feeToBps, applyEntry, entryAvg, positionPnl, opensRisk, touchExit, bookNotional } from './quote.js';

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
const PROFIT_BPS = envNum('AS_PROFIT_BPS', 10);
const ML_HALT = envNum('AS_MARGIN_LEVEL_HALT', 150);
const ML_RESUME = envNum('AS_MARGIN_LEVEL_RESUME', 350);
const MAX_FROM_MID = envNum('AS_MAX_FROM_MID', 0.02);
let makerFeeBps = FEE_BPS;
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
function halfFor(spreadBps) {
  return halfSpread({
    feeBps: makerFeeBps,
    profitBps: PROFIT_BPS,
    touchHalfBps: spreadBps > 0 ? 0.5 * spreadBps : 0,
    maxHalfBps: MAX_HALF * 10000,
  });
}
function pxText(n) {
  const x = Number(n);
  if (!(x > 0)) return '-';
  const d = x >= 100 ? 2 : x >= 1 ? 4 : 6;
  return String(Number(x.toFixed(d)));
}
async function loadMakerFee() {
  try {
    if (VENUE === 'coinbase') {
      const tier = await refreshFeeTier(cfg);
      if (tier && tier.makerBps > 0) makerFeeBps = tier.makerBps;
    } else {
      const tv = await krakenOnce('TradeVolume', {});
      const book = (tv && tv.fees_maker) || {};
      const row = Object.values(book)[0];
      const bps = feeToBps(row && row.fee);
      if (bps > 0) makerFeeBps = bps;
    }
  } catch (e) {
    console.warn('fee', e.message);
  }
  console.log('maker fee ' + makerFeeBps.toFixed(2) + 'bp profit ' + PROFIT_BPS + 'bp minHalf ' + (makerFeeBps + PROFIT_BPS).toFixed(2) + 'bp');
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
  state.fillCount = (Number(state.fillCount) || 0) + 1;
  state.fillTimes = state.fillTimes || [];
  state.fillTimes.push(Date.parse(row.time) || Date.now());
  const prev = state.entry && state.entry[row.symbol];
  const next = applyEntry(prev, row);
  const grew = String(row.side).toLowerCase() === 'buy'
    ? next.longQty > (Number(prev && prev.longQty) || 0) + 1e-12
    : next.shortQty > (Number(prev && prev.shortQty) || 0) + 1e-12;
  row.posEffect = grew ? 'open' : 'close';
  state.entry = state.entry || {};
  state.entry[row.symbol] = next;
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
    const row = positions[sym] || { long: 0, short: 0, longCost: 0, shortCost: 0, margin: 0, value: 0 };
    const cost = Number(p.cost || 0);
    const margin = Number(p.margin || 0);
    const value = Number(p.value || 0) || cost;
    if (String(p.type).toLowerCase() === 'sell') { row.short += vol; row.shortCost += cost; }
    else { row.long += vol; row.longCost += cost; }
    row.margin += margin;
    row.value += value;
    upnl += Number(p.net || 0);
    positions[sym] = row;
  }
  for (const row of Object.values(positions)) {
    row.avgLong = row.long > 0 && row.longCost > 0 ? row.longCost / row.long : 0;
    row.avgShort = row.short > 0 && row.shortCost > 0 ? row.shortCost / row.short : 0;
    const rawLev = row.margin > 0 && row.value > 0 ? row.value / row.margin : 0;
    row.lev = rawLev >= 2 && rawLev <= 20 ? Math.max(2, Math.round(rawLev)) : 0;
  }
  const mine = {};
  const known = state.knownIds || {};
  for (const [id, o] of Object.entries((open && open.open) || {})) {
    const sym = symbolOf((o.descr || {}).pair);
    const ours = String(o.userref || '') === USERREF || known[id];
    if (!ours) continue;
    const left = Number(o.vol || 0) - Number(o.vol_exec || 0);
    const rec = { id, sym, side: String((o.descr || {}).type || '').toLowerCase(), price: Number((o.descr || {}).price || 0), size: left > 0 ? left : Number(o.vol || 0), ours: true };
    (mine[sym] = mine[sym] || []).push(rec);
    known[id] = { sym, side: rec.side };
  }
  state.knownIds = known;
  const hasPos = Object.keys(positions).length > 0;
  return {
    equity: Number(tb.eb || tb.e || 0), cash: Number(tb.mf || 0), positions, mine, foreign: new Set(),
    ml: hasPos ? Number(tb.ml || 0) : null, inventoryPnl: upnl, quoteHold: 0,
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
    const baseSz = Number(limit.base_size || 0);
    const filled = Number(o.filled_size || 0);
    const rec = {
      id: o.order_id, sym, side: String(o.side || '').toLowerCase(), price: Number(limit.limit_price || 0),
      size: baseSz > filled ? baseSz - filled : baseSz, ours,
    };
    if (!ours) foreign.add(sym);
    else {
      (mine[sym] = mine[sym] || []).push(rec);
      known[o.order_id] = { sym, side: rec.side };
    }
  }
  state.knownIds = known;
  const positions = {};
  for (const [sym, p] of Object.entries(live.positions || {})) {
    const avail = Number(p.amount || 0);
    const hold = Number(p.hold || 0);
    const qty = avail + hold;
    if (!(qty > 0)) continue;
    positions[sym] = {
      long: qty, short: 0, available: avail, hold, usd: Number(p.valueQuote || 0),
      mid: Number(p.mid || 0), bid: Number(p.bestBid || 0), quoteMin: Number(p.quoteMin || 1),
    };
  }
  return {
    equity: Number(live.totalEquity || 0), cash: Number(live.freeQuote || 0), quoteHold: Number(live.quoteHold || 0),
    positions, mine, foreign, ml: null, inventoryPnl: 0,
  };
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

function markDust(state, sym, mid) {
  state.belowMin = state.belowMin || {};
  state.belowMin[sym] = mid || state.belowMin[sym] || true;
}
function restingBuyNotional(mine) {
  let n = 0;
  for (const orders of Object.values(mine || {})) {
    for (const o of orders || []) {
      if (o.side === 'buy') n += Number(o.price || 0) * Number(o.size || 0);
    }
  }
  return n;
}
function rejectReason(why) {
  const s = String(why || '');
  if (/TOO_FAR/i.test(s)) return 'too-far';
  if (/belowMin|ordermin|minimum/i.test(s)) return 'below-min';
  if (/post only|would execute|POST_ONLY|INVALID_LIMIT/i.test(s)) return 'post-only';
  if (/insufficient/i.test(s)) return 'funds';
  if (s === 'pos' || s === 'free') return 'size';
  return (s || 'reject').slice(0, 40);
}
function armBackoff(state, sym, reason) {
  state.backoff = state.backoff || {};
  const prev = state.backoff[sym] || { n: 0, reason };
  const n = prev.reason === reason ? (Number(prev.n) || 0) + 1 : 1;
  const sec = backoffSec(n);
  state.backoff[sym] = { n, reason, until: Date.now() + sec * 1000 };
  console.log('BACKOFF ' + sym + ' ' + reason + ' ' + n + ' ' + sec);
}
function backoffActive(state, sym) {
  const b = state.backoff && state.backoff[sym];
  return !!(b && b.until > Date.now());
}
function maxBackoffN(state) {
  let n = 0;
  for (const b of Object.values(state.backoff || {})) n = Math.max(n, Number(b.n) || 0);
  return n;
}
function exitResting(book) {
  for (const [sym, orders] of Object.entries(book.mine || {})) {
    const pos = book.positions[sym] || {};
    const net = Number(pos.long || 0) - Number(pos.short || 0);
    for (const o of orders || []) {
      if (net > 0 && o.side === 'sell') return true;
      if (net < 0 && o.side === 'buy') return true;
    }
  }
  return false;
}
function largestSymbol(positions) {
  let best = null;
  let bestN = 0;
  for (const [sym, p] of Object.entries(positions || {})) {
    const mid = Number(p.mid || p.avgLong || p.avgShort || 0);
    const n = Math.abs(Number(p.long || 0) - Number(p.short || 0)) * mid;
    if (n > bestN) { bestN = n; best = sym; }
  }
  return best;
}
function clearFlatEntry(state, positions) {
  if (!state.entry) return;
  for (const sym of Object.keys(state.entry)) {
    const pos = positions && positions[sym];
    const qty = pos ? Number(pos.long || 0) + Number(pos.short || 0) : 0;
    if (!(qty > 0)) delete state.entry[sym];
  }
}
function ensureEntry(state, sym, pos, mid) {
  state.entry = state.entry || {};
  let cur = state.entry[sym];
  const long = Number(pos.long || 0);
  const short = Number(pos.short || 0);
  const avg = long > 0 ? Number(pos.avgLong || 0) : Number(pos.avgShort || 0);
  if (VENUE === 'kraken' && avg > 0 && (long > 0 || short > 0)) {
    const have = long > 0 ? Number(cur && cur.longQty || 0) : Number(cur && cur.shortQty || 0);
    const need = long > 0 ? long : short;
    if (!(have > need * 0.75)) {
      cur = long > 0
        ? { longQty: long, longCost: long * avg, shortQty: 0, shortCost: 0, basis: 'fill', at: Date.now() }
        : { longQty: 0, longCost: 0, shortQty: short, shortCost: short * avg, basis: 'fill', at: Date.now() };
      state.entry[sym] = cur;
      return cur;
    }
  }
  if (cur && (Number(cur.longQty) > 1e-10 || Number(cur.shortQty) > 1e-10)) return cur;
  if (!(long > 0 || short > 0) || !(mid > 0)) return cur || null;
  cur = long >= short
    ? { longQty: long, longCost: long * mid, shortQty: 0, shortCost: 0, basis: 'legacy', at: Date.now() }
    : { longQty: 0, longCost: 0, shortQty: short, shortCost: short * mid, basis: 'legacy', at: Date.now() };
  state.entry[sym] = cur;
  return cur;
}
function noteRail(state, mode, ml) {
  const prev = state.railMode || 'ok';
  if (mode === prev) return;
  if (mode === 'stop') console.log('RAIL margin-stop ml=' + ml);
  else if (mode === 'cut') console.log('RAIL margin-cut ml=' + ml);
  else if (mode === 'halt') console.log('RAIL halt ml=' + (ml == null ? '-' : ml));
  else if (prev === 'stop' || prev === 'cut' || prev === 'halt') console.log('RAIL exit-' + prev + ' ml=' + (ml == null ? '-' : ml));
  state.railMode = mode;
}

async function select(products, book, state) {
  const held = [];
  for (const [sym, pos] of Object.entries(book.positions || {})) {
    if (!(Number(pos.long) > 0 || Number(pos.short) > 0)) continue;
    if (state.skip && state.skip[sym]) continue;
    const rec = products[sym];
    if (!rec) continue;
    held.push({ ...rec, symbol: sym, orderPair: orderPairOf(rec, sym) });
  }
  if (held.length >= MAX_PAIRS) return held;
  const scan = await pullVenueScan(VENUE);
  const rank = new Map(((scan && scan.ranked) || []).map((r, i) => [String(r.symbol || r.pair || '').toUpperCase(), i]));
  const candidates = [];
  for (const [symbol, rec] of Object.entries(products)) {
    if (held.some((r) => r.symbol === symbol) || book.foreign.has(symbol) || (state.skip && state.skip[symbol])) continue;
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

async function syncSide(row, side, target, size, mine, state, lev, reduceOnly, budget, extra) {
  extra = extra || {};
  const cur = (mine || []).find((o) => o.side === side);
  const slot = state.orders[row.symbol] || {};
  const prev = side === 'buy' ? Number(slot.bidPx || 0) : Number(slot.askPx || 0);
  if (!(target > 0) || !(Number(size) > 0)) {
    if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
    if (side === 'buy') { slot.bid = null; slot.bidPx = 0; slot.bidSz = 0; } else { slot.ask = null; slot.askPx = 0; slot.askSz = 0; }
    state.orders[row.symbol] = slot;
    return;
  }
  const notional = Number(size) * target;
  if (side === 'buy' && !reduceOnly && budget && notional > budget.left + 1e-9) {
    console.log('  skip ' + row.symbol + ' cash $' + budget.left.toFixed(2));
    return;
  }
  if (cur && prev > 0 && Math.abs(prev - target) / target < 0.0015 && Math.abs(Number(side === 'buy' ? slot.bidSz : slot.askSz) - Number(size)) < 1e-8) {
    if (state.backoff) delete state.backoff[row.symbol];
    if (state.tooFar && state.tooFar[row.symbol] && state.tooFar[row.symbol].side === side) delete state.tooFar[row.symbol];
    return;
  }
  if (side === 'buy' && cur && budget) {
    const sz = Number(cur.size || slot.bidSz || 0);
    const px = Number(cur.price || prev || 0);
    if (sz > 0 && px > 0) budget.left += px * sz;
  }
  if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
  const clientOrderId = 'as-cb-' + randomUUID();
  console.log('  ' + side.toUpperCase() + ' ' + row.symbol + ' ' + size + ' @ ' + target + (lev ? ' ' + lev + 'x' : '') + (reduceOnly ? ' reduce' : '') + (extra.halfBps != null ? ' half=' + extra.halfBps + 'bp' : '') + (extra.floorTxt ? ' floor=' + extra.floorTxt : ''));
  if (extra.lossBps != null) console.log('EXIT LOSS ' + row.symbol + ' ' + extra.lossBps);
  if (!LIVE) return;
  const meta = { level: 1, userref: Number(USERREF), leverage: lev || 0, clientOrderId };
  if (reduceOnly) {
    meta.reduceOnly = true;
    if (Number(extra.positionQty) > 0) meta.positionQty = Number(extra.positionQty);
  }
  const paramsNote = VENUE === 'kraken' ? row.orderPair : row.pair;
  const r = await ex.limitOrder(paramsNote, side, target, size, meta, VENUE);
  if (r && r.order_id) {
    state.knownIds = state.knownIds || {};
    state.knownIds[r.order_id] = { sym: row.symbol, side };
    if (state.backoff) delete state.backoff[row.symbol];
    if (state.tooFar && state.tooFar[row.symbol] && state.tooFar[row.symbol].side === side) delete state.tooFar[row.symbol];
    if (state.stepAway) delete state.stepAway[row.symbol + ':' + side];
    if (side === 'buy') { slot.bid = r.order_id; slot.bidPx = target; slot.bidSz = size; if (budget && !reduceOnly) budget.left -= notional; }
    else { slot.ask = r.order_id; slot.askPx = target; slot.askSz = size; }
  } else {
    const why = (r && (r.error || r.skipped)) || 'no id';
    const reason = rejectReason(why);
    if (reason === 'too-far') {
      state.tooFar = state.tooFar || {};
      const prevFar = state.tooFar[row.symbol] || { n: 0 };
      state.tooFar[row.symbol] = { n: (Number(prevFar.n) || 0) + 1, px: target, side, at: Date.now(), touch: Number(extra.touch) || 0 };
    } else if (reason === 'below-min') markDust(state, row.symbol, target);
    else if (reason === 'post-only') {
      state.stepAway = state.stepAway || {};
      const key = row.symbol + ':' + side;
      state.stepAway[key] = (Number(state.stepAway[key]) || 0) + 1;
    }
    if (/unknown asset pair/i.test(String(why))) { state.skip = state.skip || {}; state.skip[row.symbol] = true; }
    console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + why);
    if (reason !== 'below-min' && reason !== 'too-far') armBackoff(state, row.symbol, reason);
    if (side === 'buy') slot.bid = null; else slot.ask = null;
  }
  state.orders[row.symbol] = slot;
}

async function cancelIds(orders) {
  if (!orders.length) return false;
  for (const o of orders) {
    console.log('  CANCEL open ' + o.sym + ' ' + o.side);
    if (LIVE) await ex.cancelOrder(o.id, VENUE);
  }
  if (!LIVE) return true;
  const ids = new Set(orders.map((o) => o.id));
  for (let i = 0; i < 5; i++) {
    await sleep(500);
    try {
      if (VENUE === 'kraken') {
        const open = await krakenOnce('OpenOrders', {});
        const still = Object.keys((open && open.open) || {}).some((id) => ids.has(id));
        if (!still) return true;
      } else {
        const live = await ex.listOpen(VENUE);
        const still = (live || []).some((o) => ids.has(o.order_id));
        if (!still) return true;
      }
    } catch { /* retry */ }
  }
  console.log('  CANCEL open wait timed out');
  return true;
}
async function cancelOpening(book) {
  const doomed = [];
  for (const [sym, orders] of Object.entries(book.mine || {})) {
    const pos = book.positions[sym] || {};
    const net = Number(pos.long || 0) - Number(pos.short || 0);
    for (const o of orders || []) if (opensRisk(net, o.side)) doomed.push(o);
  }
  return cancelIds(doomed);
}
async function cancelOurs(book) {
  const all = [];
  for (const orders of Object.values(book.mine || {})) all.push(...(orders || []));
  return cancelIds(all);
}

async function quoteSymbol(row, book, state, clip, addOk, budget, rail) {
  rail = rail || {};
  const s = await stats(row);
  if (!s) return null;
  const mid = s.mid;
  const pos = book.positions[row.symbol] || { long: 0, short: 0 };
  const net = (Number(pos.long || 0) - Number(pos.short || 0)) * mid;
  const q = clip > 0 ? net / clip : 0;
  const spreads = (state.spreads && state.spreads[row.symbol]) || [];
  if (s.bid > 0 && s.ask > s.bid) {
    spreads.push((s.ask - s.bid) / mid * 10000);
    while (spreads.length > 90) spreads.shift();
    state.spreads = state.spreads || {};
    state.spreads[row.symbol] = spreads;
  }
  const entry = ensureEntry(state, row.symbol, pos, mid);
  const legacy = !!(entry && entry.basis === 'legacy');
  const ageMs = entry && entry.at ? Date.now() - Number(entry.at) : 0;
  const longAvg = entryAvg(entry, 'long');
  const shortAvg = entryAvg(entry, 'short');
  const minH = halfFor(median(spreads));
  const model = asQuote({
    mid, q, sigma: s.sigma || 0.001, gamma: GAMMA, kappa: KAPPA, tau: TAU,
    minHalf: minH, maxHalf: Math.max(MAX_HALF, minH), maxShift: MAX_SHIFT,
  });
  if (!model) return null;
  const halfBps = Math.round(model.half * 10000);
  const inc = row.quoteIncrement || 0.01;
  const lossOk = !!(rail.lossOk || rail.mode === 'cut' || state.halted);
  let bidPx = snap(model.bid, inc, 'buy');
  let askPx = snap(model.ask, inc, 'sell');
  if (!(bidPx < mid)) bidPx = snap(mid - inc, inc, 'buy');
  if (!(askPx > mid)) askPx = snap(mid + inc, inc, 'sell');
  if (VENUE !== 'kraken' && Number(pos.long) > 0) {
    const touch = touchExit('sell', s.bid, s.ask, inc, 40);
    if (touch > 0) askPx = touch;
  }
  if (rail.forceTouch) {
    if (Number(pos.long) > 0 && s.ask > 0) askPx = s.ask;
    if (Number(pos.short) > 0 && s.bid > 0) bidPx = s.bid;
    const stepS = Number(state.stepAway && state.stepAway[row.symbol + ':sell'] || 0);
    const stepB = Number(state.stepAway && state.stepAway[row.symbol + ':buy'] || 0);
    if (stepS && Number(pos.long) > 0 && s.ask > 0) askPx = s.ask + stepS * inc;
    if (stepB && Number(pos.short) > 0 && s.bid > 0) bidPx = s.bid - stepB * inc;
  }
  const longFloor = longAvg > 0 ? exitBound({ entry: longAvg, side: 'long', feeBps: makerFeeBps, profitBps: PROFIT_BPS, touch: s.ask || mid, legacy, ageMs }) : 0;
  const shortCeil = shortAvg > 0 ? exitBound({ entry: shortAvg, side: 'short', feeBps: makerFeeBps, profitBps: PROFIT_BPS, touch: s.bid || mid, legacy, ageMs }) : 0;
  const hardLong = longAvg > 0 ? exitBound({ entry: longAvg, side: 'long', feeBps: makerFeeBps, profitBps: PROFIT_BPS }) : 0;
  const hardShort = shortAvg > 0 ? exitBound({ entry: shortAvg, side: 'short', feeBps: makerFeeBps, profitBps: PROFIT_BPS }) : 0;
  if (!lossOk) {
    if (Number(pos.long) > 0 && longFloor > 0) askPx = Math.max(askPx, longFloor);
    if (Number(pos.short) > 0 && shortCeil > 0) bidPx = Math.min(bidPx, shortCeil);
  }
  let blockSell = false;
  let blockBuy = false;
  let far = state.tooFar && state.tooFar[row.symbol];
  if (far && far.n >= 3) {
    const touch = far.side === 'sell' ? (s.ask || mid) : (s.bid || mid);
    const stuckAt = Number(far.touch) > 0 ? Number(far.touch) : Number(far.px);
    const unchanged = !(touch > 0) || (stuckAt > 0 && Math.abs(touch - stuckAt) / stuckAt < 0.001);
    if (unchanged) {
      if (far.side === 'sell') blockSell = true;
      else if (far.side === 'buy') blockBuy = true;
    } else {
      delete state.tooFar[row.symbol];
      far = null;
    }
  }
  if (far && far.n > 0 && far.n < 3) {
    if (far.side === 'sell' && !blockSell) {
      const touch = s.ask || mid;
      let next = far.n >= 2 ? touch : halveToward(far.px || askPx, touch, far.n);
      if (!legacy && !lossOk && hardLong > 0) next = Math.max(next, hardLong);
      askPx = next;
    } else if (far.side === 'buy' && !blockBuy) {
      const touch = s.bid || mid;
      let next = far.n >= 2 ? touch : halveToward(far.px || bidPx, touch, far.n);
      if (!legacy && !lossOk && hardShort > 0) next = Math.min(next, hardShort);
      bidPx = next;
    }
  }
  if (VENUE !== 'kraken' && mid > 0 && MAX_FROM_MID > 0) {
    const bandAsk = clampToBand(askPx, mid, MAX_FROM_MID);
    const bandBid = clampToBand(bidPx, mid, MAX_FROM_MID);
    if (legacy || lossOk || !(hardLong > 0) || bandAsk + 1e-12 >= hardLong) askPx = bandAsk;
    if (legacy || lossOk || !(hardShort > 0) || bandBid - 1e-12 <= hardShort) bidPx = bandBid;
    if (s.bid > 0 && askPx <= s.bid) askPx = s.bid + inc;
    if (s.ask > 0 && bidPx >= s.ask) bidPx = s.ask - inc;
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
  const reduce = !!rail.onRail || !!state.halted;
  const cut = rail.mode === 'cut';
  let buySz = 0; let sellSz = 0;
  const minUsd = Number(row.quoteMin || pos.quoteMin || 1);
  const lot = row.lotDecimals ?? 8;
  const frac = rail.halfSize || cut ? 0.5 : 1;
  const focusedOut = rail.focus && rail.focus !== row.symbol;
  if (!(focusedOut && reduce)) {
    if (reduce && (Number(pos.long) > 0 || Number(pos.short) > 0)) {
      if (Number(pos.long) > 0) sellSz = formatVolume(Number(pos.long) * frac, lot);
      if (Number(pos.short) > 0) buySz = formatVolume(Number(pos.short) * frac, lot);
    } else if (VENUE === 'coinbase') {
      if (Number(pos.long) > 0 && askPx * Number(pos.long) + 1e-9 >= minUsd) sellSz = formatVolume(Number(pos.long), lot);
      else if (Number(pos.long) > 0) markDust(state, row.symbol, mid);
      if (addOk && q < 0.95 && budget.left + 1e-9 >= minUsd && bidPx > 0) buySz = formatVolume(Math.min(clip, budget.left) / bidPx, lot);
    } else if (!reduce) {
      const cap = liqNotionalCap(book.equity, lev || 2, LIQ_MIN);
      const sz = Math.min(clip, cap) / mid;
      if (q < 0.95) buySz = formatVolume(Math.max(sz, Number(row.ordermin) || 0), lot);
      if (q > -0.95) sellSz = formatVolume(Math.max(sz, Number(row.ordermin) || 0), lot);
      if (buySz * bidPx > cap || sellSz * askPx > cap) {
        console.log('RAIL liq ' + row.symbol);
        if (buySz * bidPx > cap) buySz = 0;
        if (sellSz * askPx > cap) sellSz = 0;
      }
    }
  }
  if (blockSell) sellSz = 0;
  if (blockBuy) buySz = 0;
  if (VENUE !== 'kraken' && sellSz > 0 && askPx * sellSz + 1e-9 < minUsd) {
    markDust(state, row.symbol, mid);
    sellSz = 0;
  } else if (sellSz > 0 && state.belowMin) delete state.belowMin[row.symbol];
  const floorPx = Number(pos.long) > 0 ? longFloor : Number(pos.short) > 0 ? shortCeil : 0;
  const floorTxt = pxText(floorPx);
  const sellLoss = lossOk && hardLong > 0 && askPx + 1e-12 < hardLong ? Math.round((askPx / longAvg - 1) * 10000) : null;
  const buyLoss = lossOk && hardShort > 0 && bidPx - 1e-12 > hardShort ? Math.round((1 - bidPx / shortAvg) * 10000) : null;
  const posLev = Number(pos.lev) >= 2 ? Number(pos.lev) : 0;
  const buyLev = VENUE === 'kraken' ? (posLev || state.levOk[row.symbol + ':buy'] || lev) : 0;
  const sellLev = VENUE === 'kraken' ? (posLev || state.levOk[row.symbol + ':sell'] || lev) : 0;
  const mine = book.mine[row.symbol] || [];
  const quoteExtra = { halfBps, floorTxt };
  const quiet = backoffActive(state, row.symbol) && !rail.ignoreBackoff;
  if (!quiet && !(focusedOut && reduce)) {
    await syncSide(row, 'buy', buySz > 0 ? bidPx : 0, buySz, mine, state, buyLev, reduce && Number(pos.short) > 0, budget, { ...quoteExtra, positionQty: pos.short, lossBps: buyLoss, touch: s.bid });
    await syncSide(row, 'sell', sellSz > 0 ? askPx : 0, sellSz, mine, state, sellLev, reduce && Number(pos.long) > 0, budget, { ...quoteExtra, positionQty: pos.long, lossBps: sellLoss, touch: s.ask });
  }
  const slot = state.orders[row.symbol] || {};
  return {
    symbol: row.symbol, mid, q, lev: lev || posLev || 0,
    shiftBps: Math.round(-model.shift * 10000), halfBps, floor: floorPx, floorTxt,
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
  if (state.fillCount == null) state.fillCount = Object.keys(state.seenFills || {}).length;
  if (envBool('AS_RESUME', false)) { state.halted = null; state.haltSwept = false; }
  if (envBool('AS_NEW_SESSION', false) || !(state.startEquity > 0)) {
    state.startEquity = 0;
    state.startTime = new Date().toISOString();
    state.transfers = 0;
    state.makerCapture = 0;
    state.fees = 0;
    state.fundingBorrow = 0;
    state.equityMarks = [];
  }
  await loadMakerFee();
  let feeAt = Date.now();
  for (;;) {
    try {
      if (Date.now() - productsAt > 3600 * 1000) { products = await ex.getProducts(VENUE); productsAt = Date.now(); }
      if (Date.now() - feeAt > 3600 * 1000) { await loadMakerFee(); feeAt = Date.now(); }
      let book = VENUE === 'kraken' ? await krakenBook(state) : await coinbaseBook(state, products);
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
        state.halted = sessionLoss >= SESSION_LOSS ? 'session-loss' : 'day-loss';
        console.log('HALT ' + state.halted);
      }
      if (!state.halted && book.ml != null && book.ml < ML_HALT) {
        state.halted = 'margin-halt';
        console.log('HALT margin-halt ml=' + book.ml);
      }
      const wasOnRail = !!state.onRail;
      if (book.ml != null && book.ml < ML_STOP) state.onRail = true;
      if (book.ml == null || book.ml >= ML_RESUME) {
        if (wasOnRail && book.ml != null && book.ml >= ML_RESUME) console.log('RAIL resume ml=' + book.ml);
        state.onRail = false;
      }
      let mode = 'ok';
      if (state.halted) mode = 'halt';
      else if (book.ml != null && book.ml < ML_CUT) mode = 'cut';
      else if (book.ml != null && book.ml < ML_STOP) mode = 'stop';
      if (book.ml != null && book.ml < ML_CUT) state.cutLatch = true;
      if (book.ml == null || book.ml >= ML_STOP) state.cutLatch = false;
      noteRail(state, mode, book.ml);
      if (state.halted && !state.haltSwept) {
        await cancelOurs(book);
        state.haltSwept = true;
        book = VENUE === 'kraken' ? await krakenBook(state) : await coinbaseBook(state, products);
      } else if (state.onRail) {
        const cancelled = await cancelOpening(book);
        if (cancelled) book = VENUE === 'kraken' ? await krakenBook(state) : await coinbaseBook(state, products);
      }
      const rail = {
        mode, onRail: !!state.onRail || !!state.halted,
        forceTouch: mode === 'stop' || mode === 'cut' || mode === 'halt' || !!state.cutLatch,
        halfSize: mode === 'cut',
        ignoreBackoff: mode === 'cut' || mode === 'halt' || !!state.halted || !!state.cutLatch,
        lossOk: mode === 'cut' || mode === 'halt' || !!state.halted || !!state.cutLatch,
        focus: null,
      };
      if (mode === 'stop' && !state.cutLatch && maxBackoffN(state) >= 3 && !exitResting(book)) {
        rail.halfSize = true;
        rail.focus = largestSymbol(book.positions);
      }
      const addOk = !state.halted && !state.onRail;
      clearFlatEntry(state, book.positions);
      const seedMids = {};
      for (const [sym, p] of Object.entries(book.positions || {})) if (p.mid > 0) seedMids[sym] = p.mid;
      try { await pollFills(state, seedMids); } catch (e) { console.warn('fills', e.message); }
      const levGuess = VENUE === 'kraken' ? 5 : 1;
      const clip = clipFor(book.equity, levGuess);
      const chosen = await select(products, book, state);
      let budgetLeft = Number(book.cash || 0);
      if (VENUE === 'coinbase') {
        const reserved = restingBuyNotional(book.mine);
        budgetLeft = Math.max(0, budgetLeft + Number(book.quoteHold || 0) - reserved);
        let askCover = 0;
        for (const p of Object.values(book.positions || {})) {
          const qty = Number(p.long || 0);
          const px = Number(p.mid || 0);
          if (qty > 0 && px > 0 && qty * px + 1e-9 >= Number(p.quoteMin || 1)) askCover += qty * px;
        }
        const bidRoom = Math.max(0, BOOK_TARGET * Number(book.equity || 0) - askCover - reserved);
        budgetLeft = Math.min(budgetLeft, bidRoom);
      }
      const budget = { left: budgetLeft };
      const markets = [];
      const mids = {};
      for (const row of chosen) {
        const m = await quoteSymbol(row, book, state, clip, addOk, budget, rail);
        if (m) { markets.push(m); mids[m.symbol] = m.mid; }
        await sleep(150);
      }
      const heldSyms = Object.keys(book.positions || {}).filter((s) => {
        const p = book.positions[s];
        return Number(p.long || 0) > 0 || Number(p.short || 0) > 0;
      });
      state.symbols = [...new Set(markets.map((m) => m.symbol).concat(heldSyms))];
      try { await pollTransfers(state); } catch (e) { console.warn('ledgers', e.message); }
      const bySym = {};
      let marked = 0;
      for (const [sym, pos] of Object.entries(book.positions || {})) {
        const pnl = positionPnl(state.entry && state.entry[sym], { ...pos, mid: pos.mid || mids[sym] || 0 });
        if (Math.abs(pnl) > 1e-6) bySym[sym] = pnl;
        marked += pnl;
      }
      const equityAdj = book.equity - (state.startEquity || book.equity) - (state.transfers || 0);
      const inv = VENUE === 'kraken' ? (book.inventoryPnl || 0) : marked;
      const recon = equityAdj - ((state.makerCapture || 0) - (state.fees || 0) + inv - (state.fundingBorrow || 0));
      if (book.equity > 0 && Math.abs(recon) > Math.max(0.05, book.equity * 0.01) && now - (state.reconLogAt || 0) > 3600 * 1000) {
        const split = Object.entries(bySym).map(([s, v]) => s + '=' + v.toFixed(2)).join(' ');
        console.log('RECON ' + recon.toFixed(2) + (split ? ' ' + split : ''));
        state.reconLogAt = now;
      }
      const hour = now - 3600 * 1000;
      const fillsN = Number(state.fillCount) || 0;
      const fillsH = (state.fillTimes || []).filter((t) => t >= hour).length;
      state.fillTimes = (state.fillTimes || []).filter((t) => t >= hour);
      const levBySymbol = {};
      for (const m of markets) if (m.lev) levBySymbol[m.symbol] = m.lev;
      const dust = Object.keys(state.belowMin || {});
      let openNotional = 0;
      for (const m of markets) openNotional += bookNotional(m.orders);
      const bookFrac = book.equity > 0 ? openNotional / book.equity : 0;
      saveState(state);
      postStatus({
        bot: process.env.BOT, exchange: VENUE, quote: cfg.quote,
        pnl: {
          startEquity: state.startEquity, startTime: state.startTime, lastEquity: book.equity,
          transfers: state.transfers || 0, equityAdj, makerCapture: state.makerCapture || 0,
          fees: state.fees || 0, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
          recon, fills: fillsN, fillsHour: fillsH,
          netMaker: (state.makerCapture || 0) - (state.fees || 0), pricePnl: inv,
        },
        rails: {
          ml: book.ml, liqDistPct: LIQ_MIN * 100, sessionLossPct: sessionLoss * 100,
          dayLossPct: dayLoss * 100, halted: state.halted || null, levBySymbol, onRail: !!state.onRail,
        },
        bookFrac, dust, markets,
      });
      const line = markets.map((m) => m.symbol + ' q=' + m.q.toFixed(2) + ' half=' + m.halfBps + 'bp floor=' + (m.floorTxt || '-')).join(' ');
      console.log('  AS eq=$' + book.equity.toFixed(2) + ' free=$' + book.cash.toFixed(2) + ' adj=$' + equityAdj.toFixed(2) + ' maker=$' + (state.makerCapture || 0).toFixed(2) + ' fees=$' + (state.fees || 0).toFixed(2) + ' inv=$' + inv.toFixed(2) + ' fund=$' + (state.fundingBorrow || 0).toFixed(2) + ' fills=' + fillsN + '/' + fillsH + ' book=' + Math.round(bookFrac * 100) + '% lev=' + (Object.values(levBySymbol)[0] || 0) + ' ml=' + (book.ml == null ? '-' : book.ml) + ' | ' + (line || 'no names'));
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
