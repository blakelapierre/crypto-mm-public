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
