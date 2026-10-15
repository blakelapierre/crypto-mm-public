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
import { asQuote, realizedSigma, liqNotionalCap, halfSpread, exitBound, clampToBand, halveToward, backoffSec, feeToBps, applyEntry, entryAvg, opensRisk, touchExit, bookNotional, cashBudget, feeMul, takeBuyBudget, fitOpeningPair, notionalForCarry, holdExitPx, pnlResidual, inventoryMarkPnl, fillScore, unwindAsk, sentHalfBps, adaptiveHalf, exitLossNotional, gradualHoldExit, holdingClass, openingMinHalfBps, costFloorPx, posEffectOf, riskAllowsLoss, stepToward, roundUpReduce, rankByNetEdge, haltPhase, haltTimeoutPx, haltExitBound, widenOpenDecision, openGateWhy, unexplainedJump, dustTopupUsd, bookSlots, openClipUsd, tradableBookTarget, positionAboveMin, roundTripPadBps, roundTripFloorPx, oppositeFloorPx, edgeGate, riskExempt, roundTripNet, pairCooldownMs, churnSignal, lifetimePct, lifetimeHalt, lifeText, resetAllowed, leverageNotch, rankByExpectedEdge, cbTransferAllowed, transferUsd, pendingTrigger, haltRiskAction, bookSlotsScaled, slotClipUsd, idleRelax } from './quote.js';

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
const MAX_SPREAD = envNum('SCAN_MAX_SPREAD_BPS', 250) / 10000;
const SCAN_EVAL_N = Math.max(1, envNum('SCAN_EVAL_N', 40));
const SCAN_TARGET_VOL = envNum('SCAN_TARGET_VOL24_USD', 1000000);
const FEE_BPS = envNum('MAKER_FEE_BPS', VENUE === 'kraken' ? 16 : 40);
const PROFIT_BPS = envNum('AS_PROFIT_BPS', 10);
const ML_HALT = envNum('AS_MARGIN_LEVEL_HALT', 150);
const ML_RESUME = envNum('AS_MARGIN_LEVEL_RESUME', 350);
const MAX_FROM_MID = envNum('AS_MAX_FROM_MID', 0.02);
const SIGMA_K = envNum('AS_SIGMA_K', 1.5);
const MAX_EXIT_LOSS = envNum('AS_MAX_EXIT_LOSS_PCT', 1.5) / 100;
const CLIP_CAP = envNum('CLIP_MAX_USD', 0);
const FEE_BUFFER = envNum('AS_FEE_BUFFER_BPS', 6);
const MIN_EDGE = envNum('AS_MIN_EDGE_BPS', 8);
const MAX_QUOTE_DIST = envNum('AS_MAX_QUOTE_DIST_BPS', 150);
const STOP_SIGMA = envNum('AS_STOP_SIGMA', 3);
const STOP_PCT = envNum('AS_STOP_PCT', 3) / 100;
const HALT_COOLDOWN = envNum('AS_HALT_COOLDOWN_MIN', 60) * 60 * 1000;
const MAX_Q = envNum('AS_MAX_Q', 2);
const DUST_COMBINE_MAX = Math.max(0, envNum('AS_DUST_COMBINE_MAX', 2));
const HALT_HOLD_MS = envNum('AS_HALT_HOLD_H', 6) * 3600 * 1000;
const HALT_MAX_MS = envNum('AS_HALT_MAX_H', 24) * 3600 * 1000;
const HALT_EXIT_LOSS = envNum('AS_HALT_MAX_EXIT_LOSS_PCT', 1.5) / 100;
const HALT_MAX_LEV = envNum('AS_HALT_MAX_LEV', 2);
const HALT_EXTRA_LOSS = envNum('AS_HALT_EXTRA_LOSS_PCT', 2) / 100;
const HALT_MAX_HOLD_H = envNum('AS_HALT_MAX_HOLD_H', 6);
const XFER_PENDING_MS = envNum('AS_XFER_PENDING_MAX_MIN', 30) * 60 * 1000;
const CB_MAX_PAIRS = Math.max(1, envNum('AS_CB_MAX_PAIRS', 6));
const MAX_RESETS = Math.max(0, envNum('AS_MAX_RESETS_PER_DAY', 1));
const RESET_LEV = envNum('AS_RESET_LEV', 2);
const LIFETIME_DD = envNum('AS_LIFETIME_DD_PCT', 25) / 100;
const PAIR_COOLDOWN_MIN = envNum('AS_PAIR_COOLDOWN_MIN', 60);
const SCAN_ALERT_H = envNum('AS_SCAN_ALERT_H', 6);
const BOT_NAME = process.env.BOT || 'as';
let makerFeeBps = FEE_BPS;
const statePath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.json');
const lockPath = path.join(process.cwd(), 'data', 'as-' + VENUE + '.lock');
const fillPath = path.join(process.cwd(), 'logs', 'fills-' + BOT_NAME + '.jsonl');
const ledgerPath = path.join(process.cwd(), 'logs', 'ledger-' + BOT_NAME + '.jsonl');
const markoutPath = path.join(process.cwd(), 'logs', 'markouts-' + BOT_NAME + '.jsonl');
const transferPath = path.join(process.cwd(), 'logs', 'transfers-' + BOT_NAME + '.jsonl');
const controlPath = path.join(process.cwd(), 'data', BOT_NAME + '.control.json');
let bookSample = { at: 0, rows: new Map() };

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
  const floorBps = openingNeedBps();
  return adaptiveHalf({
    feeBps: makerFeeBps,
    profitBps: Math.max(0, floorBps - makerFeeBps),
    sigma: Number(sigma) || 0,
    k: SIGMA_K,
    touchSpreadBps: Number(spreadBps) || 0,
    maxHalfBps: Math.max(MAX_HALF * 10000, floorBps),
  });
}
function openingNeedBps() {
  return openingMinHalfBps({
    feeBps: makerFeeBps, bufferBps: FEE_BUFFER, profitBps: PROFIT_BPS,
    minEdgeBps: MIN_EDGE, minHalfBps: MIN_HALF_BPS,
  });
}
function widenOpen(px, side, mid, inc, needBps, touch, otherTouch, spreadMed) {
  return widenOpenDecision({
    px, side, mid, needBps, touch, otherTouch, maxDistBps: MAX_QUOTE_DIST, inc, spreadMedBps: spreadMed,
  });
}
function gateText(decision) {
  if (!decision || decision.why === 'ok') return '';
  const need = Math.round(Number(decision.need) || 0);
  if (decision.why === 'max-dist') {
    const med = Number(decision.spreadMed) > 0 ? ' spread_med=' + Math.round(Number(decision.spreadMed)) : '';
    return 'max-dist need=' + need + ' dist_touch=' + Math.round(Number(decision.distTouch) || 0) + ' cap=' + Math.round(Number(decision.cap) || 0) + med;
  }
  if (decision.why === 'below-need' && Number(decision.half) + 0.5 < Number(decision.need)) {
    return 'fee-edge half=' + Math.round(Number(decision.half) || 0) + ' need=' + need;
  }
  if (decision.why === 'no-mid') return 'no-mid';
  return openGateWhy(decision);
}
function logGate(state, sym, side, why) {
  const reason = String(why || '').split(' ')[0] || 'other';
  const key = sym + '|' + side + '|' + reason;
  state.gateLog = state.gateLog || {};
  state.gateCounts = state.gateCounts || {};
  state.gateCounts[key] = (state.gateCounts[key] || 0) + 1;
  const now = Date.now();
  if (now - (state.gateLog[key] || 0) < 10 * 60 * 1000) return;
  state.gateLog[key] = now;
  console.log('GATE ' + sym + ' ' + side + ' ' + why);
}
function noteSpread(state, sym, bps) {
  if (!(Number(bps) > 0) || !sym) return;
  state.spreads = state.spreads || {};
  const hist = state.spreads[sym] || [];
  hist.push(Number(bps));
  while (hist.length > 360) hist.shift();
  state.spreads[sym] = hist;
}
function warmSpreads(state) {
  if (state.spreadsWarm) return;
  state.spreadsWarm = true;
  const file = path.join(process.cwd(), 'data', 'feed', VENUE === 'kraken' ? 'kraken.json' : 'coinbase.json');
  let row = null;
  try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  for (const r of (row && row.ranked) || []) {
    const sym = String(r.symbol || '').toUpperCase();
    const bid = Number(r.bid);
    const ask = Number(r.ask);
    const mid = Number(r.mid) || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
    if (!sym || !(bid > 0) || !(ask > bid) || !(mid > 0)) continue;
    const hist = (state.spreads && state.spreads[sym]) || [];
    if (hist.length >= 3) continue;
    const bps = (ask - bid) / mid * 10000;
    noteSpread(state, sym, bps);
    noteSpread(state, sym, bps);
    noteSpread(state, sym, bps);
  }
}
function logTransfer(rec) {
  const usd = Number(rec.usd) || 0;
  const kind = usd < 0 ? 'withdrawal' : 'deposit';
  if (rec.inferred) console.log('TRANSFER inferred $' + usd.toFixed(2));
  else console.log('TRANSFER ' + kind + ' $' + Math.abs(usd).toFixed(2) + ' ' + (rec.ccy || '') + ' id=' + rec.id);
  try {
    fs.mkdirSync(path.dirname(transferPath), { recursive: true });
    fs.appendFileSync(transferPath, JSON.stringify({ id: rec.id, type: rec.type, ccy: rec.ccy, amount: rec.amount, usd, inferred: !!rec.inferred, time: rec.time || new Date().toISOString() }) + '\n');
  } catch { /* keep going */ }
}
function bumpBaseline(state, usd) {
  state.lifetimeTransfers = (Number(state.lifetimeTransfers) || 0) + usd;
  if (Number(state.originEquity) > 0) state.capitalBaseline = Number(state.originEquity) + Number(state.lifetimeTransfers);
}
function bookTransfer(state, rec) {
  const id = String(rec.id || '');
  if (!id) return false;
  state.seenLedgers = state.seenLedgers || {};
  if (state.seenLedgers[id]) return false;
  const usd = Number(rec.usd) || 0;
  if (!usd) return false;
  const inf = state.inferredOpen;
  if (inf && !rec.inferred && Math.abs(usd - Number(inf.usd)) <= Math.max(0.02, Math.abs(Number(inf.usd)) * 0.02)) {
    state.transfers = (Number(state.transfers) || 0) - Number(inf.usd);
    bumpBaseline(state, -Number(inf.usd));
    console.log('TRANSFER replace inferred ' + inf.id);
    state.inferredOpen = null;
  }
  const pending = state.transferPending;
  if (pending && !rec.inferred && Math.abs(usd - Number(pending.usd)) <= Math.max(0.02, Math.abs(Number(pending.usd)) * 0.02)) {
    state.transferPending = null;
  }
  state.transfers = (state.transfers || 0) + usd;
  state.transferThisLoop = (state.transferThisLoop || 0) + usd;
  bumpBaseline(state, usd);
  state.seenLedgers[id] = true;
  if (rec.inferred) {
    state.inferredOpen = { id, usd };
    state.transferPending = null;
  }
  logTransfer(rec);
  return true;
}
function haltLossUsed(state, sym) {
  let n = 0;
  for (const [k, v] of Object.entries(state.haltLossPlan || {})) {
    if (k === sym) continue;
    n += Number(v) || 0;
  }
  return n;
}
function quoteMid(state, orderId, sym, timeIso) {
  const rec = state.orderMid && state.orderMid[String(orderId)];
  if (rec && Number(rec.mid) > 0) return Number(rec.mid);
  const t = Date.parse(timeIso) || Date.now();
  let best = 0;
  let bestT = -1;
  for (const h of (state.pxHist && state.pxHist[sym]) || []) {
    if (h && h.t <= t && Number(h.mid) > 0 && h.t >= bestT) { bestT = h.t; best = Number(h.mid); }
  }
  return best;
}
function riskStep(state, key) {
  state.riskSteps = state.riskSteps || {};
  const cur = state.riskSteps[key] || { n: 0, at: Date.now() };
  if (Date.now() - cur.at >= 15 * 60 * 1000) { cur.n += 1; cur.at = Date.now(); }
  state.riskSteps[key] = cur;
  return cur.n;
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
  if (row.capture != null && Number.isFinite(Number(row.capture))) state.makerCapture = (state.makerCapture || 0) + Number(row.capture);
  state.fees = (state.fees || 0) + (row.fee || 0);
  state.fillCount = (Number(state.fillCount) || 0) + 1;
  state.fillTimes = state.fillTimes || [];
  state.fillTimes.push(Date.parse(row.time) || Date.now());
  const prev = state.entry && state.entry[row.symbol];
  const effect = posEffectOf({
    longQty: prev && prev.longQty, shortQty: prev && prev.shortQty, side: row.side, size: row.size,
  });
  row.posEffect = effect;
  if (effect === 'reduce' || effect === 'close' || effect === 'flip') {
    const buy = String(row.side || '').toLowerCase() === 'buy';
    const have = buy ? Number(prev && prev.shortQty) || 0 : Number(prev && prev.longQty) || 0;
    const closeQty = Math.min(have, Number(row.size) || 0);
    const avg = buy ? entryAvg(prev, 'short') : entryAvg(prev, 'long');
    row.realized = roundTripNet({
      entry: avg, exit: Number(row.price), qty: closeQty, feeBps: makerFeeBps, side: buy ? 'short' : 'long',
    });
    if ((effect === 'close' || effect === 'flip') && closeQty > 0) {
      const now = Date.now();
      state.recentTrips = state.recentTrips || [];
      state.recentTrips.push({ t: now, sym: row.symbol, net: row.realized });
      state.recentTrips = state.recentTrips.filter((t) => now - t.t < 48 * 3600 * 1000);
      if (row.realized < 0) {
        state.pairLosses = state.pairLosses || {};
        const arr = (state.pairLosses[row.symbol] || []).filter((t) => now - t < 24 * 3600 * 1000);
        arr.push(now);
        state.pairLosses[row.symbol] = arr;
        const cd = pairCooldownMs({ losing: true, losses24h: arr.length, cooldownMin: PAIR_COOLDOWN_MIN });
        state.pairCooldown = state.pairCooldown || {};
        state.pairCooldown[row.symbol] = now + cd;
      }
    }
  }
  state.lastFill = state.lastFill || {};
  state.lastFill[row.symbol] = { side: row.side, price: row.price, time: row.time, size: row.size };
  const next = applyEntry(prev, row);
  state.entry = state.entry || {};
  state.entry[row.symbol] = next;
  state.pairStats = state.pairStats || {};
  const ps = state.pairStats[row.symbol] || { fills: 0, capture: 0, fees: 0, realized: 0 };
  ps.fills += 1;
  ps.capture += Number(row.capture) || 0;
  ps.fees += Number(row.fee) || 0;
  ps.realized += Number(row.realized) || 0;
  state.pairStats[row.symbol] = ps;
  state.pairWindow = state.pairWindow || {};
  const nowFill = Date.now();
  const windowRows = (state.pairWindow[row.symbol] || []).filter((x) => nowFill - x.t < 3600 * 1000);
  windowRows.push({ t: nowFill, fee: Number(row.fee) || 0, capture: Number(row.capture) || 0 });
  state.pairWindow[row.symbol] = windowRows;
  const winFees = windowRows.reduce((s, x) => s + x.fee, 0);
  const winCap = windowRows.reduce((s, x) => s + x.capture, 0);
  if (churnSignal({ fills: windowRows.length, fees: winFees, capture: winCap })) {
    state.churnLogged = state.churnLogged || {};
    if (nowFill - (state.churnLogged[row.symbol] || 0) > 3600 * 1000) {
      state.churnLogged[row.symbol] = nowFill;
      console.log('CHURN ' + row.symbol + ' fills=' + windowRows.length + ' fees=$' + winFees.toFixed(2) + ' capture=$' + winCap.toFixed(2));
      state.pairCooldown = state.pairCooldown || {};
      state.pairCooldown[row.symbol] = nowFill + pairCooldownMs({ losing: true, losses24h: 1, cooldownMin: PAIR_COOLDOWN_MIN });
    }
  }
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
        const timeIso = new Date((Number(o.closetm) || Date.now() / 1000) * 1000).toISOString();
        const mid = quoteMid(state, id, sym, timeIso);
        const venueFillId = id + ':' + exec;
        if (!(state.seenFills && state.seenFills[venueFillId]) && !(mid > 0)) console.log('CAPTURE missing ' + id);
        const side = String(d.type || '').toLowerCase();
        const delta = exec - prev;
        const capture = mid > 0 ? (side === 'buy' ? mid - px : px - mid) * delta : null;
        noteFill(state, {
          venueFillId, time: timeIso,
          symbol: sym, side, price: px, size: delta, fee: Number(o.fee || 0), feeCcy: 'USD',
          liquidity: 'maker', orderId: id, leverage: Number(String(d.leverage || '').split(':')[0]) || 0,
          capture, mid: mid || null,
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
    const timeIso = f.trade_time || new Date().toISOString();
    const venueFillId = f.trade_id || f.entry_id;
    const mid = quoteMid(state, f.order_id, sym, timeIso);
    if (!(state.seenFills && state.seenFills[venueFillId]) && !(mid > 0)) console.log('CAPTURE missing ' + (f.order_id || sym));
    noteFill(state, {
      venueFillId, time: timeIso,
      symbol: sym, side, price: px, size: sz, fee: Number(f.commission || 0), feeCcy: 'USDC',
      liquidity: String(f.liquidity_indicator || 'MAKER').toLowerCase().includes('taker') ? 'taker' : 'maker',
      orderId: f.order_id, leverage: 0,
      capture: mid > 0 ? (side === 'buy' ? mid - px : px - mid) * sz : null, mid: mid || null,
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
    const usd = Number(amt) || 0;
    if (usd) bookTransfer(state, { id, type, ccy: (row && row.asset) || 'USD', amount: usd, usd, time: row && row.time ? new Date(Number(row.time) * 1000).toISOString() : new Date().toISOString() });
    else state.seenLedgers[id] = true;
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
  state.transferThisLoop = 0;
  if (VENUE === 'kraken') {
    const origin = Math.floor(Date.parse(state.startTime || new Date().toISOString()) / 1000) || Math.floor(Date.now() / 1000) - 86400;
    const start = state.fundingReplay ? origin : (state.ledgerCursor || origin);
    try { await rememberTradeIds(state, start); } catch { /* fills still match by order id */ }
    let sawRollover = !state.fundingReplay;
    for (const type of ['deposit', 'withdrawal', 'rollover', 'margin']) {
      let page;
      try { page = await krakenOnce('Ledgers', { start, type }); }
      catch { continue; }
      if (type === 'rollover') sawRollover = true;
      for (const [id, row] of Object.entries((page && page.ledger) || {})) ingestLedger(state, id, type, row, positions);
    }
    state.ledgerCursor = Math.floor(Date.now() / 1000) - 60;
    if (sawRollover) state.fundingReplay = false;
    return;
  }
  await pollCoinbaseTransfers(state, positions);
}
function quoteCcy(code) {
  const c = String(code || '').toUpperCase();
  return c === 'USD' || c === 'USDC' || c === String(cfg.quote || '').toUpperCase();
}
function logTransferError(state, ccy, err) {
  const raw = String((err && err.message) || err || 'error');
  const status = (raw.match(/Coinbase (\d{3})/) || raw.match(/\b(\d{3})\b/) || [])[1] || 'err';
  const msg = raw.replace(/bearer\s+\S+/ig, '').replace(/key|secret|authorization/ig, '').slice(0, 160);
  state.transferErrAt = state.transferErrAt || {};
  const now = Date.now();
  if (now - (state.transferErrAt[ccy] || 0) < 10 * 60 * 1000) return;
  state.transferErrAt[ccy] = now;
  console.log('TRANSFER error ' + ccy + ' ' + status + ' ' + msg);
}
async function coinbaseAccounts() {
  let path = '/v2/accounts?limit=100';
  const out = [];
  for (let i = 0; i < 20 && path; i++) {
    const page = await coinbaseRequest(cfg, 'GET', path);
    for (const acct of (page && page.data) || []) if (acct && acct.id) out.push(acct);
    const next = page && page.pagination && page.pagination.next_uri;
    path = next ? String(next).replace(/^https:\/\/api\.coinbase\.com/i, '') : '';
  }
  return out;
}
async function pollCoinbaseTransfers(state, positions) {
  state.seenLedgers = state.seenLedgers || {};
  state.cbTxCursor = state.cbTxCursor || {};
  if (!state.transferSourceLogged) {
    state.transferSourceLogged = 'pending';
  }
  let accts = [];
  try {
    accts = await coinbaseAccounts();
    state.transferFailStreak = 0;
    state.transferBlind = false;
  } catch (e) {
    state.transferFailStreak = (Number(state.transferFailStreak) || 0) + 1;
    logTransferError(state, 'accounts', e);
    if (state.transferFailStreak >= 3) state.transferBlind = true;
    await pollCoinbaseV3Balances(state);
    return;
  }
  const rows = [];
  const seenCcy = new Set();
  for (const acct of accts) {
    const ccy = String((acct.currency && acct.currency.code) || acct.currency || '').toUpperCase();
    const bal = Math.abs(Number(acct.balance && acct.balance.amount) || 0);
    seenCcy.add(ccy);
    if (quoteCcy(ccy) || bal > 0 || (positions && positions[ccy])) rows.push({ id: acct.id, ccy });
  }
  for (const ccy of ['USD', 'USDC', String(cfg.quote || '').toUpperCase()]) {
    if (!ccy || seenCcy.has(ccy)) continue;
    const acct = accts.find((a) => String((a.currency && a.currency.code) || a.currency || '').toUpperCase() === ccy);
    if (acct && acct.id) rows.push({ id: acct.id, ccy });
  }
  if (state.transferSourceLogged === 'pending') {
    console.log('TRANSFER source=v2 accounts=' + rows.length);
    state.transferSourceLogged = 'v2';
  }
  const origin = Date.parse(state.startTime || '') || 0;
  let failures = 0;
  for (const acct of rows) {
    const cursor = state.cbTxCursor[acct.id] || '';
    let path = '/v2/accounts/' + acct.id + '/transactions?limit=100';
    let newest = cursor;
    let failed = false;
    for (let page = 0; page < 10 && path; page++) {
      let tx;
      try { tx = await coinbaseRequest(cfg, 'GET', path); }
      catch (e) {
        failed = true;
        failures += 1;
        logTransferError(state, acct.ccy || acct.id, e);
        break;
      }
      let stop = false;
      for (const t of (tx && tx.data) || []) {
        const type = String(t.type || '').toLowerCase();
        const ts = Date.parse(t.created_at || '') || 0;
        const stamp = (t.created_at || '') + '|' + (t.id || '');
        if (stamp > newest) newest = stamp;
        if (cursor && stamp <= cursor) { stop = true; continue; }
        if (origin && ts && ts + 120000 < origin) { stop = true; continue; }
        if (!cbTransferAllowed(type)) continue;
        if (!t.id || state.seenLedgers[t.id]) continue;
        const raw = Number(t.amount && t.amount.amount);
        if (!raw) continue;
        let px = 1;
        if (!quoteCcy(acct.ccy)) {
          px = positions && positions[acct.ccy] && Number(positions[acct.ccy].mid);
          if (!(px > 0)) continue;
        }
        const usd = transferUsd({ amount: raw, px, status: t.status || 'completed' });
        if (!usd) continue;
        bookTransfer(state, {
          id: t.id, type, ccy: acct.ccy, amount: raw, usd,
          time: t.created_at || new Date().toISOString(),
        });
      }
      if (stop) break;
      const next = tx && tx.pagination && tx.pagination.next_uri;
      path = next ? String(next).replace(/^https:\/\/api\.coinbase\.com/i, '') : '';
    }
    if (!failed && newest) state.cbTxCursor[acct.id] = newest;
  }
  if (failures > 0 && failures >= rows.length && rows.length) {
    state.transferFailStreak = (Number(state.transferFailStreak) || 0) + 1;
    if (state.transferFailStreak >= 3) {
      state.transferBlind = true;
      await pollCoinbaseV3Balances(state);
    }
  } else if (rows.length) {
    state.transferFailStreak = 0;
    state.transferBlind = false;
  }
}
async function pollCoinbaseV3Balances(state) {
  let cursor = '';
  const bals = {};
  try {
    for (let i = 0; i < 10; i++) {
      const path = '/api/v3/brokerage/accounts?limit=250' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const data = await coinbaseRequest(cfg, 'GET', path);
      for (const a of (data && data.accounts) || []) {
        const ccy = String(a.currency || '').toUpperCase();
        if (!quoteCcy(ccy)) continue;
        const avail = Number(a.available_balance && a.available_balance.value) || 0;
        const hold = Number(a.hold && a.hold.value) || 0;
        bals[ccy] = (bals[ccy] || 0) + avail + hold;
      }
      if (!data || !data.has_next || !data.cursor) break;
      cursor = data.cursor;
    }
  } catch (e) {
    logTransferError(state, 'v3', e);
    state.transferBlind = true;
    return;
  }
  if (state.transferSourceLogged !== 'v2') {
    console.log('TRANSFER source=v3 accounts=' + Object.keys(bals).length);
    state.transferSourceLogged = 'v3';
  }
  state.cbBalances = state.cbBalances || {};
  for (const [ccy, bal] of Object.entries(bals)) {
    const prev = Number(state.cbBalances[ccy]);
    state.cbBalances[ccy] = bal;
    if (!(prev > 0)) continue;
    const delta = bal - prev;
    if (Math.abs(delta) > Math.max(1, Math.abs(prev) * 0.03) && !(state.transferThisLoop)) {
      state.transferPending = state.transferPending || { usd: delta, since: Date.now() };
    }
  }
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
  const eb = Number(tb.eb || 0);
  const marked = Number(tb.e);
  const equity = marked > 0 ? marked : eb + upnl;
  return {
    equity, cashEq: eb, cash: Number(tb.mf || 0), positions, mine, foreign: new Set(),
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
  let markedEq = Number(live.freeQuote || 0) + Number(live.quoteHold || 0);
  for (const [sym, p] of Object.entries(live.positions || {})) {
    const avail = Number(p.amount || 0);
    const hold = Number(p.hold || 0);
    const qty = avail + hold;
    if (!(qty > 0)) continue;
    const mid = Number(p.mid || 0);
    positions[sym] = {
      long: qty, short: 0, available: avail, hold, usd: Number(p.valueQuote || 0),
      mid, bid: Number(p.bestBid || 0), quoteMin: Number(p.quoteMin || 1),
    };
    markedEq += mid > 0 ? qty * mid : Number(p.valueQuote || 0);
  }
  return {
    equity: markedEq > 0 ? markedEq : Number(live.totalEquity || 0),
    cash: Number(live.freeQuote || 0), quoteHold: Number(live.quoteHold || 0),
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
    if (sigmaWarmup) {
      const spark = feedSpark(row.symbol);
      if (spark.length >= 8) {
        sigma = realizedSigma(spark);
        sigmaWarmup = !(sigma > 0);
      }
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

function feedSpark(sym) {
  try {
    const row = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'feed', 'coinbase.json'), 'utf8'));
    const arr = row.sparks && row.sparks[sym];
    if (!Array.isArray(arr) || arr.length < 8) return [];
    const closes = [];
    let bucket = 0;
    for (const x of arr) {
      const t = Number(x.t) || 0;
      const p = Number(x.p);
      if (!(p > 0)) continue;
      const b = Math.floor(t / 60000);
      if (b !== bucket) { closes.push(p); bucket = b; }
    }
    return closes;
  } catch { return []; }
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

async function sampleBooks(rows) {
  const now = Date.now();
  if (bookSample.rows.size && now - bookSample.at < 45000) return bookSample.rows;
  const out = new Map();
  if (VENUE === 'kraken') {
    for (let i = 0; i < rows.length; i += 15) {
      const chunk = rows.slice(i, i + 15);
      try {
        const t = await krakenPublic('Ticker', { pair: chunk.map((r) => r.pair).join(',') });
        for (const row of chunk) {
          const tk = t[row.pair] || t[row.altname] || null;
          if (!tk) continue;
          const bid = Number((tk.b || [])[0] || 0);
          const ask = Number((tk.a || [])[0] || 0);
          const last = Number((tk.c || [])[0] || 0);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
          const volBase = Number((tk.v || [])[1] || (tk.v || [])[0] || 0);
          if (!(mid > 0)) continue;
          out.set(row.symbol, { bid, ask, mid, vol: volBase * mid });
        }
      } catch { /* next page */ }
      await sleep(150);
    }
  } else {
    const byVol = [...rows].sort((a, b) => (Number(b.vol24) || 0) - (Number(a.vol24) || 0));
    const head = byVol.filter((r) => !r.dustBid).slice(0, Math.max(SCAN_EVAL_N, 40));
    const ranked = head.concat(rows.filter((r) => r.dustBid && !head.some((h) => h.symbol === r.symbol)));
    for (let i = 0; i < ranked.length; i += 20) {
      const chunk = ranked.slice(i, i + 20);
      try {
        const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/best_bid_ask?product_ids=' + encodeURIComponent(chunk.map((r) => r.pair).join(',')));
        const byPair = new Map(((data && data.pricebooks) || []).map((b) => [b.product_id, b]));
        for (const row of chunk) {
          const b = byPair.get(row.pair);
          if (!b) continue;
          const bid = parseFloat((b.bids && b.bids[0] && b.bids[0].price) || 0);
          const ask = parseFloat((b.asks && b.asks[0] && b.asks[0].price) || 0);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
          if (!(mid > 0)) continue;
          out.set(row.symbol, { bid, ask, mid, vol: Number(row.vol24) || 0 });
        }
      } catch { /* next page */ }
      await sleep(80);
    }
  }
  if (out.size) bookSample = { at: now, rows: out };
  return out;
}
function spreadRow(state, row, bookRow) {
  const mid = bookRow.mid;
  const tickBps = mid > 0 ? ((row.quoteIncrement || 0.01) / mid) * 10000 : 0;
  const liveBps = bookRow.bid > 0 && bookRow.ask > bookRow.bid ? (bookRow.ask - bookRow.bid) / mid * 10000 : 0;
  if (liveBps > 0) noteSpread(state, row.symbol, liveBps);
  const hist = (state.spreads && state.spreads[row.symbol]) || [];
  const spreadBps = hist.length >= 3 ? median(hist) : liveBps;
  return {
    ...row, spreadBps, vol24: Number(bookRow.vol) || Number(row.vol24) || 0, tickBps, sigma: 0,
    bid: bookRow.bid, ask: bookRow.ask, mid,
  };
}
function logScan(state, decision) {
  const now = Date.now();
  state.feeSpreadLog = state.feeSpreadLog || {};
  for (const sym of decision.feeSpread || []) {
    if (now - (state.feeSpreadLog[sym] || 0) < 3600 * 1000) continue;
    state.feeSpreadLog[sym] = now;
    console.log('GATE ' + sym + ' both fee-spread');
  }
  const diag = 'SCAN source=' + (decision.source || 'api') + ' n=' + (decision.raw ?? 0) + ' after_products=' + (decision.afterProducts ?? 0) + ' after_quote=' + (decision.afterQuote ?? 0);
  const rejSum = ['feeSpread', 'vol', 'tick', 'wide', 'edge'].reduce((s, k) => s + Number((decision.rejected || {})[k] || 0), 0);
  const emptyScan = !(decision.raw > 0) || (!(decision.picked || []).length && rejSum === 0 && !(decision.evaluated > 0));
  if (emptyScan && now - (state.scanEmptyAt || 0) > 10 * 60 * 1000) {
    state.scanEmptyAt = now;
    console.log('SCAN empty ' + diag + ' after_filters=' + (decision.evaluated || 0));
  }
  if (!(decision.picked || []).length) {
    state.scanRejectLog = state.scanRejectLog || {};
    const top = (decision.reasons || []).slice(0, 20);
    for (const r of top) {
      const key = r.symbol + '|' + r.reason;
      if (now - (state.scanRejectLog[key] || 0) < 10 * 60 * 1000) continue;
      state.scanRejectLog[key] = now;
      console.log('SCAN reject ' + r.symbol + ' reason=' + r.reason + ' val=' + Number(r.val || 0).toFixed(1) + ' need=' + Number(r.need || 0).toFixed(1));
    }
    state.lastRejects = top.map((r) => r.symbol + ':' + r.reason);
  }
  if (now - (state.scanLogAt || 0) < 3600 * 1000) return;
  state.scanLogAt = now;
  console.log(diag);
  for (const b of decision.best5 || []) {
    console.log('SCAN best ' + b.symbol + ' exp_edge=' + Number(b.expEdge).toFixed(1) + ' need=' + Number(b.need).toFixed(1) + ' fillp=' + Number(b.fillp).toFixed(2));
  }
  const rej = decision.rejected || { feeSpread: 0, vol: 0, tick: 0 };
  const n = (rej.feeSpread || 0) + (rej.vol || 0) + (rej.tick || 0) + (rej.wide || 0);
  const picked = (decision.picked || []).map((p) => p.symbol + ':' + Number(p.edge).toFixed(0) + ':' + Math.round(Number(p.vol24) || 0)).join(',');
  console.log('SCAN picked=' + (picked || '-') + ' rejected=' + n + ' (fee-spread ' + (rej.feeSpread || 0) + ', vol ' + (rej.vol || 0) + ', tick ' + (rej.tick || 0) + ')');
  if (!(decision.picked || []).length) {
    const best = decision.best;
    console.log('SCAN none-tradeable best=' + (best && best.symbol || '-') + ' edge=' + (best ? Number(best.edge).toFixed(1) : '-') + 'bp');
    if (!state.noneSince) state.noneSince = now;
    const hours = (now - state.noneSince) / 3600000;
    if (hours > SCAN_ALERT_H && !state.scanAlerted) {
      state.scanAlerted = true;
      console.log('SCAN alert none-tradeable for=' + hours.toFixed(1) + 'h');
    }
  } else {
    state.noneSince = 0;
    state.scanAlerted = false;
  }
}
function scanReason(row, fee, minEdge, minVol, maxSpread) {
  const tick = Number(row.tickBps) || 0;
  const vol = Number(row.vol24) || 0;
  const spread = Number(row.spreadBps) || 0;
  const need = roundTripPadBps({ feeBps: fee, minEdgeBps: minEdge });
  if (tick > 10) return { symbol: row.symbol, reason: 'tick', val: tick, need };
  if (vol + 1e-9 < minVol) return { symbol: row.symbol, reason: 'vol', val: vol, need };
  if (spread > maxSpread) return { symbol: row.symbol, reason: 'wide', val: spread, need };
  if (spread - 2 * fee + 1e-9 < minEdge) return { symbol: row.symbol, reason: 'fee-spread', val: spread, need };
  return null;
}
async function select(products, book, state) {
  warmSpreads(state);
  const held = [];
  state.dustWatch = [];
  for (const [sym, pos] of Object.entries(book.positions || {})) {
    if (!(Number(pos.long) > 0 || Number(pos.short) > 0)) continue;
    if (state.skip && state.skip[sym]) continue;
    const rec = products[sym];
    if (!rec) continue;
    if (VENUE !== 'kraken') {
      const qty = Number(pos.long || 0);
      const mid = Number(pos.mid || 0);
      const klass = holdingClass({
        qty, mid,
        minNotional: Number(pos.quoteMin || rec.quoteMin || 1),
        minSize: Number(rec.baseMin || rec.ordermin || 0),
      });
      if (klass === 'dust') {
        markDust(state, sym, mid);
        state.dustWatch.push({
          ...rec, symbol: sym, orderPair: orderPairOf(rec, sym), dustBid: true,
          dustUsd: qty * mid, qty, quoteMin: Number(pos.quoteMin || rec.quoteMin || 1),
        });
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
    candidates.push({ ...rec, symbol, orderPair: orderPairOf(rec, symbol), scan: rank.has(symbol) ? rank.get(symbol) : 999 });
  }
  const dustRows = (state.dustWatch || []).filter((d) => !candidates.some((c) => c.symbol === d.symbol) && !held.some((h) => h.symbol === d.symbol));
  const books = await sampleBooks(candidates.concat(dustRows));
  const measured = [];
  for (const row of candidates) {
    const b = books.get(row.symbol);
    if (b) measured.push(spreadRow(state, row, b));
  }
  const scanTs = Number(scan && (scan.ts || scan.at)) || 0;
  const scanFresh = scanTs > 0 && Date.now() - scanTs < 2 * 3600 * 1000 && ((scan && scan.ranked) || []).length > 0;
  const relax = state.scanRelax || {};
  const minEdge = VENUE === 'kraken' ? MIN_EDGE : (Number(relax.minEdgeBps) > 0 ? Number(relax.minEdgeBps) : MIN_EDGE);
  const minVol = Number(relax.volFloor) > 0 ? Number(relax.volFloor) : MIN_VOL;
  if (VENUE !== 'kraken' && measured.length && !measured.some((r) => Number(r.vol24) > 0)) {
    for (const r of measured) r.vol24 = minVol;
  }
  const decision = VENUE === 'kraken'
    ? rankByExpectedEdge(measured, {
      feeBps: makerFeeBps, minEdgeBps: minEdge, minVol, maxSpreadBps: MAX_SPREAD * 10000,
      maxPairs: MAX_PAIRS, k: SIGMA_K, tauMin: TAU, kappa: KAPPA,
    })
    : rankByNetEdge(measured, {
      feeBps: makerFeeBps, minEdgeBps: minEdge, minVol,
      maxSpreadBps: MAX_SPREAD * 10000, targetVol: SCAN_TARGET_VOL,
      evalN: Math.max(SCAN_EVAL_N, measured.length), maxPairs: CB_MAX_PAIRS,
    });
  if (!decision.reasons) {
    decision.reasons = measured
      .slice()
      .sort((a, b) => (Number(b.vol24) || 0) - (Number(a.vol24) || 0))
      .map((row) => scanReason(row, makerFeeBps, minEdge, minVol, MAX_SPREAD * 10000))
      .filter(Boolean);
  }
  decision.raw = Object.keys(products || {}).length;
  decision.afterProducts = candidates.length;
  decision.afterQuote = measured.length;
  decision.source = scanFresh ? 'file' : 'api';
  logScan(state, decision);
  const dustMeasured = [];
  for (const row of dustRows) {
    const b = books.get(row.symbol);
    if (b) dustMeasured.push(spreadRow(state, row, { ...b, vol: Math.max(Number(b.vol) || 0, MIN_VOL) }));
  }
  const dustDecision = rankByNetEdge(dustMeasured, {
    feeBps: makerFeeBps, minEdgeBps: MIN_EDGE, minVol: 0,
    maxSpreadBps: MAX_SPREAD * 10000, targetVol: SCAN_TARGET_VOL,
    evalN: SCAN_EVAL_N, maxPairs: dustMeasured.length || 1,
  });
  const dustOk = new Set((dustDecision.picked || []).map((p) => p.symbol));
  decision.picked.forEach((r, i) => { r.hot = i < 2; });
  for (const h of held) h.hot = (rank.get(h.symbol) ?? 99) < 2;
  for (const d of state.dustWatch || []) {
    d.scan = rank.has(d.symbol) ? rank.get(d.symbol) : 999;
    d.edgeOk = dustOk.has(d.symbol);
  }
  return held.concat(decision.picked);
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
  console.log('  ' + side.toUpperCase() + ' ' + row.symbol + ' ' + size + ' @ ' + target + (lev ? ' ' + lev + 'x' : '') + (reduceOnly ? ' reduce' : '') + (extra.halfBps != null ? ' half=' + extra.halfBps + 'bp' : '') + (extra.halfSrc ? ' half_src=' + extra.halfSrc : '') + (extra.risk ? ' risk=' + extra.risk : '') + sigTxt + distTxt + (extra.floorTxt ? ' floor=' + extra.floorTxt : ''));
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
    state.orderMid = state.orderMid || {};
    if (Number(extra.mid) > 0) state.orderMid[r.order_id] = { mid: Number(extra.mid), t: Date.now() };
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
    if (reason === 'below-min') {
      state.belowMinLog = state.belowMinLog || {};
      if (Date.now() - (state.belowMinLog[row.symbol + ':' + side] || 0) > 3600 * 1000) {
        state.belowMinLog[row.symbol + ':' + side] = Date.now();
        console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + why);
      }
    } else console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + why);
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
  if (Date.now() - (state.holdLogAt[sym] || 0) < 60 * 60 * 1000) return;
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
    while (spreads.length > 180) spreads.shift();
    state.spreads = state.spreads || {};
    state.spreads[row.symbol] = spreads;
  }
  state.pxHist = state.pxHist || {};
  const pxHist = state.pxHist[row.symbol] || [];
  pxHist.push({ t: Date.now(), mid });
  while (pxHist.length > 200) pxHist.shift();
  state.pxHist[row.symbol] = pxHist;
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
  let lossOk = !!(rail.lossOk || rail.mode === 'cut');
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
  const ageMinNow = ageMs / 60000;
  const adverseLong = longAvg > 0 && mid > 0 && Number(pos.long) > 0 ? Math.max(0, (longAvg - mid) / longAvg) : 0;
  const adverseShort = shortAvg > 0 && mid > 0 && Number(pos.short) > 0 ? Math.max(0, (mid - shortAvg) / shortAvg) : 0;
  const sigmaMove = (s.sigmaWarmup ? 0 : Number(s.sigma) || 0) * Math.sqrt(Math.max(1, ageMinNow) / 15);
  const haltKind = state.halted === 'day-loss' || state.halted === 'margin-halt' ? state.halted : '';
  const risk = riskAllowsLoss({
    ml: book.ml, cut: ML_CUT, adverseFrac: Math.max(adverseLong, adverseShort), sigmaMove,
    stopSigma: STOP_SIGMA, stopPct: STOP_PCT, ageMin: ageMinNow, maxHoldMin: MAX_HOLD_MIN, haltKind,
  });
  const costLong = roundTripFloorPx({ entry: longAvg, side: 'long', feeBps: makerFeeBps, minEdgeBps: MIN_EDGE, tick: inc });
  const costShort = roundTripFloorPx({ entry: shortAvg, side: 'short', feeBps: makerFeeBps, minEdgeBps: MIN_EDGE, tick: inc });
  const lastFill = state.lastFill && state.lastFill[row.symbol];
  const oppAsk = lastFill && String(lastFill.side) === 'buy'
    ? oppositeFloorPx({ fillPx: lastFill.price, side: 'buy', feeBps: makerFeeBps, minEdgeBps: MIN_EDGE, tick: inc }) : 0;
  const oppBid = lastFill && String(lastFill.side) === 'sell'
    ? oppositeFloorPx({ fillPx: lastFill.price, side: 'sell', feeBps: makerFeeBps, minEdgeBps: MIN_EDGE, tick: inc }) : 0;
  let riskTag = '';
  if (state.halted === 'day-loss') riskTag = 'day-kill';
  else if (state.halted === 'lifetime-dd') riskTag = 'lifetime-rail';
  else if (state.halted && state.haltAction === 'delever') riskTag = 'halt-delever';
  else if (state.halted && state.haltAction === 'cap-exit') riskTag = 'halt-cap';
  else if (rail.mode === 'cut' && book.ml != null && book.ml < ML_HALT) riskTag = 'liq';
  const exempt = riskExempt(riskTag);
  if (!exempt) {
    if (Number(pos.long) > 0 && costLong > 0) askPx = Math.max(askPx, costLong, oppAsk || 0);
    if (Number(pos.short) > 0 && costShort > 0) bidPx = Math.min(bidPx, costShort);
    if (Number(pos.short) > 0 && oppBid > 0) bidPx = Math.min(bidPx, oppBid);
    if (!(Number(pos.long) > 0) && oppAsk > 0) askPx = Math.max(askPx, oppAsk);
    if (!(Number(pos.short) > 0) && oppBid > 0) bidPx = Math.min(bidPx, oppBid);
  } else if (riskTag === 'halt-delever') {
    if (Number(pos.long) > 0 && s.ask > 0) askPx = s.ask;
    if (Number(pos.short) > 0 && s.bid > 0) bidPx = s.bid;
  } else if (riskTag) {
    if (Number(pos.long) > 0) {
      askPx = stepToward({ from: costLong || askPx, to: s.ask || mid, halfBps: plan.bps, steps: riskStep(state, row.symbol + ':halt-sell'), entry: longAvg || mid });
    }
    if (Number(pos.short) > 0) {
      bidPx = stepToward({ from: costShort || bidPx, to: s.bid || mid, halfBps: plan.bps, steps: riskStep(state, row.symbol + ':halt-buy'), entry: shortAvg || mid });
    }
  }
  let haltExit = '';
  if (!exempt && state.halted === 'session-loss' && state.haltPhase === 'B') {
    if (Number(pos.long) > 0 && (costLong > 0 || longAvg > 0)) {
      const cost = costLong || longAvg;
      const steps = riskStep(state, row.symbol + ':halt-sell');
      askPx = haltTimeoutPx({
        cost, side: 'long', touch: s.ask || mid, halfBps: plan.bps, steps,
        maxLossPct: HALT_EXIT_LOSS, equity: book.equity, qty: Number(pos.long),
        haltLossUsed: haltLossUsed(state, row.symbol),
      });
      haltExit = 'halt-timeout';
      state.haltLossPlan = state.haltLossPlan || {};
      state.haltLossPlan[row.symbol] = Math.max(0, (cost - askPx) * Number(pos.long));
    }
    if (Number(pos.short) > 0 && (costShort > 0 || shortAvg > 0)) {
      const cost = costShort || shortAvg;
      const steps = riskStep(state, row.symbol + ':halt-buy');
      bidPx = haltTimeoutPx({
        cost, side: 'short', touch: s.bid || mid, halfBps: plan.bps, steps,
        maxLossPct: HALT_EXIT_LOSS, equity: book.equity, qty: Number(pos.short),
        haltLossUsed: haltLossUsed(state, row.symbol),
      });
      haltExit = 'halt-timeout';
      state.haltLossPlan = state.haltLossPlan || {};
      state.haltLossPlan[row.symbol + ':short'] = Math.max(0, (bidPx - cost) * Number(pos.short));
    }
  }
  const spreadMed = median(((state.spreads && state.spreads[row.symbol]) || []).slice(-30));
  const needBps = Math.max(openingNeedBps(), roundTripPadBps({ feeBps: makerFeeBps, minEdgeBps: MIN_EDGE }));
  let blockOpenBuy = false;
  let blockOpenSell = false;
  let openBuyWhy = '';
  let openSellWhy = '';
  if (!(Number(pos.short) > 0) && !exempt) {
    const w = widenOpen(bidPx, 'buy', mid, inc, needBps, s.bid, s.ask, spreadMed);
    if (w.why !== 'ok') { blockOpenBuy = true; openBuyWhy = gateText(w); }
    else bidPx = w.px;
  }
  if (!(Number(pos.long) > 0) && !exempt) {
    const w = widenOpen(askPx, 'sell', mid, inc, needBps, s.ask, s.bid, spreadMed);
    if (w.why !== 'ok') { blockOpenSell = true; openSellWhy = gateText(w); }
    else askPx = w.px;
  }
  if (s.bid > 0 && askPx > 0 && askPx <= s.bid) askPx = s.bid + inc;
  if (s.ask > 0 && bidPx > 0 && bidPx >= s.ask) bidPx = s.ask - inc;
  if (haltExit && !exempt && Number(pos.long) > 0) {
    const bound = haltExitBound({ cost: costLong || longAvg, side: 'long', maxLossPct: HALT_EXIT_LOSS, equity: book.equity, qty: Number(pos.long), haltLossUsed: haltLossUsed(state, row.symbol) });
    if (bound > 0 && askPx + 1e-12 < bound) askPx = bound;
  }
  if (haltExit && !exempt && Number(pos.short) > 0) {
    const bound = haltExitBound({ cost: costShort || shortAvg, side: 'short', maxLossPct: HALT_EXIT_LOSS, equity: book.equity, qty: Number(pos.short), haltLossUsed: haltLossUsed(state, row.symbol + ':short') });
    if (bound > 0 && bidPx - 1e-12 > bound) bidPx = bound;
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
    if (row.dustBid) {
      sellSz = 0;
      const topup = dustTopupUsd({ dustUsd: row.dustUsd, venueMin: minUsd });
      const room = budget ? Number(budget.dustLeft) : 0;
      if (addOk && bidPx > 0 && topup > 0 && room + 1e-9 >= topup) {
        buySz = formatVolume(topup / bidPx, lot);
        row.dustTopupUsd = topup;
      } else row.dustNoCash = !(topup > 0 && room + 1e-9 >= topup);
    } else if (reduce && state.belowMin && state.belowMin[row.symbol]) {
      buySz = 0;
      sellSz = 0;
    } else if (reduce && (Number(pos.long) > 0 || Number(pos.short) > 0)) {
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
      const slots = Math.max(1, Number(budget && budget.slots) || 1);
      const left = Math.max(0, Number(budget && budget.left) || 0);
      const wantUsd = slotClipUsd({ budget: left, slots, venueMin: minUsd });
      if (addOk && q < MAX_Q && bidPx > 0 && wantUsd > 0) buySz = formatVolume(wantUsd / bidPx, lot);
      if (budget) budget.slots = Math.max(1, slots - 1);
    } else if (!reduce) {
      const cap = liqNotionalCap(book.equity, lev || 2, LIQ_MIN);
      const sz = Math.min(clip, cap) / mid;
      if (q < MAX_Q) buySz = formatVolume(Math.max(sz, Number(row.ordermin) || 0), lot);
      if (q > -MAX_Q && row.shortable !== false) sellSz = formatVolume(Math.max(sz, Number(row.ordermin) || 0), lot);
      if (buySz * bidPx > cap || sellSz * askPx > cap) {
        console.log('RAIL liq ' + row.symbol);
        if (buySz * bidPx > cap) buySz = 0;
        if (sellSz * askPx > cap) sellSz = 0;
      }
    }
  }
  if (blockSell) sellSz = 0;
  if (blockBuy) buySz = 0;
  if (reduce) {
    const fitReduce = (sz, px, posQty) => {
      if (!(sz > 0) || !(px > 0)) return 0;
      const minSz = Math.max(Number(row.ordermin || row.baseMin || 0), px > 0 ? minUsd / px : 0);
      const fit = roundUpReduce({ size: Number(sz), minSize: minSz, posQty });
      if (fit.dust) { markDust(state, row.symbol, mid); return 0; }
      return formatVolume(fit.size, lot);
    };
    if (Number(pos.long) > 0) sellSz = fitReduce(sellSz, askPx, Number(pos.long));
    if (Number(pos.short) > 0) buySz = fitReduce(buySz, bidPx, Number(pos.short));
  }
  const rampLev = state.levRamp && Number(state.levRamp.lev) > 0 ? Number(state.levRamp.lev) : 0;
  const posLev = Number(pos.lev) >= 2 ? Number(pos.lev) : 0;
  let buyLev = VENUE === 'kraken' ? (posLev || state.levOk[row.symbol + ':buy'] || lev) : 0;
  let sellLev = VENUE === 'kraken' ? (posLev || state.levOk[row.symbol + ':sell'] || lev) : 0;
  if (rampLev > 0 && VENUE === 'kraken') {
    if (opensRisk(Number(pos.long || 0) - Number(pos.short || 0), 'buy')) buyLev = Math.min(buyLev || rampLev, rampLev);
    if (opensRisk(Number(pos.long || 0) - Number(pos.short || 0), 'sell')) sellLev = Math.min(sellLev || rampLev, rampLev);
  }
  const orderminNow = Number(row.ordermin || row.baseMin || 0);
  const dustShort = VENUE === 'kraken' && Number(pos.short) > 0 && orderminNow > 0 && Number(pos.short) + 1e-12 < orderminNow;
  const dustLong = VENUE === 'kraken' && Number(pos.long) > 0 && orderminNow > 0 && Number(pos.long) + 1e-12 < orderminNow;
  if (dustShort || dustLong) {
    const minNotional = orderminNow * (mid || 0);
    const afford = minNotional > 0 && minNotional <= 0.005 * Number(book.equity || 0);
    if (dustShort) {
      if (buySz > 0 && opensRisk(Number(pos.long || 0) - Number(pos.short || 0), 'buy')) buySz = formatVolume(Number(buySz) + Number(pos.short), lot);
      else if (afford && (addOk || state.halted)) buySz = formatVolume(orderminNow, lot);
      else buySz = 0;
      sellSz = 0;
    }
    if (dustLong) {
      if (sellSz > 0) sellSz = formatVolume(Number(sellSz) + Number(pos.long), lot);
      else if (afford) sellSz = formatVolume(orderminNow, lot);
      else sellSz = 0;
    }
  }
  if (riskTag === 'halt-delever') {
    const eqNow = Math.max(0, Number(book.equity || 0) - (state.transferPending && !state.transferPending.inferred ? Number(state.transferPending.usd) || 0 : 0));
    const capN = HALT_MAX_LEV * eqNow;
    if (Number(pos.long) > 0 && askPx > 0) {
      const excess = Math.max(0, Number(pos.long) * mid - capN);
      sellSz = excess > 0 ? formatVolume(excess / askPx, lot) : 0;
      buySz = 0;
    }
    if (Number(pos.short) > 0 && bidPx > 0) {
      const excess = Math.max(0, Number(pos.short) * mid - capN);
      buySz = excess > 0 ? formatVolume(excess / bidPx, lot) : 0;
      sellSz = 0;
    }
  }
  const cooling = (state.pairCooldown && state.pairCooldown[row.symbol] || 0) > Date.now();
  if (cooling) {
    const netNow = Number(pos.long || 0) - Number(pos.short || 0);
    if (buySz > 0 && opensRisk(netNow, 'buy')) buySz = 0;
    if (sellSz > 0 && opensRisk(netNow, 'sell')) sellSz = 0;
  }
  const mine = book.mine[row.symbol] || [];
  const klassNow = holdingClass({ qty: Number(pos.long) || 0, mid, minNotional: minUsd, minSize: Number(row.baseMin || row.ordermin || 0) });
  if (klassNow === 'inventory' && state.belowMin) delete state.belowMin[row.symbol];
  if (VENUE !== 'kraken' && sellSz > 0 && askPx * sellSz + 1e-9 < minUsd) {
    markDust(state, row.symbol, mid);
    sellSz = 0;
  } else if (sellSz > 0 && state.belowMin && klassNow === 'inventory') delete state.belowMin[row.symbol];
  const gates = [];
  const gate = (side, why) => {
    if (gates.some((g) => g.startsWith(side + ' '))) return;
    gates.push(side + ' ' + why);
    logGate(state, row.symbol, side, why);
  };
  const netQty = Number(pos.long || 0) - Number(pos.short || 0);
  const hasPos = Number(pos.long || 0) > 0 || Number(pos.short || 0) > 0;
  if (blockOpenBuy && !(Number(pos.short) > 0)) { buySz = 0; if (openBuyWhy) gate('buy', openBuyWhy); }
  if (blockOpenSell && !(Number(pos.long) > 0)) { sellSz = 0; if (openSellWhy) gate('sell', openSellWhy); }
  if (reduce && hasPos) {
    const why = state.halted || rail.mode === 'halt' ? 'halt' : rail.mode === 'cut' ? 'cut' : 'stop';
    if (!(Number(pos.short) > 0)) gate('buy', why);
    if (!(Number(pos.long) > 0)) gate('sell', why);
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
      gate('buy', row.dustBid ? 'dust-budget' : 'budget');
      if (!budget.skipped || !budget.skipped[row.symbol]) {
        budget.skipped = budget.skipped || {};
        budget.skipped[row.symbol] = true;
        console.log('SKIP ' + row.symbol + ' ' + (row.dustBid ? 'dust-budget' : 'budget'));
      }
    } else if (taken.send) {
      buySz = taken.size;
      buyCharged = taken.cost;
      if (row.dustBid && budget) budget.dustLeft = Math.max(0, Number(budget.dustLeft) - taken.cost);
    } else buyHold = true;
  }
  const bidHalf = buySz > 0 ? sentHalfBps(mid, bidPx, 0) : 0;
  const askHalf = sellSz > 0 ? sentHalfBps(mid, 0, askPx) : 0;
  const halfShown = 'b' + (bidHalf || '-') + '/a' + (askHalf || '-');
  const floorPx = Number(pos.long) > 0 ? (costLong || longFloor) : Number(pos.short) > 0 ? (costShort || shortCeil) : 0;
  const floorTxt = pxText(floorPx);
  const sellThrough = !!(risk && Number(pos.long) > 0 && costLong > 0 && askPx + 1e-12 < costLong);
  const buyThrough = !!(risk && Number(pos.short) > 0 && costShort > 0 && bidPx - 1e-12 > costShort);
  const sellRisk = riskTag && Number(pos.long) > 0 ? riskTag : (haltExit && Number(pos.long) > 0 ? 'halt-timeout' : (sellThrough ? risk : ''));
  const buyRisk = riskTag && Number(pos.short) > 0 ? riskTag : (haltExit && Number(pos.short) > 0 ? 'halt-timeout' : (buyThrough ? risk : ''));
  const sellLoss = lossOk && hardLong > 0 && askPx + 1e-12 < hardLong ? Math.round((askPx / longAvg - 1) * 10000) : null;
  const buyLoss = lossOk && hardShort > 0 && bidPx - 1e-12 > hardShort ? Math.round((1 - bidPx / shortAvg) * 10000) : null;
  const sigmaBps = s.sigmaWarmup ? null : Math.round((s.sigma || 0) * 10000);
  const quoteExtra = { halfBps: halfShown, halfSrc: plan.src, floorTxt, sigmaBps, mid };
  const quiet = backoffActive(state, row.symbol) && !rail.ignoreBackoff;
  if (row.dustBid && buySz > 0) {
    state.dustArmed = state.dustArmed || {};
    state.dustArmed[row.symbol] = true;
    console.log('DUST topup ' + row.symbol + ' bid=$' + (buySz * bidPx).toFixed(2));
  }
  if (state.dustArmed && state.dustArmed[row.symbol] && sellSz > 0 && Number(pos.long) > 0) {
    const floor = roundTripFloorPx({ entry: longAvg || mid, side: 'long', feeBps: makerFeeBps, minEdgeBps: MIN_EDGE, tick: inc });
    if (floor > 0 && askPx + 1e-12 < floor) askPx = formatPrice(floor, row.pairDecimals ?? 8);
    state.dustExitLogged = state.dustExitLogged || {};
    if (!state.dustExitLogged[row.symbol]) {
      state.dustExitLogged[row.symbol] = true;
      console.log('DUST exit ' + row.symbol);
    }
  }
  if (quiet) { gate('buy', 'backoff'); gate('sell', 'backoff'); }
  if (cooling) {
    const netNow = Number(pos.long || 0) - Number(pos.short || 0);
    if (opensRisk(netNow, 'buy')) gate('buy', 'cooldown');
    if (opensRisk(netNow, 'sell')) gate('sell', 'cooldown');
  }
  const sellEdge = edgeGate({ px: askPx, floor: Math.max(costLong || 0, oppAsk || 0), side: 'sell', risk: sellRisk });
  const buyEdge = edgeGate({ px: bidPx, floor: Math.max(costShort || 0, oppBid || 0) ? Math.min(...[costShort, oppBid].filter((n) => n > 0)) : 0, side: 'buy', risk: buyRisk });
  if (sellSz > 0 && !sellEdge.ok) { sellSz = 0; gate('sell', sellEdge.why); }
  if (buySz > 0 && !buyEdge.ok) { buySz = 0; gate('buy', buyEdge.why); }
  if (!(buySz > 0) && !gates.some((g) => g.startsWith('buy '))) {
    if (row.dustBid) gate('buy', 'dust-budget');
    else if (state.halted) gate('buy', 'halt');
    else gate('buy', 'budget');
  }
  if (!(sellSz > 0) && !gates.some((g) => g.startsWith('sell '))) {
    const underMin = row.dustBid || klassNow === 'dust' || (state.belowMin && state.belowMin[row.symbol]);
    if (Number(pos.long) > 0 && underMin) gate('sell', 'below-min');
    else if (state.halted && Number(pos.long) > 0) gate('sell', 'halt');
    else if (VENUE === 'kraken' && opensRisk(netQty, 'sell')) gate('sell', 'budget');
  }
  const buyJob = { row, side: 'buy', target: buySz > 0 ? bidPx : 0, size: buySz, mine, lev: buyLev, reduceOnly: reduce && Number(pos.short) > 0, extra: { ...quoteExtra, risk: buyRisk, positionQty: pos.short, lossBps: buyLoss, touch: s.bid, distBps: mid > 0 && s.bid > 0 ? Math.round(Math.abs(bidPx - s.bid) / mid * 10000) : 0, charged: buyCharged, hold: buyHold } };
  const sellJob = { row, side: 'sell', target: sellSz > 0 ? askPx : 0, size: sellSz, mine, lev: sellLev, reduceOnly: reduce && Number(pos.long) > 0, extra: { ...quoteExtra, risk: sellRisk, positionQty: pos.long, lossBps: sellLoss, touch: s.ask, distBps: mid > 0 && s.ask > 0 ? Math.round(Math.abs(askPx - s.ask) / mid * 10000) : 0 } };
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
  for (const orders of Object.values((book && book.mine) || {})) {
    for (const o of orders || []) {
      if (o && Number(o.price) > 0 && Number(o.size) > 0) n += Number(o.price) * Number(o.size);
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

function beginSession(state, equity, reason) {
  const prev = Number(state.startEquity) || 0;
  state.startEquity = equity;
  state.startTime = new Date().toISOString();
  state.transfers = 0;
  state.makerCapture = 0;
  state.fees = 0;
  state.fundingBorrow = 0;
  state.ledgerPnl = 0;
  state.markBasis = 0;
  state.carry = {};
  state.needPnlBasis = true;
  state.halted = null;
  state.haltSwept = false;
  state.haltSince = 0;
  state.haltAt = 0;
  state.haltEquity = 0;
  state.haltNotional = 0;
  state.haltAction = '';
  state.haltPhase = '';
  state.haltLossPlan = {};
  state.flatSince = 0;
  state.resetCapLogged = false;
  state.equityPauseUntil = 0;
  const now = Date.now();
  state.resetTimes = state.resetTimes || [];
  state.resetTimes.push(now);
  state.resetTimes = state.resetTimes.filter((t) => now - t < 48 * 3600 * 1000);
  state.levRamp = { step: 0, lev: RESET_LEV, since: now };
  const day = new Date().toISOString().slice(0, 10);
  if (state.resetDay !== day) { state.resetDay = day; state.sessionResets = 0; }
  state.sessionResets = (Number(state.sessionResets) || 0) + 1;
  console.log('SESSION reset baseline=$' + Number(equity).toFixed(2) + ' prev=$' + prev.toFixed(2) + ' reason=' + reason + ' lev=' + RESET_LEV);
}
function handleControl(state, equity) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(controlPath, 'utf8')); }
  catch { return; }
  const cmd = raw && raw.cmd;
  try { fs.renameSync(controlPath, controlPath.replace(/\.json$/, '.' + Date.now() + '.done')); } catch { /* renamed by a racing loop */ }
  console.log('CONTROL ' + cmd);
  if (cmd === 'reset-session' && equity > 0) beginSession(state, equity, 'control');
  else if (cmd === 'halt') { state.halted = 'manual'; state.haltSwept = false; console.log('HALT manual'); }
  else if (cmd === 'book-transfer') {
    const usd = Number(raw.usd);
    if (usd) bookTransfer(state, { id: 'control-' + Date.now(), type: usd < 0 ? 'withdrawal' : 'deposit', ccy: cfg.quote, amount: usd, usd, time: new Date().toISOString() });
  }
}
function bookIsFlat(book) {
  for (const p of Object.values(book.positions || {})) {
    const qty = Math.abs(Number(p.long || 0) - Number(p.short || 0));
    if (!(qty > 0)) continue;
    const mid = Number(p.mid || p.avgLong || p.avgShort || 0) || (qty > 0 && Number(p.value) > 0 ? Number(p.value) / qty : 0);
    if (positionAboveMin({ qty, mid, minNotional: Number(p.quoteMin || 1), minSize: Number(p.baseMin || 0) })) return false;
  }
  for (const [sym, orders] of Object.entries(book.mine || {})) {
    const p = (book.positions && book.positions[sym]) || {};
    const qty = Math.abs(Number(p.long || 0) - Number(p.short || 0));
    const mid = Number(p.mid || p.avgLong || p.avgShort || 0);
    const real = positionAboveMin({ qty, mid, minNotional: Number(p.quoteMin || 1), minSize: Number(p.baseMin || 0) });
    for (const o of orders || []) {
      if (real) return false;
      const opens = o.side === 'buy' ? !(Number(p.short) > 0) : !(Number(p.long) > 0);
      if (opens) return false;
    }
  }
  return true;
}
function holdInvText(state, book) {
  const parts = [];
  for (const [sym, p] of Object.entries(book.positions || {})) {
    const qty = Math.abs(Number(p.long || 0) - Number(p.short || 0));
    if (!(qty > 0)) continue;
    const entry = state.entry && state.entry[sym];
    const cost = Number(p.long) >= Number(p.short) ? entryAvg(entry, 'long') : entryAvg(entry, 'short');
    parts.push(sym + ':' + qty + '@' + (cost > 0 ? cost : 0));
  }
  return parts.join(',') || '-';
}
function adoptOrphans(state, book) {
  const tracked = new Set();
  for (const slot of Object.values(state.orders || {})) {
    if (slot && slot.bid) tracked.add(slot.bid);
    if (slot && slot.ask) tracked.add(slot.ask);
  }
  state.orphanLogged = state.orphanLogged || {};
  let n = 0;
  for (const [sym, orders] of Object.entries(book.mine || {})) {
    for (const o of orders || []) {
      n += 1;
      if (!o || tracked.has(o.id)) continue;
      if (!state.orphanLogged[o.id]) {
        console.log('ORPHAN ' + o.id);
        state.orphanLogged[o.id] = true;
      }
      const slot = state.orders[sym] || {};
      const free = o.side === 'buy' ? !slot.bid : o.side === 'sell' ? !slot.ask : false;
      if (free) {
        if (o.side === 'buy') { slot.bid = o.id; slot.bidPx = o.price; slot.bidSz = o.size; }
        else { slot.ask = o.id; slot.askPx = o.price; slot.askSz = o.size; }
        state.orders[sym] = slot;
        tracked.add(o.id);
      } else {
        state.orphanCancel = state.orphanCancel || [];
        if (!state.orphanCancel.includes(o.id)) state.orphanCancel.push(o.id);
      }
    }
  }
  return n;
}
function dropStaleOrders(state, book) {
  const live = new Set();
  for (const orders of Object.values((book && book.mine) || {})) {
    for (const o of orders || []) if (o && o.id) live.add(o.id);
  }
  state.staleSeen = state.staleSeen || {};
  for (const [sym, slot] of Object.entries(state.orders || {})) {
    if (!slot) continue;
    for (const side of ['bid', 'ask']) {
      const id = slot[side];
      if (!id) continue;
      if (live.has(id)) { delete state.staleSeen[id]; continue; }
      state.staleSeen[id] = (Number(state.staleSeen[id]) || 0) + 1;
      if (state.staleSeen[id] < 2) continue;
      const px = side === 'bid' ? slot.bidPx : slot.askPx;
      const name = side === 'bid' ? 'buy' : 'sell';
      console.log('ORDER stale ' + sym + ' ' + name + ' ' + px + ' dropped');
      console.log('RECON order ' + id + ' local=open exch=missing → drop');
      slot[side] = null;
      if (side === 'bid') { slot.bidPx = 0; slot.bidSz = 0; }
      else { slot.askPx = 0; slot.askSz = 0; }
      delete state.staleSeen[id];
    }
  }
}
function positionNotional(book) {
  let n = 0;
  for (const p of Object.values((book && book.positions) || {})) {
    const qty = Math.abs(Number(p.long || 0) - Number(p.short || 0));
    const mid = Number(p.mid || p.avgLong || p.avgShort || 0);
    if (qty > 0 && mid > 0) n += qty * mid;
    else if (Number(p.value) > 0) n += Number(p.value);
  }
  return n;
}
function pendingOf(state) {
  const p = state.transferPending;
  if (!p || p.inferred) return 0;
  return Number(p.usd) || 0;
}
function haltEquityNow(equity, state) {
  return (Number(equity) || 0) - pendingOf(state);
}
function lifeBase(state) {
  if (Number(state.capitalBaseline) > 0) return Number(state.capitalBaseline);
  return (Number(state.originEquity) || Number(state.startEquity) || 0) + (Number(state.lifetimeTransfers) || 0);
}
function canAutoReset(state, now) {
  if (state.halted === 'lifetime-dd') return false;
  return resetAllowed({ resets: state.resetTimes || [], now, max: MAX_RESETS, windowMs: 24 * 3600 * 1000 });
}
function noteHaltStart(state, now, book) {
  if (!(state.haltAt > 0)) state.haltAt = state.haltSince > 0 ? state.haltSince : now;
  if (!(state.haltSince > 0)) state.haltSince = state.haltAt;
  if (!(state.haltEquity > 0)) state.haltEquity = haltEquityNow(book.equity, state);
  if (!(state.haltNotional > 0)) state.haltNotional = positionNotional(book);
}
function ensureBaseline(state, equity) {
  if (Number(state.capitalBaseline) > 0 && Number(state.originEquity) > 0) return;
  const origin = Number(state.originEquity) > 0 ? Number(state.originEquity) : (Number(state.startEquity) > 0 ? Number(state.startEquity) : equity);
  state.originEquity = origin;
  const already = Number(state.lifetimeTransfers);
  state.lifetimeTransfers = Number.isFinite(already) ? already : (Number(state.transfers) || 0);
  state.capitalBaseline = origin + Number(state.lifetimeTransfers);
}
function migrateV9(state) {
  if (state.specV9) return;
  state.specV9 = true;
  state.cbTxCursor = {};
  state.cbTransferBooted = false;
  state.transferSourceLogged = '';
  if (!(state.resetTimes || []).length && (state.sessionResets || 0) > 0) state.resetTimes = [Date.now()];
  if (!state.levRamp) state.levRamp = { step: 0, lev: RESET_LEV, since: Date.now() };
  state.equityPauseUntil = 0;
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
  if (state.pnlModel !== 4 && state.pnlModel !== 5) {
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
  if (state.pnlModel !== 5) {
    state.needPnlBasis = true;
    state.pnlModel = 5;
    console.log('PNL equity model 5, marked equity');
  }
  migrateV9(state);
  await loadMakerFee();
  let feeAt = Date.now();
  for (;;) {
    try {
      if (Date.now() - productsAt > 3600 * 1000) { products = await ex.getProducts(VENUE); productsAt = Date.now(); }
      if (Date.now() - feeAt > 3600 * 1000) { await loadMakerFee(); feeAt = Date.now(); }
      let book = VENUE === 'kraken' ? await krakenBook(state) : await coinbaseBook(state, products);
      state.ordersSyncedAt = Date.now();
      if (!(state.startEquity > 0) && book.equity > 0) state.startEquity = book.equity;
      ensureBaseline(state, book.equity);
      const now = Date.now();
      const eqRisk = haltEquityNow(book.equity, state);
      const sessionLoss = lossPct(state.startEquity, eqRisk, state.transfers);
      state.equityMarks = state.equityMarks || [];
      if (!state.equityMarks.length || now - state.equityMarks[state.equityMarks.length - 1].t > 60000) {
        state.equityMarks.push({ t: now, eq: eqRisk });
      }
      state.equityMarks = state.equityMarks.filter((m) => now - m.t < 26 * 3600 * 1000);
      const dayBase = (state.equityMarks.find((m) => now - m.t >= 24 * 3600 * 1000) || state.equityMarks[0] || {}).eq || state.startEquity;
      const dayLoss = lossPct(dayBase, eqRisk, 0);
      const life = lifetimePct({ equity: eqRisk, baseline: lifeBase(state) });
      if (!state.halted && lifetimeHalt({ equity: eqRisk, baseline: lifeBase(state), ddPct: LIFETIME_DD })) {
        state.halted = 'lifetime-dd';
        state.haltSince = now;
        state.haltAt = now;
        console.log('HALT lifetime-dd');
      }
      if (!state.halted && (sessionLoss >= SESSION_LOSS || dayLoss >= DAY_LOSS)) {
        state.halted = sessionLoss >= SESSION_LOSS ? 'session-loss' : 'day-loss';
        state.haltSince = now;
        state.haltAt = now;
        console.log('HALT ' + state.halted);
      }
      if (!state.halted && book.ml != null && book.ml < ML_HALT) {
        state.halted = 'margin-halt';
        state.haltSince = now;
        state.haltAt = now;
        console.log('HALT margin-halt ml=' + book.ml);
      }
      if (state.halted) noteHaltStart(state, now, book);
      if (state.halted && !(state.haltSince > 0)) state.haltSince = now;
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
      handleControl(state, book.equity);
      const resetDay = new Date().toISOString().slice(0, 10);
      if (state.resetDay !== resetDay) { state.resetDay = resetDay; state.sessionResets = 0; state.resetCapLogged = false; }
      if (state.halted === 'day-loss' && dayLoss < DAY_LOSS && book.equity > 0 && !state.transferPending) beginSession(state, book.equity, 'day-window');
      if (state.halted === 'session-loss') {
        state.haltPhase = haltPhase({ halted: 'session-loss', since: state.haltAt || state.haltSince, now, holdMs: HALT_HOLD_MS, maxMs: HALT_MAX_MS });
        if (bookIsFlat(book)) {
          if (!state.flatSince) state.flatSince = now;
          if (now - state.flatSince >= HALT_COOLDOWN) {
            if (canAutoReset(state, now) && book.equity > 0) beginSession(state, book.equity, 'flat-cooldown');
            else if (!state.resetCapLogged) { console.log('SESSION reset capped'); state.resetCapLogged = true; }
          }
        } else {
          state.flatSince = 0;
          if (state.haltPhase === 'C' && canAutoReset(state, now) && book.equity > 0) {
            beginSession(state, book.equity, 'hold-timeout inv=' + holdInvText(state, book));
          } else if (state.haltPhase === 'C' && !state.resetCapLogged) {
            console.log('SESSION reset capped');
            state.resetCapLogged = true;
          }
        }
      } else if (state.halted === 'lifetime-dd') {
        state.haltPhase = 'C';
        if (!state.resetCapLogged) { console.log('SESSION reset capped'); state.resetCapLogged = true; }
      } else state.haltPhase = '';
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
        forceTouch: mode === 'stop' || mode === 'cut' || !!state.cutLatch || state.halted === 'day-loss' || state.halted === 'margin-halt',
        halfSize: mode === 'cut',
        ignoreBackoff: mode === 'cut' || mode === 'halt' || !!state.halted || !!state.cutLatch,
        lossOk: mode === 'cut' || !!state.cutLatch || state.halted === 'day-loss' || state.halted === 'margin-halt',
        focus: null,
        defer: { sells: [], buys: [] },
        margin: { used: usedMargin(book), slots: MAX_PAIRS * 2 },
      };
      if (mode === 'stop' && !state.cutLatch && maxBackoffN(state) >= 3 && !exitResting(book)) {
        rail.halfSize = true;
        rail.focus = largestSymbol(book.positions);
      }
      const fillsBefore = Number(state.fillCount) || 0;
      clearFlatEntry(state, book.positions);
      const seedMids = {};
      for (const [sym, p] of Object.entries(book.positions || {})) if (p.mid > 0) seedMids[sym] = p.mid;
      try { await pollFills(state, seedMids); } catch (e) { console.warn('fills', e.message); }
      try { await pollTransfers(state, book.positions); } catch (e) { console.warn('ledgers', e.message); }
      const quietBook = (Number(state.fillCount) || 0) === fillsBefore && !(state.transferThisLoop);
      const jump = unexplainedJump({ prev: state.prevEquity, next: book.equity, quiet: quietBook });
      if (jump) console.log('EQUITY jump unexplained $' + jump.toFixed(2));
      if (!state.bootJumpChecked) {
        state.bootJumpChecked = true;
        const boot = unexplainedJump({ prev: state.lastEquity, next: book.equity, quiet: true });
        if (boot && !state.transferPending) state.transferPending = { usd: boot, since: now };
      }
      if (state.transferPending && !state.inferredOpen && now - Number(state.transferPending.since || now) >= XFER_PENDING_MS) {
        const usd = Number(state.transferPending.usd);
        if (usd) bookTransfer(state, { id: 'inferred-' + state.transferPending.since, type: usd < 0 ? 'withdrawal' : 'deposit', ccy: cfg.quote, amount: usd, usd, inferred: true, time: new Date().toISOString() });
      }
      state.prevEquity = book.equity;
      state.lastEquity = book.equity;
      const addOk = !state.halted && !state.onRail;
      if (state.halted) {
        const eqNow = haltEquityNow(book.equity, state);
        const notion = positionNotional(book);
        const action = (state.halted === 'day-loss' || state.halted === 'lifetime-dd')
          ? 'cap-exit'
          : haltRiskAction({
            notional: notion, equity: book.equity, haltEquity: state.haltEquity, equityNow: eqNow,
            ageH: state.haltAt ? (now - state.haltAt) / 3600000 : 0,
            maxLev: HALT_MAX_LEV, extraLossPct: HALT_EXTRA_LOSS, maxHoldH: HALT_MAX_HOLD_H,
          });
        state.haltAction = action;
        const loss = (Number(state.haltEquity) || eqNow) - eqNow;
        const pct = state.haltEquity > 0 ? loss / state.haltEquity * 100 : 0;
        if (action !== state.haltActionLogged || now - (state.haltRiskLog || 0) > 3600 * 1000) {
          console.log('HALT risk notional=$' + notion.toFixed(2) + ' lev=' + (eqNow > 0 ? (notion / eqNow).toFixed(2) : '-') + ' haltLoss=$' + loss.toFixed(2) + ' (' + pct.toFixed(1) + '%) action=' + action);
          state.haltActionLogged = action;
          state.haltRiskLog = now;
        }
      } else {
        state.haltAction = '';
        const ramp = state.levRamp || { step: 0, lev: RESET_LEV, since: now };
        const since = Number(ramp.since) || now;
        const trips = (state.recentTrips || []).filter((t) => t.t >= since);
        const lost = trips.some((t) => Number(t.net) < 0);
        const positive = trips.some((t) => Number(t.net) > 0) && !lost;
        const next = leverageNotch({ step: ramp.step || 0, elapsedMs: now - since, positive, lost, maxLev: LEV_CAP || 10 });
        if (lost) state.levRamp = { step: ramp.step || 0, lev: next.lev, since: now };
        else if (next.advanced) state.levRamp = { step: next.step, lev: next.lev, since: now };
        else state.levRamp = { step: ramp.step || 0, lev: next.lev, since };
      }
      dropStaleOrders(state, book);
      for (const id of state.orphanCancel || []) {
        console.log('ORPHAN cancel ' + id);
        if (LIVE) { try { await ex.cancelOrder(id, VENUE); } catch { /* next loop */ } }
      }
      state.orphanCancel = [];
      const levGuess = VENUE === 'kraken' ? ((state.levRamp && state.levRamp.lev) || RESET_LEV) : 1;
      const clip = clipFor(book.equity, levGuess);
      const chosen = await select(products, book, state);
      let dustAdded = 0;
      for (const d of state.dustWatch || []) {
        if (dustAdded >= DUST_COMBINE_MAX) break;
        if (!d.edgeOk) continue;
        const topup = dustTopupUsd({ dustUsd: d.dustUsd, venueMin: Number(d.quoteMin || 1) });
        if (!(topup > 0)) continue;
        chosen.push(d);
        dustAdded += 1;
      }
      const chosenSet = new Set(chosen.map((r) => r.symbol));
      for (const sym of Object.keys(state.orders || {})) {
        if (chosenSet.has(sym)) continue;
        const pos = (book.positions && book.positions[sym]) || {};
        if (Number(pos.long) > 0 || Number(pos.short) > 0) continue;
        for (const o of (book.mine && book.mine[sym]) || []) {
          console.log('CANCEL dropped ' + sym + ' ' + o.id);
          if (LIVE) { try { await ex.cancelOrder(o.id, VENUE); } catch { /* next loop */ } }
        }
        delete state.orders[sym];
      }
      const halve = now < (state.budgetHalveUntil || 0);
      let budgetLeft = Number(book.cash || 0);
      let slotN = MAX_PAIRS;
      if (VENUE === 'coinbase') {
        const heldBuys = restingBuyNotional(book.mine);
        const reserve = Math.max(Number(book.equity || 0) * 0.01, 0.1);
        budgetLeft = cashBudget({ free: book.cash, restingCost: heldBuys, equity: book.equity, halve, netOfHolds: true });
        let askCover = 0;
        let dustNow = 0;
        for (const p of Object.values(book.positions || {})) {
          const qty = Number(p.long || 0);
          const px = Number(p.mid || 0);
          const usd = qty > 0 && px > 0 ? qty * px : 0;
          const klass = holdingClass({ qty, mid: px, minNotional: Number(p.quoteMin || 1) });
          if (klass === 'inventory') askCover += usd;
          else if (klass === 'dust') dustNow += usd;
        }
        const room = tradableBookTarget({ equity: book.equity, dust: dustNow, reserve, frac: BOOK_TARGET, askCover });
        budgetLeft = Math.min(Math.max(0, budgetLeft), room.bidRoom);
        slotN = bookSlotsScaled({ budget: budgetLeft, venueMin: 1, maxPairs: CB_MAX_PAIRS });
        if (Math.abs(budgetLeft - (state.lastBudget ?? budgetLeft)) >= 1) {
          console.log('BOOK replan budget=$' + budgetLeft.toFixed(2) + ' slots=' + slotN);
        }
        state.lastBudget = budgetLeft;
        console.log('BUDGET free=' + Number(book.cash || 0).toFixed(2) + ' held=' + heldBuys.toFixed(2) + ' reserve=' + reserve.toFixed(2) + ' → b=' + budgetLeft.toFixed(2));
      }
      const budget = { left: Math.max(0, budgetLeft), slots: Math.max(1, slotN || 1), dustLeft: Math.max(0, budgetLeft) * 0.25 };
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
      const explained = (Number(state.fillCount) || 0) !== fillsBefore || !!state.transferThisLoop;
      const rawResid = pnlResidual({
        equity: book.equity, startEquity: state.startEquity || book.equity, transfers: state.transfers || 0,
        netMaker, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
      });
      const trig = pendingTrigger({ resid: rawResid, equity: book.equity, fillDelta: explained ? 1 : 0 });
      if (trig && !state.transferPending && !state.inferredOpen) {
        state.transferPending = { usd: trig, since: now };
        console.log('TRANSFER pending $' + Number(trig).toFixed(2) + ' (resid, no fills)');
      }
      const pend = pendingOf(state);
      const equityAdj = book.equity - pend - (state.startEquity || book.equity) - (state.transfers || 0);
      const resid = pnlResidual({
        equity: book.equity - pend, startEquity: state.startEquity || book.equity, transfers: state.transfers || 0,
        netMaker, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
      });
      if (book.equity > 0 && Math.abs(resid) > 0.02 && now - (state.reconLogAt || 0) > 3600 * 1000) {
        const m5 = markoutAvg(state, 'm5');
        console.log('RECON drift parts=resid=' + resid.toFixed(2) + ' dust=$' + dustUsd.toFixed(2) + ' inv=$' + inv.toFixed(2) + ' fund=$' + (state.fundingBorrow || 0).toFixed(2) + ' fees=$' + (state.fees || 0).toFixed(2) + ' markout5=' + (m5 == null ? '-' : m5.toFixed(1)));
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
      const exBase = Math.max(0, book.equity - dustUsd);
      const bookEx = exBase > 0 ? openNotional / exBase : 0;
      const exDustEq = Math.max(0, book.equity - dustUsd);
      if (exDustEq > 1 && book.cash > 0.5 * exDustEq) {
        if (!state.idleSince) state.idleSince = now;
        const mins = (now - state.idleSince) / 60000;
        if (mins > 15 && now - (state.idleLogAt || 0) > 10 * 60 * 1000) {
          state.idleLogAt = now;
          const why = (state.lastRejects || []).slice(0, 4).join(',') || 'no-candidate';
          console.log('IDLE free=$' + book.cash.toFixed(2) + ' (' + Math.round(100 * book.cash / exDustEq) + '%) for=' + mins.toFixed(0) + ' min reason=' + why);
        }
        if (mins > 60 && !(state.scanRelax && state.scanRelax.relaxed)) {
          state.scanRelax = idleRelax({ idleMin: mins, minEdgeBps: MIN_EDGE, volFloor: MIN_VOL });
          state.relaxStep = (Number(state.relaxStep) || 0) + 1;
          console.log('SCAN relax step=' + state.relaxStep);
        }
      } else state.idleSince = 0;
      if (bookEx >= 0.8) {
        if (!state.bookOkSince) state.bookOkSince = now;
        if (state.scanRelax && now - state.bookOkSince > 30 * 60 * 1000) state.scanRelax = null;
      } else state.bookOkSince = 0;
      const tracked = adoptOrphans(state, book);
      if (VENUE !== 'kraken' && budgetLeft + 1e-9 < 1 && dustUsd >= 0.3 * Number(book.equity || 0) && now - (state.starvedLogAt || 0) > 3600 * 1000) {
        console.log('BUDGET starved dust=$' + dustUsd.toFixed(2));
        state.starvedLogAt = now;
      }
      if (now - (state.dustStuckAt || 0) > 3600 * 1000) {
        for (const d of state.dustWatch || []) {
          if (!(d.dustUsd > 0)) continue;
          if (!d.edgeOk || Number(d.quoteMin || 1) > 10 * Number(d.dustUsd || 0)) console.log('dust-stuck ' + d.symbol + ' $' + Number(d.dustUsd).toFixed(2));
        }
        for (const m of markets) {
          const ps = (state.pairStats && state.pairStats[m.symbol]) || {};
          console.log('PAIR ' + m.symbol + ' fills=' + (ps.fills || 0) + ' capture=' + Number(ps.capture || 0).toFixed(2) + ' fees=' + Number(ps.fees || 0).toFixed(2) + ' realized=' + Number(ps.realized || 0).toFixed(2) + ' half=' + m.halfBps + ' need=' + Math.round(openingNeedBps()));
        }
        const gateN = Object.values(state.gateCounts || {}).reduce((s, n) => s + Number(n || 0), 0);
        console.log('GATES n=' + gateN);
        state.gateCounts = {};
        state.dustStuckAt = now;
      }
      pruneState(state, book, now);
      saveState(state);
      postStatus({
        bot: process.env.BOT, exchange: VENUE, quote: cfg.quote,
        pnl: {
          startEquity: state.startEquity, startTime: state.startTime, lastEquity: book.equity,
          transfers: state.transfers || 0, equityAdj, makerCapture: state.makerCapture || 0,
          fees: state.fees || 0, inventoryPnl: inv, fundingBorrow: state.fundingBorrow || 0,
          recon: resid, resid, fills: fillsN, fillsHour: fillsH,
          netMaker, pricePnl: inv, sessionStart: state.startTime, sessionResets: state.sessionResets || 0,
          capitalBaseline: lifeBase(state), lifetimePct: lifetimePct({ equity: haltEquityNow(book.equity, state), baseline: lifeBase(state) }) * 100,
          ordersSyncedAt: state.ordersSyncedAt || now,
        },
        rails: {
          ml: book.ml, liqDistPct: LIQ_MIN * 100, sessionLossPct: sessionLoss * 100,
          dayLossPct: dayLoss * 100, halted: state.halted || null, haltPhase: state.haltPhase || null,
          haltAgeH: (state.haltAt || state.haltSince) ? (now - (state.haltAt || state.haltSince)) / 3600000 : 0,
          haltLoss: state.halted ? (Number(state.haltEquity) || 0) - haltEquityNow(book.equity, state) : 0,
          levBySymbol, onRail: !!state.onRail, lifetimePct: lifetimePct({ equity: haltEquityNow(book.equity, state), baseline: lifeBase(state) }) * 100,
        },
        bookFrac: (state.ordersSyncedAt && now - state.ordersSyncedAt > 2 * LOOP) ? null : bookFrac,
        bookStale: !!(state.ordersSyncedAt && now - state.ordersSyncedAt > 2 * LOOP),
        dust, markets, sessionStart: state.startTime, sessionResets: state.sessionResets || 0,
      });
      const line = markets.map((m) => m.symbol + ' q=' + m.q.toFixed(2) + ' half=' + m.halfBps + 'bp' + (m.halfSrc ? '/' + m.halfSrc : '') + ' sig=' + (m.sigmaBps == null ? 'warmup' : m.sigmaBps + 'bp') + ' floor=' + (m.floorTxt || '-')).join(' ');
      const ageH = ((now - (state.haltAt || state.haltSince || now)) / 3600000);
      const hLoss = state.halted ? ((Number(state.haltEquity) || 0) - haltEquityNow(book.equity, state)) : 0;
      const haltTxt = state.halted ? ' halt=' + state.halted + ' phase=' + (state.haltPhase || '-') + ' age=' + ageH.toFixed(1) + 'h haltLoss=$' + hLoss.toFixed(2) : '';
      const xferTxt = state.transferBlind ? ' xfer=blind' : (pend ? ' xfer=pending $' + pend.toFixed(2) : '');
      const idleTxt = state.idleSince && now - state.idleSince > 15 * 60 * 1000 ? ' idle=' + ((now - state.idleSince) / 60000).toFixed(0) + 'm' : '';
      const lifeTxt = lifeText({ equity: haltEquityNow(book.equity, state), baseline: lifeBase(state) });
      const bookLabel = (state.ordersSyncedAt && now - state.ordersSyncedAt > 2 * LOOP) ? 'book=stale' : ('book=' + Math.round(bookFrac * 100) + '% (ex-dust ' + Math.round(bookEx * 100) + '%)');
      console.log('  AS eq=$' + book.equity.toFixed(2) + ' free=$' + book.cash.toFixed(2) + ' adj=$' + equityAdj.toFixed(2) + ' ' + lifeTxt + ' maker=$' + (state.makerCapture || 0).toFixed(2) + ' fees=$' + (state.fees || 0).toFixed(2) + ' inv=$' + invUsd.toFixed(2) + ' (' + invN + ') dust=$' + dustUsd.toFixed(2) + ' (' + dustN + ') fund=$' + (state.fundingBorrow || 0).toFixed(2) + ' resid=$' + resid.toFixed(2) + ' fills=' + fillsN + '/' + fillsH + ' ' + bookLabel + ' tracked=' + tracked + ' lev=' + (Object.values(levBySymbol)[0] || (state.levRamp && state.levRamp.lev) || 0) + ' ml=' + (book.ml == null ? '-' : book.ml) + haltTxt + xferTxt + idleTxt + ' | ' + (line || 'no names'));
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
