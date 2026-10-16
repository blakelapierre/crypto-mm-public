// Pure ladder math for Coinbase equities. Orders are limit and post-only.
// The product id is the venue hash, never the display ticker.

export function sessionWindow(details, now) {
  const windows = (details && details.trading_day_info && details.trading_day_info.trading_sessions) || [];
  const t = Number(now);
  for (const w of windows) {
    const a = Date.parse(w && w.session_start_time);
    const b = Date.parse(w && w.session_end_time);
    if (Number.isFinite(a) && Number.isFinite(b) && t >= a && t < b) return w;
  }
  return null;
}

export function wholeShares(details, side, now) {
  const w = sessionWindow(details, now);
  if (w && w.support_fractional === false) return true;
  const flags = (details && details.equity_trading_flags) || {};
  const key = side === 'sell' ? 'sell_fractional_shares' : 'buy_fractional_shares';
  if (flags[key] === false) return true;
  const sess = String((details && details.current_session) || '');
  if (sess && sess !== 'EQUITY_TRADING_SESSION_NORMAL' && sess !== 'UNKNOWN_EQUITY_TRADING_SESSION') return true;
  return false;
}

export function tradableNow(product, now) {
  if (!product || product.trading_disabled || product.view_only || product.cancel_only) return false;
  const d = product.equity || {};
  if (d.trading_halted) return false;
  const flags = d.equity_trading_flags || {};
  if (flags.tradable === false) return false;
  return !!sessionWindow(d, now);
}

function snap(px, tick, dir) {
  const t = Number(tick);
  const n = Number(px);
  if (!(n > 0)) return 0;
  if (!(t > 0)) return n;
  const k = dir < 0 ? Math.floor(n / t + 1e-8) : Math.ceil(n / t - 1e-8);
  const d = Math.min(8, (String(t).split('.')[1] || '').replace(/0+$/, '').length || 2);
  return Number((k * t).toFixed(d));
}

export function shareSize({ price = 0, budgetUsd = 0, whole = true, minSize = 0 } = {}) {
  const px = Number(price);
  const budget = Number(budgetUsd);
  if (!(px > 0) || !(budget > 0)) return 0;
  let sz = budget / px;
  if (whole) sz = Math.floor(sz + 1e-9);
  const min = Number(minSize) || 0;
  if (whole && sz < 1) return 0;
  if (min > 0 && sz + 1e-12 < min) return 0;
  if (!(sz > 0) || sz * px > budget + 1e-6) return 0;
  return sz;
}

// One bid under the touch and one ask over it, then extra rungs further out.
// A price that would cross is pulled back a tick, or dropped.
export function rungPrices({ mid = 0, bid = 0, ask = 0, halfBps = 10, levels = 1, tick = 0.01, join = true } = {}) {
  const t = Number(tick) > 0 ? Number(tick) : 0.01;
  const half = Math.max(0, Number(halfBps) || 0) / 10000;
  const n = Math.max(1, Number(levels) || 1);
  const m = Number(mid) > 0 ? Number(mid) : (Number(bid) > 0 && Number(ask) > 0 ? (Number(bid) + Number(ask)) / 2 : 0);
  const bids = [];
  const asks = [];
  if (!(m > 0)) return { bids, asks };
  for (let i = 1; i <= n; i++) {
    const dist = join && i === 1 ? 0 : half * (join ? i - 1 : i);
    let b = snap(join && i === 1 && Number(bid) > 0 ? Number(bid) : m * (1 - (dist || half)), t, -1);
    let a = snap(join && i === 1 && Number(ask) > 0 ? Number(ask) : m * (1 + (dist || half)), t, 1);
    if (Number(ask) > 0 && !(b < Number(ask))) b = snap(Number(ask) - t, t, -1);
    if (Number(bid) > 0 && !(a > Number(bid))) a = snap(Number(bid) + t, t, 1);
    if (!(b > 0) || (Number(ask) > 0 && !(b < Number(ask)))) b = 0;
    if (!(a > 0) || (Number(bid) > 0 && !(a > Number(bid)))) a = 0;
    if (b > 0 && !bids.includes(b)) bids.push(b);
    if (a > 0 && !asks.includes(a)) asks.push(a);
  }
  return { bids, asks };
}

export function planBook({
  mid = 0, bid = 0, ask = 0, halfBps = 10, levels = 1, tick = 0.01, join = true,
  cash = 0, inventory = 0, clipUsd = 0, wholeBid = true, wholeAsk = true,
  minSize = 0, buyEnabled = true, sellEnabled = true, liquidateOnly = false,
} = {}) {
  const px = rungPrices({ mid, bid, ask, halfBps, levels, tick, join });
  const clip = Number(clipUsd) > 0 ? Number(clipUsd) : Number(cash);
  const bids = [];
  let left = Math.max(0, Number(cash) || 0);
  if (buyEnabled && !liquidateOnly) {
    for (const price of px.bids) {
      const sz = shareSize({ price, budgetUsd: Math.min(left, clip), whole: wholeBid, minSize });
      if (!(sz > 0)) continue;
      bids.push({ price, size: sz });
      left -= sz * price;
    }
  }
  let shares = Math.max(0, Number(inventory) || 0);
  const asks = [];
  if (sellEnabled) {
    for (const price of px.asks) {
      const one = wholeAsk ? price : 0;
      const budget = Math.min(shares * price, Math.max(clip, one));
      const sz = shareSize({ price, budgetUsd: budget, whole: wholeAsk, minSize });
      const fit = wholeAsk ? Math.min(sz, Math.floor(shares + 1e-9)) : Math.min(sz, shares);
      if (!(fit > 0)) continue;
      asks.push({ price, size: fit });
      shares -= fit;
    }
  }
  return { bids, asks };
}

// Match resting orders to the new rungs. A budget of zero keeps a resting bid
// unless pull is set. A replace that the cash cannot fund is not a cancel.
export function reconcileSide({ open = [], want = [], requoteBps = 15, pull = false, replace = true } = {}) {
  const used = new Set();
  const keep = [];
  const place = [];
  const band = Math.max(0, Number(requoteBps) || 0);
  for (const w of want) {
    let best = null;
    let bestDist = Infinity;
    for (const o of open) {
      if (!o || used.has(o.id) || !(Number(o.price) > 0) || !(Number(w.price) > 0)) continue;
      const dist = Math.abs(Number(o.price) - Number(w.price)) / Number(w.price) * 10000;
      const sizeOk = Math.abs(Number(o.size) - Number(w.size)) <= Math.max(1e-6, Number(w.size) * 0.02);
      if (dist <= band + 1e-9 && sizeOk && dist < bestDist) { best = o; bestDist = dist; }
    }
    if (best) { used.add(best.id); keep.push(best); }
    else place.push(w);
  }
  const cancel = [];
  for (const o of open) {
    if (!o || used.has(o.id)) continue;
    if (!want.length && !pull) { keep.push(o); continue; }
    cancel.push(o);
  }
  if (!replace && cancel.length && place.length) return { keep: open.filter(Boolean), cancel: [], place: [] };
  return { keep, cancel, place };
}
