import { midReturn, trendMult, shortRun } from './mid-ring.js';
import { volStatsForSymbol, sizeWeightForSymbol } from './vol-scan.js';

export function planRotation({ mmAlloc, ranked, now, enteredAt, watch, live, cfg }) {
  const enterPct = Number(process.env.VOL_ENTER_PCT || 2);
  const exitPct = Number(process.env.VOL_EXIT_PCT || 1.5);
  const rotateMin = Number(process.env.VOL_ROTATE_MIN_MS || 900000);
  const hardMax = Math.max(1, Number(process.env.MM_MAX_PAIRS_HARD || process.env.MM_MAX_PAIRS || cfg.mmMaxPairs || 4));
  const keep = [];
  const leaving = [];
  for (const a of mmAlloc) {
    const meta = volStatsForSymbol(a.symbol);
    const range = meta ? Number(meta.rangePct || 0) : 0;
    const age = now - (enteredAt.get(a.pair) || now);
    const rip = shortRun(a.symbol);
    const ret1 = midReturn(a.symbol);
    const weak = (range < exitPct && rip < Number(process.env.SHORT_RUN_ENTER || 0.008))
      || ret1 < Number(process.env.FALL_EXIT_RET || -0.002);
    const fallAge = Number(process.env.FALL_EXIT_MS || 60000);
    if (weak && age >= (ret1 < Number(process.env.FALL_EXIT_RET || -0.002) ? fallAge : rotateMin)) leaving.push(a);
    else keep.push(a);
  }
  keep.sort((x, y) => sizeWeightForSymbol(y.symbol) - sizeWeightForSymbol(x.symbol));
  while (keep.length > hardMax) leaving.push(keep.pop());
  const have = new Set(keep.map((a) => a.pair));
  const additions = [];
  const eqNow = live ? Number(live.totalEquity || 0) : 0;
  const cashNow = live ? Number(live.freeQuote || 0) : 0;
  const cashFrac = eqNow > 0 ? cashNow / eqNow : 1;
  const cashFloor = Number(process.env.CASH_FLOOR_FRAC || 0.25);
  if (cashFrac < cashFloor && keep.length) {
    const falling = keep.filter((a) => midReturn(a.symbol) <= 0);
    if (falling.length) {
      falling.sort((x, y) => midReturn(x.symbol) - midReturn(y.symbol));
      const worst = falling[0];
      leaving.push(worst);
      keep.splice(keep.indexOf(worst), 1);
      console.log('  CASH FLOOR flatten ' + worst.symbol + ' ret=' + (midReturn(worst.symbol) * 100).toFixed(2) + '% cash/eq=' + cashFrac.toFixed(2));
    }
  }
  const scored = ranked.map((r) => {
    const ret = Number(r.ret != null ? r.ret : midReturn(r.symbol));
    const tr = trendMult(r.symbol);
    const rise = ret > 0 ? 1.6 : (ret < -0.01 ? 0.45 : 0.8);
    return { ...r, ret15: ret, trend: tr, pick: ret * 100 + Number(r.rangePct || 0) * Math.max(tr, 1) * rise };
  }).sort((a, b) => b.ret15 - a.ret15 || b.pick - a.pick);
  const topRise = scored.filter((r) => r.ret15 >= Number(process.env.ENTER_RET_MIN || 0.003)).slice(0, 4);
  if (topRise.length) console.log('rising ' + topRise.map((r) => r.symbol + ' ' + (r.ret15 * 100).toFixed(2) + '%').join('  ') + '  held ' + keep.map((a) => a.symbol).join(','));
  for (const r of scored) {
    if (have.has(r.pair) || have.has(r.symbol)) continue;
    const rip = shortRun(r.symbol);
    const watched = watch.has(r.pair);
    const hot = Number(r.rangePct || 0) >= enterPct;
    const rising = Number(r.ret15 || 0) >= Number(process.env.ENTER_RET_MIN || 0.003);
    if (!rising && !(watched && rip >= Number(process.env.SHORT_RUN_ENTER || 0.008))) continue;
    if (!hot && !rising) continue;
    while (keep.length + additions.length >= hardMax) {
      const retOf = (a) => {
        const row = ranked.find((x) => x.pair === a.pair || x.symbol === a.symbol);
        return Number(row && row.ret != null ? row.ret : midReturn(a.symbol));
      };
      keep.sort((x, y) => retOf(x) - retOf(y));
      const worst = keep[0];
      if (!worst || retOf(worst) >= Number(r.ret15 || 0)) break;
      leaving.push(worst);
      keep.shift();
      have.delete(worst.pair);
      console.log('  RISE SWAP out ' + worst.symbol + ' for ' + r.symbol + ' ret=' + (r.ret15 * 100).toFixed(2) + '%');
    }
    if (keep.length + additions.length >= hardMax) continue;
    if (cashFrac < cashFloor && !rising) continue;
    if (!(r.pair && r.symbol)) continue;
    additions.push(r);
  }
  return { keep, leaving, additions, topRise };
}
