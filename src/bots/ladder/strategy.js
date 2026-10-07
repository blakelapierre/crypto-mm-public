import { setTimeout as sleep } from 'timers/promises';
import { formatPrice, calculateVolume, formatVolume } from '../../shared/sizing.js';
import { applySpreadFromFees, joinTouchForPair, assumedMakerFeeBps, realizedFeeBps } from '../../shared/fee-spread.js';
import { sizeWeightForSymbol, volStatsForSymbol } from '../../shared/vol-scan.js';
import { tapeSizeMult, tapeEdgeBps, markRipSell, inRipCooldown } from '../../shared/pair-tape.js';
import { backtestRungs } from '../../shared/rungs.js';
import { midRing, noteMid, midReturn, midRangePct } from '../../shared/mid-ring.js';
import { postOrders } from '../../shared/status-client.js';
import { nnQuote } from '../../ml/infer-quote.js';
import { logEvent } from '../../shared/fill-log.js';
import { invalidateLiveCache } from '../../shared/portfolio.js';
import { noteHoldExit, holdBasis } from '../../shared/hold-pnl.js';
import { noteCapture } from '../../shared/inside-fee.js';
import { freeQty, cooled } from '../../shared/free-qty.js';



function publishOrders(a, ladder, mid) {
  if (!a || !ladder) return;
  const legs = [...(ladder.buys || []), ...(ladder.sells || [])];
  const orders = legs.filter((o) => o.status === 'open').map((o) => ({
    side: o.side, level: o.level, size: o.size, price: o.price, status: o.status,
    usd: Number(o.size) * Number(o.price), id: o.orderId ? String(o.orderId).slice(0, 8) : '',
  }));
  postOrders(a.symbol, orders, { mid, pair: a.pair });
}
function rangeFrac(symbol) {
  const vs = volStatsForSymbol(symbol);
  return vs && vs.rangePct > 0 ? vs.rangePct / 100 : 0;
}
function liveRangeFrac(symbol) {
  const pct = midRangePct(symbol, Number(process.env.LIVE_WEIGHT_MS || 60000));
  return pct > 0 ? pct / 100 : 0;
}
function deadTape(symbol) {
  return liveRangeFrac(symbol) < Number(process.env.DEAD_RANGE_PCT || 0.0035);
}
function riseStrength(symbol) {
  const r1 = midReturn(symbol, Number(process.env.LIVE_WEIGHT_MS || 60000));
  const r15 = midReturn(symbol);
  if (r1 <= 0 && r15 <= 0) return 0;
  return Math.max(0, r1, r15 * 0.25);
}
function riseHoldFrac(symbol) {
  const s = riseStrength(symbol);
  if (!(s > 0) || deadTape(symbol)) return 0;
  const base = Number(process.env.RISE_INV_HOLD || 0.08);
  const extra = Math.min(0.17, s * 10);
  return Math.min(Number(process.env.RISE_INV_HOLD_MAX || 0.25), base + extra);
}
function rungHint(pair, symbol) {
  if (String(process.env.RUNG_BACKTEST || '1') === '0') return null;
  return backtestRungs(midRing(symbol), realizedFeeBps(pair));
}
function ladderLevelCount(cfg, range, hint = null, symbol = null) {
  if (symbol && deadTape(symbol)) return 1;
  if (hint && hint.levels && !(symbol && deadTape(symbol))) return hint.levels;
  let n = cfg.mmLevels || 1;
  if (range >= Number(process.env.MM_VOL_RANGE_MIN || 0.02)) n = Math.max(n, Number(process.env.MM_VOL_LEVELS || 3));
  return n;
}
function gridStep(cfg, pair, symbol) {
  const hint = rungHint(pair, symbol);
  const feeStep = applySpreadFromFees(cfg, pair) / 10000;
  if (hint && hint.stepBps) return Math.max(feeStep, hint.stepBps / 10000);
  const range = rangeFrac(symbol);
  const levels = ladderLevelCount(cfg, range, hint, symbol);
  const widen = Number(process.env.MM_RANGE_WIDEN || 0.5);
  let step = feeStep * (1 + range * widen / Math.max(feeStep, 1e-6) * 0.01);
  step = Math.max(feeStep, step);
  if (range >= Number(process.env.MM_VOL_RANGE_MIN || 0.02)) step = Math.max(step, range / (levels * 2 + 2));
  return step;
}
function inventoryUsd(live, symbol) {
  const pos = live && live.positions && live.positions[symbol];
  return Number((pos && pos.valueQuote) || 0);
}
function capFor(live, symbol) {
  const eq = Number((live && live.totalEquity) || 0);
  const rising = midReturn(symbol) > 0 && !deadTape(symbol);
  const frac = rising
    ? Number(process.env.RISE_COIN_CAP_PCT || 0.25)
    : Number(process.env.INV_NAME_MAX_FRAC || process.env.INV_CAP_FRAC || 0.25);
  return Math.max(0, eq * frac);
}
const pendingBids = new Map();
let allocPlan = null;
function allocFor(symbol) {
  if (!allocPlan || !allocPlan.alloc) return 0;
  return Number(allocPlan.alloc[symbol] || 0);
}
export function bookPlan() { return allocPlan; }
function pendingBidUsd(symbol) {
  const row = pendingBids.get(String(symbol || '').toUpperCase());
  if (!row) return 0;
  if (Date.now() - row.at > 15000) { pendingBids.delete(String(symbol || '').toUpperCase()); return 0; }
  return row.usd;
}
function notePendingBid(symbol, usd) {
  const k = String(symbol || '').toUpperCase();
  pendingBids.set(k, { usd: Number(usd) || 0, at: Date.now() });
}
function clearPendingBid(symbol) {
  pendingBids.delete(String(symbol || '').toUpperCase());
}
function allPendingBidUsd() {
  let s = 0;
  const now = Date.now();
  for (const [k, row] of pendingBids) {
    if (!row || now - row.at > 15000) { pendingBids.delete(k); continue; }
    s += Number(row.usd) || 0;
  }
  return s;
}
function openOrderNotional() {
  let bids = 0;
  let asks = 0;
  if (livePairState) {
    for (const st of livePairState.values()) {
      for (const b of (st.ladder && st.ladder.buys) || []) {
        if (b.status === 'open') bids += Number(b.price) * Number(b.size);
      }
      for (const s of (st.ladder && st.ladder.sells) || []) {
        if (s.status === 'open') asks += Number(s.price) * Number(s.size);
      }
    }
  }
  return { bids, asks, book: bids + asks };
}
function deployBookUsd() {
  return openOrderNotional().book + allPendingBidUsd();
}
function bookTargetFor(eq) {
  return Math.max(0, Number(eq) || 0) * Number(process.env.BOOK_TARGET_FRAC || 0.90);
}
// Account deploy goal is book ≈ equity. Cash floor yields when the book is short and one clip of cash is free.
function cashFloorBlocks(live) {
  const eq = Number(live && live.totalEquity || 0);
  const free = Number(live && live.freeQuote || 0);
  if (!(eq > 0)) return false;
  const floor = Number(process.env.CASH_FLOOR_FRAC || 0.10);
  if (free / eq >= floor) return false;
  const clip = Number(process.env.CLIP_MAX_USD || 1.5);
  if (bookTargetFor(eq) - deployBookUsd() > 0 && free >= clip) return false;
  return true;
}
function inventoryCost(live, symbol) {
  const pos = live && live.positions && live.positions[symbol];
  const qty = Number((pos && pos.amount) || 0) + Number((pos && pos.hold) || 0);
  const basis = holdBasis(symbol);
  const px = basis > 0 ? basis : Number((pos && pos.mid) || 0);
  return qty * (px > 0 ? px : 0);
}
function costHeld(live, symbol) {
  const open = openBidUsd(symbol);
  const pend = pendingBidUsd(symbol);
  return inventoryCost(live, symbol) + open + (open > 0 ? 0 : pend);
}
function ret5m(symbol) { return midReturn(symbol, 5 * 60 * 1000); }
function offHigh15(symbol) {
  const ring = midRing(symbol);
  const cut = Date.now() - 15 * 60 * 1000;
  let hi = 0;
  let last = 0;
  for (const x of ring) {
    if (!x || x.t < cut || !(x.p > 0)) continue;
    if (x.p > hi) hi = x.p;
    last = x.p;
  }
  if (!(hi > 0) || !(last > 0)) return 0;
  return (hi - last) / hi;
}
const bidWhyAt = new Map();
const bidClearSince = new Map();
function bidShape(symbol, live) {
  let offMult = 1;
  let sizeMult = 1;
  const clip = Number(process.env.CLIP_MAX_USD || 1.5);
  const inv = live ? inventoryUsd(live, symbol) : 0;
  const r5 = ret5m(symbol);
  const veto = Number(process.env.TREND_VETO_5M || -0.025);
  const shapeAt = Number(process.env.TREND_BID_MIN_5M || -0.01);
  const mult = Number(process.env.TREND_SHAPE_MULT || 2);
  if (r5 < shapeAt && r5 >= veto) { offMult *= mult; sizeMult *= 0.5; }
  const peaked = offHigh15(symbol) >= Number(process.env.PEAK_OFF_PCT || 0.015) && midReturn(symbol, 60000) <= 0;
  if (peaked && inv < clip) { offMult *= mult; sizeMult *= 0.5; }
  return { offMult, sizeMult };
}
export function hardBidVeto(a, live) {
  const sym = a && a.symbol;
  if (!sym) return '';
  if (!liveTapeReady(sym)) return 'tape';
  if (ret5m(sym) < Number(process.env.TREND_VETO_5M || -0.025)) return 'trend';
  const clip = Number(process.env.CLIP_MAX_USD || 1.5);
  const invUsd = live ? inventoryUsd(live, sym) : 0;
  if (offHigh15(sym) >= Number(process.env.PEAK_OFF_PCT || 0.015) && midReturn(sym, 60000) <= 0 && invUsd >= clip) return 'peak';
  if (live) {
    const cap = capFor(live, sym);
    if (cap > 0 && inventoryCost(live, sym) >= cap) return 'cap';
  }
  if (inRipCooldown(sym)) return 'rip';
  return '';
}
export function bidGate(a, live) {
  // Hard vetoes only. Trend/peak otherwise shape price and size. Sibling and cash are not vetoes.
  const sym = a && a.symbol;
  const shape = bidShape(sym, live);
  if (!sym) return { ok: true, reason: '', shape };
  const st = livePairState && [...livePairState.values()].find((s) => s.symbol === sym);
  if (st && st.parked) return { ok: false, reason: 'park', shape };
  const reason = hardBidVeto(a, live);
  if (reason) return { ok: false, reason, shape };
  return { ok: true, reason: '', shape };
}
function bidAllowed(a, live) {
  const g = bidGate(a, live);
  const prev = bidWhyAt.get(a.symbol);
  if (!g.ok) {
    if (!prev || prev.reason !== g.reason) console.log('  BID BLOCK ' + a.symbol + ' reason=' + g.reason);
    bidWhyAt.set(a.symbol, { reason: g.reason, at: Date.now() });
    bidClearSince.delete(a.symbol);
    return g;
  }
  if (prev && prev.reason) {
    const since = bidClearSince.get(a.symbol) || Date.now();
    if (!bidClearSince.has(a.symbol)) bidClearSince.set(a.symbol, since);
    if (Date.now() - since < Number(process.env.BID_GATE_HYST_MS || 30000)) return { ok: false, reason: prev.reason };
    bidWhyAt.delete(a.symbol);
    bidClearSince.delete(a.symbol);
  }
  return g;
}
export function quoteSnap(a, ladder, live) {
  const buys = ((ladder && ladder.buys) || []).filter((o) => o.status === 'open');
  const sells = ((ladder && ladder.sells) || []).filter((o) => o.status === 'open');
  const g = a ? bidGate(a, live) : { ok: true, reason: '' };
  let askWhy = '';
  if (!sells.length && a) {
    const pos = live && live.positions && live.positions[a.symbol];
    const amt = Number((pos && pos.amount) || 0) + Number((pos && pos.hold) || 0);
    const free = freeQty(a.symbol, Number((pos && pos.amount) || 0));
    const bid = Number((pos && pos.mid) || 0);
    const quoteMin = Number((pos && pos.quoteMin) || (a && a.quoteMin) || 1);
    const baseMin = Number((pos && (pos.baseMin || pos.ordermin)) || (a && a.ordermin) || 0);
    const inc = Number((pos && pos.baseInc) || (a && a.baseInc) || 0);
    const qty = inc > 0 ? Math.floor((free + 1e-12) / inc) * inc : free;
    const bidPx = Number((pos && pos.bestBid) || bid || 0);
    const tradable = qty + 1e-12 >= baseMin && (bidPx > 0 ? qty * bidPx + 1e-12 >= quoteMin : false);
    const raw = Number((pos && pos.amount) || 0) + Number((pos && pos.hold) || 0);
    const rawQty = inc > 0 ? Math.floor((raw + 1e-12) / inc) * inc : raw;
    const rawTradable = rawQty + 1e-12 >= baseMin && bidPx > 0 && rawQty * bidPx + 1e-12 >= quoteMin;
    if (!(amt > 0) && !(free > 0)) askWhy = 'noInv';
    else if (cooled(a.pair, 'sell')) askWhy = 'cooled';
    else if (!tradable && rawTradable && free + 1e-8 < raw * 0.5) askWhy = 'clamp';
    else if (!tradable) askWhy = 'belowMin';
    else {
      askWhy = 'pending';
      const k = a.symbol;
      const now = Date.now();
      quoteSnap._miss = quoteSnap._miss || {};
      if (!quoteSnap._miss[k]) quoteSnap._miss[k] = now;
      const ensure = Number(process.env.ASK_ENSURE_MS || 60000);
      if (now - quoteSnap._miss[k] > ensure && now - (quoteSnap._at && quoteSnap._at[k] || 0) > 60000) {
        quoteSnap._at = quoteSnap._at || {};
        quoteSnap._at[k] = now;
        console.log('  ASK MISSING ' + a.symbol);
      }
    }
  } else if (a) {
    if (quoteSnap._miss) delete quoteSnap._miss[a.symbol];
  }
  return { bids: buys.length, asks: sells.length, bidWhy: buys.length ? '' : g.reason, askWhy };
}
function openBidUsd(symbol) {
  let s = 0;
  if (!livePairState) return s;
  for (const st of livePairState.values()) {
    if (st.symbol !== symbol) continue;
    for (const b of (st.ladder && st.ladder.buys) || []) {
      if (b.status === 'open') s += Number(b.price) * Number(b.size);
    }
  }
  return s;
}
function inventorySkew(live, symbol) {
  const cap = capFor(live, symbol);
  if (!(cap > 0)) return 0;
  return Math.max(0, Math.min(1, costHeld(live, symbol) / cap));
}
function exitStep(cfg, pair, symbol) {
  const feeStep = applySpreadFromFees(cfg, pair) / 10000;
  const range = rangeFrac(symbol);
  const frac = Number(process.env.MM_RANGE_EXIT_FRAC || 0.4);
  if (range >= Number(process.env.MM_VOL_RANGE_MIN || 0.02)) return Math.max(feeStep, range * frac);
  return feeStep;
}

export function generateLadder(cfg, mid, sizeUsd, pairDecimals, lotDecimals, ordermin, book = null, pair = null, symbol = null, live = null) {
  const hint = rungHint(pair, symbol);
  const step = gridStep(cfg, pair, symbol);
  const focusN = Math.max(1, Number(process.env.LIVE_FOCUS_N || 4));
  const levels = (pair && isTopWeight(pair, focusN))
    ? ladderLevelCount(cfg, rangeFrac(symbol), hint, symbol)
    : 1;
  const tick = Number((10 ** -pairDecimals).toFixed(pairDecimals));
  const u = inventorySkew(live, symbol);
  const kBid = Number(process.env.INV_SKEW_BID_K || 1);
  const kAsk = Number(process.env.INV_SKEW_ASK_K || 0.4);
  const qq = nnQuote({ symbol, buy: 0.5, level: 1, sizeUsd });
  const shape = bidShape(symbol, live);
  sizeUsd = Number(sizeUsd) * qq.sizeMult * Math.max(0, 1 - u) * (shape.sizeMult || 1);
  const bidOff = step * (1 + kBid * u) * (shape.offMult || 1) + (qq.bidAddBps || 0) / 10000;
  const askOff = step * Math.max(0.35, 1 - kAsk * u) + (qq.askAddBps || 0) / 10000;
  const rising = symbol && midReturn(symbol) > 0;
  const sellHalf = rising ? riseSellHalf(cfg, pair, symbol) : l1HalfFrac(cfg, pair);
  const inv0 = Number((live && live.positions && live.positions[symbol] && (Number(live.positions[symbol].amount || 0) + Number(live.positions[symbol].hold || 0))) || 0);
  const useBook = false;
  let bid1 = mid * (1 - Math.max(tick / mid, bidOff, l1HalfFrac(cfg, pair)));
  let ask1 = mid * (1 + Math.max(tick / mid, askOff, sellHalf));
  if (bid1 >= ask1) {
    bid1 = mid * (1 - l1HalfFrac(cfg, pair));
    ask1 = mid * (1 + l1HalfFrac(cfg, pair));
  }
  bid1 = Number(clampAwayFromMid(mid, bid1, 'buy', l1HalfFrac(cfg, pair), pairDecimals));
  ask1 = Number(clampAwayFromMid(mid, ask1, 'sell', sellHalf, pairDecimals));
  const skewKey = String(symbol || '');
  const nowSk = Date.now();
  const prevU = generateLadder._u && generateLadder._u[skewKey];
  if (symbol && (prevU == null || Math.abs(u - prevU) >= 0.1) && nowSk - (generateLadder._skewAt && generateLadder._skewAt[skewKey] || 0) > 60000) {
    generateLadder._u = generateLadder._u || {};
    generateLadder._skewAt = generateLadder._skewAt || {};
    generateLadder._u[skewKey] = u;
    generateLadder._skewAt[skewKey] = nowSk;
    console.log('  SKEW inv ' + symbol + ' u=' + u.toFixed(2) + ' bidOff=' + (bidOff * 10000).toFixed(1) + 'bps askOff=' + (askOff * 10000).toFixed(1) + 'bps');
  }
  const buys = []; const sells = [];
  const gate = symbol ? bidGate({ symbol, pair }, live) : { ok: true };
  const clipUsd = Number(process.env.CLIP_MAX_USD || 1.5);
  const budget = allocFor(symbol);
  const clips = Math.min(Number(process.env.BID_CLIPS_MAX || 8), budget > 0 ? Math.max(1, Math.ceil(budget / clipUsd)) : 0);
  const buyLevels = gate.ok ? clips : 0;
  const sellLevels = 1;
  const n = Math.max(buyLevels, sellLevels, 1);
  for (let i = 1; i <= n; i++) {
    const size = calculateVolume(cfg, mid, Math.min(sizeUsd, clipUsd), ordermin, lotDecimals);
    const buyPx = i === 1 ? bid1 : bid1 * (1 - (i - 1) * step);
    const sellPx = i === 1 ? ask1 : ask1 * (1 + (i - 1) * step);
    if (i <= buyLevels) buys.push({ level: i, side: 'buy', price: formatPrice(buyPx, pairDecimals), size, orderId: null, status: 'pending' });
    if (i <= sellLevels) sells.push({ level: i, side: 'sell', price: formatPrice(sellPx, pairDecimals), size, orderId: null, status: 'pending' });
  }
  return { buys, sells, mid };
}

export function syncLadderFromRegistry(ladder, orderRegistry) {
  let anyFilled = false;
  for (const leg of [...ladder.buys, ...ladder.sells]) {
    if (!leg.orderId) continue;
    const rec = orderRegistry.get(leg.orderId); if (!rec) continue;
    if (rec.status === 'filled' && leg.status !== 'filled') { leg.status = 'filled'; anyFilled = true; }
    else if (rec.status === 'cancelled') leg.status = 'cancelled';
    else if (rec.status === 'open') leg.status = 'open';
  }
  return anyFilled;
}

export function printLadder(symbol, pair, ladder, book) {
  const live = (o) => o.status === 'open';
  const buys = ladder.buys.filter(live);
  const sells = ladder.sells.filter(live);
  if (!buys.length && !sells.length) return;
  console.log('[' + new Date().toLocaleTimeString() + '] ' + symbol + ' ' + pair + ' mid=' + book.mid.toFixed(6));
  for (const o of buys) console.log('  BUY  L' + o.level + ' ' + o.size + ' @ ' + o.price + '  ~$' + (Number(o.size) * Number(o.price)).toFixed(2) + '  [' + o.status + ']');
  for (const o of sells) console.log('  SELL L' + o.level + ' ' + o.size + ' @ ' + o.price + '  ~$' + (Number(o.size) * Number(o.price)).toFixed(2) + '  [' + o.status + ']');
}

function pruneDone(ladder) {
  ladder.buys = ladder.buys.filter((o) => o.status === 'open');
  ladder.sells = ladder.sells.filter((o) => o.status === 'open');
}

function resizeLeg(cfg, a, o, live) {
  if (!live) return o.size;
  const hair = cfg.orderSizeHaircut || 0.9;
  const minV = (a.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
  const isL1 = Number(o.level || 1) === 1;
  if (o.side === 'buy') {
    const cap = capFor(live, a.symbol);
    const held = costHeld(live, a.symbol);
    const gate = bidAllowed(a, live);
    if (!gate.ok) return 0;
    const hard = Number(process.env.INV_CAP_HARD || 1.0);
    if (cap > 0 && held >= cap * hard) {
      if (midReturn(a.symbol) <= 0) {
        const k = 'trim:' + a.symbol;
        const now = Date.now();
        if (now - (resizeLeg._trim && resizeLeg._trim[k] || 0) > 120000) {
          resizeLeg._trim = resizeLeg._trim || {};
          resizeLeg._trim[k] = now;
          console.log('  TRIM ' + a.symbol + ' over cap');
        }
      }
      return 0;
    }
    const eq = Number(live.totalEquity || 0);
    const pairs = Math.max(1, Number(process.env.MM_MAX_PAIRS_HARD || process.env.MM_LIVE_PAIRS || cfg.mmMaxPairs || 4));
    const rank = liveMmAlloc ? [...liveMmAlloc].sort((x, y) => sizeWeightForSymbol(y.symbol) - sizeWeightForSymbol(x.symbol)) : [];
    if (rank.length && rank.findIndex((x) => x.symbol === a.symbol) >= pairs) return 0;
    const cashLeft = Math.max(0, Number(live.freeQuote || 0) * 0.98);
    const clipMax = Number(process.env.CLIP_MAX_USD || 1.5);
    const budget = allocFor(a.symbol);
    const already = openBidUsd(a.symbol) + pendingBidUsd(a.symbol);
    const remain = Math.max(0, budget - already);
    const shape = bidShape(a.symbol, live);
    const invCost = inventoryCost(live, a.symbol);
    const nameRoom = cap > 0 ? Math.max(0, cap * hard - invCost - already) : cashLeft;
    let useUsd = Math.min(cashLeft, nameRoom, clipMax, remain) * (shape.sizeMult || 1);
    const minUsd = Math.max(cfg.minOrderUsd || 0, minV * (o.price || 0));
    if (useUsd < minUsd) {
      if (nameRoom >= minUsd && cashLeft >= minUsd && remain + 1e-9 >= minUsd) useUsd = minUsd;
      else return 0;
    }
    if (o.price <= 0 || useUsd <= 0) return 0;
    let size = useUsd / o.price;
    const out = size + 1e-12 < minV
      ? ((minV * o.price <= cashLeft && nameRoom >= minUsd) ? formatVolume(minV, a.lotDecimals) : 0)
      : formatVolume(size, a.lotDecimals);
    return out;
  }
  if (cooled(a.pair, 'sell')) return 0;
  const heldRaw = (live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount) || 0;
  const held = freeQty(a.symbol, heldRaw);
  const nSell = Math.max(1, isL1 ? 1 : ladderLevelCount(cfg, rangeFrac(a.symbol), rungHint(a.pair, a.symbol), a.symbol));
  const rising = midReturn(a.symbol) > 0;
  const holdRet = midReturn(a.symbol, Number(process.env.HOLD_EXIT_MS || 5000));
  const flatTape = holdRet <= Number(process.env.HOLD_FLAT_RET || 0) || deadTape(a.symbol);
  const riseHold = rising && !flatTape ? riseHoldFrac(a.symbol) : 0;
  const key = String(a.symbol || '').toUpperCase();
  const midPx = Number((live.positions && live.positions[a.symbol] && live.positions[a.symbol].mid) || 0);
  const heldUsd = held * (midPx || Number(o.price) || 0);
  if (riseHold > 0 && heldUsd > 0) {
    const prev = holdStart.get(key);
    if (!prev) holdStart.set(key, { mid: midPx || Number(o.price) || 0, usd: heldUsd * riseHold });
    else prev.usd = heldUsd * riseHold;
  } else if (flatTape && holdStart.has(key)) {
    const h = holdStart.get(key);
    console.log('  HOLD EXIT ' + a.symbol + ' flat — sell reserved at touch');
    try { noteHoldExit(a.symbol, h.mid, h.usd); } catch { /* ignore */ }
    holdStart.delete(key);
  }
  const quoteMin = Number(a.quoteMin || process.env.MIN_ORDER_USD || 1);
  const pxNow = Number(o.price) || midPx;
  let riseFrac = riseHold;
  if (riseFrac > 0 && pxNow > 0 && held * riseFrac * pxNow < quoteMin) riseFrac = 0;
  const budget = (held * hair * (1 - riseFrac)) / nSell;
  let size = Number(o.size) > 0 ? Math.min(o.size, budget) : budget;
  if (pxNow > 0 && (held - size) * pxNow < quoteMin && held * pxNow >= quoteMin) size = held * hair;
  if (size + 1e-12 < minV) {
    const floor = a.ordermin || 0;
    if (held >= minV) return formatVolume(Math.min(held * hair, size || held * hair), a.lotDecimals);
    if (isL1 && held >= floor && floor > 0) return formatVolume(held * hair, a.lotDecimals);
    return 0;
  }
  return formatVolume(size, a.lotDecimals);
}

async function cancelCrossed(ex, ladder, mid, tick) {
  const buf = Number(tick) || 0;
  let n = 0;
  for (const o of ladder.sells) {
    if (o.status === 'open' && o.orderId && Number(o.price) <= mid + buf) {
      console.log('  PULL sell ' + o.price + ' <= mid ' + mid);
      await ex.cancelOrder(o.orderId);
      o.status = 'cancelled';
      n += 1;
    }
  }
  for (const o of ladder.buys) {
    if (o.status === 'open' && o.orderId && Number(o.price) >= mid - buf) {
      console.log('  PULL buy ' + o.price + ' >= mid ' + mid);
      await ex.cancelOrder(o.orderId);
      o.status = 'cancelled';
      n += 1;
    }
  }
  return n;
}

async function cancelSide(ex, legs, why = 'cancel') {
  for (const o of legs) {
    if (o.orderId && o.status === 'open') {
      logEvent('cancel', { orderId: o.orderId, side: o.side, level: o.level, price: o.price, why, mid: o.mid || null });
      await ex.cancelOrder(o.orderId);
      o.status = 'cancelled';
    }
  }
}

function l1HalfFrac(cfg, pair) {
  const feeBps = Number(realizedFeeBps(pair) != null ? realizedFeeBps(pair) : assumedMakerFeeBps(cfg));
  const edge = Number(cfg.minEdgeBps || process.env.MIN_EDGE_BPS || 20);
  const floor = Math.max(Number(cfg.minHalfSpreadBps || process.env.MIN_HALF_SPREAD_BPS || 0), Number(process.env.MIN_SPREAD_BPS || 0) / 2, feeBps + edge);
  return floor / 10000;
}
function riseSellHalf(cfg, pair, symbol) {
  const feeBps = Number(realizedFeeBps(pair) != null ? realizedFeeBps(pair) : assumedMakerFeeBps(cfg));
  const edge = Number(cfg.minEdgeBps || process.env.MIN_EDGE_BPS || 20);
  const s = riseStrength(symbol);
  const extra = Math.min(Number(process.env.RISE_SELL_EXTRA_BPS || 40), s * 2500);
  const floor = Math.max(Number(cfg.minHalfSpreadBps || process.env.MIN_HALF_SPREAD_BPS || 0), Number(process.env.MIN_SPREAD_BPS || 0) / 2);
  return Math.max(floor, feeBps * 2 + edge + extra) / 10000;
}
const holdStart = new Map();
export function holdInfo(symbol, mid) {
  const h = holdStart.get(String(symbol || '').toUpperCase());
  if (!h) return { usd: 0, gain: 0 };
  const m = Number(mid || h.mid);
  const gain = h.mid > 0 ? h.usd * ((m - h.mid) / h.mid) : 0;
  return { usd: h.usd, gain };
}
function clampAwayFromMid(mid, px, side, half, decimals) {
  const inc = Number((10 ** -decimals).toFixed(decimals));
  let p = Number(formatPrice(px, decimals));
  const need = side === 'buy' ? mid * (1 - half) : mid * (1 + half);
  if (side === 'buy' && p > need) p = Number(formatPrice(need, decimals));
  if (side === 'sell' && p < need) p = Number(formatPrice(need, decimals));
  let guard = 0;
  while (side === 'buy' && mid > 0 && (mid - p) / mid + 1e-12 < half && guard++ < 20) p = Number(formatPrice(p - inc, decimals));
  while (side === 'sell' && mid > 0 && (p - mid) / mid + 1e-12 < half && guard++ < 20) p = Number(formatPrice(p + inc, decimals));
  return formatPrice(p, decimals);
}
function quoteClear(mid, px, side, half) {
  const p = Number(px);
  if (!(mid > 0) || !(p > 0) || !(half > 0)) return false;
  return side === 'sell' ? (p - mid) / mid >= half * 0.98 : (mid - p) / mid >= half * 0.98;
}

async function cancelHighestToFree(ex, pairState, keepPair, keepSide) {
  if (!pairState) return false;
  const rows = [];
  for (const [p, st] of pairState) {
    const lad = st && st.ladder;
    if (!lad) continue;
    for (const o of [...(lad.buys || []), ...(lad.sells || [])]) {
      if (o.status !== 'open' || !o.orderId) continue;
      if (Number(o.level) <= 1) continue;
      rows.push({ p, o });
    }
  }
  rows.sort((x, y) => Number(y.o.level) - Number(x.o.level) || (x.p === keepPair ? 1 : -1));
  if (!rows.length) return false;
  const row = rows[0];
  console.log('  FREE L' + row.o.level + ' ' + row.o.side + ' ' + row.p + ' @ ' + row.o.price);
  try { await ex.cancelOrder(row.o.orderId); } catch { /* ignore */ }
  row.o.status = 'cancelled';
  return true;
}

const pinAt = new Map();
const pinMid = new Map();
export async function pinL1(cfg, ex, a, ladder, book, getLive, pairState) {
  const mid = Number(book && book.mid);
  if (!(mid > 0)) return;
  const rising = midReturn(a.symbol) > 0;
  const half = rising ? riseSellHalf(cfg, a.pair, a.symbol) : l1HalfFrac(cfg, a.pair);
  let inv0 = 0;
  let pinLive = null;
  if (getLive) {
    try {
      pinLive = await getLive();
      inv0 = Number((pinLive.positions && pinLive.positions[a.symbol] && (Number(pinLive.positions[a.symbol].amount || 0) + Number(pinLive.positions[a.symbol].hold || 0))) || 0);
    } catch { inv0 = 0; }
  }
  const shape = pinLive ? bidShape(a.symbol, pinLive) : { offMult: 1, sizeMult: 1 };
  const falling = pinLive && !bidAllowed(a, pinLive).ok;
  const bidFloor = l1HalfFrac(cfg, a.pair) * (shape.offMult || 1);
  const bidT = falling
    ? null
    : clampAwayFromMid(mid, mid * (1 - bidFloor), 'buy', bidFloor, a.pairDecimals);
  const askT = clampAwayFromMid(mid, mid * (1 + half), 'sell', half, a.pairDecimals);
  const cool = Number(process.env.L1_PIN_MS || 20000);
  function stillGood(side, px) {
    const p = Number(px);
    if (!(p > 0)) return false;
    if (side === 'sell') {
      const off = (p - mid) / mid;
      return off >= half * 0.8 && off <= half * 2.2 && p > mid;
    }
    const off = (mid - p) / mid;
    return off >= half * 0.8 && off <= half * 2.2 && p < mid;
  }
  async function pin(side, target) {
    const key = a.pair + ':' + side;
    if (Date.now() - (pinAt.get(key) || 0) < cool) return;
    const legs = side === 'buy' ? ladder.buys : ladder.sells;
    const open = legs.filter((o) => o.status === 'open' && o.orderId);
    const l1 = open.filter((o) => Number(o.level) === 1);
    const move = Number(process.env.L1_REQUOTE_BPS || cfg.requoteMoveBps || 8) / 10000;
    const lastM = pinMid.get(key);
    const midMoved = lastM > 0 && Math.abs(mid - lastM) / lastM >= move;
    if (open.length && !midMoved) {
      const atTouch = side === 'buy' && rising && Math.abs(Number(l1[0] && l1[0].price) - Number(target)) / mid < 0.0008;
      const good = l1.find((o) => stillGood(side, o.price) || formatPrice(Number(o.price), a.pairDecimals) === String(target) || atTouch);
      if (good) return;
      if (l1.length && !(side === 'buy' && rising)) return;
    }
    const prevSell = side === 'sell' ? l1.map((o) => ({ price: o.price, size: o.size })) : [];
    if (midMoved && l1.length) {
      for (const o of l1) {
        try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
        o.status = 'cancelled';
      }
      if (side === 'sell') { try { invalidateLiveCache(); } catch { /* ignore */ } }
    }
    let live = getLive ? await getLive() : null;
    let size = live ? resizeLeg(cfg, a, { side, price: target, size: 0, level: 1 }, live) : 0;
    if (!size) {
      if (await cancelHighestToFree(ex, pairState || livePairState, a.pair, side)) {
        live = getLive ? await getLive() : live;
        size = live ? resizeLeg(cfg, a, { side, price: target, size: 0, level: 1 }, live) : 0;
      }
    }
    if (!size) {
      if (side === 'sell' && prevSell[0]) {
        const r0 = await ex.limitOrder(a.pair, 'sell', prevSell[0].price, prevSell[0].size, { level: 1, why: 'repost' });
        if (r0 && r0.order_id) {
          legs.push({ level: 1, side: 'sell', price: prevSell[0].price, size: prevSell[0].size, orderId: r0.order_id, status: 'open' });
          console.log('  REPOST ask ' + a.symbol + ' ' + prevSell[0].size + ' @ ' + prevSell[0].price);
        }
      }
      pinAt.set(key, Date.now());
      return;
    }
    if (side === 'sell' && live) {
      const held = Number((live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount) || 0);
      if (!(held > 0)) { pinAt.set(key, Date.now() + Number(process.env.FUNDS_COOL_MS || 45000)); return; }
      if (Number(size) > held * 0.97) size = formatVolume(held * 0.9, a.lotDecimals);
      if (!(Number(size) > 0)) { pinAt.set(key, Date.now()); return; }
    }
    console.log('  PIN L1 ' + side.toUpperCase() + ' ' + a.symbol + ' @ ' + target + ' half=' + (half * 10000).toFixed(0) + 'bps');
    if (side === 'buy') notePendingBid(a.symbol, Number(target) * Number(size));
    const r = await ex.limitOrder(a.pair, side, target, size, { level: 1 });
    if (side === 'buy') clearPendingBid(a.symbol);
    if (!(r && r.order_id)) {
      if (side === 'sell' && prevSell[0]) {
        const r0 = await ex.limitOrder(a.pair, 'sell', prevSell[0].price, prevSell[0].size, { level: 1, why: 'repost' });
        if (r0 && r0.order_id) legs.push({ level: 1, side: 'sell', price: prevSell[0].price, size: prevSell[0].size, orderId: r0.order_id, status: 'open' });
      }
      pinAt.set(key, Date.now() + Number(process.env.FUNDS_COOL_MS || 45000));
      return;
    }
    logEvent('place', { pair: a.pair, symbol: a.symbol, side, level: 1, price: target, size, orderId: r.order_id, mid });
    pinAt.set(key, Date.now());
    pinMid.set(key, mid);
    for (const o of l1) {
      try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
      o.status = 'cancelled';
    }
    legs.push({
      level: 1, side, price: target, size,
      orderId: r.order_id,
      status: 'open',
    });
    if (a) publishOrders(a, ladder, mid);
  }
  await pin('sell', askT);
  if (bidT) await pin('buy', bidT);
  else {
    for (const o of (ladder.buys || []).filter((x) => x.status === 'open' && x.orderId)) {
      const off = mid > 0 ? (mid - Number(o.price)) / mid : 0;
      if (off < l1HalfFrac(cfg, a.pair)) {
        try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
        o.status = 'cancelled';
        console.log('  CANCEL tight buy ' + a.symbol + ' @ ' + o.price + ' off=' + (off * 10000).toFixed(0) + 'bps');
      }
    }
  }
}

async function ensureBothSides(cfg, ex, a, ladder, book, getLive = null, state = null, forceSell = false) {
  const now = Date.now();
  const isOpen = (o) => o.status === 'open' && o.orderId;
  const openS = ladder.sells.some(isOpen);
  const openB = ladder.buys.some(isOpen);
  if (openS && openB) return;
  const buyGate = state && now - (state.lastEnsureAt || 0) < 20000;
  if (openS && buyGate && !forceSell) return;
  const live = getLive ? await getLive() : null;
  const template = [...ladder.sells, ...ladder.buys].find((o) => o.size > 0);
  if (!template) return;
  async function place(side, px) {
    const size = live ? resizeLeg(cfg, a, { side, price: px, size: template.size }, live) : template.size;
    if (!size) { if (state) state.lastEnsureAt = now; return; }
    console.log('  ENSURE ' + side.toUpperCase() + ' ' + a.symbol + ' ' + size + ' @ ' + px);
    const r = await ex.limitOrder(a.pair, side, px, size, { level: 1 });
    const row = { level: 1, side, price: px, size, orderId: r && r.order_id || null, status: r && r.order_id ? 'open' : 'failed' };
    if (side === 'sell') ladder.sells.push(row); else ladder.buys.push(row);
    if (!(r && r.order_id) && state) state.lastEnsureAt = Date.now();
    await sleep(cfg.rateLimitMs);
  }
  const mid = Number((book && book.mid) || 0);
  const half = l1HalfFrac(cfg, a.pair);
  if (!openS && mid > 0) await place('sell', clampAwayFromMid(mid, mid * (1 + half), 'sell', half, a.pairDecimals));
  const cap = live ? capFor(live, a.symbol) : 0;
  const held = live ? costHeld(live, a.symbol) : 0;
  const allowBuy = live ? bidAllowed(a, live).ok : true;
  if (!openB && !buyGate && allowBuy && !(cap > 0 && held >= cap) && mid > 0) await place('buy', clampAwayFromMid(mid, mid * (1 - half), 'buy', half, a.pairDecimals));
}

let livePairState = null;
let liveMmAlloc = [];
let lastLive = null;
export function setLivePairState(m) { livePairState = m; }
export function setLiveMmAlloc(arr) { liveMmAlloc = arr || []; }
function sizedLeg(cfg, a, side, price, size, level) {
  if (!lastLive) return size;
  const next = resizeLeg(cfg, a, { side, price, size, level }, lastLive);
  return next || 0;
}
function liveTapeReady(symbol) {
  const win = Number(process.env.LIVE_WEIGHT_MS || 60000);
  if (midRangePct(symbol, win) >= 0.05) return true;
  const cut = Date.now() - win;
  return midRing(symbol).filter((x) => x.t >= cut).length >= 8;
}
let focusLocked = [];
let focusLockUntil = 0;
function configuredFocusN() {
  return Math.max(1, Number(process.env.LIVE_FOCUS_N || 4));
}
function effectiveFocusN() {
  const n = configuredFocusN();
  const allocN = (liveMmAlloc && liveMmAlloc.length) || 0;
  const eq = lastLive ? Number(lastLive.totalEquity || 0) : 0;
  const allEq = Number(process.env.FOCUS_ALL_EQ_USD || 25);
  if (!(eq > 0) || eq < allEq) return Math.max(n, allocN || n);
  return n;
}
function isTopWeight(selfPair, n = 4) {
  if (!liveMmAlloc.length) return false;
  if (n >= liveMmAlloc.length && liveMmAlloc.some((a) => a.pair === selfPair)) return true;
  const ready = liveMmAlloc.filter((a) => liveTapeReady(a.symbol));
  if (!ready.length) return false;
  const ranked = [...ready].sort((x, y) => sizeWeightForSymbol(y.symbol) - sizeWeightForSymbol(x.symbol));
  const top = ranked.slice(0, n).map((a) => a.pair);
  const now = Date.now();
  if (now >= focusLockUntil || !focusLocked.length) {
    focusLocked = top;
    focusLockUntil = now + Number(process.env.FOCUS_LOCK_MS || 120000);
  }
  return focusLocked.includes(selfPair);
}

function heavierBare(selfPair) {
  if (!liveMmAlloc.length || !livePairState) return false;
  const self = liveMmAlloc.find((x) => x.pair === selfPair);
  const wSelf = self ? sizeWeightForSymbol(self.symbol) : 0;
  for (const a of liveMmAlloc) {
    if (a.pair === selfPair) continue;
    if (sizeWeightForSymbol(a.symbol) <= wSelf + 0.05) continue;
    const st = livePairState.get(a.pair);
    const buys = ((st && st.ladder && st.ladder.buys) || []).filter((o) => o.status === 'open');
    const sells = ((st && st.ladder && st.ladder.sells) || []).filter((o) => o.status === 'open');
    if (!buys.length || !sells.length) return true;
  }
  return false;
}

export async function placeLadder(cfg, ex, pair, ladder, a = null, getLive = null, prefer = null) {
  const gap = Number(process.env.ORDER_STAGGER_MS || 40);
  const buys = ladder.buys || [];
  const sells = ladder.sells || [];
  const legs = prefer === 'buy' ? [...buys, ...sells] : [...sells, ...buys];
  await Promise.all(legs.map((o, i) => sleep(i * gap).then(async () => {
    if (o.status === 'open' && o.orderId) return;
    if (Number(o.level) === 1) {
      const sideLegs = o.side === 'buy' ? buys : sells;
      if (sideLegs.some((x) => x !== o && x.status === 'open' && x.orderId && Number(x.level) === 1)) return;
    }
    if (getLive && a) {
      const live = await getLive();
      const resized = resizeLeg(cfg, a, o, live);
      if (!resized) { o.status = 'failed'; return; }
      if (resized !== o.size) { o.size = resized; }
    }
    if (Number(o.price) * Number(o.size) < 0.4) { o.status = 'pending'; return; }
    const midNow = Number((livePairState && livePairState.get(pair) && livePairState.get(pair).lastMid) || o.price);
    const halfNow = l1HalfFrac(cfg, pair);
    o.price = clampAwayFromMid(midNow, o.price, o.side, halfNow, a ? a.pairDecimals : 6);
    if (!quoteClear(midNow, o.price, o.side, halfNow)) { o.status = 'pending'; return; }
    if (o.side === 'buy') notePendingBid(a && a.symbol, Number(o.price) * Number(o.size));
    const r = await ex.limitOrder(pair, o.side, o.price, o.size, { level: o.level });
    if (o.side === 'buy') clearPendingBid(a && a.symbol);
    if (r && r.order_id) {
      o.orderId = r.order_id; o.status = 'open';
      logEvent('place', { pair, symbol: a && a.symbol, side: o.side, level: o.level, price: o.price, size: o.size, orderId: r.order_id, mid: (livePairState && livePairState.get(pair) && livePairState.get(pair).lastMid) || o.price });
    } else o.status = 'failed';
    if (a) publishOrders(a, ladder, o.price);
  })));
}

function nextSlidePrice(cfg, filledLeg, pairDecimals, pair, symbol) {
  const step = exitStep(cfg, pair, symbol);
  if (filledLeg.side === 'buy') return formatPrice(filledLeg.price * (1 - step), pairDecimals);
  return formatPrice(filledLeg.price * (1 + step), pairDecimals);
}

async function slideSameSide(cfg, ex, a, ladder, filledLeg, book = null) {
  if (filledLeg.side === 'buy') {
    const falling = book && book.mid && filledLeg.price && Number(book.mid) < Number(filledLeg.price);
    const toxic = (tapeEdgeBps(a.pair) || 0) < 0;
    if (falling || toxic) {
      console.log('  SKIP bid replace ' + a.symbol + (falling ? ' down-tape' : '') + (toxic ? ' toxic' : ''));
      return;
    }
  }
  const sideLegs = filledLeg.side === 'buy' ? ladder.buys : ladder.sells;
  const working = sideLegs.filter((o) => o.status === 'open');
  if (working.length >= cfg.slideMaxLegsPerSide) return;
  const mid = Number((book && book.mid) || filledLeg.price);
  const half = l1HalfFrac(cfg, a.pair);
  const raw = nextSlidePrice(cfg, filledLeg, a.pairDecimals, a.pair, a.symbol);
  const price = clampAwayFromMid(mid, raw, filledLeg.side, half, a.pairDecimals);
  if (!quoteClear(mid, price, filledLeg.side, half)) return;
  const maxLevel = sideLegs.reduce((m, o) => Math.max(m, o.level || 0), 0);
  const neu = { level: maxLevel + 1, side: filledLeg.side, price, size: filledLeg.size, orderId: null, status: 'pending' };
  const sz = sizedLeg(cfg, a, neu.side, neu.price, neu.size, neu.level);
  if (!sz) return;
  neu.size = sz;
  console.log('  SLIDE ' + neu.side.toUpperCase() + ' ' + a.symbol + ' ' + neu.size + ' @ ' + neu.price);
  const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
  if (r && r.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'failed';
  sideLegs.push(neu);
  await sleep(cfg.rateLimitMs);
}

async function skewOtherSide(cfg, ex, a, ladder, filledLeg) {
  if (!cfg.skewOtherSide) return;
  const otherSide = filledLeg.side === 'buy' ? 'sell' : 'buy';
  const others = otherSide === 'sell' ? ladder.sells : ladder.buys;
  const open = others.filter((o) => o.status === 'open' && o.orderId);
  const step = exitStep(cfg, a.pair, a.symbol);
  const mid = Number((livePairState && livePairState.get(a.pair) && livePairState.get(a.pair).lastMid) || filledLeg.price);
  const half = l1HalfFrac(cfg, a.pair);
  if (!open.length) {
    const raw = filledLeg.side === 'buy'
      ? filledLeg.price * (1 + Math.max(step, half * 2))
      : filledLeg.price * (1 - Math.max(step, half * 2));
    const price = clampAwayFromMid(mid, raw, otherSide, half, a.pairDecimals);
    if (!quoteClear(mid, price, otherSide, half)) return;
    const neu = { level: 1, side: otherSide, price, size: filledLeg.size, orderId: null, status: 'pending' };
    const sz0 = sizedLeg(cfg, a, otherSide, price, filledLeg.size, 1);
    if (!sz0) return;
    neu.size = sz0;
    const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
    if (r && r.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'failed';
    others.push(neu);
    return;
  }
  const best = otherSide === 'sell'
    ? open.reduce((b, o) => (o.price < b.price ? o : b))
    : open.reduce((b, o) => (o.price > b.price ? o : b));
  const rawPx = otherSide === 'sell'
    ? best.price * (1 - step)
    : best.price * (1 + step);
  const newPx = clampAwayFromMid(mid, rawPx, otherSide, half, a.pairDecimals);
  if (newPx === best.price || !quoteClear(mid, newPx, otherSide, half)) return;
  await ex.cancelOrder(best.orderId);
  best.status = 'cancelled';
  const skewSize = sizedLeg(cfg, a, otherSide, newPx, best.size, best.level);
  if (!skewSize) return;
  const r = await ex.limitOrder(a.pair, otherSide, newPx, skewSize, { level: best.level });
  others.push({ level: best.level, side: otherSide, price: newPx, size: skewSize, orderId: r && r.order_id || null, status: r && r.order_id ? 'open' : 'failed' });
}

async function softStop(cfg, ex, a, state, book, live, getLive = null) {
  if (!state || !state.ladder || !live || !book) return;
  if (Date.now() - (state.lastSoft || 0) < 20000) return;
  const clip = Number(process.env.CLIP_MAX_USD || 1.5);
  const cost = costHeld(live, a.symbol);
  if (!(cost > Number(process.env.TRIM_TO_CLIPS || 1) * clip)) return;
  const off = offHigh15(a.symbol);
  const r5 = ret5m(a.symbol);
  const trigger = (off >= Number(process.env.PEAK_OFF_PCT || 0.015) && midReturn(a.symbol, 60000) <= 0)
    || r5 < Number(process.env.TREND_BID_MIN_5M || -0.01);
  if (!trigger) return;
  state.lastSoft = Date.now();
  const ladder = state.ladder;
  for (const o of (ladder.buys || []).filter((x) => x.status === 'open' && x.orderId)) {
    try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
    o.status = 'cancelled';
  }
  const rawAmt = Number(live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount || 0);
  const qty = freeQty(a.symbol, rawAmt);
  const mid = Number(book.mid);
  const bidPx = Number(book.bid || mid);
  const quoteMin = Number(a.quoteMin || 1);
  const baseMin = Number(a.baseMin || a.ordermin || 0);
  if (!(qty + 1e-12 >= baseMin) || !(qty * bidPx + 1e-12 >= quoteMin)) {
    console.log('  SOFT STOP ' + a.symbol + ' off=' + (off * 100).toFixed(2) + '% ret5=' + (r5 * 100).toFixed(2) + '% sell=0');
    return;
  }
  const prev = (ladder.sells || []).filter((x) => x.status === 'open' && x.orderId).map((o) => ({ price: o.price, size: o.size }));
  for (const o of (ladder.sells || []).filter((x) => x.status === 'open' && x.orderId)) {
    try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
    o.status = 'cancelled';
  }
  try { invalidateLiveCache(); } catch { /* ignore */ }
  let live2 = live;
  if (getLive) { try { live2 = await getLive(); } catch { live2 = live; } }
  const qty2 = freeQty(a.symbol, Number(live2 && live2.positions && live2.positions[a.symbol] && live2.positions[a.symbol].amount || rawAmt));
  const half = l1HalfFrac(cfg, a.pair);
  const basis = holdBasis(a.symbol) || 0;
  const feeBps = Number(realizedFeeBps(a.pair) != null ? realizedFeeBps(a.pair) : assumedMakerFeeBps(cfg));
  let px = clampAwayFromMid(mid, Math.max(Number(book.ask || mid), mid * (1 + half)), 'sell', half, a.pairDecimals);
  const floor = basis > 0 ? basis * (1 + feeBps / 10000) : 0;
  if (floor > Number(px)) px = formatPrice(floor, a.pairDecimals);
  const size = formatVolume(qty2, a.lotDecimals);
  if (!(Number(size) > 0) || Number(size) * bidPx < quoteMin) {
    if (prev[0]) {
      const r0 = await ex.limitOrder(a.pair, 'sell', prev[0].price, prev[0].size, { level: 1, why: 'repost' });
      if (r0 && r0.order_id) ladder.sells.push({ level: 1, side: 'sell', price: prev[0].price, size: prev[0].size, orderId: r0.order_id, status: 'open' });
    }
    console.log('  SOFT STOP ' + a.symbol + ' sell=0 kept ask');
    return;
  }
  console.log('  SOFT STOP ' + a.symbol + ' off=' + (off * 100).toFixed(2) + '% ret5=' + (r5 * 100).toFixed(2) + '% sell=' + size);
  const r = await ex.limitOrder(a.pair, 'sell', px, size, { level: 1, why: 'soft' });
  if (r && r.order_id) ladder.sells.push({ level: 1, side: 'sell', price: px, size, orderId: r.order_id, status: 'open' });
  else if (prev[0]) {
    const r0 = await ex.limitOrder(a.pair, 'sell', prev[0].price, prev[0].size, { level: 1, why: 'repost' });
    if (r0 && r0.order_id) ladder.sells.push({ level: 1, side: 'sell', price: prev[0].price, size: prev[0].size, orderId: r0.order_id, status: 'open' });
  }
}

async function shapeBidDepth(cfg, ex, a, ladder, book, getLive) {
  if (!a || !ladder || !book || !(Number(book.mid) > 0)) return;
  const clip = Number(process.env.CLIP_MAX_USD || 1.5);
  const maxClips = Number(process.env.BID_CLIPS_MAX || 8);
  const alloc = allocFor(a.symbol);
  const open = (ladder.buys || []).filter((o) => o.status === 'open' && o.orderId);
  const openUsd = open.reduce((s, o) => s + Number(o.price) * Number(o.size), 0);
  if (openUsd - alloc >= clip && open.length) {
    const deep = open.reduce((b, o) => (Number(o.price) < Number(b.price) ? o : b));
    try { await ex.cancelOrder(deep.orderId); } catch { /* ignore */ }
    deep.status = 'cancelled';
    console.log('  TRIM BID ' + a.symbol + ' L' + deep.level);
    return;
  }
  if (!(alloc - openUsd >= clip) || !open.length || open.length >= maxClips) return;
  const live = typeof getLive === 'function' ? await getLive() : null;
  if (!live || !bidAllowed(a, live).ok) return;
  const deep = open.reduce((b, o) => (Number(o.price) < Number(b.price) ? o : b));
  const step = gridStep(cfg, a.pair, a.symbol);
  const mid = Number(book.mid);
  const px = clampAwayFromMid(mid, Number(deep.price) * (1 - step), 'buy', l1HalfFrac(cfg, a.pair), a.pairDecimals);
  if (!quoteClear(mid, px, 'buy', l1HalfFrac(cfg, a.pair))) return;
  const level = Math.max(...open.map((o) => Number(o.level) || 1)) + 1;
  const size = resizeLeg(cfg, a, { side: 'buy', price: px, size: 0, level }, live);
  if (!(Number(size) > 0) || Number(size) * Number(px) < Math.max(Number(cfg.minOrderUsd) || 1, 1)) return;
  notePendingBid(a.symbol, Number(px) * Number(size));
  const r = await ex.limitOrder(a.pair, 'buy', px, size, { level });
  clearPendingBid(a.symbol);
  if (r && r.order_id) {
    ladder.buys.push({ level, side: 'buy', price: px, size, orderId: r.order_id, status: 'open' });
    console.log('  ADD BID ' + a.symbol + ' L' + level + ' ' + size + ' @ ' + px);
  }
}

export function planBook(live, mmAlloc, exitNotional = 0) {
  const eq = Number(live && live.totalEquity || 0);
  let dustUsd = 0;
  for (const [sym, pos] of Object.entries((live && live.positions) || {})) {
    const qty = Number(pos.amount || 0) + Number(pos.hold || 0);
    const bid = Number(pos.bestBid || pos.mid || 0);
    const quoteMin = Number(pos.quoteMin || 1);
    const baseMin = Number(pos.baseMin || pos.ordermin || 0);
    const inc = Number(pos.baseInc || 0);
    const q = inc > 0 ? Math.floor((qty + 1e-12) / inc) * inc : qty;
    const tradable = q + 1e-12 >= baseMin && bid > 0 && q * bid + 1e-12 >= quoteMin;
    if (!tradable && qty > 0) dustUsd += Number(pos.valueQuote || qty * bid || 0);
  }
  const tradableEq = Math.max(0, eq - dustUsd);
  const bookTarget = tradableEq * Number(process.env.BOOK_TARGET_FRAC || 0.90);
  const askBook = openOrderNotional().asks + Number(exitNotional || 0);
  const freeCash = Number(live && live.freeQuote || 0);
  const quoteTotal = freeCash + Number(live && live.quoteHold || 0);
  const deploy = Number(process.env.CASH_DEPLOY_FRAC || 0.97);
  const bidTarget = Math.min(quoteTotal * deploy, Math.max(0, bookTarget - askBook));
  const invFrac = Number(process.env.INV_NAME_MAX_FRAC || 0.25);
  const needPairs = Math.max(1, Math.ceil(Number(process.env.BOOK_TARGET_FRAC || 0.90) / Math.max(invFrac, 0.05)) + 1);
  const rows = [];
  for (const a of mmAlloc || []) {
    const pst = livePairState && livePairState.get(a.pair);
    if (pst && pst.parked) continue;
    if (hardBidVeto(a, live)) continue;
    const w = Math.max(0.01, sizeWeightForSymbol(a.symbol) * tapeSizeMult(a.pair));
    const cap = live ? capFor(live, a.symbol) : bidTarget;
    const inv = live ? inventoryCost(live, a.symbol) : 0;
    const room = cap > 0 ? Math.max(0, cap - inv) : bidTarget;
    rows.push({ a, w, room });
  }
  const alloc = waterFill(rows, bidTarget);
  const allocSum = Object.values(alloc).reduce((s, n) => s + n, 0);
  allocPlan = {
    tradableEq, bookTarget, askBook, bidBudget: bidTarget, bidTarget, quoteTotal,
    eligible: rows.map((r) => r.a.symbol), alloc, allocSum, dustUsd, needPairs,
    capRoom: rows.reduce((s, r) => s + r.room, 0),
  };
  return allocPlan;
}
function waterFill(rows, budget) {
  const alloc = {};
  let left = Math.max(0, Number(budget) || 0);
  let open = rows.map((r) => ({ ...r }));
  let guard = 0;
  while (open.length && left > 0.005 && guard++ < 8) {
    const wSum = open.reduce((s, r) => s + r.w, 0) || 1;
    const tent = open.map((r) => ({ r, share: left * r.w / wSum }));
    const capped = tent.filter((t) => t.share >= t.r.room - 1e-9);
    if (!capped.length) {
      for (const t of tent) alloc[t.r.a.symbol] = t.share;
      left = 0;
      break;
    }
    const next = [];
    for (const t of tent) {
      if (t.share >= t.r.room - 1e-9) {
        alloc[t.r.a.symbol] = t.r.room;
        left -= t.r.room;
      } else next.push(t.r);
    }
    open = next;
  }
  return alloc;
}
const blockedSince = new Map();
export function blockedLeave(mmAlloc, live) {
  const windowMs = Number(process.env.SET_BLOCKED_MS || 600000);
  if (!mmAlloc || !mmAlloc.length) return null;
  const livePairs = new Set(mmAlloc.map((a) => a.pair));
  for (const p of [...blockedSince.keys()]) if (!livePairs.has(p)) blockedSince.delete(p);
  let all = true;
  let oldest = null;
  for (const a of mmAlloc) {
    const why = hardBidVeto(a, live);
    const pos = live && live.positions && live.positions[a.symbol];
    const qty = Number(pos && pos.amount || 0) + Number(pos && pos.hold || 0);
    const bid = Number((pos && (pos.bestBid || pos.mid)) || 0);
    const quoteMin = Number((pos && pos.quoteMin) || a.quoteMin || 1);
    const baseMin = Number((pos && (pos.baseMin || pos.ordermin)) || a.ordermin || 0);
    const inc = Number((pos && pos.baseInc) || a.baseInc || 0);
    const q = inc > 0 ? Math.floor((qty + 1e-12) / inc) * inc : qty;
    const tradable = q + 1e-12 >= baseMin && bid > 0 && q * bid >= quoteMin;
    if (!why || tradable) { blockedSince.delete(a.pair); all = false; continue; }
    if (!blockedSince.has(a.pair)) blockedSince.set(a.pair, Date.now());
    const age = Date.now() - blockedSince.get(a.pair);
    if (!oldest || age > oldest.age) oldest = { a, age, why };
  }
  if (!all || !oldest || oldest.age < windowMs) return null;
  return oldest;
}
export function previewGate(symbol) {
  if (!symbol) return false;
  if (inRipCooldown(symbol)) return false;
  const vs = volStatsForSymbol(symbol);
  const tape = liveTapeReady(symbol) || (vs && Number(vs.rangePct) >= 0.05 && Number(vs.samples || 0) >= 3);
  if (!tape) return false;
  if (ret5m(symbol) < Number(process.env.TREND_VETO_5M || -0.025)) return false;
  return true;
}
async function ensureAsk(cfg, ex, a, ladder, book, getLive) {
  if (!a || !ladder || !book || !(Number(book.mid) > 0)) return;
  const st = livePairState && livePairState.get(a.pair);
  const every = Number(process.env.ASK_ENSURE_MS || 60000);
  const openSells = (ladder.sells || []).filter((o) => o.status === 'open' && o.orderId);
  if (st && openSells.length && Date.now() - (st.lastAskEnsure || 0) < every) return;
  if (st) st.lastAskEnsure = Date.now();
  if (getLive) { try { lastLive = await getLive() || lastLive; } catch { /* keep */ } }
  const pos = lastLive && lastLive.positions && lastLive.positions[a.symbol];
  const avail = freeQty(a.symbol, Number(pos && pos.amount || 0));
  const bid = Number(book.bid || book.mid);
  const quoteMin = Number(a.quoteMin || (pos && pos.quoteMin) || 1);
  const baseMin = Number(a.baseMin || a.ordermin || 0);
  if (!(avail + 1e-12 >= baseMin) || !(avail * bid >= quoteMin)) return;
  const openSz = openSells.reduce((s, o) => s + Number(o.size || 0), 0);
  if (openSz + 1e-8 >= avail * 0.9) return;
  const mid = Number(book.mid);
  const holdFrac = riseHoldFrac(a.symbol);
  const half = l1HalfFrac(cfg, a.pair);
  const riseHalf = riseSellHalf(cfg, a.pair, a.symbol) * Number(process.env.RISE_HOLD_ASK_MULT || 2);
  const heldQty = avail * holdFrac;
  const rest = Math.max(0, avail - heldQty);
  const risePx = clampAwayFromMid(mid, mid * (1 + Math.max(half, riseHalf)), 'sell', half, a.pairDecimals);
  const normPx = clampAwayFromMid(mid, mid * (1 + half), 'sell', half, a.pairDecimals);
  const parts = [];
  const need = Math.max(0, avail - openSz);
  if (holdFrac > 0 && heldQty * Number(risePx) >= quoteMin && rest * Number(normPx) >= quoteMin && heldQty >= baseMin && rest >= baseMin && !openSells.length) {
    parts.push({ px: normPx, size: formatVolume(rest, a.lotDecimals), level: 1 });
    parts.push({ px: risePx, size: formatVolume(heldQty, a.lotDecimals), level: 2, riseHold: true });
  } else if (need * bid >= quoteMin) {
    const px = holdFrac > 0 ? risePx : normPx;
    parts.push({ px, size: formatVolume(need, a.lotDecimals), level: 1, riseHold: holdFrac > 0 });
  }
  for (const p of parts) {
    if (!(Number(p.size) > 0) || Number(p.size) * bid < quoteMin) continue;
    console.log('  ASK ' + a.symbol + ' ' + p.size + ' @ ' + p.px);
    const r = await ex.limitOrder(a.pair, 'sell', p.px, p.size, { level: p.level, why: 'ask' });
    if (r && r.order_id) ladder.sells.push({ level: p.level, side: 'sell', price: p.px, size: p.size, orderId: r.order_id, status: 'open', riseHold: !!p.riseHold });
  }
}

export async function processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive = null) {
  setLivePairState(pairState);
  let book = null;
  try { book = await ex.getBook(a.pair); } catch { book = null; }
  const st0 = pairState.get(a.pair);
  if (!book && st0 && st0.lastMid) {
    book = { mid: st0.lastMid, bid: st0.lastBid || st0.lastMid, ask: st0.lastAsk || st0.lastMid, pair: a.pair };
  }
  if (!book) return;
  if (a.symbol && book.mid) noteMid(a.symbol, book.mid);
  const stAsk = pairState.get(a.pair);
  if (stAsk && stAsk.ladder) {
    try { await ensureAsk(cfg, ex, a, stAsk.ladder, book, getLive); } catch (e) { console.warn('ask', a.symbol, e.message); }
    try { await shapeBidDepth(cfg, ex, a, stAsk.ladder, book, getLive); } catch (e) { console.warn('depth', a.symbol, e.message); }
  }
  const forced = (cfg.symbols || []).includes(a.symbol);
  const focusN = effectiveFocusN();
  const focused = isTopWeight(a.pair, focusN);
  const risingNow = midReturn(a.symbol) > 0;
  if (!forced && !focused && !risingNow) {
    if (!pairState.has(a.pair)) {
      pairState.set(a.pair, { ladder: { buys: [], sells: [] }, symbol: a.symbol, lastMid: book.mid, parked: true, bornAt: Date.now() });
    }
    const st = pairState.get(a.pair);
    st.parked = true;
    const ladder = st.ladder;
    const buys = (ladder.buys || []).filter((o) => o.status === 'open' && o.orderId);
    if (buys.length) {
      console.log('  PARK flat ' + a.symbol + ' not in top ' + focusN + ' 1m — pull bids');
      try {
        const liveP = getLive ? await getLive() : null;
        const pos = liveP && liveP.positions && liveP.positions[a.symbol];
        const usd = pos ? (Number(pos.amount || 0) * Number(book.mid || 0)) : 0;
        if (usd > 0) noteHoldExit(a.symbol, book.mid, usd);
      } catch { /* ignore */ }
      await Promise.all(buys.map(async (o) => {
        try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
        o.status = 'cancelled';
        logEvent('cancel', { orderId: o.orderId, side: o.side, level: o.level, price: o.price, why: 'park', mid: book.mid });
      }));
    }
    await coverInventory(cfg, ex, a, ladder, book, getLive);
    publishOrders(a, ladder, book.mid);
    return;
  }
  {
    const stClear = pairState.get(a.pair);
    if (stClear && stClear.parked) stClear.parked = false;
  }
  if (!forced && !liveTapeReady(a.symbol)) {
    if (!pairState.has(a.pair)) {
      pairState.set(a.pair, { ladder: { buys: [], sells: [] }, symbol: a.symbol, lastMid: book.mid, bornAt: Date.now() });
    }
    const stTape = pairState.get(a.pair);
    try { await ensureAsk(cfg, ex, a, stTape.ladder, book, getLive); } catch (e) { console.warn('ask', a.symbol, e.message); }
    publishOrders(a, stTape.ladder, book.mid);
    return;
  }
  const wNow = sizeWeightForSymbol(a.symbol) * tapeSizeMult(a.pair);
  const sized = orderSizeUsd * wNow;
  const live0 = getLive ? await getLive() : null;
  lastLive = live0 || lastLive;
  if (live0 && book) await softStop(cfg, ex, a, pairState.get(a.pair), book, live0, getLive);
  const tick = Number((10 ** -a.pairDecimals).toFixed(a.pairDecimals));
  if (!pairState.has(a.pair)) {
    const ladder = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair, a.symbol, live0);
    pairState.set(a.pair, { ladder, symbol: a.symbol, lastMid: book.mid, lastWeight: wNow, bornAt: Date.now(), lastRequoteAt: Date.now() });
    console.log('\nInitial ladder ' + a.symbol + ' mid=' + book.mid.toFixed(6));
    await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
    await placeLadder(cfg, ex, a.pair, ladder, a, getLive);
    publishOrders(a, ladder, book.mid);
    printLadder(a.symbol, a.pair, ladder, book);
    return;
  }
  const state = pairState.get(a.pair);
  const ladder = state.ladder;
  const retNow = midReturn(a.symbol);
  if ((deadTape(a.symbol) || retNow < Number(process.env.FALL_EXIT_RET || -0.002)) && Date.now() - (state.lastFadeCover || 0) > 20000) {
    state.lastFadeCover = Date.now();
    await coverInventory(cfg, ex, a, ladder, book, getLive);
  }
  const wantLv = ladderLevelCount(cfg, rangeFrac(a.symbol), rungHint(a.pair, a.symbol), a.symbol);
  const haveLv = Math.max(0, ...[...ladder.buys, ...ladder.sells].map((o) => o.level || 0));
  const tooNew = Date.now() - (state.bornAt || 0) < 120000;
  if (wantLv > haveLv && !tooNew) {
    const next = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair, a.symbol, live0);
    const extraB = next.buys.filter((o) => o.level > haveLv);
    const extraS = next.sells.filter((o) => o.level > haveLv);
    if (extraB.length || extraS.length) {
      console.log('  EXPAND grid ' + a.symbol + ' L' + haveLv + ' -> L' + wantLv + ' range=' + (rangeFrac(a.symbol) * 100).toFixed(2) + '%');
      ladder.buys.push(...extraB);
      ladder.sells.push(...extraS);
      await placeLadder(cfg, ex, a.pair, { buys: extraB, sells: extraS }, a, getLive);
    }
  }
  if (wantLv < haveLv) {
    const drop = [...ladder.buys, ...ladder.sells].filter((o) => o.status === 'open' && Number(o.level) > wantLv && !(o.cover || (o.side === 'sell' && Number(o.level) === 1)));
    if (drop.length) {
      console.log('  COLLAPSE ' + a.symbol + ' L' + haveLv + ' -> L' + wantLv);
      await Promise.all(drop.map(async (o) => {
        try { await ex.cancelOrder(o.orderId); } catch { /* ignore */ }
        o.status = 'cancelled';
        logEvent('cancel', { orderId: o.orderId, side: o.side, level: o.level, price: o.price, why: 'dead-tape', mid: book.mid });
      }));
    }
  }
  const before = new Map([...ladder.buys, ...ladder.sells].filter((o) => o.orderId).map((o) => [o.orderId, o.status]));
  let filledNow = syncLadderFromRegistry(ladder, orderRegistry);
  for (const o of [...ladder.buys, ...ladder.sells]) {
    if (!o.orderId || o.status !== 'open') continue;
    try {
      const st = await ex.getOrderStatus(o.orderId);
      const s = String((st && st.status) || '').toUpperCase();
      if (s.indexOf('FILL') >= 0 && s.indexOf('PARTIAL') < 0) {
        o.status = 'filled'; filledNow = true;
        const rec = orderRegistry.get(o.orderId);
        if (rec) rec.status = 'filled';
      } else if (s === 'CANCELLED' || s === 'EXPIRED' || s === 'FAILED') o.status = 'cancelled';
    } catch { /* ignore */ }
  }
  if (filledNow) {
    state.lastEnsureAt = 0;
    pinAt.delete(a.pair + ':buy');
    pinAt.delete(a.pair + ':sell');
  }
  const pulled = await cancelCrossed(ex, ladder, book.mid, tick);
  if (pulled) pruneDone(ladder);
  await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
  const lastMid = state.lastMid || book.mid;
  const move = Math.abs(book.mid - lastMid) / (lastMid || book.mid);
  const openBuy = ladder.buys.some((o) => o.status === 'open');
  const openSell = ladder.sells.some((o) => o.status === 'open');
  const anyOpen = openBuy || openSell;
  const ageMs = Date.now() - (state.bornAt || 0);
  const staleEmpty = !anyOpen && ageMs > 25000 && Date.now() - (state.lastRequoteAt || state.bornAt || 0) > 15000;
  const wOld = state.lastWeight != null ? Number(state.lastWeight) : wNow;
  const wChg = wOld > 0 ? Math.abs(wNow - wOld) / wOld : 0;
  const wTrig = Number(process.env.SIZE_RESCALE_PCT || 0.25);
  const needResize = wChg >= wTrig && move > 0;
  const hint = rungHint(a.pair, a.symbol);
  const hintKey = hint ? (hint.levels + '@' + hint.stepBps) : '';
  const rungAge = Date.now() - (state.lastRungAt || 0);
  const born = Date.now() - (state.bornAt || state.lastRequoteAt || 0);
  const needRungs = hint && hint.touches >= 3 && hintKey && hintKey !== (state.rungKey || '') && rungAge > Number(process.env.RUNG_REQUOTE_MS || 60000) && born > 120000;
  if (needRungs) console.log('  RUNGS ' + a.symbol + ' ' + (state.rungKey || '-') + ' -> ' + hintKey + ' touches=' + hint.touches);
  const grace = ageMs < Number(process.env.START_REQUOTE_GRACE_MS || 45000);
  const needRequote = !grace && (move >= (cfg.requoteMoveBps || 8) / 10000 || needResize || needRungs);
  if (!anyOpen) {
    await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
    publishOrders(a, ladder, book.mid);
    return;
  }
  if (!filledNow && openBuy && openSell && !needRequote && !pulled) return;
  if (!openSell || !openBuy) {
    const prefer = !openSell ? 'sell' : 'buy';
    await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
    publishOrders(a, ladder, book.mid);
  }
  if ((needRequote && !filledNow) || pulled) {
    console.log('  REQUOTE ' + a.symbol + ' mid ' + Number(lastMid).toFixed(6) + ' -> ' + book.mid.toFixed(6) + (pulled ? ' pulled=' + pulled : '') + (needResize ? ' w ' + wOld.toFixed(2) + 'x->' + wNow.toFixed(2) + 'x' : ''));
    const next = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair, a.symbol, live0);
    const tickN = Number(tick) || 0;
    const stepNow = gridStep(cfg, a.pair, a.symbol);
    const band = Math.max(tickN / (book.mid || 1), stepNow * (ladderLevelCount(cfg, rangeFrac(a.symbol), rungHint(a.pair, a.symbol), a.symbol) + 0.25));
    const keepBuy = new Set(ladder.buys.filter((o) => {
      if (!(o.status === 'open' && o.orderId && Number(o.price) < book.mid - tickN)) return false;
      return (book.mid - Number(o.price)) / book.mid <= band;
    }).map((o) => o.orderId));
    const keepSell = new Set(ladder.sells.filter((o) => {
      if (!(o.status === 'open' && o.orderId && Number(o.price) > book.mid + tickN)) return false;
      return (Number(o.price) - book.mid) / book.mid <= band;
    }).map((o) => o.orderId));
    await cancelSide(ex, ladder.buys.filter((o) => o.status === 'open' && !keepBuy.has(o.orderId)));
    await cancelSide(ex, ladder.sells.filter((o) => o.status === 'open' && !keepSell.has(o.orderId)));
    const keptB = ladder.buys.filter((o) => keepBuy.has(o.orderId));
    const keptS = ladder.sells.filter((o) => keepSell.has(o.orderId));
    if (keptB.length) next.buys = [...keptB, ...next.buys.filter((n) => !keptB.some((k) => k.level === n.level))];
    if (keptS.length) next.sells = [...keptS, ...next.sells.filter((n) => !keptS.some((k) => k.level === n.level))];
    state.ladder = next;
    state.lastMid = book.mid;
    state.lastRequoteAt = Date.now();
    state.lastWeight = wNow;
    state.rungKey = hintKey;
    if (needRungs) state.lastRungAt = Date.now();
    publishOrders(a, next, book.mid);
    await placeLadder(cfg, ex, a.pair, next, a, getLive, book.mid >= lastMid ? 'buy' : 'sell');
    printLadder(a.symbol, a.pair, state.ladder, book);
    return;
  }
  state.lastMid = book.mid;
  const newlyFilled = [...ladder.buys, ...ladder.sells].filter((o) => o.status === 'filled' && before.get(o.orderId) !== 'filled');
  if (newlyFilled.some((o) => o.side === 'sell') && midReturn(a.symbol) > 0.005) markRipSell(a.symbol);
  if (cfg.rebalanceOnFill) {
    await cancelSide(ex, ladder.buys);
    await cancelSide(ex, ladder.sells);
    const next = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair, a.symbol, live0);
    state.ladder = next; state.lastMid = book.mid; state.lastWeight = wNow;
    await placeLadder(cfg, ex, a.pair, next, a, getLive);
    return;
  }
  for (const leg of newlyFilled) {
    const midN = Number(book && book.mid);
    const off = midN > 0 ? (leg.side === 'buy' ? (midN - Number(leg.price)) / midN : (Number(leg.price) - midN) / midN) * 10000 : 0;
    noteCapture(a.symbol, off);
    if (leg.side === 'buy') {
      try { invalidateLiveCache(); } catch { /* ignore */ }
      await coverInventory(cfg, ex, a, ladder, book, getLive);
      await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
    }
    publishOrders(a, ladder, book && book.mid);
    await slideSameSide(cfg, ex, a, ladder, leg, book);
    await skewOtherSide(cfg, ex, a, ladder, leg);
    publishOrders(a, ladder, book && book.mid);
  }
  pruneDone(ladder);
  publishOrders(a, ladder, book && book.mid);
  state.lastEnsureAt = 0;
  await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
  await coverInventory(cfg, ex, a, ladder, book, getLive);
  if (newlyFilled.length) printLadder(a.symbol, a.pair, ladder, book);
}

export async function coverInventory(cfg, ex, a, ladder, book, getLive) {
  if (!getLive || !book) return;
  if (cooled(a.pair, 'sell')) return;
  const st = livePairState && livePairState.get(a.pair);
  if (st && Date.now() - (st.lastCoverAt || 0) < Number(process.env.COVER_MS || 20000)) return;
  const live = await getLive();
  const pos = live.positions && live.positions[a.symbol];
  const available = freeQty(a.symbol, Number((pos && pos.amount) || 0));
  const minV = (a.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
  const openAsk = (ladder.sells || []).filter((o) => o.status === 'open').reduce((s, o) => s + Number(o.size || 0), 0);
  const need = Math.max(0, available - openAsk);
  if (st) st.lastCoverAt = Date.now();
  const mid = Number(book.mid || 0);
  if (!(mid > 0) || !(need > 0)) return;
  const half = l1HalfFrac(cfg, a.pair);
  const feeBps = Number(realizedFeeBps(a.pair) != null ? realizedFeeBps(a.pair) : assumedMakerFeeBps(cfg));
  const basis = holdBasis(a.symbol) || 0;
  const floor = basis > 0 ? basis * (1 + (2 * feeBps) / 10000) : 0;
  let px = clampAwayFromMid(mid, mid * (1 + half), 'sell', half, a.pairDecimals);
  if (floor > 0 && Number(px) + 1e-12 < floor) px = formatPrice(floor, a.pairDecimals);
  const off = (Number(px) - mid) / mid;
  if (off < half * 0.98) return;
  const quoteMin = Number(a.quoteMin || process.env.MIN_ORDER_USD || 1);
  const size = formatVolume(need, a.lotDecimals);
  const left = Math.max(0, available - Number(size));
  const full = left * mid < quoteMin && available * mid >= quoteMin ? formatVolume(available, a.lotDecimals) : size;
  if (!(Number(full) >= minV) || Number(full) * mid < quoteMin) return;
  console.log('  COVER SELL ' + a.symbol + ' ' + full + ' @ ' + px + ' avail=' + available.toFixed(4));
  const r = await ex.limitOrder(a.pair, 'sell', px, full, { level: 1 });
  if (r && r.order_id) {
    ladder.sells.push({ level: 1, side: 'sell', price: px, size: full, orderId: r.order_id, status: 'open', cover: true });
    logEvent('place', { pair: a.pair, symbol: a.symbol, side: 'sell', level: 1, price: px, size: full, orderId: r.order_id, mid });
  }
}

export function siblingHasBareBids(pairState, selfPair, live) {
  const names = (liveMmAlloc && liveMmAlloc.length) ? liveMmAlloc : [];
  if (!names.length) return false;
  const bookLive = live || lastLive;
  const bidsOf = (a) => {
    const st = pairState && pairState.get(a.pair);
    return ((st && st.ladder && st.ladder.buys) || []).filter((o) => o.status === 'open').length;
  };
  if (!names.some((a) => bidsOf(a) > 0)) {
    const ranked = [...names].sort((x, y) => sizeWeightForSymbol(y.symbol) - sizeWeightForSymbol(x.symbol));
    let leader = null;
    for (const a of ranked) {
      if (bidGate(a, bookLive, { skipSibling: true }).ok) { leader = a.pair; break; }
    }
    if (!leader || leader === selfPair) return false;
    return true;
  }
  const self = names.find((x) => x.pair === selfPair);
  const wSelf = self ? sizeWeightForSymbol(self.symbol) : 0;
  for (const a of names) {
    if (a.pair === selfPair) continue;
    if (sizeWeightForSymbol(a.symbol) <= wSelf + 0.05) continue;
    if (!bidGate(a, bookLive, { skipSibling: true }).ok) continue;
    if (bidsOf(a) === 0) return true;
  }
  return false;
}

export async function harvestLowWeightBids() {
  return;
}
