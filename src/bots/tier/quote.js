// Fee-tier trail quotes. Offset is the maker fee plus TIER_EDGE_BPS (default 10).
// A bid trails up only. An ask trails down only. A fill's complement is the other
// side of that same offset around the fill, and it is a hard ceiling (bid) or
// floor (ask) so a later trail cannot give the edge back.

export function offsetBps({ makerBps = 0, edgeBps = 10, fallbackBps = 35 } = {}) {
  const edge = Number(edgeBps);
  const add = Number.isFinite(edge) ? edge : 0;
  const fee = Number(makerBps);
  const base = fee > 0 ? fee : (Number(fallbackBps) || 0);
  return base + add;
}

export function sideTarget(mid, bps, side) {
  const m = Number(mid);
  const off = Number(bps) / 10000;
  if (!(m > 0) || !(off > 0) || off >= 1) return 0;
  return String(side).toLowerCase() === 'sell' ? m * (1 + off) : m * (1 - off);
}

// Buy at P (which was `off` under fair) → ask at fair * (1+off) = P*(1+off)/(1-off).
// Sell at P → bid at P*(1-off)/(1+off). One offset from the fill would sit near fair
// and would not clear two maker fees.
export function complementPx(fillSide, fillPx, bps) {
  const p = Number(fillPx);
  const off = Number(bps) / 10000;
  if (!(p > 0) || !(off > 0) || off >= 1) return 0;
  const buy = String(fillSide).toLowerCase() !== 'sell';
  return buy ? p * (1 + off) / (1 - off) : p * (1 - off) / (1 + off);
}

export function nextBounds({ side, fillPx, offsetBps: bps, askFloor = 0, bidCeil = 0 } = {}) {
  const buy = String(side).toLowerCase() !== 'sell';
  const px = complementPx(buy ? 'buy' : 'sell', fillPx, bps);
  if (!(px > 0)) return { askFloor: Number(askFloor) || 0, bidCeil: Number(bidCeil) || 0, complementSide: '', complementPx: 0 };
  if (buy) return { askFloor: px, bidCeil: 0, complementSide: 'sell', complementPx: px };
  return { askFloor: 0, bidCeil: px, complementSide: 'buy', complementPx: px };
}

function tickOf(tick, px) {
  const t = Number(tick);
  if (t > 0) return t;
  return 0;
}

function snapDown(px, tick) {
  if (!(px > 0)) return 0;
  if (!(tick > 0)) return px;
  return Number((Math.floor(px / tick + 1e-8) * tick).toFixed(12));
}

function snapUp(px, tick) {
  if (!(px > 0)) return 0;
  if (!(tick > 0)) return px;
  return Number((Math.ceil(px / tick - 1e-8) * tick).toFixed(12));
}

// action: place | replace | keep | skip
export function trailDecision({
  side = 'buy', mid = 0, offsetBps: bps = 0, resting = 0, bound = 0,
  touchBid = 0, touchAsk = 0, tick = 0, hystBps = 2,
} = {}) {
  const sell = String(side).toLowerCase() === 'sell';
  const buy = !sell;
  const have = Number(resting) > 0 ? Number(resting) : 0;
  const cap = Number(bound) > 0 ? Number(bound) : 0;
  const target = sideTarget(mid, bps, buy ? 'buy' : 'sell');
  if (!(target > 0)) return { action: 'skip', why: 'no-mid', px: 0, target: 0 };

  let want;
  let why;
  if (cap) {
    // The complement is the price. Trail cannot go through it, and a wider
    // resting quote comes in to it instead of waiting for the mid to catch up.
    want = cap;
    why = 'complement';
  } else if (have) {
    want = buy ? Math.max(have, target) : Math.min(have, target);
    why = (buy ? want > have + 1e-12 : want + 1e-12 < have) ? 'trail' : 'hold';
  } else {
    want = target;
    why = 'open';
  }

  const step = tickOf(tick, want);
  const crossing = buy
    ? (Number(touchAsk) > 0 && want >= Number(touchAsk) - 1e-12)
    : (Number(touchBid) > 0 && want <= Number(touchBid) + 1e-12);
  if (crossing) {
    const restingCross = have && (buy
      ? have >= Number(touchAsk) - 1e-12
      : have <= Number(touchBid) + 1e-12);
    const forced = cap && have && (buy ? have > cap + 1e-12 : have + 1e-12 < cap);
    // Only a resting order the market has already reached is left alone.
    // A wanted price through the touch is pulled back so a new order stays maker.
    if (restingCross && !forced) return { action: 'keep', why: 'let-fill', px: have, target };
    const raw = buy ? Number(touchAsk) - (step || Number(touchAsk) * 1e-8) : Number(touchBid) + (step || Number(touchBid) * 1e-8);
    const pulled = buy ? snapDown(raw, step) : snapUp(raw, step);
    const stillCross = !(pulled > 0) || (buy ? pulled >= Number(touchAsk) : pulled <= Number(touchBid));
    if (stillCross) return { action: 'skip', why: 'cross', px: 0, target };
    if (cap && (buy ? pulled > cap + 1e-12 : pulled + 1e-12 < cap)) {
      return { action: 'skip', why: buy ? 'ceiling' : 'floor', px: 0, target };
    }
    want = pulled;
    why = 'post-only';
  } else {
    want = buy ? snapDown(want, step) : snapUp(want, step);
    if (cap) {
      if (buy && want > cap + 1e-12) want = snapDown(cap, step);
      if (!buy && want + 1e-12 < cap) want = snapUp(cap, step);
    }
    if (buy && Number(touchAsk) > 0 && want >= Number(touchAsk)) return { action: 'skip', why: 'cross', px: 0, target };
    if (!buy && Number(touchBid) > 0 && want <= Number(touchBid)) return { action: 'skip', why: 'cross', px: 0, target };
  }
  if (!(want > 0)) return { action: 'skip', why: 'no-px', px: 0, target };
  if (!have) return { action: 'place', why, px: want, target };
  const moved = Math.abs(want - have) / have * 10000;
  const hyst = Number.isFinite(Number(hystBps)) ? Number(hystBps) : 2;
  if (moved <= hyst) return { action: 'keep', why: 'hyst', px: have, target };
  if (buy && want <= have + 1e-12 && !(cap && have > cap + 1e-12)) return { action: 'keep', why: 'hold', px: have, target };
  if (!buy && want + 1e-12 >= have && !(cap && have + 1e-12 < cap)) return { action: 'keep', why: 'hold', px: have, target };
  return { action: 'replace', why, px: want, target };
}

// Highest weight is funded first. Each funded name gets at least minUsd,
// then leftover cash is split by weight up to maxUsd. Unfunded names get 0.
export function weightedClips(weights, { free = 0, reserve = 0, minUsd = 1, maxUsd = 1.5 } = {}) {
  const w = (weights || []).map((x) => Math.max(0, Number(x) || 0));
  const min = Math.max(0.01, Number(minUsd) || 1);
  const cap = Math.max(min, Number(maxUsd) || min);
  let left = Math.max(0, Number(free) - Number(reserve || 0));
  const order = w.map((weight, i) => ({ i, weight })).sort((a, b) => b.weight - a.weight || a.i - b.i);
  const clips = w.map(() => 0);
  const picked = [];
  for (const row of order) {
    if (left + 1e-9 < min) break;
    picked.push(row);
    clips[row.i] = min;
    left -= min;
  }
  const sum = picked.reduce((s, r) => s + Math.max(r.weight, 0.01), 0);
  if (sum > 0 && left > 0) {
    for (const r of picked) {
      const room = Math.max(0, cap - min);
      const add = Math.min(room, left * (Math.max(r.weight, 0.01) / sum));
      clips[r.i] = Number((min + add).toFixed(2));
    }
  } else {
    for (let i = 0; i < clips.length; i++) if (clips[i]) clips[i] = Number(clips[i].toFixed(2));
  }
  return clips;
}

// Same cash+inventory slot cap the ladder uses before planRotation.
export function effPairCap({ equity = 0, maxPairs = 6, minUsd = 1, cashK = 2.5 } = {}) {
  const min = Math.max(Number(minUsd) || 1, 1);
  const k = Number(cashK) > 0 ? Number(cashK) : 2.5;
  const slots = Math.floor(Number(equity) / (min * k));
  return Math.max(1, Math.min(Math.max(1, Number(maxPairs) || 1), Math.max(0, slots)));
}
