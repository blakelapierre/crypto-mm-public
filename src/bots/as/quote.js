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

export function pnlResidual({ equity = 0, startEquity = 0, transfers = 0, netMaker = 0, inventoryPnl = 0, fundingBorrow = 0 } = {}) {
  const left = Number(equity) - Number(startEquity) - Number(transfers || 0);
  const right = Number(netMaker || 0) + Number(inventoryPnl || 0) - Number(fundingBorrow || 0);
  return left - right;
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

