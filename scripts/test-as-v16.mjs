import {
  anchorActive, buildOpenBid, widenOpenDecision, capHysteresis, tradableBookTarget, fundedSlots,
  exitAskPx, sentHalfFromPx, migrateDustArmed, parkStepPlan, expectedEdgeRow, scanTradeable, rankByExpectedEdge,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const ttl = anchorActive({ fill: 1, mid: 1, ageMin: 4.01 * 60, posQty: 2, minNotional: 1, needBps: 78, sigma: 0.003 });
check(!ttl.active && ttl.reason === 'ttl', 'anchor expires after 4.01h');

const moved = anchorActive({
  fill: 0.01847, mid: 0.01847 * 1.32, sigma: 0.003, ageMin: 60, posQty: 10, minNotional: 1, needBps: 78,
});
check(!moved.active && moved.reason === 'move', 'anchor expires on a 32% move');

const flat = anchorActive({ fill: 1, mid: 1.001, ageMin: 30, posQty: 0, needBps: 78, sigma: 0.001 });
check(!flat.active && flat.reason === 'flat', 'anchor expires when the book is flat');

const live = anchorActive({ fill: 1, mid: 1.002, sigma: 0.003, ageMin: 60, posQty: 5, minNotional: 1, needBps: 78 });
check(live.active, 'a 1h anchor with a 20bp move and inventory stays');

const warm = anchorActive({ fill: 1, mid: 1.002, ageMin: 60, posQty: 5, minNotional: 1, needBps: 78, warming: true, sigma: 0 });
check(warm.active && Math.abs(warm.thresh - 78) < 1e-9, 'while sigma warms up the move test uses need');
const warmBreak = anchorActive({ fill: 1, mid: 1.01, ageMin: 30, posQty: 5, minNotional: 1, needBps: 78, warming: true });
check(!warmBreak.active && warmBreak.reason === 'move', 'a warming anchor still expires once the move clears need');

const expiredBid = buildOpenBid({ modelBid: 99, mid: 100, touch: 100, anchorPx: 91, anchorOn: false, capBps: 150 });
check(Math.abs(expiredBid.bidPx - 99) < 1e-9, 'an expired anchor leaves the model bid');
const deep = buildOpenBid({
  modelBid: 99, mid: 100, touch: 100, anchorPx: 100 * (1 - 900 / 10000), anchorOn: true, capBps: 150,
});
const capPx = 100 * (1 - 150 / 10000);
check(Math.abs(deep.bidPx - capPx) < 1e-6, 'an anchor 900bp under the touch is clamped to the cap');
check(Math.abs(deep.bidPx - 91) > 0.5, 'the clamped bid is not the raw anchor');
check(deep.ok, 'edgeGate accepts the cap-bounded bid');

const fort = widenOpenDecision({
  px: 98.46, side: 'buy', mid: 100, needBps: 110, touch: 100, otherTouch: 100.2, maxDistBps: 150, spreadMedBps: 59,
});
check(fort.why === 'clamped' && fort.px > 0 && Math.abs(fort.distTouch - 150) < 1 && fort.half + 0.5 >= 110, '154bp against a 150 cap is clamped and still pays need');
const crossed = widenOpenDecision({
  px: 90, side: 'buy', mid: 100, needBps: 50, touch: 99, otherTouch: 50, maxDistBps: 150,
});
check(crossed.why === 'max-dist' && crossed.px === 0, 'a clamp that crosses the book is still max-dist');

const mid = 100;
const touch = 100;
const rest = touch * (1 - 149 / 10000);
const tgt = touch * (1 - 150 / 10000);
check(capHysteresis({ restingPx: rest, targetPx: tgt, capBps: 150, mid, touch }), 'hysteresis keeps a 149bp order');
check(!capHysteresis({ restingPx: touch * (1 - 140 / 10000), targetPx: tgt, capBps: 150, mid, touch }), 'a quote more than 2bp inside the cap is not held for hysteresis');

const room = tradableBookTarget({
  equity: 20, dust: 0, reserve: 0.13, frac: 0.9, free: 3.58, share: 0.15, maxDistBps: 150,
  restingOrders: [
    { side: 'buy', px: 98.96, usd: 1.49, touch: 100, mid: 100 },
    { side: 'sell', px: 107.8, usd: 2, touch: 100, mid: 100 },
    { side: 'sell', px: 120.5, usd: 3, touch: 100, mid: 100 },
    { side: 'sell', px: 121.75, usd: 3.84, touch: 100, mid: 100 },
  ],
});
check(Math.abs(room.cover - 1.49) < 1e-9 && Math.abs(room.parkedUsd - 8.84) < 1e-9, 'reachable cover is the near bid; far asks are parked');
check(Math.abs(room.budget - 3.45) < 1e-9, 'buy budget is free cash after the reserve');
check(fundedSlots({ budget: room.budget, venueMin: 1, names: 6 }) >= 2, 'that cash funds at least two slots');

const resolved = exitAskPx({ releasePx: 25.11, parkPx: 25.5, touch: 24.41, lossBound: 24.08 });
check(Math.abs(resolved - 25.11) < 1e-9, 'release 25.11 beats park 25.50 and stays above the bound and the touch');
const parked = exitAskPx({ parkPx: 25.5, touch: 24.5, lossBound: 24.08, dustFloor: 26.38, costFloor: 26.38 });
check(Math.abs(parked - 25.5) < 1e-9, 'a park plan is not lifted back to the dust round-trip floor');
const half = sentHalfFromPx({ mid: 24.5, px: parked });
check(Math.abs(half - Math.abs(25.5 - 24.5) / 24.5 * 10000) < 1e-6, 'the shown half comes from the final price');

const armed = migrateDustArmed(
  { COMP: true, BASECAT: true, DOOD: true, DUST: true },
  {
    COMP: { long: 0.123, mid: 24.5, quoteMin: 1 },
    BASECAT: { long: 92, mid: 0.013, quoteMin: 1 },
    DUST: { long: 0.01, mid: 1, quoteMin: 1 },
  },
);
check(!armed.COMP && !armed.BASECAT && armed.DUST && armed.DOOD, 'dust flags clear once the position is above the minimum');

const hold = parkStepPlan({
  idleH: 72, entry: 1, costFloor: 1.01, touch: 0.79, qty: 1, feeBps: 0,
  stepH: 6, stepBps: 150, maxLossBps: 800, stopDistPp: 100, capital: 1000,
  deepMode: 'hold', deepH: 72,
});
check(hold.stuck && hold.px > 0.79 + 1e-9, 'hold leaves a stuck park at the bound above the touch');
const trail = parkStepPlan({
  idleH: 72, entry: 1, costFloor: 1.01, touch: 0.79, qty: 1, feeBps: 0,
  stepH: 6, stepBps: 150, maxLossBps: 800, stopDistPp: 100, capital: 1000,
  deepMode: 'trail', deepH: 72,
});
check(trail.mode === 'trail' && trail.px < hold.px - 1e-9, 'trail widens one step after the deep-park age');

check(scanTradeable({ expEdge: 45.5, minNet: 8 }), 'a 45.5bp net edge clears min_net 8');
check(!scanTradeable({ expEdge: 5, minNet: 8 }), 'a 5bp net edge does not clear min_net 8');
const okEdge = expectedEdgeRow({ spreadBps: 80, sigma: 0 }, { feeBps: 35, minEdgeBps: 8, scanMinNetBps: 8 });
check(okEdge.tradeable && okEdge.expEdge + 1e-9 >= okEdge.minNet && okEdge.minNet === 8, 'the printed min_net is the threshold that was applied');
const thin = expectedEdgeRow({ spreadBps: 10, sigma: 0.05 }, { feeBps: 35, minEdgeBps: 8, scanMinNetBps: 8, k: 1.5, tauMin: 15, kappa: 1.5 });
check(!thin.tradeable && thin.expEdge < thin.minNet, 'a tiny fill probability is not tradeable');
const ranked = rankByExpectedEdge([
  { symbol: 'LOW', spreadBps: 10, vol24: 1e6, tickBps: 1, sigma: 0.05 },
  { symbol: 'OK', spreadBps: 80, vol24: 1e6, tickBps: 1, sigma: 0 },
], { feeBps: 35, minEdgeBps: 8, scanMinNetBps: 8, minVol: 0, maxPairs: 5, k: 1.5, tauMin: 15 });
check(ranked.picked.every((p) => p.symbol !== 'LOW'), 'a name under min_net is not picked');
check(ranked.best5.length > 0 && ranked.best5.every((b) => b.expEdge + 1e-9 >= (b.minNet != null ? b.minNet : 8)), 'every SCAN best row clears min_net');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('as v16 checks passed');
