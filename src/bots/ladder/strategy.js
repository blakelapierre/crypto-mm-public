import { setTimeout as sleep } from 'timers/promises';
import { formatPrice, calculateVolume, formatVolume } from '../../shared/sizing.js';
import { applySpreadFromFees, joinTouchForPair, assumedMakerFeeBps, realizedFeeBps } from '../../shared/fee-spread.js';
import { sizeWeightForSymbol, volStatsForSymbol } from '../../shared/vol-scan.js';
import { tapeSizeMult, tapeEdgeBps, markRipSell, inRipCooldown } from '../../shared/pair-tape.js';
import { backtestRungs } from '../../shared/rungs.js';
import { midRing, noteMid, midReturn } from '../../shared/mid-ring.js';
import { postOrders } from '../../shared/status-client.js';
import { logEvent } from '../../shared/fill-log.js';



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
function rungHint(pair, symbol) {
  if (String(process.env.RUNG_BACKTEST || '1') === '0') return null;
  return backtestRungs(midRing(symbol), realizedFeeBps(pair));
}
function ladderLevelCount(cfg, range, hint = null) {
  if (hint && hint.levels) return hint.levels;
  let n = cfg.mmLevels || 1;
  if (range >= Number(process.env.MM_VOL_RANGE_MIN || 0.02)) n = Math.max(n, Number(process.env.MM_VOL_LEVELS || 3));
  return n;
}
function gridStep(cfg, pair, symbol) {
  const hint = rungHint(pair, symbol);
  const feeStep = applySpreadFromFees(cfg, pair) / 10000;
  if (hint && hint.stepBps) return Math.max(feeStep, hint.stepBps / 10000);
  const range = rangeFrac(symbol);
  const levels = ladderLevelCount(cfg, range, hint);
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
function inventoryCapUsd(live) {
  const eq = Number((live && live.totalEquity) || 0);
  const frac = Number(process.env.INV_CAP_FRAC || 0.08);
  return Math.max(0, eq * frac);
}
function inventorySkew(live, symbol) {
  if (!live) return 0;
  const pos = live.positions && live.positions[symbol];
  const inv = Number((pos && pos.valueQuote) || 0);
  const cash = Number(live.freeQuote || 0);
  const eq = Number(live.totalEquity || inv + cash) || 1;
  const n = Math.max(1, Number(process.env.MM_MAX_PAIRS || process.env.MM_LIVE_PAIRS || 2));
  const target = Number(process.env.INV_SKEW_TARGET || Math.min(0.45, 0.9 / n));
  const strength = Number(process.env.INV_SKEW_STRENGTH || 0.75);
  return Math.max(-0.8, Math.min(0.8, (inv / eq - target) * strength));
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
  const levels = ladderLevelCount(cfg, rangeFrac(symbol), hint);
  const tick = Number((10 ** -pairDecimals).toFixed(pairDecimals));
  const sk = inventorySkew(live, symbol);
  const bidOff = step * (1 + sk);
  const askOff = step * (1 - sk);
  const useBook = false;
  let bid1 = mid * (1 - Math.max(tick / mid, bidOff, l1HalfFrac(cfg, pair)));
  let ask1 = mid * (1 + Math.max(tick / mid, askOff, l1HalfFrac(cfg, pair)));
  if (useBook && sk) {
    if (sk > 0) bid1 = Math.min(bid1, mid * (1 - bidOff));
    if (sk < 0) ask1 = Math.max(ask1, mid * (1 + askOff));
  }
  if (bid1 >= ask1) { bid1 = mid - tick; ask1 = mid + tick; }
  const skewKey = String(symbol || '');
  const nowSk = Date.now();
  if (sk && nowSk - (generateLadder._started || (generateLadder._started = nowSk)) > 180000 && nowSk - (generateLadder._skewAt && generateLadder._skewAt[skewKey] || 0) > 120000) {
    generateLadder._skewAt = generateLadder._skewAt || {};
    generateLadder._skewAt[skewKey] = nowSk;
    console.log('  SKEW inv ' + symbol + ' ' + sk.toFixed(2) + ' bidOff=' + (bidOff * 10000).toFixed(1) + 'bps askOff=' + (askOff * 10000).toFixed(1) + 'bps');
  }
  const buys = []; const sells = [];
  const ret = midReturn(symbol);
  const buyLevels = (ret < -0.005 || inRipCooldown(symbol)) ? 1 : levels;
  for (let i = 1; i <= levels; i++) {
    const size = calculateVolume(cfg, mid, sizeUsd, ordermin, lotDecimals);
    const buyPx = i === 1 ? bid1 : bid1 * (1 - (i - 1) * step);
    const sellPx = i === 1 ? ask1 : ask1 * (1 + (i - 1) * step);
    if (i <= buyLevels) buys.push({ level: i, side: 'buy', price: formatPrice(buyPx, pairDecimals), size, orderId: null, status: 'pending' });
    sells.push({ level: i, side: 'sell', price: formatPrice(sellPx, pairDecimals), size, orderId: null, status: 'pending' });
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
    const cap = inventoryCapUsd(live);
    const held = inventoryUsd(live, a.symbol);
    const ret = midReturn(a.symbol);
    const hard = Number(process.env.INV_CAP_HARD || 1.4);
    if (!isL1 && cap > 0 && held >= cap * hard) return 0;
    if (!isL1 && cap > 0 && held >= cap && ret <= 0) return 0;
    const pairs = Math.max(1, Number(process.env.MM_LIVE_PAIRS || cfg.mmMaxPairs || (cfg.symbols && cfg.symbols.length) || 4));
    const w = sizeWeightForSymbol(a.symbol) * tapeSizeMult(a.pair);
    let reserved = 0;
    if (livePairState) {
      for (const [p, st] of livePairState) {
        if (p === a.pair) continue;
        for (const b of (st.ladder && st.ladder.buys) || []) {
          if (b.status === 'open' && b.price && b.size) reserved += Number(b.price) * Number(b.size);
        }
      }
    }
    const cashLeft = Math.max(0, live.freeQuote - reserved) * (cfg.capitalSafetyMargin || 0.92) * hair;
    const cashShare = isL1 ? cashLeft : (cashLeft * w) / pairs;
    const room = cap > 0 ? Math.max(0, cap * hard - held) : cashShare;
    const wantUsd = Number(o.size) > 0 && o.price > 0 ? o.price * o.size : cashShare;
    let useUsd = isL1 ? Math.min(wantUsd || cashShare, cashLeft) : Math.min(wantUsd || cashShare, cashShare || wantUsd, room || cashShare);
    const minUsd = Math.max(cfg.minOrderUsd || 0, minV * (o.price || 0));
    if (useUsd < minUsd && cashLeft >= minUsd) useUsd = minUsd;
    if (o.price <= 0 || useUsd <= 0) return 0;
    let size = useUsd / o.price;
    if (size + 1e-12 < minV) return minV * o.price <= cashLeft ? formatVolume(minV, a.lotDecimals) : 0;
    return formatVolume(size, a.lotDecimals);
  }
  const held = (live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount) || 0;
  const nSell = Math.max(1, isL1 ? 1 : ladderLevelCount(cfg, rangeFrac(a.symbol), rungHint(a.pair, a.symbol)));
  const budget = (held * hair) / nSell;
  let size = Number(o.size) > 0 ? Math.min(o.size, budget) : budget;
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
      logEvent('cancel', { orderId: o.orderId, side: o.side, level: o.level, price: o.price, why });
      await ex.cancelOrder(o.orderId);
      o.status = 'cancelled';
    }
  }
}

function l1HalfFrac(cfg, pair) {
  const fee = realizedFeeBps(pair);
  const feeBps = fee != null ? fee : assumedMakerFeeBps(cfg);
  const edge = Number(cfg.minEdgeBps || process.env.MIN_EDGE_BPS || 20);
  return Math.max(feeBps + edge, Number(process.env.MIN_HALF_SPREAD_BPS || 55)) / 10000;
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
export async function pinL1(cfg, ex, a, ladder, book, getLive, pairState) {
  const mid = Number(book && book.mid);
  if (!(mid > 0)) return;
  const half = l1HalfFrac(cfg, a.pair);
  const bidT = formatPrice(mid * (1 - half), a.pairDecimals);
  const askT = formatPrice(mid * (1 + half), a.pairDecimals);
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
    const good = l1.find((o) => stillGood(side, o.price) || formatPrice(Number(o.price), a.pairDecimals) === String(target));
    if (good) return;
    let live = getLive ? await getLive() : null;
    let size = live ? resizeLeg(cfg, a, { side, price: target, size: 0, level: 1 }, live) : 0;
    if (!size) {
      if (await cancelHighestToFree(ex, pairState || livePairState, a.pair, side)) {
        live = getLive ? await getLive() : live;
        size = live ? resizeLeg(cfg, a, { side, price: target, size: 0, level: 1 }, live) : 0;
      }
    }
    if (!size) {
      pinAt.set(key, Date.now());
      return;
    }
    console.log('  PIN L1 ' + side.toUpperCase() + ' ' + a.symbol + ' @ ' + target + ' half=' + (half * 10000).toFixed(0) + 'bps');
    const r = await ex.limitOrder(a.pair, side, target, size, { level: 1 });
    if (!(r && r.order_id)) return;
    pinAt.set(key, Date.now());
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
  await pin('buy', bidT);
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
  if (!openS) await place('sell', formatPrice((book && (book.ask || book.mid)) || 0, a.pairDecimals));
  const cap = live ? inventoryCapUsd(live) : 0;
  const held = live ? inventoryUsd(live, a.symbol) : 0;
  if (!openB && !buyGate && !(cap > 0 && held >= cap)) await place('buy', formatPrice((book && (book.bid || book.mid)) || 0, a.pairDecimals));
}

let livePairState = null;
let liveMmAlloc = [];
export function setLivePairState(m) { livePairState = m; }
export function setLiveMmAlloc(arr) { liveMmAlloc = arr || []; }
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
    if (Number(o.level) > 1 && (heavierBare(pair) || (o.side === 'buy' && livePairState && siblingHasBareBids(livePairState, pair)))) {
      o.status = 'pending';
      return;
    }
    if (getLive && a) {
      const live = await getLive();
      const resized = resizeLeg(cfg, a, o, live);
      if (!resized) { o.status = 'failed'; return; }
      if (resized !== o.size) { o.size = resized; }
    }
    const r = await ex.limitOrder(pair, o.side, o.price, o.size, { level: o.level });
    if (r && r.order_id) {
      o.orderId = r.order_id; o.status = 'open';
      logEvent('place', { pair, symbol: a && a.symbol, side: o.side, level: o.level, price: o.price, size: o.size, orderId: r.order_id });
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
  const price = nextSlidePrice(cfg, filledLeg, a.pairDecimals, a.pair, a.symbol);
  const maxLevel = sideLegs.reduce((m, o) => Math.max(m, o.level || 0), 0);
  const neu = { level: maxLevel + 1, side: filledLeg.side, price, size: filledLeg.size, orderId: null, status: 'pending' };
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
  if (!open.length) {
    const price = filledLeg.side === 'buy'
      ? formatPrice(filledLeg.price * (1 + step), a.pairDecimals)
      : formatPrice(filledLeg.price * (1 - step), a.pairDecimals);
    const neu = { level: 1, side: otherSide, price, size: filledLeg.size, orderId: null, status: 'pending' };
    const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
    if (r && r.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'failed';
    others.push(neu);
    return;
  }
  const best = otherSide === 'sell'
    ? open.reduce((b, o) => (o.price < b.price ? o : b))
    : open.reduce((b, o) => (o.price > b.price ? o : b));
  const newPx = otherSide === 'sell'
    ? formatPrice(best.price * (1 - step), a.pairDecimals)
    : formatPrice(best.price * (1 + step), a.pairDecimals);
  if (newPx === best.price) return;
  await ex.cancelOrder(best.orderId);
  best.status = 'cancelled';
  const r = await ex.limitOrder(a.pair, otherSide, newPx, best.size, { level: best.level });
  others.push({ level: best.level, side: otherSide, price: newPx, size: best.size, orderId: r && r.order_id || null, status: r && r.order_id ? 'open' : 'failed' });
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
  const wNow = sizeWeightForSymbol(a.symbol) * tapeSizeMult(a.pair);
  const sized = orderSizeUsd * wNow;
  const live0 = getLive ? await getLive() : null;
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
  const wantLv = ladderLevelCount(cfg, rangeFrac(a.symbol), rungHint(a.pair, a.symbol));
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
  if (filledNow) state.lastEnsureAt = 0;
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
    const band = Math.max(tickN / (book.mid || 1), stepNow * (ladderLevelCount(cfg, rangeFrac(a.symbol), rungHint(a.pair, a.symbol)) + 0.25));
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
    if (leg.side === 'buy') await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
    publishOrders(a, ladder, book && book.mid);
    await slideSameSide(cfg, ex, a, ladder, leg, book);
    await skewOtherSide(cfg, ex, a, ladder, leg);
    publishOrders(a, ladder, book && book.mid);
  }
  pruneDone(ladder);
  publishOrders(a, ladder, book && book.mid);
  state.lastEnsureAt = 0;
  await pinL1(cfg, ex, a, ladder, book, getLive, pairState);
  if (newlyFilled.length) printLadder(a.symbol, a.pair, ladder, book);
}

export function siblingHasBareBids(pairState, selfPair) {
  for (const [p, st] of pairState) {
    if (p === selfPair) continue;
    const n = ((st && st.ladder && st.ladder.buys) || []).filter((o) => o.status === 'open').length;
    if (n === 0) return true;
  }
  return false;
}

export async function harvestLowWeightBids(cfg, ex, mmAlloc, pairState, getLive) {
  if (!mmAlloc || mmAlloc.length < 2) return;
  const rows = mmAlloc.map((a) => {
    const st = pairState.get(a.pair);
    const w = sizeWeightForSymbol(a.symbol) * tapeSizeMult(a.pair);
    const buys = ((st && st.ladder && st.ladder.buys) || []).filter((o) => o.status === 'open' && o.orderId);
    return { a, w, buys, ret: midReturn(a.symbol) };
  });
  const bare = rows.filter((r) => r.buys.length === 0).sort((x, y) => y.w - x.w);
  const fat = rows.filter((r) => r.buys.length > 1).sort((x, y) => x.w - y.w || y.buys.length - x.buys.length);
  if (!bare.length || !fat.length) {
    const heavy = [...rows].sort((x, y) => y.w - x.w)[0];
    if (!heavy || heavy.buys.length) return;
    const donor = [...rows].filter((r) => r.buys.length && r.w < heavy.w * 0.7).sort((x, y) => x.w - y.w)[0];
    if (!donor) return;
    const victim = [...donor.buys].sort((p, q) => Number(q.level) - Number(p.level) || Number(p.price) - Number(q.price))[0];
    console.log('  HARVEST ' + donor.a.symbol + ' w=' + donor.w.toFixed(2) + ' buy L' + victim.level + ' -> ' + heavy.a.symbol + ' w=' + heavy.w.toFixed(2));
    try { await ex.cancelOrder(victim.orderId); } catch { /* ignore */ }
    victim.status = 'cancelled';
    return;
  }
  const hungry = bare[0];
  const donor = fat.find((r) => r.a.pair !== hungry.a.pair) || fat[0];
  if (!donor || donor.a.pair === hungry.a.pair) return;
  const extras = donor.buys.filter((o) => Number(o.level) > 1);
  const victim = (extras.length ? extras : donor.buys).sort((p, q) => Number(q.level) - Number(p.level) || Number(p.price) - Number(q.price))[0];
  console.log('  HARVEST ' + donor.a.symbol + ' w=' + donor.w.toFixed(2) + ' n=' + donor.buys.length + ' L' + victim.level + ' -> ' + hungry.a.symbol + ' w=' + hungry.w.toFixed(2));
  try { await ex.cancelOrder(victim.orderId); } catch { /* ignore */ }
  victim.status = 'cancelled';
}
