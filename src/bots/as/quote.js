// Avellaneda–Stoikov quote.
// q is inventory in clips, positive when long.
// sigma is the standard deviation of one-minute log returns.
// tau is the horizon in minutes. gamma is risk aversion per clip.
// The reservation price moves against inventory. The spread widens with variance.
export function asQuote({ mid, q = 0, sigma = 0, gamma = 40, kappa = 1.5, tau = 15, minHalf = 0.006, maxHalf = 0.02, maxShift = 0.015 }) {
  const m = Number(mid);
  if (!(m > 0)) return null;
  const sig = Math.max(0, Number(sigma) || 0);
  const g = Math.max(1e-6, Number(gamma) || 40);
  const k = Math.max(1e-6, Number(kappa) || 1.5);
  const t = Math.max(1, Number(tau) || 15);
  const variance = sig * sig * t;
  const rawShift = Number(q) * g * variance;
  const shift = clamp(rawShift, -maxShift, maxShift);
  const reservation = m * (1 - shift);
  const intensity = (Math.log(1 + g / k) / g) * sig;
  const half = clamp(0.5 * g * variance + intensity, minHalf, maxHalf);
  return {
    reservation,
    shift,
    half,
    bid: reservation * (1 - half),
    ask: reservation * (1 + half),
  };
}

export function realizedSigma(closes) {
  const px = (closes || []).map(Number).filter((n) => n > 0);
  if (px.length < 5) return 0;
  const rets = [];
  for (let i = 1; i < px.length; i++) rets.push(Math.log(px[i] / px[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const v = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.sqrt(Math.max(0, v));
}

// Largest position notional whose cross-margin liquidation stays at least minDist
// (a fraction, 0.15 = 15%) away from the fill, at the given leverage.
export function liqNotionalCap(equity, lev, minDist) {
  const e = Number(equity);
  const l = Math.max(1, Number(lev) || 1);
  const d = Math.max(0, Number(minDist) || 0);
  if (!(e > 0)) return 0;
  return e / (d + 1 / l);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function minHalfBps(feeBps, profitBps) {
  return Math.max(0, Number(feeBps) || 0) + Math.max(0, Number(profitBps) || 0);
}

// Half-spread as a fraction of mid. Never tighter than fee + profit per side.
export function halfSpread({ feeBps = 0, profitBps = 0, touchHalfBps = 0, maxHalfBps = 200 } = {}) {
  const minB = Math.max(minHalfBps(feeBps, profitBps), 1);
  const bps = Math.max(minB, Number(touchHalfBps) || 0);
  const hi = Number(maxHalfBps) > 0 ? Number(maxHalfBps) : bps;
  return Math.max(minB, Math.min(hi, bps)) / 10000;
}

// Long exit is a floor (ask must be at or above it). Short exit is a ceiling.
// Legacy lots decay from that bound to the touch over windowMs.
export function exitBound({ entry, side = 'long', feeBps = 0, profitBps = 0, touch = 0, legacy = false, ageMs = 0, windowMs = 24 * 3600 * 1000 } = {}) {
  const e = Number(entry);
  if (!(e > 0)) return 0;
  const pad = (2 * (Number(feeBps) || 0) + (Number(profitBps) || 0)) / 10000;
  const raw = side === 'short' || side === 'buy' ? e * (1 - pad) : e * (1 + pad);
  if (!legacy) return raw;
  const win = Number(windowMs) > 0 ? Number(windowMs) : 24 * 3600 * 1000;
  const t = Math.max(0, Math.min(1, (Number(ageMs) || 0) / win));
  const touchPx = Number(touch) > 0 ? Number(touch) : raw;
  return raw + (touchPx - raw) * t;
}

export function clampToBand(px, mid, maxFrac) {
  const p = Number(px);
  const m = Number(mid);
  const f = Number(maxFrac);
  if (!(p > 0) || !(m > 0) || !(f > 0)) return p;
  return Math.min(m * (1 + f), Math.max(m * (1 - f), p));
}

// Pull a rejected price toward the touch. After `steps` failures the price is the touch.
export function halveToward(px, touch, steps) {
  const p = Number(px);
  const t = Number(touch);
  const n = Math.max(0, Number(steps) || 0);
  if (!(t > 0)) return p;
  if (!(p > 0) || n >= 3) return t;
  return t + (p - t) / (2 ** n);
}

export function backoffSec(n) {
  const k = Math.max(1, Number(n) || 1);
  return Math.min(600, 20 * 2 ** (k - 1));
}

export function feeToBps(v) {
  const n = Number(v);
  if (!(n > 0)) return 0;
  if (n < 0.01) return n * 10000;
  if (n < 2) return n * 100;
  return n;
}

export function applyEntry(entry, fill) {
  const e = {
    longQty: Number(entry && entry.longQty) || 0,
    longCost: Number(entry && entry.longCost) || 0,
    shortQty: Number(entry && entry.shortQty) || 0,
    shortCost: Number(entry && entry.shortCost) || 0,
    basis: (entry && entry.basis) || 'fill',
    at: Number(entry && entry.at) || 0,
    longMark: Number(entry && entry.longMark) || 0,
    shortMark: Number(entry && entry.shortMark) || 0,
    realizedMark: Number(entry && entry.realizedMark) || 0,
  };
  const qty = Number(fill && fill.size);
  const px = Number(fill && fill.price);
  if (!(qty > 0) || !(px > 0)) return e;
  const buy = String(fill.side || '').toLowerCase() === 'buy';
  const when = Date.parse(fill.time) || Number(fill.at) || Date.now();
  const mid = Number(fill.mid) > 0 ? Number(fill.mid) : px;
  if (buy) {
    const close = Math.min(e.shortQty, qty);
    if (close > 0 && e.shortQty > 0) {
      const avg = e.shortCost / e.shortQty;
      const mark = (e.shortMark > 0 ? e.shortMark : e.shortCost) / e.shortQty;
      e.realizedMark = (Number(e.realizedMark) || 0) + (mark - mid) * close;
      e.shortQty -= close;
      e.shortCost = Math.max(0, avg * e.shortQty);
      e.shortMark = Math.max(0, mark * e.shortQty);
    }
    const open = qty - close;
    if (open > 0) {
      e.longCost += open * px;
      e.longMark = (Number(e.longMark) || 0) + open * mid;
      e.longQty += open;
      e.basis = 'fill';
      e.at = when;
    }
  } else {
    const close = Math.min(e.longQty, qty);
    if (close > 0 && e.longQty > 0) {
      const avg = e.longCost / e.longQty;
      const mark = (e.longMark > 0 ? e.longMark : e.longCost) / e.longQty;
      e.realizedMark = (Number(e.realizedMark) || 0) + (mid - mark) * close;
      e.longQty -= close;
      e.longCost = Math.max(0, avg * e.longQty);
      e.longMark = Math.max(0, mark * e.longQty);
    }
    const open = qty - close;
    if (open > 0) {
      e.shortCost += open * px;
      e.shortMark = (Number(e.shortMark) || 0) + open * mid;
      e.shortQty += open;
      e.basis = 'fill';
      e.at = when;
    }
  }
  return e;
}

export function entryAvg(entry, side) {
  if (!entry) return 0;
  if (side === 'short' || side === 'buy') return entry.shortQty > 0 ? entry.shortCost / entry.shortQty : 0;
  return entry.longQty > 0 ? entry.longCost / entry.longQty : 0;
}

export function positionPnl(entry, pos) {
  const mid = Number(pos && (pos.mid || pos.mark) || 0);
  if (!entry || !(mid > 0)) return 0;
  const longQty = Math.min(Number(entry.longQty || 0), Number(pos && pos.long != null ? pos.long : entry.longQty || 0));
  const shortQty = Math.min(Number(entry.shortQty || 0), Number(pos && pos.short != null ? pos.short : entry.shortQty || 0));
  let pnl = 0;
  if (longQty > 0 && entry.longQty > 0) pnl += (mid - entry.longCost / entry.longQty) * longQty;
  if (shortQty > 0 && entry.shortQty > 0) pnl += (entry.shortCost / entry.shortQty - mid) * shortQty;
  return pnl;
}

// True when this order would increase absolute inventory.
export function opensRisk(net, side) {
  const n = Number(net) || 0;
  const s = String(side || '').toLowerCase();
  if (n > 1e-12) return s === 'buy';
  if (n < -1e-12) return s === 'sell';
  return true;
}

// Inventory exit at the touch. A wide spread joins one tick inside instead of the far touch.
export function touchExit(side, bid, ask, inc, wideBps = 40) {
  const b = Number(bid) || 0;
  const a = Number(ask) || 0;
  const tick = Number(inc) > 0 ? Number(inc) : 0;
  const s = String(side || '').toLowerCase();
  if (s === 'sell') {
    if (!(a > b) || !(b > 0)) return a;
    const mid = (a + b) / 2;
    if (tick > 0 && mid > 0 && ((a - b) / mid) * 10000 > wideBps) return b + tick;
    return a;
  }
  if (!(a > b) || !(a > 0)) return b;
  const mid = (a + b) / 2;
  if (tick > 0 && mid > 0 && ((a - b) / mid) * 10000 > wideBps) return a - tick;
  return b;
}

export function bookNotional(orders) {
  let n = 0;
  for (const o of orders || []) n += Math.abs(Number(o.price) || 0) * Math.abs(Number(o.size) || 0);
  return n;
}

export function feeMul(feeBps) {
  return 1 + Math.max(0, Number(feeBps) || 0) / 10000;
}

// free quote minus a cash reserve. Subtract resting buys only when the venue
// figure does not already exclude them (Coinbase available is already net).
export function cashBudget({ free = 0, restingCost = 0, equity = 0, halve = false, netOfHolds = false } = {}) {
  const reserve = Math.max((Number(equity) || 0) * 0.01, 0.1);
  const held = netOfHolds ? 0 : Math.max(0, Number(restingCost) || 0);
  let b = Math.max(0, (Number(free) || 0) - held - reserve);
  if (halve) b *= 0.5;
  return b;
}

function floorToLot(size, lot) {
  const d = Math.max(0, Number(lot) || 0);
  const pow = 10 ** d;
  return Math.floor((Number(size) || 0) * pow + 1e-9) / pow;
}

// Shrink a buy to the cash left. `curNotional` is the resting order we would cancel first.
// `same` means that order already matches: it stays, and the budget is unchanged.
export function takeBuyBudget(budgetLeft, { price = 0, wantSize = 0, curNotional = 0, feeBps = 0, minNotional = 0, minSize = 0, lot = 8, same = false } = {}) {
  const left = Math.max(0, Number(budgetLeft) || 0);
  const want = Number(wantSize) || 0;
  if (same) return { budgetLeft: left, size: want, send: false, skip: false, cost: 0 };
  const px = Number(price);
  const mul = feeMul(feeBps);
  const room = left + Math.max(0, Number(curNotional) || 0) * mul;
  if (!(px > 0) || !(room > 0)) return { budgetLeft: left, size: 0, send: false, skip: true, cost: 0 };
  let sz = floorToLot(Math.min(want, room / (px * mul)), lot);
  const cost = sz * px * mul;
  const minN = Number(minNotional) || 0;
  const minS = Number(minSize) || 0;
  if (!(sz > 0) || sz + 1e-12 < minS || sz * px + 1e-12 < minN || cost > room + 1e-6) {
    return { budgetLeft: left, size: 0, send: false, skip: true, cost: 0 };
  }
  return { budgetLeft: room - cost, size: sz, send: true, skip: false, cost };
}

export function mlAfter(equity, usedMargin) {
  const e = Number(equity);
  const u = Number(usedMargin);
  if (!(e > 0) || !(u > 0)) return null;
  return (e / u) * 100;
}

// Extra opening notional that still leaves margin level at `resume`.
export function openingNotionalCap({ equity = 0, usedMargin = 0, lev = 1, resume = 350 } = {}) {
  const e = Number(equity);
  const used = Math.max(0, Number(usedMargin) || 0);
  const L = Math.max(1, Number(lev) || 1);
  const r = Number(resume) > 0 ? Number(resume) : 350;
  if (!(e > 0)) return 0;
  const room = e / (r / 100) - used;
  if (!(room > 0)) return 0;
  return room * L;
}

// Both opening sides consume margin until one fills. Scale them into the room.
export function fitOpeningPair({ equity = 0, usedMargin = 0, resume = 350, buy = {}, sell = {} } = {}) {
  const e = Number(equity);
  const r = (Number(resume) > 0 ? Number(resume) : 350) / 100;
  let room = e > 0 ? Math.max(0, e / r - Math.max(0, Number(usedMargin) || 0)) : 0;
  const bOpen = !!buy.opening;
  const sOpen = !!sell.opening;
  const bLev = Math.max(1, Number(buy.lev) || 1);
  const sLev = Math.max(1, Number(sell.lev) || 1);
  const bWant = Math.max(0, Number(buy.notional) || 0);
  const sWant = Math.max(0, Number(sell.notional) || 0);
  let buyN = bOpen ? 0 : bWant;
  let sellN = sOpen ? 0 : sWant;
  if (bOpen && sOpen) {
    const half = room / 2;
    buyN = Math.min(bWant, half * bLev);
    sellN = Math.min(sWant, half * sLev);
    let spare = room - (buyN / bLev + sellN / sLev);
    if (spare > 1e-12 && buyN + 1e-12 < bWant) {
      const add = Math.min(bWant - buyN, spare * bLev);
      buyN += add;
      spare -= add / bLev;
    }
    if (spare > 1e-12 && sellN + 1e-12 < sWant) {
      const add = Math.min(sWant - sellN, spare * sLev);
      sellN += add;
    }
  } else if (bOpen) {
    buyN = Math.min(bWant, room * bLev);
  } else if (sOpen) {
    sellN = Math.min(sWant, room * sLev);
  }
  const usedAdd = (bOpen ? buyN / bLev : 0) + (sOpen ? sellN / sLev : 0);
  return { buy: buyN, sell: sellN, usedAdd };
}

export function carryAllows({ holdMin = 0, bpsPerHour = 0, profitBps = 0 } = {}) {
  const cost = (Math.max(0, Number(holdMin) || 0) / 60) * Math.max(0, Number(bpsPerHour) || 0);
  return cost < Math.max(0, Number(profitBps) || 0) / 2;
}

// Expected hold × carry rate must stay under half the profit. Otherwise shrink, then skip.
export function notionalForCarry({ notional = 0, holdMin = 0, bpsPerHour = 0, profitBps = 0, minNotional = 0 } = {}) {
  const want = Math.max(0, Number(notional) || 0);
  const rate = Math.max(0, Number(bpsPerHour) || 0);
  if (!(want > 0)) return 0;
  if (!(rate > 0) || carryAllows({ holdMin, bpsPerHour: rate, profitBps })) return want;
  const limit = Math.max(0, Number(profitBps) || 0) / 2;
  const cost = (Math.max(0, Number(holdMin) || 0) / 60) * rate;
  if (!(cost > 0)) return want;
  const scaled = want * (limit / cost);
  const minN = Number(minNotional) || 0;
  if (scaled + 1e-9 < minN) return 0;
  return scaled;
}

// After max hold, the exit walks from entry+fee+profit to entry+fee+carry over 2h, then to the touch.
export function holdExitPx({ entry = 0, side = 'long', feeBps = 0, profitBps = 0, carryPerUnit = 0, ageMin = 0, maxHoldMin = 240, touch = 0 } = {}) {
  const e = Number(entry);
  if (!(e > 0)) return 0;
  const fee = Math.max(0, Number(feeBps) || 0) / 10000;
  const profit = Math.max(0, Number(profitBps) || 0) / 10000;
  const carry = Math.max(0, Number(carryPerUnit) || 0);
  const sign = side === 'short' || side === 'buy' ? -1 : 1;
  const profitPx = e * (1 + sign * (fee + profit));
  const bePx = e * (1 + sign * fee) + sign * carry;
  const age = Number(ageMin) || 0;
  const maxH = Number(maxHoldMin) > 0 ? Number(maxHoldMin) : 240;
  if (age <= maxH) return 0;
  const t = (age - maxH) / 120;
  if (t < 1) return profitPx + (bePx - profitPx) * Math.max(0, t);
  const touchPx = Number(touch);
  return touchPx > 0 ? touchPx : bePx;
}

// Mark change versus the mid at fill (longMark), plus drift already realized on closes.
export function inventoryMarkPnl(entry, pos) {
  if (!entry) return 0;
  const mid = Number(pos && (pos.mid || pos.mark) || 0);
  let pnl = Number(entry.realizedMark) || 0;
  if (!(mid > 0)) return pnl;
  const lq = Number(entry.longQty) || 0;
  const sq = Number(entry.shortQty) || 0;
  const haveL = Math.min(lq, pos && pos.long != null ? Number(pos.long) : lq);
  const haveS = Math.min(sq, pos && pos.short != null ? Number(pos.short) : sq);
  if (haveL > 0 && lq > 0) {
    const basis = Number(entry.longMark) > 0 ? entry.longMark / lq : entry.longCost / lq;
    pnl += (mid - basis) * haveL;
  }
  if (haveS > 0 && sq > 0) {
    const basis = Number(entry.shortMark) > 0 ? entry.shortMark / sq : entry.shortCost / sq;
    pnl += (basis - mid) * haveS;
  }
  return pnl;
}

export function fillScore({ tradesPerHour = 0, range = 0, needRange = 0 } = {}) {
  const rng = Number(range) || 0;
  const need = Number(needRange) || 0;
  if (rng + 1e-12 < need) return 0;
  return Math.max(0, Number(tradesPerHour) || 0) * rng;
}

// Post-only ask walks from the best ask toward one tick above the bid over windowMs.
export function unwindAsk({ bid = 0, ask = 0, tick = 0, ageMs = 0, windowMs = 2 * 3600 * 1000 } = {}) {
  const a = Number(ask);
  const b = Number(bid);
  if (!(a > 0)) return 0;
  const tickN = Number(tick) > 0 ? Number(tick) : 0;
  const dest = b > 0 ? b + tickN : a;
  const win = Number(windowMs) > 0 ? Number(windowMs) : 2 * 3600 * 1000;
  const t = Math.max(0, Math.min(1, (Number(ageMs) || 0) / win));
  let px = a + (dest - a) * t;
  if (b > 0 && px <= b) px = dest > b ? dest : b + tickN;
  return px;
}

export function sentHalfBps(mid, bidPx, askPx) {
  const m = Number(mid);
  if (!(m > 0)) return 0;
  let h = 0;
  if (Number(bidPx) > 0) h = Math.max(h, (m - Number(bidPx)) / m * 10000);
  if (Number(askPx) > 0) h = Math.max(h, (Number(askPx) - m) / m * 10000);
  return Math.round(h);
}

// half = max(fee + profit, k × sigma, half the touch). Never under the fee floor.
export function adaptiveHalf({ feeBps = 0, profitBps = 0, sigma = 0, k = 1.5, touchSpreadBps = 0, maxHalfBps = 200 } = {}) {
  const floor = Math.max(minHalfBps(feeBps, profitBps), 1);
  const vol = Math.max(0, Number(k) || 0) * Math.max(0, Number(sigma) || 0) * 10000;
  const touch = 0.5 * Math.max(0, Number(touchSpreadBps) || 0);
  let src = 'floor';
  let bps = floor;
  if (vol > bps + 1e-9) { bps = vol; src = 'vol'; }
  if (touch > bps + 1e-9) { bps = touch; src = 'touch'; }
  const hi = Math.max(floor, Number(maxHalfBps) > 0 ? Number(maxHalfBps) : bps);
  if (bps > hi) bps = hi;
  if (bps + 1e-9 < floor) { bps = floor; src = 'floor'; }
  return { half: bps / 10000, bps, src };
}

// Notional whose forced exit (round-trip fee + a sigma move over the hold) stays inside maxLossPct of equity.
export function exitLossNotional({ equity = 0, feeBps = 0, sigma = 0, holdMin = 240, maxLossPct = 0.015 } = {}) {
  const e = Number(equity);
  if (!(e > 0)) return 0;
  const fee = Math.max(0, Number(feeBps) || 0) / 10000;
  const move = Math.max(0, Number(sigma) || 0) * Math.sqrt(Math.max(1, Number(holdMin) || 1) / 15);
  const lossFrac = 2 * fee + move;
  const cap = Math.max(0, Number(maxLossPct) || 0);
  if (!(lossFrac > 0)) return e * cap;
  return (e * cap) / lossFrac;
}

// From 75% of the hold cap, walk the exit from entry+fee+profit toward breakeven.
// After the cap, step a quarter-spread toward the touch every 15 minutes. 0 means "keep the v2 floor".
export function gradualHoldExit({ entry = 0, side = 'long', feeBps = 0, profitBps = 0, carryPerUnit = 0, ageMin = 0, maxHoldMin = 240, touch = 0, halfBps = 26 } = {}) {
  const e = Number(entry);
  if (!(e > 0)) return 0;
  const fee = Math.max(0, Number(feeBps) || 0) / 10000;
  const profit = Math.max(0, Number(profitBps) || 0) / 10000;
  const carry = Math.max(0, Number(carryPerUnit) || 0);
  const sign = side === 'short' || side === 'buy' ? -1 : 1;
  const profitPx = e * (1 + sign * (fee + profit));
  const bePx = e * (1 + sign * fee) + sign * carry;
  const age = Number(ageMin) || 0;
  const maxH = Number(maxHoldMin) > 0 ? Number(maxHoldMin) : 240;
  if (age + 1e-9 < 0.75 * maxH) return 0;
  if (age < maxH) {
    const t = (age - 0.75 * maxH) / (0.25 * maxH);
    return profitPx + (bePx - profitPx) * Math.max(0, Math.min(1, t));
  }
  const touchPx = Number(touch) > 0 ? Number(touch) : bePx;
  const steps = Math.floor((age - maxH) / 15);
  const step = Math.abs(e) * (Math.max(1, Number(halfBps) || 26) / 10000) * 0.25;
  const dir = touchPx >= bePx ? 1 : -1;
  let px = bePx + dir * step * Math.max(0, steps);
  if (dir > 0) px = Math.min(touchPx, Math.max(bePx, px));
  else px = Math.max(touchPx, Math.min(bePx, px));
  return px;
}

export function holdingClass({ qty = 0, mid = 0, minNotional = 1, minSize = 0 } = {}) {
  const q = Number(qty) || 0;
  const m = Number(mid) || 0;
  if (!(q > 0) || !(m > 0)) return 'dust';
  if (q + 1e-12 < (Number(minSize) || 0)) return 'dust';
  if (q * m + 1e-12 < Math.max(0, Number(minNotional) || 0)) return 'dust';
  return 'inventory';
}

// Opening half must pay the fee, the buffer, the profit, and a positive round trip.
export function openingMinHalfBps({ feeBps = 0, bufferBps = 6, profitBps = 10, minEdgeBps = 8, minHalfBps = 0 } = {}) {
  const fee = Math.max(0, Number(feeBps) || 0);
  const byBuffer = fee + Math.max(0, Number(bufferBps) || 0) + Math.max(0, Number(profitBps) || 0);
  const byEdge = fee + Math.max(0, Number(minEdgeBps) || 0) / 2;
  return Math.max(byBuffer, byEdge, Number(minHalfBps) || 0, 1);
}

// Long exit sits at or above this. Short exit sits at or below it.
export function costFloorPx({ entry = 0, side = 'long', feeBps = 0, profitBps = 0 } = {}) {
  const e = Number(entry);
  if (!(e > 0)) return 0;
  const pad = (Math.max(0, Number(feeBps) || 0) + Math.max(0, Number(profitBps) || 0)) / 10000;
  const sign = side === 'short' || side === 'buy' ? -1 : 1;
  return e * (1 + sign * pad);
}

export function posEffectOf({ longQty = 0, shortQty = 0, side = 'buy', size = 0 } = {}) {
  const sz = Math.max(0, Number(size) || 0);
  const buy = String(side || '').toLowerCase() === 'buy';
  const long = Math.max(0, Number(longQty) || 0);
  const short = Math.max(0, Number(shortQty) || 0);
  if (!(sz > 0)) return 'open';
  const have = buy ? short : long;
  const same = buy ? long : short;
  if (!(have > 1e-12) && !(same > 1e-12)) return 'open';
  if (!(have > 1e-12)) return 'add';
  if (sz + 1e-8 < have) return 'reduce';
  if (Math.abs(sz - have) <= Math.max(1e-8, have * 1e-6)) return 'close';
  return 'flip';
}

export function quoteCapture({ side = 'buy', price = 0, size = 0, mid = 0 } = {}) {
  const px = Number(price);
  const sz = Number(size);
  const m = Number(mid);
  if (!(px > 0) || !(sz > 0) || !(m > 0)) return null;
  return (String(side || '').toLowerCase() === 'buy' ? m - px : px - m) * sz;
}

// A tag means the exit may cross the cost floor. Session-loss is not one of them.
export function riskAllowsLoss({ ml = null, cut = 200, adverseFrac = 0, sigmaMove = 0, stopSigma = 3, stopPct = 0.03, ageMin = 0, maxHoldMin = 240, haltKind = '' } = {}) {
  if (ml != null && Number(ml) > 0 && Number(ml) < Number(cut)) return 'margin';
  const adv = Math.max(0, Number(adverseFrac) || 0);
  const need = Math.max(0, Number(stopSigma) || 0) * Math.max(0, Number(sigmaMove) || 0);
  if ((need > 0 && adv + 1e-12 >= need) || (Number(stopPct) > 0 && adv + 1e-12 >= Number(stopPct))) return 'stop';
  const maxH = Number(maxHoldMin) > 0 ? Number(maxHoldMin) : 240;
  if ((Number(ageMin) || 0) + 1e-9 >= 2 * maxH) return 'hold';
  if (haltKind === 'day-loss' || haltKind === 'margin-halt') return 'halt';
  return '';
}

export function stepToward({ from = 0, to = 0, halfBps = 26, steps = 0, entry = 0 } = {}) {
  const a = Number(from);
  const b = Number(to);
  if (!(a > 0)) return b > 0 ? b : 0;
  if (!(b > 0)) return a;
  const step = Math.abs(Number(entry) > 0 ? Number(entry) : a) * (Math.max(1, Number(halfBps) || 26) / 10000) * 0.25;
  const n = Math.max(0, Math.floor(Number(steps) || 0));
  const dir = b >= a ? 1 : -1;
  let px = a + dir * step * n;
  if (dir > 0) px = Math.min(b, px);
  else px = Math.max(b, px);
  return px;
}

// A reduce below the venue minimum rounds up only when that stays inside the position.
export function roundUpReduce({ size = 0, minSize = 0, posQty = 0 } = {}) {
  const sz = Math.max(0, Number(size) || 0);
  const minS = Math.max(0, Number(minSize) || 0);
  const pos = Math.max(0, Number(posQty) || 0);
  if (!(sz > 0)) return { size: 0, dust: true };
  if (!(minS > 0) || sz + 1e-12 >= minS) return { size: sz, dust: false };
  if (minS <= pos + 1e-12) return { size: minS, dust: false };
  return { size: 0, dust: true };
}

// Touch spread a maker must see before the round trip clears fees plus the minimum edge.
export function minBookSpreadBps({ feeBps = 0, minEdgeBps = 8 } = {}) {
  return 2 * Math.max(0, Number(feeBps) || 0) + Math.max(0, Number(minEdgeBps) || 0);
}

// Rank by net edge, not by how tight the book is. Volume is a weight, not the sort.
export function rankByNetEdge(rows, opts = {}) {
  const fee = Math.max(0, Number(opts.feeBps) || 0);
  const minEdge = Math.max(0, Number(opts.minEdgeBps) || 0);
  const minVol = Math.max(0, Number(opts.minVol) || 0);
  const maxSpread = Number(opts.maxSpreadBps) > 0 ? Number(opts.maxSpreadBps) : Infinity;
  const target = Math.max(0, Number(opts.targetVol) || 0);
  const evalN = Math.max(1, Number(opts.evalN) || 40);
  const maxPairs = Math.max(0, Number(opts.maxPairs) || 0);
  const ordered = [...(rows || [])].sort((a, b) => (Number(b.vol24) || 0) - (Number(a.vol24) || 0) || String(a.symbol || '').localeCompare(String(b.symbol || '')));
  const evald = ordered.slice(0, evalN);
  const rejected = { feeSpread: 0, vol: 0, tick: 0, wide: 0 };
  const feeSpread = [];
  const ok = [];
  let best = null;
  for (const row of evald) {
    const spread = Number(row.spreadBps) || 0;
    const edge = spread - 2 * fee;
    const vol = Number(row.vol24) || 0;
    if (!best || edge > best.edge) best = { symbol: row.symbol, edge };
    const tickBps = Number(row.tickBps) || 0;
    if (tickBps > 10) { rejected.tick += 1; continue; }
    if (vol + 1e-9 < minVol) { rejected.vol += 1; continue; }
    if (spread > maxSpread) { rejected.wide += 1; continue; }
    if (edge + 1e-9 < minEdge) { rejected.feeSpread += 1; feeSpread.push(row.symbol); continue; }
    const volW = target > 0 ? Math.min(1, vol / target) : 1;
    const tie = (Number(row.sigma) || 0) + tickBps;
    ok.push({ ...row, edge, score: edge * volW, tie });
  }
  ok.sort((a, b) => b.score - a.score || a.tie - b.tie || String(a.symbol).localeCompare(String(b.symbol)));
  return {
    picked: maxPairs > 0 ? ok.slice(0, maxPairs) : ok,
    rejected, feeSpread, best, evaluated: evald.length,
  };
}

export function haltPhase({ halted = '', since = 0, now = 0, holdMs = 6 * 3600 * 1000, maxMs = 24 * 3600 * 1000 } = {}) {
  if (halted !== 'session-loss') return '';
  const start = since == null || since === '' ? Number(now) : Number(since);
  const age = Math.max(0, Number(now) - (Number.isFinite(start) ? start : Number(now)));
  if (age + 1e-9 >= Number(maxMs)) return 'C';
  if (age + 1e-9 >= Number(holdMs)) return 'B';
  return 'A';
}

// Lowest long exit (highest short cover) once a session-loss halt is allowed to give ground.
export function haltExitBound({ cost = 0, side = 'long', maxLossPct = 0.015, equity = 0, qty = 0, haltLossUsed = 0 } = {}) {
  const c = Number(cost);
  if (!(c > 0)) return 0;
  const short = side === 'short' || side === 'buy';
  const cap = Math.max(0, Number(maxLossPct) || 0);
  const pctBound = short ? c * (1 + cap) : c * (1 - cap);
  const q = Number(qty) || 0;
  const eq = Number(equity) || 0;
  if (!(q > 0) || !(eq > 0)) return pctBound;
  const room = Math.max(0, eq * 0.01 - Math.max(0, Number(haltLossUsed) || 0));
  const eqBound = short ? c + room / q : c - room / q;
  return short ? Math.min(pctBound, eqBound) : Math.max(pctBound, eqBound);
}

// Phase B: step a quarter-spread toward the touch, never through the loss bound.
export function haltTimeoutPx({ cost = 0, side = 'long', touch = 0, halfBps = 26, steps = 0, maxLossPct = 0.015, equity = 0, qty = 0, haltLossUsed = 0 } = {}) {
  const c = Number(cost);
  if (!(c > 0)) return 0;
  const short = side === 'short' || side === 'buy';
  const bound = haltExitBound({ cost: c, side, maxLossPct, equity, qty, haltLossUsed });
  const touchPx = Number(touch) || 0;
  const dest = short
    ? (touchPx > 0 ? Math.min(Math.max(touchPx, c), bound) : bound)
    : (touchPx > 0 ? Math.max(Math.min(touchPx, c), bound) : bound);
  return stepToward({ from: c, to: dest, halfBps, steps, entry: c });
}

function snapOpen(px, inc, side) {
  const tick = Number(inc) > 0 ? Number(inc) : 0;
  if (!(tick > 0)) return px;
  return side === 'buy' ? Math.floor(px / tick + 1e-8) * tick : Math.ceil(px / tick - 1e-8) * tick;
}

// why is ok, max-dist, below-need, or no-mid. half is the half that would have been sent.
export function widenOpenDecision({ px = 0, side = 'buy', mid = 0, needBps = 0, touch = 0, otherTouch = 0, maxDistBps = 150, inc = 0, spreadMedBps = 0 } = {}) {
  const m = Number(mid);
  const need = Math.max(0, Number(needBps) || 0);
  const capBase = Math.max(0, Number(maxDistBps) || 0);
  if (!(m > 0)) return { px: 0, why: 'no-mid', need, distTouch: 0, cap: capBase, half: 0, spreadMed: 0 };
  const buy = String(side) !== 'sell';
  const raw = buy ? m * (1 - need / 10000) : m * (1 + need / 10000);
  let next = buy ? Math.min(Number(px) > 0 ? Number(px) : raw, raw) : Math.max(Number(px) > 0 ? Number(px) : raw, raw);
  next = snapOpen(next, inc, buy ? 'buy' : 'sell');
  if (buy && !(next < m)) next = snapOpen(raw, inc, 'buy');
  if (!buy && !(next > m)) next = snapOpen(raw, inc, 'sell');
  if (!(next > 0)) return { px: 0, why: 'no-mid', need, distTouch: 0, cap: capBase, half: 0, spreadMed: 0 };
  const half = Math.abs(next - m) / m * 10000;
  const bid = buy ? Number(touch) || 0 : Number(otherTouch) || 0;
  const ask = buy ? Number(otherTouch) || 0 : Number(touch) || 0;
  const distTouch = Number(touch) > 0 ? Math.abs(next - Number(touch)) / m * 10000 : 0;
  const touchSpread = bid > 0 && ask > bid ? (ask - bid) / m * 10000 : 0;
  const spreadMed = Number(spreadMedBps) > 0 ? Number(spreadMedBps) : touchSpread;
  const wide = need > 0 && touchSpread > 2 * need;
  const cap = Math.max(capBase, spreadMed / 2 + need);
  const measured = wide ? half : distTouch;
  if (measured > cap + 1e-6) return { px: 0, why: 'max-dist', need, distTouch, cap, half, spreadMed };
  if (half + 0.5 < need) return { px: 0, why: 'below-need', need, distTouch, cap, half, spreadMed };
  return { px: next, why: 'ok', need, distTouch, cap, half, spreadMed };
}

export function openGateWhy(decision) {
  if (!decision || decision.why === 'ok') return '';
  const need = Math.round(Number(decision.need) || 0);
  if (decision.why === 'max-dist') {
    const med = Number(decision.spreadMed) > 0 ? ' spread_med=' + Math.round(Number(decision.spreadMed)) : '';
    return 'max-dist need=' + need + ' dist_touch=' + Math.round(Number(decision.distTouch) || 0) + ' cap=' + Math.round(Number(decision.cap) || 0) + med;
  }
  if (decision.why === 'below-need') {
    const half = Number(decision.half) || 0;
    if (!(half + 0.5 < Number(decision.need))) return '';
    return 'fee-edge half=' + Math.round(half) + ' need=' + need;
  }
  if (decision.why === 'no-mid') return 'no-mid';
  return '';
}

export function unexplainedJump({ prev = 0, next = 0, quiet = true } = {}) {
  if (!quiet) return 0;
  const p = Number(prev) || 0;
  const n = Number(next) || 0;
  if (!(p > 0)) return 0;
  const jump = n - p;
  if (Math.abs(jump) > Math.max(Math.abs(p) * 0.05, 1)) return jump;
  return 0;
}

export function dustTopupUsd({ dustUsd = 0, venueMin = 1 } = {}) {
  return Math.max(0, (Number(venueMin) || 0) - Math.max(0, Number(dustUsd) || 0));
}

export function bookSlots({ budget = 0, maxPairs = 1, venueMin = 1 } = {}) {
  const floor = Math.max(0.01, (Number(venueMin) || 1) * 1.2);
  const n = Math.floor(Math.max(0, Number(budget) || 0) / floor);
  return Math.max(0, Math.min(Math.max(0, Number(maxPairs) || 0), n));
}

// Per-slot share of the cash budget. A CLIP_MAX under that share cannot hit the book target,
// so it only binds when it is wider than the venue minimum.
export function openClipUsd({ budget = 0, slots = 1, clipMax = 0, venueMin = 1 } = {}) {
  const n = Math.max(1, Number(slots) || 1);
  const share = Math.max(0, Number(budget) || 0) / n;
  const venueFloor = Math.max(Number(venueMin) || 0, (Number(venueMin) || 0) * 1.2);
  if (share + 1e-9 < Math.max(Number(venueMin) || 0, venueFloor)) return 0;
  const cap = Number(clipMax) || 0;
  if (cap > venueFloor) return Math.min(share, cap);
  return share;
}

export function tradableBookTarget({ equity = 0, dust = 0, reserve = 0, frac = 0.9, askCover = 0 } = {}) {
  const base = Math.max(0, (Number(equity) || 0) - (Number(dust) || 0) - (Number(reserve) || 0));
  const target = Math.max(0, Number(frac) || 0) * base;
  return { target, bidRoom: Math.max(0, target - Math.max(0, Number(askCover) || 0)) };
}

// Missing price does not count as flat. A known price under the venue minimum does.
export function positionAboveMin({ qty = 0, mid = 0, minNotional = 1, minSize = 0 } = {}) {
  const q = Math.abs(Number(qty) || 0);
  if (!(q > 0)) return false;
  if ((Number(minSize) || 0) > 0 && q + 1e-12 < Number(minSize)) return false;
  const m = Number(mid) || 0;
  if (!(m > 0)) return true;
  return q * m + 1e-12 >= Math.max(0, Number(minNotional) || 0);
}

// Round trip is both fees plus the minimum edge. One fee is not a close.
export function roundTripPadBps({ feeBps = 0, minEdgeBps = 8 } = {}) {
  return 2 * Math.max(0, Number(feeBps) || 0) + Math.max(0, Number(minEdgeBps) || 0);
}

function snapAway(px, tick, dir) {
  const t = Number(tick) > 0 ? Number(tick) : 0;
  if (!(t > 0) || !(Number(px) > 0)) return Number(px) || 0;
  if (dir > 0) return Math.ceil(Number(px) / t - 1e-12) * t;
  return Math.floor(Number(px) / t + 1e-12) * t;
}

// Long close ask is at least this. Short close bid is at most this. Rounded away from entry.
export function roundTripFloorPx({ entry = 0, side = 'long', feeBps = 0, minEdgeBps = 8, tick = 0 } = {}) {
  const e = Number(entry);
  if (!(e > 0)) return 0;
  const pad = roundTripPadBps({ feeBps, minEdgeBps }) / 10000;
  const short = side === 'short' || side === 'buy';
  const raw = short ? e * (1 - pad) : e * (1 + pad);
  return snapAway(raw, tick, short ? -1 : 1);
}

// After a fill, the opposite order cannot sit tighter than fill ± the same pad.
export function oppositeFloorPx({ fillPx = 0, side = 'buy', feeBps = 0, minEdgeBps = 8, tick = 0 } = {}) {
  const f = Number(fillPx);
  if (!(f > 0)) return 0;
  const pad = roundTripPadBps({ feeBps, minEdgeBps }) / 10000;
  const buy = String(side || '').toLowerCase() === 'buy';
  const raw = buy ? f * (1 + pad) : f * (1 - pad);
  return snapAway(raw, tick, buy ? 1 : -1);
}

const RISK_EXEMPT = new Set(['halt-delever', 'halt-cap', 'day-kill', 'lifetime-rail', 'liq']);

export function riskExempt(tag) {
  return RISK_EXEMPT.has(String(tag || ''));
}

// A close (or a requote) inside the round-trip floor is not sent unless the tag is a defined risk exit.
export function edgeGate({ px = 0, floor = 0, side = 'sell', risk = '' } = {}) {
  if (riskExempt(risk)) return { ok: true, why: '' };
  const p = Number(px);
  const f = Number(floor);
  if (!(p > 0) || !(f > 0)) return { ok: true, why: '' };
  const sell = String(side || '') !== 'buy';
  const through = sell ? p + 1e-12 < f : p - 1e-12 > f;
  if (!through) return { ok: true, why: '' };
  return { ok: false, why: 'edge need=' + f + ' have=' + p };
}

// (exit − entry) × qty − both fees. Short profits when exit is below entry.
export function roundTripNet({ entry = 0, exit = 0, qty = 0, feeBps = 0, side = 'long' } = {}) {
  const e = Number(entry);
  const x = Number(exit);
  const q = Math.abs(Number(qty) || 0);
  if (!(e > 0) || !(x > 0) || !(q > 0)) return 0;
  const short = side === 'short' || side === 'buy';
  const gross = short ? (e - x) * q : (x - e) * q;
  const fees = (e + x) * q * (Math.max(0, Number(feeBps) || 0) / 10000);
  return gross - fees;
}

export function pairCooldownMs({ losses24h = 0, losing = false, cooldownMin = 60 } = {}) {
  if (!(losing || Number(losses24h) >= 2)) return 0;
  if (Number(losses24h) >= 2) return 6 * 3600 * 1000;
  return Math.max(0, Number(cooldownMin) || 60) * 60 * 1000;
}

export function churnSignal({ fills = 0, fees = 0, capture = 0, minFills = 6 } = {}) {
  if ((Number(fills) || 0) + 1e-9 < (Number(minFills) || 6)) return false;
  return (Number(fees) || 0) - (Number(capture) || 0) > 0;
}

export function lifetimePct({ equity = 0, baseline = 0 } = {}) {
  const b = Number(baseline);
  if (!(b > 0)) return 0;
  return ((Number(equity) || 0) - b) / b;
}

export function lifetimeHalt({ equity = 0, baseline = 0, ddPct = 0.25 } = {}) {
  const b = Number(baseline);
  if (!(b > 0)) return false;
  return lifetimePct({ equity, baseline: b }) <= -Math.abs(Number(ddPct) || 0.25) + 1e-12;
}

export function lifeText({ equity = 0, baseline = 0 } = {}) {
  const b = Number(baseline) || 0;
  const e = Number(equity) || 0;
  const p = lifetimePct({ equity: e, baseline: b }) * 100;
  return 'life=$' + e.toFixed(2) + ' vs $' + b.toFixed(2) + ' (' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%)';
}

export function resetAllowed({ resets = [], now = 0, max = 1, windowMs = 24 * 3600 * 1000 } = {}) {
  const t = Number(now) || 0;
  const recent = (resets || []).filter((x) => t - Number(x) < Number(windowMs));
  return recent.length < Math.max(0, Number(max) || 0);
}

export function leverageNotch({ step = 0, elapsedMs = 0, positive = false, lost = false, maxLev = 5, stepMs = 2 * 3600 * 1000, notches = null } = {}) {
  const cap = Math.max(2, Number(maxLev) || 5);
  const ladder = (notches && notches.length ? notches : [2, 3, 5, cap]).map((n) => Math.min(cap, Number(n) || 2));
  if (ladder[ladder.length - 1] < cap) ladder.push(cap);
  let i = Math.max(0, Math.min(ladder.length - 1, Math.floor(Number(step) || 0)));
  if (lost) return { step: i, lev: ladder[i], advanced: false };
  if (positive && Number(elapsedMs) + 1e-9 >= Number(stepMs) && i + 1 < ladder.length) {
    i += 1;
    return { step: i, lev: ladder[i], advanced: true };
  }
  return { step: i, lev: ladder[i], advanced: false };
}

// Expected half is the wider of the touch and k × σ over the hold. Quoting past the touch is allowed.
export function expectedEdgeRow(row, opts = {}) {
  const fee = Math.max(0, Number(opts.feeBps) || 0);
  const minEdge = Math.max(0, Number(opts.minEdgeBps) || 0);
  const k = Number(opts.k) > 0 ? Number(opts.k) : 1.5;
  const tau = Number(opts.tauMin) > 0 ? Number(opts.tauMin) : 15;
  const kappa = Number(opts.kappa) > 0 ? Number(opts.kappa) : 1.5;
  const quotedHalf = Math.max(0, Number(row && row.spreadBps) || 0) / 2;
  const sig = Math.max(0, Number(row && row.sigma) || 0);
  const horizonBps = sig * Math.sqrt(tau) * 10000;
  const need = roundTripPadBps({ feeBps: fee, minEdgeBps: minEdge });
  const expHalf = Math.max(quotedHalf, k * horizonBps, need);
  const extra = Math.max(0, expHalf - quotedHalf);
  const fillp = Math.exp(-kappa * extra / 100);
  const expEdge = fillp * (2 * expHalf - 2 * fee);
  const tradeable = expEdge > 0 && expHalf + 1e-9 >= need;
  return { expHalf, need, fillp, expEdge, tradeable, quotedHalf };
}

export function rankByExpectedEdge(rows, opts = {}) {
  const minVol = Math.max(0, Number(opts.minVol) || 0);
  const maxSpread = Number(opts.maxSpreadBps) > 0 ? Number(opts.maxSpreadBps) : Infinity;
  const maxPairs = Math.max(0, Number(opts.maxPairs) || 0);
  const rejected = { feeSpread: 0, vol: 0, tick: 0, wide: 0, edge: 0 };
  const scored = [];
  const reasons = [];
  const considered = [];
  for (const row of rows || []) {
    const tickBps = Number(row.tickBps) || 0;
    const vol = Number(row.vol24) || 0;
    const spread = Number(row.spreadBps) || 0;
    let reason = '';
    if (tickBps > 10) { rejected.tick += 1; reason = 'tick'; }
    else if (vol + 1e-9 < minVol) { rejected.vol += 1; reason = 'vol'; }
    else if (spread > maxSpread) { rejected.wide += 1; reason = 'wide'; }
    else {
      const e = expectedEdgeRow(row, opts);
      considered.push({ symbol: row.symbol, ...e, edge: e.expEdge, vol24: vol });
      if (!e.tradeable) { rejected.edge += 1; rejected.feeSpread += 1; reason = 'fee-spread'; }
      else scored.push({ ...row, ...e, edge: e.expEdge, score: e.expEdge });
    }
    if (reason) reasons.push({ symbol: row.symbol, reason, val: reason === 'vol' ? vol : reason === 'tick' ? tickBps : spread, need: roundTripPadBps({ feeBps: opts.feeBps, minEdgeBps: opts.minEdgeBps }) });
  }
  scored.sort((a, b) => b.expEdge - a.expEdge || String(a.symbol).localeCompare(String(b.symbol)));
  considered.sort((a, b) => b.expEdge - a.expEdge || String(a.symbol).localeCompare(String(b.symbol)));
  return {
    picked: maxPairs > 0 ? scored.slice(0, maxPairs) : scored,
    rejected,
    feeSpread: reasons.filter((r) => r.reason === 'fee-spread').map((r) => r.symbol),
    best: considered[0] ? { symbol: considered[0].symbol, edge: considered[0].expEdge } : null,
    best5: considered.slice(0, 5),
    evaluated: (rows || []).length,
    reasons,
  };
}

export function cbTransferAllowed(type) {
  const t = String(type || '').toLowerCase();
  if (/buy|sell|trade|advanced_trade_fill|retail_simple_dust|interest|staking_reward/.test(t)) return false;
  return /send|receive|fiat_deposit|fiat_withdrawal|deposit|withdrawal|transfer|exchange_deposit|exchange_withdrawal|pro_deposit|pro_withdrawal|intx_deposit|intx_withdrawal/.test(t);
}

// Sign comes from the amount. A send onto this account is a positive deposit.
export function transferUsd({ amount = 0, px = 1, status = 'completed' } = {}) {
  const st = String(status || 'completed').toLowerCase();
  if (st && st !== 'completed') return 0;
  const a = Number(amount);
  if (!Number.isFinite(a) || a === 0) return 0;
  const p = Number(px);
  if (!(p > 0)) return 0;
  return Math.sign(a) * Math.abs(a) * p;
}

export function pendingTrigger({ resid = 0, equity = 0, fillDelta = 0 } = {}) {
  if (Math.abs(Number(fillDelta) || 0) >= 0.05) return 0;
  const thresh = Math.max(1, Math.abs(Number(equity) || 0) * 0.03);
  const r = Number(resid) || 0;
  if (Math.abs(r) > thresh) return r;
  return 0;
}

// Pending cash is already inside older equity marks. Shift those marks by the
// pending amount so a day-loss check does not treat the same cash as a loss.
// Marks far from the current gross (a real earlier peak) stay put.
export function marksForPending({ marks = [], gross = 0, pending = 0, shifted = 0 } = {}) {
  const usd = Number(pending) || 0;
  const g = Number(gross) || 0;
  const prev = Number(shifted) || 0;
  const out = (marks || []).map((m) => ({ t: m.t, eq: Number(m.eq) || 0 }));
  if (!(usd > 0) || !(g > 0)) {
    if (prev) return { marks: out.map((m) => ({ t: m.t, eq: m.eq + prev })), shifted: 0 };
    return { marks: out, shifted: 0 };
  }
  if (prev) return { marks: out, shifted: prev };
  const band = Math.max(1, usd * 0.25);
  let n = 0;
  for (const m of out) {
    if (Math.abs(m.eq - g) <= band) { m.eq -= usd; n += 1; }
  }
  return { marks: out, shifted: n ? usd : 0 };
}

export function haltRiskAction({ notional = 0, equity = 0, haltEquity = 0, equityNow = 0, ageH = 0, maxLev = 2, extraLossPct = 0.02, maxHoldH = 6 } = {}) {
  const eq = Number(equityNow) > 0 ? Number(equityNow) : Number(equity);
  const capN = Math.max(0, Number(maxLev) || 2) * Math.max(0, eq);
  const n = Math.abs(Number(notional) || 0);
  const base = Number(haltEquity) || 0;
  const lossPct = base > 0 ? (base - eq) / base : 0;
  if (lossPct > Number(extraLossPct) + 1e-12 || Number(ageH) + 1e-9 >= Number(maxHoldH)) return 'cap-exit';
  if (capN > 0 && n > capN + 1e-6) return 'delever';
  return 'hold';
}

export function bookSlotsScaled({ budget = 0, venueMin = 1, maxPairs = 6 } = {}) {
  const floorUsd = Math.max(0.01, (Number(venueMin) || 1) * 1.2);
  const n = Math.floor(Math.max(0, Number(budget) || 0) / floorUsd);
  const cap = Math.max(1, Number(maxPairs) || 1);
  return Math.max(1, Math.min(cap, Math.max(n, 1)));
}

export function slotClipUsd({ budget = 0, slots = 1, venueMin = 1 } = {}) {
  const n = Math.max(1, Number(slots) || 1);
  const clip = Math.max(0, Number(budget) || 0) * 0.9 / n;
  const min = Math.max(0, Number(venueMin) || 0);
  if (clip + 1e-9 < min) return min > 0 && clip + 1e-9 < min ? 0 : clip;
  return clip;
}

export function idleRelax({ idleMin = 0, minEdgeBps = 8, volFloor = 0 } = {}) {
  if (Number(idleMin) + 1e-9 < 60) return { minEdgeBps: Number(minEdgeBps) || 0, volFloor: Number(volFloor) || 0, relaxed: false };
  return {
    minEdgeBps: Math.min(Number(minEdgeBps) || 0, 2),
    volFloor: Math.max(0, Number(volFloor) || 0) / 2,
    relaxed: true,
  };
}

// Opening notional at ramp leverage: margin level stays at `resume`, and the book stays inside bookFrac.
export function krakenNotionalRoom({ equity = 0, lev = 2, resume = 350, usedMargin = 0, bookFrac = 0.9 } = {}) {
  const e = Math.max(0, Number(equity) || 0);
  const L = Math.max(1, Number(lev) || 1);
  const r = (Number(resume) > 0 ? Number(resume) : 350) / 100;
  const marginRoom = Math.max(0, e / r - Math.max(0, Number(usedMargin) || 0));
  const bookCap = e * L * Math.max(0, Number(bookFrac) || 0);
  return { marginRoom, notional: Math.max(0, Math.min(marginRoom * L, bookCap)) };
}

// Give room to the sides that clear the venue minimum, best expected edge first.
// A side that cannot fit releases its share. If none fit, the best side may take exactly the minimum.
// Reasons are min-size, margin, or loss-cap. Never "budget" (that label is Coinbase cash only).
export function krakenOpeningPlan({ equity = 0, lev = 2, resume = 350, usedMargin = 0, bookFrac = 0.9, sides = [] } = {}) {
  const room = krakenNotionalRoom({ equity, lev, resume, usedMargin, bookFrac });
  const list = (sides || []).map((s) => ({
    id: s.id,
    sym: s.sym,
    side: s.side,
    want: Math.max(0, Number(s.want) || 0),
    min: Math.max(0, Number(s.min) || 0),
    lossCap: Number(s.lossCap) > 0 ? Number(s.lossCap) : Infinity,
    fillp: Number(s.fillp) > 0 && Number(s.fillp) <= 1 ? Number(s.fillp) : 1,
    wider: !!s.wider,
    expEdge: Number(s.expEdge) || 0,
  }));
  const result = list.map((s) => ({
    id: s.id, sym: s.sym, side: s.side, fit: 0, reason: '',
    min: s.min, lossCap: Number.isFinite(s.lossCap) ? s.lossCap : 0,
  }));
  for (let i = 0; i < list.length; i++) {
    if (!(list[i].want > 0)) continue;
    if (list[i].min > 0 && list[i].lossCap + 1e-9 < list[i].min) {
      result[i].reason = 'min-size';
      list[i].dead = true;
    }
  }
  const alive = list.map((s, i) => ({ s, i })).filter((x) => !x.s.dead && x.s.want > 0);
  alive.sort((a, b) => b.s.expEdge - a.s.expEdge || String(a.s.id || '').localeCompare(String(b.s.id || '')));
  let left = room.notional;
  const placed = [];
  for (const { s, i } of alive) {
    let n = Math.min(s.want, s.lossCap, left);
    if (s.wider && s.fillp < 1) n *= s.fillp;
    if (s.min > 0 && n + 1e-9 < s.min) {
      if (!(s.lossCap + 1e-9 >= s.min)) result[i].reason = 'loss-cap';
      else if (!(left + 1e-9 >= s.min)) result[i].reason = 'margin';
      else result[i].reason = 'min-size';
      continue;
    }
    if (!(n > 0)) { result[i].reason = 'margin'; continue; }
    result[i].fit = n;
    result[i].reason = '';
    left -= n;
    placed.push(i);
  }
  if (!placed.length) {
    const one = alive.find(({ s }) => s.lossCap + 1e-9 >= s.min && room.notional + 1e-9 >= s.min && s.min > 0);
    if (one) {
      result[one.i].fit = one.s.min;
      result[one.i].reason = '';
    }
  }
  return { room: room.notional, marginRoom: room.marginRoom, sides: result };
}

// Trading P&L only. Residual and pending are printed beside it and do not move the percent.
export function lifeTradingText({ trading = 0, baseline = 0, resid = 0, pending = 0 } = {}) {
  const b = Number(baseline) || 0;
  const t = Number(trading) || 0;
  const left = b + t;
  const p = b > 0 ? (t / b) * 100 : 0;
  let s = 'life=$' + left.toFixed(2) + ' vs $' + b.toFixed(2) + ' (' + (p >= 0 ? '+' : '') + p.toFixed(1) + '% trading)';
  const r = Number(resid) || 0;
  const q = Number(pending) || 0;
  if (Math.abs(r) >= 0.005) s += ' resid=$' + r.toFixed(2);
  if (Math.abs(q) >= 0.005) s += ' pending=$' + q.toFixed(2);
  return s;
}

export function cashTransferJump({ prevCash = 0, nextCash = 0, fillDelta = 0, feeDelta = 0, orderHoldDelta = 0 } = {}) {
  const prev = Number(prevCash) || 0;
  if (!(prev > 0)) return 0;
  if (Math.abs(Number(fillDelta) || 0) >= 0.05) return 0;
  if (Math.abs(Number(feeDelta) || 0) >= 0.05) return 0;
  const delta = (Number(nextCash) || 0) - prev;
  const unexplained = delta + (Number(orderHoldDelta) || 0);
  if (Math.abs(unexplained) + 1e-9 < 1) return 0;
  return unexplained;
}

// Trading loss as a fraction of capital. Residual and pending are not inputs.
export function drawdownPct({ trading = 0, capital = 0 } = {}) {
  const c = Number(capital) || 0;
  const t = Number(trading) || 0;
  if (!(c > 0) || !(t < 0)) return 0;
  return -t / c;
}

// Session, day, and lifetime each use trading / capital. resid and pending do not move them.
export function lossHalts({
  sessionTrading = 0, dayTrading = 0, lifeTrading = 0,
  sessionCapital = 0, dayCapital = 0, lifeCapital = 0,
  sessionLoss = 0.08, dayLoss = 0.12, lifetimeDd = 0.25,
  resid = 0, pending = 0,
} = {}) {
  const ignored = (Number(resid) || 0) * 0 + (Number(pending) || 0) * 0;
  const session = drawdownPct({ trading: sessionTrading, capital: sessionCapital }) + ignored;
  const day = drawdownPct({ trading: dayTrading, capital: dayCapital });
  const lifetime = drawdownPct({ trading: lifeTrading, capital: lifeCapital });
  return {
    session, day, lifetime,
    sessionHalt: session + 1e-12 >= Math.abs(Number(sessionLoss) || 0),
    dayHalt: day + 1e-12 >= Math.abs(Number(dayLoss) || 0),
    lifetimeHalt: lifetime + 1e-12 >= Math.abs(Number(lifetimeDd) || 0),
  };
}

export function displayCapital(state) {
  const s = state || {};
  const lifeT = Number(s.lifetimeTransfers) || 0;
  const origin = Number(s.originEquity) > 0 ? Number(s.originEquity) : (Number(s.capitalBaseline) > 0 ? Number(s.capitalBaseline) - lifeT : 0);
  const base = Number(s.capitalBaseline) > 0 ? Number(s.capitalBaseline) : origin + lifeT;
  return base - (Number(s.pendingShift) || 0);
}

// One shift for every stored baseline. Caller decides booked vs pending.
export function applyCapitalShift(state, usd, why) {
  const n = Number(usd) || 0;
  const s = { ...(state || {}) };
  if (!n) return s;
  if (Number(s.startEquity) > 0) s.startEquity = Number(s.startEquity) + n;
  const prevLife = Number(s.lifetimeTransfers) || 0;
  const origin = Number(s.originEquity) > 0
    ? Number(s.originEquity)
    : (Number(s.capitalBaseline) > 0 ? Number(s.capitalBaseline) - prevLife : 0);
  if (origin > 0) s.originEquity = origin;
  s.lifetimeTransfers = prevLife + n;
  s.capitalBaseline = origin + s.lifetimeTransfers;
  s.equityMarks = (s.equityMarks || []).map((m) => ({ t: m.t, eq: (Number(m.eq) || 0) + n }));
  if (Number(s.haltEquity) > 0) s.haltEquity = Number(s.haltEquity) + n;
  s.resetBaselines = (s.resetBaselines || []).map((b) => (typeof b === 'number' ? b + n : { ...b, eq: (Number(b.eq) || 0) + n }));
  if (Number(s.prevEquity) > 0) s.prevEquity = Number(s.prevEquity) + n;
  if (Number(s.lastEquity) > 0) s.lastEquity = Number(s.lastEquity) + n;
  s.capitalShiftWhy = why || '';
  return s;
}

export function openPending(state, usd, source, now) {
  const s = { ...(state || {}) };
  const n = Number(usd) || 0;
  if (!n || s.transferPending) return { state: s, opened: false, id: '' };
  const id = String(source || 'jump') + '-' + (Number(now) || Date.now());
  const next = applyCapitalShift(s, n, 'pending');
  next.transferPending = { usd: n, at: Number(now) || Date.now(), since: Number(now) || Date.now(), source: source || 'jump', id };
  next.pendingShift = (Number(s.pendingShift) || 0) + n;
  next.skipHalt = true;
  return { state: next, opened: true, id };
}

export function settleTransfer(state, rec) {
  const s = {
    ...(state || {}),
    seenLedgers: { ...((state && state.seenLedgers) || {}) },
    equityMarks: ((state && state.equityMarks) || []).map((m) => ({ ...m })),
    resetBaselines: ((state && state.resetBaselines) || []).slice(),
  };
  const id = String((rec && rec.id) || '');
  const usd = Number(rec && rec.usd) || 0;
  if (!id || !usd || s.seenLedgers[id]) return { state: s, booked: false };
  let shift = usd;
  const pending = s.transferPending;
  if (pending && !rec.inferred) {
    const tol = Math.max(0.02, Math.abs(Number(pending.usd) || 0) * 0.02);
    if (Math.abs(usd - Number(pending.usd)) <= tol) {
      shift = usd - Number(pending.usd);
      s.pendingShift = (Number(s.pendingShift) || 0) - Number(pending.usd);
      s.transferPending = null;
      s.replacedPending = pending.id || true;
    }
  }
  const inf = s.inferredOpen;
  if (inf && !rec.inferred) {
    const tol = Math.max(0.02, Math.abs(Number(inf.usd) || 0) * 0.02);
    if (Math.abs(usd - Number(inf.usd)) <= tol) {
      shift -= Number(inf.usd);
      s.transfers = (Number(s.transfers) || 0) - Number(inf.usd);
      s.inferredOpen = null;
    }
  }
  let next = shift ? applyCapitalShift(s, shift, (rec && rec.source) || 'book') : s;
  next.transfers = (Number(next.transfers) || 0) + usd;
  next.transferThisLoop = (Number(next.transferThisLoop) || 0) + usd;
  next.seenLedgers = { ...(next.seenLedgers || {}), [id]: true };
  if (rec && rec.inferred) {
    next.inferredOpen = { id, usd };
    next.transferPending = null;
  }
  return { state: next, booked: true, shift };
}

export function clearPendingState(state, id) {
  const s = { ...(state || {}) };
  const p = s.transferPending;
  if (!p) return { state: s, result: 'no-pending' };
  if (id && p.id && String(p.id) !== String(id)) return { state: s, result: 'id-mismatch' };
  const usd = Number(p.usd) || 0;
  const next = usd ? applyCapitalShift(s, -usd, 'pending-reverse') : s;
  next.pendingShift = (Number(s.pendingShift) || 0) - usd;
  next.transferPending = null;
  return { state: next, result: 'cleared', usd };
}

export function controlResume(state) {
  const prev = (state && state.halted) || null;
  return {
    prev,
    state: {
      ...(state || {}),
      halted: null,
      haltSwept: false,
      haltSince: 0,
      haltAt: 0,
      haltPhase: '',
      haltAction: '',
      haltEquity: 0,
      haltNotional: 0,
    },
  };
}

export function statusMoney({ equity = 0, capital = 0, trading = 0, resid = 0, pending = 0 } = {}) {
  const c = Number(capital) || 0;
  const t = Number(trading) || 0;
  const p = c > 0 ? (t / c) * 100 : 0;
  const sign = p >= 0 ? '+' : '';
  return 'eq=$' + Number(equity || 0).toFixed(2)
    + ' capital=$' + c.toFixed(2)
    + ' trading=$' + t.toFixed(2) + ' (' + sign + p.toFixed(1) + '%)'
    + ' resid=$' + Number(resid || 0).toFixed(2)
    + ' pending=$' + Number(pending || 0).toFixed(2);
}

export function dustCanExit({ qty = 0, mid = 0, minSize = 0, minNotional = 1 } = {}) {
  const q = Number(qty) || 0;
  const m = Number(mid) || 0;
  if (!(q > 0) || !(m > 0)) return false;
  if (q + 1e-12 < (Number(minSize) || 0)) return false;
  return q * m + 1e-12 >= Math.max(0, Number(minNotional) || 0);
}

export function pnlResidual({ equity = 0, startEquity = 0, transfers = 0, netMaker = 0, inventoryPnl = 0, fundingBorrow = 0, dustPnl = 0 } = {}) {
  const left = Number(equity) - Number(startEquity) - Number(transfers || 0);
  const right = Number(netMaker || 0) + Number(inventoryPnl || 0) + Number(dustPnl || 0) - Number(fundingBorrow || 0);
  return left - right;
}




