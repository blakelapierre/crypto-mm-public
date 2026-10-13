import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envNum, envBool, envStr } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { coinbaseRequest } from '../../shared/coinbase.js';
import { fetchLivePortfolio, invalidateLiveCache } from '../../shared/portfolio.js';
import { formatPrice, formatVolume } from '../../shared/sizing.js';
import { postStatus, postFill, pullVenueScan } from '../../shared/status-client.js';
import { refreshFeeTier } from '../../shared/fee-tier.js';
import { asQuote, realizedSigma, liqNotionalCap, halfSpread, exitBound, clampToBand, halveToward, backoffSec, feeToBps, applyEntry, entryAvg, opensRisk, touchExit, bookNotional, cashBudget, feeMul, takeBuyBudget, fitOpeningPair, notionalForCarry, holdExitPx, pnlResidual, inventoryMarkPnl, fillScore, unwindAsk, sentHalfBps, adaptiveHalf, exitLossNotional, gradualHoldExit, holdingClass } from './quote.js';

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
const MIN_HALF_BPS = envNum('MIN_HALF_BPS', 0);
const MAX_HOLD_MIN = envNum('AS_MAX_HOLD_MIN', 240);
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
const SIGMA_K = envNum('AS_SIGMA_K', 1.5);
const MAX_EXIT_LOSS = envNum('AS_MAX_EXIT_LOSS_PCT', 1.5) / 100;
const CLIP_CAP = envNum('CLIP_MAX_USD', 0);
const BOT_NAME = process.env.BOT || 'as';
let makerFeeBps = FEE_BPS;
const statePath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.json');
const lockPath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.lock');
const fillPath = path.join(process.cwd(), 'logs', 'fills-' + BOT_NAME + '.jsonl');
const ledgerPath = path.join(process.cwd(), 'logs', 'ledger-' + BOT_NAME + '.jsonl');
const markoutPath = path.join(process.cwd(), 'logs', 'markouts-' + BOT_NAME + '.jsonl');

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
function halfFor(spreadBps, sigma) {
  const floorBps = Math.max(makerFeeBps + PROFIT_BPS, MIN_HALF_BPS);
  return adaptiveHalf({
    feeBps: makerFeeBps,
    profitBps: Math.max(PROFIT_BPS, floorBps - makerFeeBps),
    sigma: Number(sigma) || 0,
    k: SIGMA_K,
    touchSpreadBps: Number(spreadBps) || 0,
    maxHalfBps: Math.max(MAX_HALF * 10000, floorBps),
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
  state.fillOrders = state.fillOrders || [];
  if (row.orderId) state.fillOrders.push(String(row.orderId));
  if (state.fillOrders.length > 2000) state.fillOrders.splice(0, state.fillOrders.length - 2000);
  state.markouts = state.markouts || [];
  state.markouts.push({
    id: row.venueFillId, symbol: row.symbol, side: row.side, price: row.price, size: row.size,
    time: row.time, fillMid: row.mid || row.price, fee: row.fee || 0,
  });
  fs.mkdirSync(path.dirname(fillPath), { recursive: true });
  fs.appendFileSync(fillPath, JSON.stringify(row) + '\n');
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
          posEffect: 'open', capture, mid,
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
      capture: (side === 'buy' ? mid - px : px - mid) * sz, mid,
    });
  }
}

function feeAlreadyOnFill(state, row) {
  const ids = [row && row.refid, row && row.ordertxid, row && row.tradeid].filter(Boolean).map(String);
  if (!ids.length) return false;
  const known = state.fillOrders || [];
  return ids.some((id) => known.includes(id));
}
function attributeCarry(state, row, usd, positions) {
  if (!(usd > 0)) return;
  state.carry = state.carry || {};
  const sym = symbolOf(row && row.asset);
  const t = Number(row && row.time) > 0 ? Number(row.time) * 1000 : Date.now();
  const bump = (slot) => {
    slot.usd += usd;
    if (!(slot.since > 0) || t < slot.since) slot.since = t;
  };
  if (sym && positions && positions[sym]) {
    const c = state.carry[sym] || { usd: 0, since: t };
    bump(c);
    state.carry[sym] = c;
    return;
  }
  state.carryAccount = state.carryAccount || { usd: 0, since: t, notional: 0 };
  bump(state.carryAccount);
}
function appendLedger(id, type, row) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify({ id, type, row }) + '\n');
}
function ingestLedger(state, id, type, row, positions) {
  state.seenLedgers = state.seenLedgers || {};
  state.ledgerWritten = state.ledgerWritten || {};
  if (!state.ledgerWritten[id]) {
    appendLedger(id, type, row);
    state.ledgerWritten[id] = true;
  }
  if (state.seenLedgers[id]) return;
  const amt = Number(row.amount || 0);
  const fee = Number(row.fee || 0);
  if (type === 'deposit' || type === 'withdrawal') {
    state.transfers = (state.transfers || 0) + amt;
    state.seenLedgers[id] = true;
    return;
  }
  if (type === 'rollover') {
    let carry = Math.abs(Math.min(0, amt));
    if (fee > 0 && Math.abs(fee - carry) > 1e-8) carry += fee;
    if (carry > 0) {
      state.fundingBorrow = (state.fundingBorrow || 0) + carry;
      attributeCarry(state, row, carry, positions);
    }
    state.seenLedgers[id] = true;
    return;
  }
  if (type !== 'margin') {
    state.seenLedgers[id] = true;
    return;
  }
  if (feeAlreadyOnFill(state, row)) {
    state.seenLedgers[id] = true;
    return;
  }
  const age = Date.now() / 1000 - Number(row.time || 0);
  if (fee > 0 && age < 600) return;
  if (fee > 0) {
    console.log('LEDGER orphan ' + (row.refid || id));
    state.fees = (state.fees || 0) + fee;
  }
  if (amt) state.ledgerPnl = (state.ledgerPnl || 0) + amt;
  state.seenLedgers[id] = true;
}
async function rememberTradeIds(state, start) {
  const known = new Set(state.fillOrders || []);
  for (let ofs = 0; ofs < 1000; ofs += 50) {
    let page;
    try { page = await krakenOnce('TradesHistory', { start, ofs }); }
    catch { break; }
    const trades = (page && page.trades) || {};
    const ids = Object.keys(trades);
    if (!ids.length) break;
    for (const [tid, t] of Object.entries(trades)) {
      known.add(String(tid));
      if (t && t.ordertxid) known.add(String(t.ordertxid));
    }
    if (ids.length < 50) break;
  }
  state.fillOrders = [...known].slice(-4000);
}
async function pollTransfers(state, positions) {
  if (VENUE !== 'kraken') return;
  const origin = Math.floor(Date.parse(state.startTime || new Date().toISOString()) / 1000) || Math.floor(Date.now() / 1000) - 86400;
  const start = state.fundingReplay ? origin : (state.ledgerCursor || origin);
  try { await rememberTradeIds(state, start); } catch { /* fills still match by order id */ }
  let sawRollover = !state.fundingReplay;
  for (const type of ['deposit', 'withdrawal', 'rollover', 'margin']) {
    if (state.fundingReplay && (type === 'deposit' || type === 'withdrawal')) continue;
    let page;
    try { page = await krakenOnce('Ledgers', { start, type }); }
    catch { continue; }
    if (type === 'rollover') sawRollover = true;
    for (const [id, row] of Object.entries((page && page.ledger) || {})) ingestLedger(state, id, type, row, positions);
  }
  state.ledgerCursor = Math.floor(Date.now() / 1000) - 60;
  if (sawRollover) state.fundingReplay = false;
}
function rebuildFillsFromLog(state) {
  let text = '';
  try { text = fs.readFileSync(fillPath, 'utf8'); } catch { return; }
  const seen = new Set();
  const orders = new Set(state.fillOrders || []);
  let fees = 0;
  let maker = 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const id = row.venueFillId ? String(row.venueFillId) : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (row.orderId) orders.add(String(row.orderId));
    fees += Number(row.fee) || 0;
    maker += Number(row.capture) || 0;
    n += 1;
  }
  state.fillOrders = [...orders].slice(-4000);
  if (n > 0) {
    state.fees = fees;
    state.makerCapture = maker;
    state.fillCount = n;
  }
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
    known[id] = { sym, side: rec.side, at: (known[id] && known[id].at) || Date.now() };
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
      known[o.order_id] = { sym, side: rec.side, at: (known[o.order_id] && known[o.order_id].at) || Date.now() };
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
    let bid = 0; let ask = 0; let vol = 0; let trades = 0;
    try {
      const t = await krakenPublic('Ticker', { pair: row.pair });
      const tk = t[row.pair] || t[row.altname] || Object.values(t).find((x) => x && x.c) || {};
      bid = Number((tk.b || [])[0] || 0);
      ask = Number((tk.a || [])[0] || 0);
      vol = Number((tk.v || [])[1] || (tk.v || [])[0] || 0) * mid;
      trades = Number((tk.t || [])[1] || (tk.t || [])[0] || 0);
    } catch { /* range still usable */ }
    return { mid, bid, ask, sigma: realizedSigma(closes), sigmaWarmup: closes.length < 8, range: mid > 0 ? (hi - lo) / mid : 0, vol, tradesPerHour: trades / 24 };
  }
  const book = await ex.getBook(row.pair, 'coinbase');
  if (!book || !(book.mid > 0)) return null;
  let sigma = 0;
  let sigmaWarmup = true;
  let range = MIN_RANGE;
  let tradesPerHour = 0;
  try {
    const end = Math.floor(Date.now() / 1000);
    const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/market/products/' + encodeURIComponent(row.pair) + '/candles?start=' + (end - 35 * 60) + '&end=' + end + '&granularity=ONE_MINUTE');
    const candles = data.candles || [];
    const closes = candles.map((c) => Number(c.close)).filter((n) => n > 0).reverse();
    if (closes.length >= 8) {
      sigma = realizedSigma(closes);
      sigmaWarmup = !(sigma > 0);
    }
    const win = candles.slice(0, 15);
    const hi = Math.max(...win.map((c) => Number(c.high)).filter((n) => n > 0));
    const lo = Math.min(...win.map((c) => Number(c.low)).filter((n) => n > 0));
    if (book.mid > 0 && hi > lo) range = (hi - lo) / book.mid;
    const volBase = win.reduce((s, c) => s + (Number(c.volume) || 0), 0);
    if (volBase > 0 && book.mid > 0) tradesPerHour = (volBase * book.mid) / Math.max(1, 15 / 60) / 1000;
  } catch { /* keep fallback */ }
  return { mid: book.mid, bid: book.bid, ask: book.ask, sigma, sigmaWarmup, range, vol: MIN_VOL, tradesPerHour };
}

function markDust(state, sym, mid) {
  state.belowMin = state.belowMin || {};
  state.belowMin[sym] = mid || state.belowMin[sym] || true;
}
function restingBuyNotional(mine) {
  const mul = feeMul(makerFeeBps);
  let n = 0;
  for (const orders of Object.values(mine || {})) {
    for (const o of orders || []) {
      if (o.side === 'buy') n += Number(o.price || 0) * Number(o.size || 0) * mul;
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
      const keptRealized = Number(cur && cur.realizedMark) || 0;
      cur = long > 0
        ? { longQty: long, longCost: long * avg, longMark: long * avg, shortQty: 0, shortCost: 0, shortMark: 0, basis: 'fill', at: (cur && cur.at) || Date.now(), realizedMark: keptRealized }
        : { longQty: 0, longCost: 0, longMark: 0, shortQty: short, shortCost: short * avg, shortMark: short * avg, basis: 'fill', at: (cur && cur.at) || Date.now(), realizedMark: keptRealized };
      state.entry[sym] = cur;
      return cur;
    }
  }
  if (cur && (Number(cur.longQty) > 1e-10 || Number(cur.shortQty) > 1e-10)) return cur;
  if (!(long > 0 || short > 0) || !(mid > 0)) return cur || null;
  cur = long >= short
    ? { longQty: long, longCost: long * mid, longMark: long * mid, shortQty: 0, shortCost: 0, shortMark: 0, basis: 'legacy', at: Date.now(), realizedMark: 0 }
    : { longQty: 0, longCost: 0, longMark: 0, shortQty: short, shortCost: short * mid, shortMark: short * mid, basis: 'legacy', at: Date.now(), realizedMark: 0 };
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
    if (VENUE !== 'kraken') {
      const klass = holdingClass({
        qty: Number(pos.long || 0),
        mid: Number(pos.mid || 0),
        minNotional: Number(pos.quoteMin || rec.quoteMin || 1),
        minSize: Number(rec.baseMin || rec.ordermin || 0),
      });
      if (klass === 'dust') {
        markDust(state, sym, Number(pos.mid || 0));
        continue;
      }
      if (state.belowMin) delete state.belowMin[sym];
    }
    held.push({ ...rec, symbol: sym, orderPair: orderPairOf(rec, sym) });
  }
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
      const needRange = 2 * (makerFeeBps + PROFIT_BPS) / 10000;
      if (s.range + 1e-12 < Math.max(MIN_RANGE, needRange)) {
        console.log('GATE ' + row.symbol + ' both vol');
        continue;
      }
      ranked.push({ ...row, range: s.range, spread, tradesPerHour: s.tradesPerHour || 0, needRange });
    } catch { /* skip */ }
    await sleep(80);
  }
  ranked.sort((a, b) => fillScore(b) - fillScore(a) || a.symbol.localeCompare(b.symbol));
  ranked.forEach((r, i) => { r.hot = i < 2; });
  for (const h of held) h.hot = (rank.get(h.symbol) ?? 99) < 2;
  return held.concat(ranked.slice(0, MAX_PAIRS));
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
  if (extra.hold && cur) {
    if (state.backoff) delete state.backoff[row.symbol];
    return;
  }
  if (side === 'buy' && !reduceOnly && budget && VENUE !== 'kraken') {
    const cost = notional * feeMul(makerFeeBps);
    const allowed = Number(extra.charged) || 0;
    if (!(allowed > 0) || cost > allowed + 1e-6) {
      budget.skipped = budget.skipped || {};
      if (!budget.skipped[row.symbol]) {
        budget.skipped[row.symbol] = true;
        console.log('SKIP ' + row.symbol + ' budget');
      }
      return;
    }
  }
  if (cur && prev > 0 && Math.abs(prev - target) / target < 0.0015 && Math.abs(Number(side === 'buy' ? slot.bidSz : slot.askSz) - Number(size)) < 1e-8) {
    if (state.backoff) delete state.backoff[row.symbol];
    if (state.tooFar && state.tooFar[row.symbol] && state.tooFar[row.symbol].side === side) delete state.tooFar[row.symbol];
    return;
  }
  if (cur && LIVE) await ex.cancelOrder(cur.id, VENUE);
  const clientOrderId = 'as-cb-' + randomUUID();
  const sigTxt = extra.sigmaBps != null ? ' sig=' + extra.sigmaBps + 'bp' : '';
  const distTxt = extra.distBps != null ? ' dist=' + extra.distBps + 'bp' : '';
  console.log('  ' + side.toUpperCase() + ' ' + row.symbol + ' ' + size + ' @ ' + target + (lev ? ' ' + lev + 'x' : '') + (reduceOnly ? ' reduce' : '') + (extra.halfBps != null ? ' half=' + extra.halfBps + 'bp' : '') + (extra.halfSrc ? ' half_src=' + extra.halfSrc : '') + sigTxt + distTxt + (extra.floorTxt ? ' floor=' + extra.floorTxt : ''));
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
    state.knownIds[r.order_id] = { sym: row.symbol, side, at: Date.now() };
    if (state.backoff) delete state.backoff[row.symbol];
    if (state.tooFar && state.tooFar[row.symbol] && state.tooFar[row.symbol].side === side) delete state.tooFar[row.symbol];
    if (state.stepAway) delete state.stepAway[row.symbol + ':' + side];
    if (side === 'buy') { slot.bid = r.order_id; slot.bidPx = target; slot.bidSz = size; }
    else { slot.ask = r.order_id; slot.askPx = target; slot.askSz = size; }
  } else {
    const why = (r && (r.error || r.skipped)) || 'no id';
    const reason = rejectReason(why);
    if (side === 'buy' && !reduceOnly && budget && extra.charged) {
      budget.left += Number(extra.charged) || 0;
      if (reason === 'funds') {
        invalidateLiveCache();
        state.budgetHalveUntil = Date.now() + 10 * 60 * 1000;
        budget.left *= 0.5;
        budget.shocked = true;
        console.log('BUDGET halve ' + row.symbol);
      }
    }
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

function carryBpsPerHour(state, sym, notional) {
  const c = state.carry && state.carry[sym];
  const n = Number(notional) || 0;
  if (c && c.usd > 0 && n > 0) {
    const hours = Math.max(1 / 60, (Date.now() - (c.since || Date.now())) / 3600000);
    return (c.usd / n) * 10000 / hours;
  }
  const acc = state.carryAccount;
  if (acc && acc.usd > 0) {
    const hours = Math.max(1 / 60, (Date.now() - (acc.since || Date.now())) / 3600000);
    const base = Number(acc.notional) > 0 ? Number(acc.notional) : n;
    if (base > 0) return (acc.usd / base) * 10000 / hours;
  }
  return 0;
}
function logHold(state, sym, ageMin, carryUsd) {
  state.holdLogAt = state.holdLogAt || {};
  if (Date.now() - (state.holdLogAt[sym] || 0) < 5 * 60 * 1000) return;
  state.holdLogAt[sym] = Date.now();
  console.log('HOLD ' + sym + ' ' + Math.round(ageMin) + ' carry=$' + Number(carryUsd || 0).toFixed(2));
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
  const plan = halfFor(median(spreads), s.sigmaWarmup ? 0 : s.sigma);
  const minH = plan.half;
  const model = asQuote({
    mid, q, sigma: s.sigmaWarmup ? 0 : (s.sigma || 0), gamma: GAMMA, kappa: KAPPA, tau: TAU,
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
  if (!rail.forceTouch) {
    const floorBid = snap(mid * (1 - plan.half), inc, 'buy');
    const floorAsk = snap(mid * (1 + plan.half), inc, 'sell');
    if (!(Number(pos.long) > 0)) bidPx = Math.min(bidPx, floorBid);
    if (!(Number(pos.short) > 0)) askPx = Math.max(askPx, floorAsk);
  }
  const tight = book.equity > 0 && Number(book.cash) < 0.25 * Number(book.equity);
  const legacyWindow = legacy && tight ? 6 * 3600 * 1000 : 24 * 3600 * 1000;
  if (VENUE !== 'kraken' && Number(pos.long) > 0 && s.ask > 0) {
    state.unwindAt = state.unwindAt || {};
    if (!state.unwindAt[row.symbol]) state.unwindAt[row.symbol] = Date.now();
    const walked = unwindAsk({ bid: s.bid, ask: s.ask, tick: inc, ageMs: Date.now() - state.unwindAt[row.symbol], windowMs: MAX_HOLD_MIN * 60 * 1000 });
    if (walked > 0) askPx = walked;
  } else if (state.unwindAt && state.unwindAt[row.symbol]) delete state.unwindAt[row.symbol];
  if (VENUE === 'kraken' && !rail.forceTouch) {
    if (Number(pos.long) > 0 && s.ask > 0) askPx = s.ask;
    if (Number(pos.short) > 0 && s.bid > 0) bidPx = s.bid;
  }
  if (rail.forceTouch) {
    if (Number(pos.long) > 0 && s.ask > 0) askPx = s.ask;
    if (Number(pos.short) > 0 && s.bid > 0) bidPx = s.bid;
    const stepS = Number(state.stepAway && state.stepAway[row.symbol + ':sell'] || 0);
    const stepB = Number(state.stepAway && state.stepAway[row.symbol + ':buy'] || 0);
    if (stepS && Number(pos.long) > 0 && s.ask > 0) askPx = s.ask + stepS * inc;
    if (stepB && Number(pos.short) > 0 && s.bid > 0) bidPx = s.bid - stepB * inc;
  }
  const longFloor = longAvg > 0 ? exitBound({ entry: longAvg, side: 'long', feeBps: makerFeeBps, profitBps: PROFIT_BPS, touch: s.ask || mid, legacy, ageMs, windowMs: legacyWindow }) : 0;
  const shortCeil = shortAvg > 0 ? exitBound({ entry: shortAvg, side: 'short', feeBps: makerFeeBps, profitBps: PROFIT_BPS, touch: s.bid || mid, legacy, ageMs, windowMs: legacyWindow }) : 0;
  const hardLong = longAvg > 0 ? exitBound({ entry: longAvg, side: 'long', feeBps: makerFeeBps, profitBps: PROFIT_BPS }) : 0;
  const hardShort = shortAvg > 0 ? exitBound({ entry: shortAvg, side: 'short', feeBps: makerFeeBps, profitBps: PROFIT_BPS }) : 0;
  if (!lossOk && !legacy) {
    if (Number(pos.long) > 0 && longFloor > 0) askPx = Math.max(askPx, longFloor);
    if (Number(pos.short) > 0 && shortCeil > 0) bidPx = Math.min(bidPx, shortCeil);
  }
  const ageMin = ageMs / 60000;
  const carryUsd = (state.carry && state.carry[row.symbol] && state.carry[row.symbol].usd) || 0;
  if (VENUE === 'kraken' && !lossOk && ageMin >= 0.75 * MAX_HOLD_MIN) {
    if (Number(pos.long) > 0 && longAvg > 0) {
      const px = gradualHoldExit({ entry: longAvg, side: 'long', feeBps: makerFeeBps, profitBps: PROFIT_BPS, carryPerUnit: carryUsd / Number(pos.long), ageMin, maxHoldMin: MAX_HOLD_MIN, touch: s.ask || mid, halfBps: plan.bps });
      if (px > 0) askPx = px;
      logHold(state, row.symbol, ageMin, carryUsd);
    }
    if (Number(pos.short) > 0 && shortAvg > 0) {
      const px = gradualHoldExit({ entry: shortAvg, side: 'short', feeBps: makerFeeBps, profitBps: PROFIT_BPS, carryPerUnit: carryUsd / Number(pos.short), ageMin, maxHoldMin: MAX_HOLD_MIN, touch: s.bid || mid, halfBps: plan.bps });
      if (px > 0) bidPx = px;
      logHold(state, row.symbol, ageMin, carryUsd);
    }
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
      const klass = holdingClass({ qty: Number(pos.long) || 0, mid, minNotional: minUsd, minSize: Number(row.baseMin || row.ordermin || 0) });
      if (klass === 'inventory') {
        sellSz = formatVolume(Number(pos.long), lot);
        if (state.belowMin) delete state.belowMin[row.symbol];
      } else if (Number(pos.long) > 0) {
        markDust(state, row.symbol, mid);
      }
      const floorUsd = Math.max(CLIP_CAP || 0, minUsd * 1.2);
      const slots = Math.max(1, Number(budget && budget.slots) || MAX_PAIRS);
      const left = Math.max(0, Number(budget && budget.left) || 0);
      const wantUsd = Math.min(left, Math.max(left / slots, floorUsd));
      if (addOk && q < 0.95 && bidPx > 0 && wantUsd > 0) buySz = formatVolume(wantUsd / bidPx, lot);
      if (budget) budget.slots = Math.max(1, slots - 1);
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
  const posLev = Number(pos.lev) >= 2 ? Number(pos.lev) : 0;
  const buyLev = VENUE === 'kraken' ? (posLev || state.levOk[row.symbol + ':buy'] || lev) : 0;
  const sellLev = VENUE === 'kraken' ? (posLev || state.levOk[row.symbol + ':sell'] || lev) : 0;
  const mine = book.mine[row.symbol] || [];
  const klassNow = holdingClass({ qty: Number(pos.long) || 0, mid, minNotional: minUsd, minSize: Number(row.baseMin || row.ordermin || 0) });
  if (klassNow === 'inventory' && state.belowMin) delete state.belowMin[row.symbol];
  if (VENUE !== 'kraken' && sellSz > 0 && askPx * sellSz + 1e-9 < minUsd) {
    markDust(state, row.symbol, mid);
    sellSz = 0;
  } else if (sellSz > 0 && state.belowMin && klassNow === 'inventory') delete state.belowMin[row.symbol];
  const gates = [];
  const gate = (side, why) => gates.push(side + ' ' + why);
  const netQty = Number(pos.long || 0) - Number(pos.short || 0);
  const hasPos = Number(pos.long || 0) > 0 || Number(pos.short || 0) > 0;
  if (reduce && hasPos) {
    const why = state.halted || rail.mode === 'halt' ? 'halt' : rail.mode === 'cut' ? 'cut' : 'stop';
    if (!(Number(pos.short) > 0)) gate('buy', why);
    if (!(Number(pos.long) > 0)) gate('sell', why);
  }
  if (VENUE === 'kraken' && !reduce && hasPos) {
    if (buySz > 0 && opensRisk(netQty, 'buy')) { buySz = 0; gate('buy', 'carry'); }
    if (sellSz > 0 && opensRisk(netQty, 'sell')) { sellSz = 0; gate('sell', 'carry'); }
  }
  if (s.sigmaWarmup) {
    if (buySz > 0 && opensRisk(netQty, 'buy')) { buySz = 0; gate('buy', 'vol-warmup'); }
    if (sellSz > 0 && opensRisk(netQty, 'sell')) { sellSz = 0; gate('sell', 'vol-warmup'); }
  } else if (s.range > 0 && model.half > 2 * s.range) {
    if (buySz > 0 && opensRisk(netQty, 'buy')) { buySz = 0; gate('buy', 'vol'); }
    if (sellSz > 0 && opensRisk(netQty, 'sell')) { sellSz = 0; gate('sell', 'vol'); }
  }
  if (VENUE !== 'kraken' && tight && buySz > 0 && (!hasPos || !row.hot)) {
    buySz = 0;
    gate('buy', 'budget');
  }
  if (VENUE === 'kraken' && !reduce) {
    const rateN = Math.max(buySz * bidPx, sellSz * askPx, Number(pos.value) || Math.abs(net));
    const rate = carryBpsPerHour(state, row.symbol, rateN);
    const ordermin = Number(row.ordermin) || 0;
    if (buySz > 0 && opensRisk(netQty, 'buy')) {
      const n = notionalForCarry({ notional: buySz * bidPx, holdMin: MAX_HOLD_MIN, bpsPerHour: rate, profitBps: PROFIT_BPS, minNotional: Math.max(minUsd, ordermin * bidPx) });
      if (!(n > 0)) { buySz = 0; gate('buy', 'carry'); }
      else buySz = formatVolume(n / bidPx, lot);
    }
    if (sellSz > 0 && opensRisk(netQty, 'sell')) {
      const n = notionalForCarry({ notional: sellSz * askPx, holdMin: MAX_HOLD_MIN, bpsPerHour: rate, profitBps: PROFIT_BPS, minNotional: Math.max(minUsd, ordermin * askPx) });
      if (!(n > 0)) { sellSz = 0; gate('sell', 'carry'); }
      else sellSz = formatVolume(n / askPx, lot);
    }
    const lossCap = exitLossNotional({ equity: book.equity, feeBps: makerFeeBps, sigma: s.sigmaWarmup ? 0 : s.sigma, holdMin: MAX_HOLD_MIN, maxLossPct: MAX_EXIT_LOSS });
    let sizeSrc = s.sigma > 0 && !s.sigmaWarmup ? 'vol' : 'margin';
    if (buySz > 0 && opensRisk(netQty, 'buy') && bidPx > 0 && lossCap > 0 && buySz * bidPx > lossCap + 1e-9) {
      buySz = formatVolume(lossCap / bidPx, lot);
      sizeSrc = 'exit';
    }
    if (sellSz > 0 && opensRisk(netQty, 'sell') && askPx > 0 && lossCap > 0 && sellSz * askPx > lossCap + 1e-9) {
      sellSz = formatVolume(lossCap / askPx, lot);
      sizeSrc = 'exit';
    }
    if (rail.margin) {
      const buyOpen = buySz > 0 && opensRisk(netQty, 'buy');
      const sellOpen = sellSz > 0 && opensRisk(netQty, 'sell');
      const beforeBuy = buyOpen ? buySz * bidPx : 0;
      const beforeSell = sellOpen ? sellSz * askPx : 0;
      const slotsNeed = (buyOpen ? 1 : 0) + (sellOpen ? 1 : 0);
      const slots = Math.max(slotsNeed, rail.margin.slots || slotsNeed || 1);
      const maxUsed = book.equity > 0 ? book.equity / (ML_RESUME / 100) : 0;
      const roomMargin = Math.max(0, maxUsed - rail.margin.used);
      const allow = slots > 0 ? roomMargin * (slotsNeed / slots) : 0;
      const fit = fitOpeningPair({
        equity: book.equity,
        usedMargin: Math.max(0, maxUsed - allow),
        resume: ML_RESUME,
        buy: { notional: buyOpen ? buySz * bidPx : 0, lev: buyLev || lev || 2, opening: buyOpen },
        sell: { notional: sellOpen ? sellSz * askPx : 0, lev: sellLev || lev || 2, opening: sellOpen },
      });
      if (buyOpen) {
        const minN = Math.max(minUsd, ordermin * bidPx);
        if (!(fit.buy + 1e-9 >= minN) || !(bidPx > 0)) { buySz = 0; gate('buy', 'budget'); }
        else buySz = formatVolume(fit.buy / bidPx, lot);
      }
      if (sellOpen) {
        const minN = Math.max(minUsd, ordermin * askPx);
        if (!(fit.sell + 1e-9 >= minN) || !(askPx > 0)) { sellSz = 0; gate('sell', 'budget'); }
        else sellSz = formatVolume(fit.sell / askPx, lot);
      }
      const usedAdd = (buySz > 0 && buyOpen ? (buySz * bidPx) / (buyLev || lev || 2) : 0)
        + (sellSz > 0 && sellOpen ? (sellSz * askPx) / (sellLev || lev || 2) : 0);
      rail.margin.used += usedAdd;
      rail.margin.slots = Math.max(0, slots - slotsNeed);
      const afterBuy = buyOpen ? buySz * bidPx : 0;
      const afterSell = sellOpen ? sellSz * askPx : 0;
      if (afterBuy + 1e-6 < beforeBuy || afterSell + 1e-6 < beforeSell) sizeSrc = 'margin';
      const usedN = Math.max(afterBuy, afterSell);
      if (usedN > 0) console.log('SIZE ' + row.symbol + ' lev=max used=' + usedN.toFixed(2) + ' cap=' + sizeSrc);
    }
  }
  let buyHold = false;
  let buyCharged = 0;
  let skipBuySend = false;
  if (VENUE !== 'kraken' && !reduce && buySz > 0 && bidPx > 0) {
    const curBuy = mine.find((o) => o.side === 'buy');
    const curN = curBuy ? Number(curBuy.price) * Number(curBuy.size) : 0;
    const slotNow = state.orders[row.symbol] || {};
    const same = !!(curBuy && Number(slotNow.bidPx) > 0 && Math.abs(Number(slotNow.bidPx) - bidPx) / bidPx < 0.0015 && Math.abs(Number(slotNow.bidSz) - buySz) < 1e-8);
    const taken = takeBuyBudget(budget.left, {
      price: bidPx, wantSize: buySz, curNotional: curN, feeBps: makerFeeBps,
      minNotional: minUsd, minSize: Number(row.baseMin || row.ordermin || 0), lot, same,
    });
    budget.left = taken.budgetLeft;
    if (taken.skip) {
      buySz = 0;
      skipBuySend = true;
      gate('buy', 'budget');
      if (!budget.skipped || !budget.skipped[row.symbol]) {
        budget.skipped = budget.skipped || {};
        budget.skipped[row.symbol] = true;
        console.log('SKIP ' + row.symbol + ' budget');
      }
    } else if (taken.send) {
      buySz = taken.size;
      buyCharged = taken.cost;
    } else buyHold = true;
  }
  const sentHalf = sentHalfBps(mid, buySz > 0 ? bidPx : 0, sellSz > 0 ? askPx : 0);
  const halfShown = sentHalf || Math.round(plan.bps);
  const floorPx = Number(pos.long) > 0 ? longFloor : Number(pos.short) > 0 ? shortCeil : 0;
  const floorTxt = pxText(floorPx);
  const sellLoss = lossOk && hardLong > 0 && askPx + 1e-12 < hardLong ? Math.round((askPx / longAvg - 1) * 10000) : null;
  const buyLoss = lossOk && hardShort > 0 && bidPx - 1e-12 > hardShort ? Math.round((1 - bidPx / shortAvg) * 10000) : null;
  const sigmaBps = s.sigmaWarmup ? null : Math.round((s.sigma || 0) * 10000);
  const quoteExtra = { halfBps: halfShown, halfSrc: plan.src, floorTxt, sigmaBps };
  const quiet = backoffActive(state, row.symbol) && !rail.ignoreBackoff;
  if (quiet) { gate('buy', 'backoff'); gate('sell', 'backoff'); }
  for (const g of gates) console.log('GATE ' + row.symbol + ' ' + g);
  const buyJob = { row, side: 'buy', target: buySz > 0 ? bidPx : 0, size: buySz, mine, lev: buyLev, reduceOnly: reduce && Number(pos.short) > 0, extra: { ...quoteExtra, positionQty: pos.short, lossBps: buyLoss, touch: s.bid, distBps: mid > 0 && s.bid > 0 ? Math.round(Math.abs(bidPx - s.bid) / mid * 10000) : 0, charged: buyCharged, hold: buyHold } };
  const sellJob = { row, side: 'sell', target: sellSz > 0 ? askPx : 0, size: sellSz, mine, lev: sellLev, reduceOnly: reduce && Number(pos.long) > 0, extra: { ...quoteExtra, positionQty: pos.long, lossBps: sellLoss, touch: s.ask, distBps: mid > 0 && s.ask > 0 ? Math.round(Math.abs(askPx - s.ask) / mid * 10000) : 0 } };
  if (!quiet && !(focusedOut && reduce)) {
    if (rail.defer) {
      rail.defer.sells.push(sellJob);
      if (!skipBuySend) rail.defer.buys.push(buyJob);
    } else {
      await syncSide(row, 'sell', sellJob.target, sellJob.size, mine, state, sellLev, sellJob.reduceOnly, budget, sellJob.extra);
      if (!skipBuySend) await syncSide(row, 'buy', buyJob.target, buyJob.size, mine, state, buyLev, buyJob.reduceOnly, budget, buyJob.extra);
    }
  }
  const slot = state.orders[row.symbol] || {};
  return {
    symbol: row.symbol, mid, q, lev: lev || posLev || 0, sigmaBps,
    shiftBps: Math.round(-model.shift * 10000), halfBps: halfShown, halfSrc: plan.src, floor: floorPx, floorTxt,
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
function usedMargin(book) {
  let used = 0;
  for (const p of Object.values(book.positions || {})) {
    if (Number(p.margin) > 0) used += Number(p.margin);
    else if (Number(p.lev) >= 2 && Number(p.value) > 0) used += Number(p.value) / Number(p.lev);
  }
  if (!(used > 0) && book.ml > 0 && book.equity > 0 && book.ml < 1e6) used = book.equity / (book.ml / 100);
  return used;
}
function openBookNotional(state, book) {
  let n = 0;
  const seen = new Set();
  for (const [sym, slot] of Object.entries(state.orders || {})) {
    if (slot && slot.bid && slot.bidPx > 0 && slot.bidSz > 0) { n += slot.bidPx * slot.bidSz; seen.add(sym + ':buy'); }
    if (slot && slot.ask && slot.askPx > 0 && slot.askSz > 0) { n += slot.askPx * slot.askSz; seen.add(sym + ':sell'); }
  }
  for (const [sym, orders] of Object.entries((book && book.mine) || {})) {
    for (const o of orders || []) {
      if (seen.has(sym + ':' + o.side)) continue;
      n += Number(o.price || 0) * Number(o.size || 0);
    }
  }
  return n;
}
function markoutAvg(state, key) {
  const xs = (state.markouts || []).map((m) => Number(m[key])).filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}
function updateMarkouts(state, mids) {
  const now = Date.now();
  let changed = false;
  for (const m of state.markouts || []) {
    const mid = Number(mids[m.symbol] || 0);
    const base = Number(m.fillMid || m.price || 0);
    if (!(mid > 0) || !(base > 0)) continue;
    const age = (now - Date.parse(m.time || 0)) / 60000;
    const fav = (String(m.side) === 'buy' ? mid - base : base - mid) / base * 10000;
    for (const [key, min] of [['m1', 1], ['m5', 5], ['m15', 15]]) {
      if (age + 1e-9 >= min && m[key] == null) { m[key] = fav; changed = true; }
    }
  }
  if ((state.markouts || []).length > 400) state.markouts.splice(0, state.markouts.length - 400);
  if (!changed) return;
  try {
    fs.mkdirSync(path.dirname(markoutPath), { recursive: true });
    fs.appendFileSync(markoutPath, JSON.stringify({ ts: new Date().toISOString(), m5: markoutAvg(state, 'm5') }) + '\n');
  } catch { /* keep going */ }
}
function pruneState(state, book, now) {
  const open = new Set();
  for (const orders of Object.values((book && book.mine) || {})) {
    for (const o of orders || []) if (o && o.id) open.add(o.id);
  }
  const cutoff = now - 24 * 3600 * 1000;
  state.execAt = state.execAt || {};
  for (const id of Object.keys(state.exec || {})) {
    if (open.has(id)) state.execAt[id] = now;
    else if ((state.execAt[id] || 0) < cutoff) {
      delete state.exec[id];
      delete state.execAt[id];
    }
  }
  for (const id of Object.keys(state.knownIds || {})) {
    if (!open.has(id) && (state.execAt[id] || 0) < cutoff && !(state.knownIds[id] && state.knownIds[id].at > cutoff)) delete state.knownIds[id];
  }
  for (const sym of Object.keys(state.orders || {})) {
    const pos = book.positions && book.positions[sym];
    const held = pos && (Number(pos.long) > 0 || Number(pos.short) > 0);
    const mine = book.mine && book.mine[sym];
    if (!held && !(mine && mine.length)) delete state.orders[sym];
  }
  if (state.seenFunding) {
    const ids = Object.keys(state.seenFunding);
    if (ids.length > 2000) {
      for (const id of ids.slice(0, ids.length - 2000)) delete state.seenFunding[id];
    }
  }
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
    state.pnlModel = 3;
  }
  if (state.pnlModel !== 4) {
    state.fundingBorrow = 0;
    state.carry = {};
    state.carryAccount = { usd: 0, since: Date.now(), notional: 0 };
    state.ledgerPnl = 0;
    state.seenLedgers = {};
    state.fundingReplay = true;
    state.needPnlBasis = true;
    state.pnlModel = 4;
    rebuildFillsFromLog(state);
    console.log('PNL ledger model 4, funding is rollover only');
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
        defer: { sells: [], buys: [] },
        margin: { used: usedMargin(book), slots: MAX_PAIRS * 2 },
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
      try { await pollTransfers(state, book.positions); } catch (e) { console.warn('ledgers', e.message); }
      const levGuess = VENUE === 'kraken' ? 5 : 1;
      const clip = clipFor(book.equity, levGuess);
      const chosen = await select(products, book, state);
      const halve = now < (state.budgetHalveUntil || 0);
      let budgetLeft = Number(book.cash || 0);
      if (VENUE === 'coinbase') {
        const heldBuys = restingBuyNotional(book.mine);
        const reserve = Math.max(Number(book.equity || 0) * 0.01, 0.1);
        budgetLeft = cashBudget({ free: book.cash, restingCost: heldBuys, equity: book.equity, halve, netOfHolds: true });
        let askCover = 0;
        for (const p of Object.values(book.positions || {})) {
          const qty = Number(p.long || 0);
          const px = Number(p.mid || 0);
          if (holdingClass({ qty, mid: px, minNotional: Number(p.quoteMin || 1) }) === 'inventory') askCover += qty * px;
        }
        const bidRoom = Math.max(0, BOOK_TARGET * Number(book.equity || 0) - askCover);
        budgetLeft = Math.min(budgetLeft, bidRoom);
        console.log('BUDGET free=' + Number(book.cash || 0).toFixed(2) + ' held=' + heldBuys.toFixed(2) + ' reserve=' + reserve.toFixed(2) + ' → b=' + budgetLeft.toFixed(2));
      }
      const budget = { left: Math.max(0, budgetLeft), slots: MAX_PAIRS };
      const markets = [];
      const mids = {};
      for (const row of chosen) {
        const m = await quoteSymbol(row, book, state, clip, addOk, budget, rail);
        if (m) { markets.push(m); mids[m.symbol] = m.mid; }
        await sleep(150);
      }
      for (const job of rail.defer.sells) {
        await syncSide(job.row, job.side, job.target, job.size, job.mine, state, job.lev, job.reduceOnly, budget, job.extra);
      }
      for (const job of rail.defer.buys) {
        await syncSide(job.row, job.side, job.target, job.size, job.mine, state, job.lev, job.reduceOnly, budget, job.extra);
        if (budget.shocked && VENUE === 'coinbase') {
          invalidateLiveCache();
          try { book = await coinbaseBook(state, products); } catch { /* keep */ }
          budget.left = cashBudget({ free: book.cash, restingCost: restingBuyNotional(book.mine), equity: book.equity, halve: true, netOfHolds: true });
          budget.shocked = false;
        }
      }
      for (const m of markets) {
        const slot = state.orders[m.symbol] || {};
        m.bids = slot.bid ? 1 : 0;
        m.asks = slot.ask ? 1 : 0;
        m.orders = [
          slot.bid ? { side: 'buy', price: slot.bidPx, size: slot.bidSz, status: 'open' } : null,
          slot.ask ? { side: 'sell', price: slot.askPx, size: slot.askSz, status: 'open' } : null,
        ].filter(Boolean);
      }
      const heldSyms = Object.keys(book.positions || {}).filter((s) => {
        const p = book.positions[s];
        return Number(p.long || 0) > 0 || Number(p.short || 0) > 0;
      });
      state.symbols = [...new Set(markets.map((m) => m.symbol).concat(heldSyms))];
      const bySym = {};
      let marked = 0;
      let notion = 0;
      let dustUsd = 0;
      let dustN = 0;
      let invUsd = 0;
      let invN = 0;
      for (const [sym, pos] of Object.entries(book.positions || {})) {
        const mid = pos.mid || mids[sym] || 0;
        const entry = ensureEntry(state, sym, pos, mid);
        const pnl = inventoryMarkPnl(entry, { ...pos, mid });
        if (Math.abs(pnl) > 1e-6) bySym[sym] = pnl;
        marked += pnl;
        const qty = Math.abs(Number(pos.long || 0) - Number(pos.short || 0));
        const usd = qty > 0 && mid > 0 ? qty * mid : Number(pos.value || pos.usd || 0);
        notion += usd;
        const klass = holdingClass({ qty, mid, minNotional: Number(pos.quoteMin || 1), minSize: Number(pos.baseMin || 0) });
        if (klass === 'dust') { dustUsd += usd; dustN += 1; }
        else if (usd > 0) { invUsd += usd; invN += 1; }
      }
      updateMarkouts(state, mids);
      if (state.carryAccount) state.carryAccount.notional = notion;
      const netMaker = (state.makerCapture || 0) - (state.fees || 0);
      if (state.needPnlBasis && book.equity > 0) {
        const gap = pnlResidual({
          equity: book.equity, startEquity: state.startEquity || book.equity, transfers: state.transfers || 0,
          netMaker, inventoryPnl: marked, fundingBorrow: state.fundingBorrow || 0,
        });
        state.markBasis = gap;
        state.needPnlBasis = false;
        console.log('PNL basis $' + gap.toFixed(2));
      }
      const inv = marked + (Number(state.markBasis) || 0) + (Number(state.ledgerPnl) || 0);
      const equityAdj = book.equity - (state.startEquity || book.equity) - (state.transfers || 0);
      const resid = pnlResidual({
        equity: book.equity, startEquity: state.startEquity || book.equity, transfers: state.transfers || 0,
        netMaker, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
      });
      if (book.equity > 0 && Math.abs(resid) > 0.02 && now - (state.reconLogAt || 0) > 3600 * 1000) {
        const m5 = markoutAvg(state, 'm5');
        console.log('RECON resid=' + resid.toFixed(2) + ' dust=$' + dustUsd.toFixed(2) + ' inv=$' + inv.toFixed(2) + ' fund=$' + (state.fundingBorrow || 0).toFixed(2) + ' fees=$' + (state.fees || 0).toFixed(2) + ' markout5=' + (m5 == null ? '-' : m5.toFixed(1)));
        state.reconLogAt = now;
      }
      const hour = now - 3600 * 1000;
      const fillsN = Number(state.fillCount) || 0;
      const fillsH = (state.fillTimes || []).filter((t) => t >= hour).length;
      state.fillTimes = (state.fillTimes || []).filter((t) => t >= hour);
      const levBySymbol = {};
      for (const m of markets) if (m.lev) levBySymbol[m.symbol] = m.lev;
      const dust = Object.keys(state.belowMin || {});
      const openNotional = openBookNotional(state, book);
      const bookFrac = book.equity > 0 ? openNotional / book.equity : 0;
      pruneState(state, book, now);
      saveState(state);
      postStatus({
        bot: process.env.BOT, exchange: VENUE, quote: cfg.quote,
        pnl: {
          startEquity: state.startEquity, startTime: state.startTime, lastEquity: book.equity,
          transfers: state.transfers || 0, equityAdj, makerCapture: state.makerCapture || 0,
          fees: state.fees || 0, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
          recon: resid, resid, fills: fillsN, fillsHour: fillsH,
          netMaker, pricePnl: inv,
        },
        rails: {
          ml: book.ml, liqDistPct: LIQ_MIN * 100, sessionLossPct: sessionLoss * 100,
          dayLossPct: dayLoss * 100, halted: state.halted || null, levBySymbol, onRail: !!state.onRail,
        },
        bookFrac, dust, markets,
      });
      const line = markets.map((m) => m.symbol + ' q=' + m.q.toFixed(2) + ' half=' + m.halfBps + 'bp' + (m.halfSrc ? '/' + m.halfSrc : '') + ' sig=' + (m.sigmaBps == null ? 'warmup' : m.sigmaBps + 'bp') + ' floor=' + (m.floorTxt || '-')).join(' ');
      console.log('  AS eq=$' + book.equity.toFixed(2) + ' free=$' + book.cash.toFixed(2) + ' adj=$' + equityAdj.toFixed(2) + ' maker=$' + (state.makerCapture || 0).toFixed(2) + ' fees=$' + (state.fees || 0).toFixed(2) + ' inv=$' + invUsd.toFixed(2) + ' (' + invN + ') dust=$' + dustUsd.toFixed(2) + ' (' + dustN + ') fund=$' + (state.fundingBorrow || 0).toFixed(2) + ' resid=$' + resid.toFixed(2) + ' fills=' + fillsN + '/' + fillsH + ' book=' + Math.round(bookFrac * 100) + '% lev=' + (Object.values(levBySymbol)[0] || 0) + ' ml=' + (book.ml == null ? '-' : book.ml) + ' | ' + (line || 'no names'));
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
