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
  };
  const qty = Number(fill && fill.size);
  const px = Number(fill && fill.price);
  if (!(qty > 0) || !(px > 0)) return e;
  const buy = String(fill.side || '').toLowerCase() === 'buy';
  const when = Date.parse(fill.time) || Number(fill.at) || Date.now();
  if (buy) {
    const close = Math.min(e.shortQty, qty);
    if (close > 0 && e.shortQty > 0) {
      const avg = e.shortCost / e.shortQty;
      e.shortQty -= close;
      e.shortCost = Math.max(0, avg * e.shortQty);
    }
    const open = qty - close;
    if (open > 0) {
      e.longCost += open * px;
      e.longQty += open;
      e.basis = 'fill';
      e.at = when;
    }
  } else {
    const close = Math.min(e.longQty, qty);
    if (close > 0 && e.longQty > 0) {
      const avg = e.longCost / e.longQty;
      e.longQty -= close;
      e.longCost = Math.max(0, avg * e.longQty);
    }
    const open = qty - close;
    if (open > 0) {
      e.shortCost += open * px;
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
