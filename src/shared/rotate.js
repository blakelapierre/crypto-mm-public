import { midReturn } from './mid-ring.js';
import { volStatsForSymbol, sizeWeightForSymbol } from './vol-scan.js';
import { insideFeeDrop } from './inside-fee.js';

const belowSince = new Map();
const swapAt = [];
let lastSwap = 0;

function scoreOf(row) {
  const range = Number(row.rangePct || 0);
  const ret = Number(row.ret != null ? row.ret : 0);
  return range + Math.max(ret, 0) * 100;
}

export function planRotation({ mmAlloc, ranked, now, enteredAt, watch, live, cfg }) {
  const enterPct = Number(process.env.VOL_ENTER_PCT || 2);
  const exitPct = Number(process.env.VOL_EXIT_PCT || 1.5);
  const minHold = Number(process.env.ROTATE_MIN_HOLD_MS || process.env.VOL_ROTATE_MIN_MS || 1800000);
  const stopRet = Number(process.env.ROTATE_STOP_RET || -0.04);
  const stopMin = Number(process.env.ROTATE_STOP_MIN_MS || 300000);
  const hyst = Number(process.env.ROTATE_EXIT_HYST || 0.6);
  const confirmTicks = Number(process.env.ROTATE_CONFIRM_TICKS || 3);
  const maxPerHour = Number(process.env.ROTATE_MAX_PER_HOUR || 4);
  const hardMax = Math.max(1, Number(process.env.MM_MAX_PAIRS_HARD || process.env.MM_MAX_PAIRS || cfg.mmMaxPairs || 4));
  const hourAgo = now - 3600000;
  while (swapAt.length && swapAt[0] < hourAgo) swapAt.shift();
  const capped = swapAt.length >= maxPerHour;
  const keep = [];
  const leaving = [];
  for (const a of mmAlloc) {
    const meta = volStatsForSymbol(a.symbol) || {};
    const range = Number(meta.rangePct || 0);
    const age = now - (enteredAt.get(a.pair) || now);
    const ret15 = midReturn(a.symbol, 15 * 60 * 1000);
    const emergency = ret15 < stopRet && age >= stopMin;
    const weak = insideFeeDrop(a.symbol) || (range < exitPct && scoreOf({ rangePct: range, ret: ret15 }) < enterPct * hyst);
    if (weak) belowSince.set(a.pair, (belowSince.get(a.pair) || 0) + 1);
    else belowSince.set(a.pair, 0);
    const held = belowSince.get(a.pair) >= confirmTicks;
    const idleMs = Number(process.env.IDLE_RELEASE_MS || 900000);
    const idle = cfg && cfg.idlePairs;
    if (idle && idle.has(a.pair) && age >= idleMs) {
      console.log('  ROTATE idle ' + a.symbol + ' ' + Math.round(age / 60000) + 'm');
      leaving.push(a);
      continue;
    }
    if (emergency) {
      console.log('  ROTATE_STOP_RET ' + a.symbol + ' ret15=' + (ret15 * 100).toFixed(2) + '% age=' + Math.round(age / 1000) + 's');
      leaving.push(a);
    } else if (!capped && held && age >= minHold) {
      console.log('  ROTATE exit ' + a.symbol + ' hold=' + Math.round(age / 60000) + 'm range=' + range.toFixed(2));
      leaving.push(a);
      swapAt.push(now);
    } else keep.push(a);
  }
  keep.sort((x, y) => sizeWeightForSymbol(y.symbol) - sizeWeightForSymbol(x.symbol));
  const eligible = keep.filter((a) => now - (enteredAt.get(a.pair) || now) >= minHold);
  while (keep.length > hardMax && eligible.length) {
    const extra = eligible.pop();
    const i = keep.indexOf(extra);
    if (i >= 0) keep.splice(i, 1);
    leaving.push(extra);
  }
  if (keep.length > hardMax) console.log('  rotate hold cap ' + keep.length + ' > ' + hardMax + ' names under min hold');
  const have = new Set(keep.map((a) => a.pair));
  const additions = [];
  const cool = Number(process.env.REENTER_COOLDOWN_MS || 1800000);
  const scored = ranked.map((r) => ({ ...r, ret15: Number(r.ret != null ? r.ret : midReturn(r.symbol)), pick: scoreOf(r) }))
    .filter((r) => Number(r.rangePct || 0) >= enterPct)
    .sort((a, b) => b.pick - a.pick);
  for (const r of scored) {
    if (have.has(r.pair) || have.has(r.symbol)) continue;
    const left = watch.get(r.pair);
    if (left && now - (left.leftAt || 0) < cool) continue;
    if (keep.length + additions.length >= hardMax) {
      if (now - lastSwap < Number(process.env.SWAP_COOLDOWN_MS || 900000) || capped) continue;
      const worst = keep[keep.length - 1];
      if (!worst || now - (enteredAt.get(worst.pair) || now) < minHold) continue;
      if (r.pick < scoreOf(worst) * Number(process.env.SWAP_SCORE_MULT || 1.5)) continue;
      leaving.push(worst);
      keep.pop();
      have.delete(worst.pair);
      lastSwap = now;
      swapAt.push(now);
      console.log('  RISE SWAP out ' + worst.symbol + ' for ' + r.symbol);
    }
    if (keep.length + additions.length >= hardMax) continue;
    if (!(r.pair && r.symbol)) continue;
    additions.push(r);
  }
  return { keep, leaving, additions, topRise: scored.slice(0, 4) };
}
