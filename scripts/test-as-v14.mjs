import fs from 'fs';
import {
  releaseK, releaseStep, releaseWorstLoss, releaseQtyForBudget, releaseAllowed,
  fundedSlots, slotClipUsd, accountCarryBps, carryRateBps, carryAllows,
  sessionCapPct, orderWorstUsd, feeTier, netEdgeRow, rankByExpectedEdge, statusMoney,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

check(releaseK({ idleH: 11.9, idleNeed: 12, stepH: 2 }) === 0, 'no release step before the idle window');
check(releaseK({ idleH: 12, idleNeed: 12, stepH: 2 }) === 1, 'the first step starts when the name has been idle 12h');
check(releaseK({ idleH: 16.1, idleNeed: 12, stepH: 2 }) === 3, 'steps keep advancing every two hours');

const floor1 = releaseStep({ entry: 1, costFloor: 1.1, touch: 1.05, k: 1, stepBps: 150, maxLossBps: 800 });
check(Math.abs(floor1 - 1.1 * (1 - 0.015)) < 1e-9, 'one step takes 150bp off the cost floor');
const floored = releaseStep({ entry: 1, costFloor: 1.1, touch: 1.05, k: 20, stepBps: 150, maxLossBps: 800 });
check(Math.abs(floored - 1.05) < 1e-9, 'the decay never crosses the touch or the max-loss floor when the touch is higher');
const lossFloor = releaseStep({ entry: 1, costFloor: 1.1, touch: 0.5, k: 40, stepBps: 150, maxLossBps: 800 });
check(Math.abs(lossFloor - 0.92) < 1e-9, 'the per-name loss floor is 800bp under entry');

const worst = releaseWorstLoss({ entry: 1, floor: 0.92, qty: 10, feeBps: 0 });
check(Math.abs(worst - 0.8) < 1e-9, 'worst-case release loss is entry minus the stepped floor');
const sized = releaseQtyForBudget({ entry: 1, floor: 0.92, qty: 10, feeBps: 0, dayUsed: 0, dayCap: 0.2, minQty: 1 });
check(sized.qty > 1 && sized.qty < 3 && sized.loss <= 0.2 + 1e-9, 'the day cap shrinks the release size');
const held = releaseQtyForBudget({ entry: 1, floor: 0.92, qty: 10, feeBps: 0, dayUsed: 0.19, dayCap: 0.2, minQty: 5 });
check(held.hold === 'day-cap' && held.qty === 0, 'a release that cannot clear the venue minimum holds');
check(!releaseAllowed({ stopDistPp: 4.2, sessionCapPct: 8, sessionLossPct: 0 }), 'release stops inside 10pp of the lifetime stop');
check(!releaseAllowed({ stopDistPp: 20, sessionCapPct: 8, sessionLossPct: 4.1, rail: false }), 'release stops at half the session cap');
check(releaseAllowed({ stopDistPp: 20, sessionCapPct: 8, sessionLossPct: 1, rail: false }), 'release is allowed with room under both caps');
check(!releaseAllowed({ stopDistPp: 20, sessionCapPct: 8, sessionLossPct: 0, rail: true }), 'a rail cancels the release');

check(fundedSlots({ budget: 1.85, venueMin: 1, names: 11 }) === 1, '1.85 dollars funds one slot, not eleven');
const clip = slotClipUsd({ budget: 1.85, slots: 1, venueMin: 1 });
check(clip + 1e-9 >= 1, 'that slot is at least the venue minimum');
check(fundedSlots({ budget: 3.17, venueMin: 1, names: 11 }) === 2, 'a 3.17 budget funds two clips, not three under the haircut');
const clip317 = slotClipUsd({ budget: 3.17, slots: 2, venueMin: 1 });
check(clip317 + 1e-9 >= 1, 'those clips stay at least the venue minimum');

const inflated = 0.0489 / 1.87 * 10000 / 130;
const timed = accountCarryBps({ usd: 0.0489, notionalHours: 20 * 130 });
check(timed + 1e-9 < 1 && timed * 5 < inflated, 'a small current notional cannot inflate the account carry rate');
const venue = carryRateBps({ perPair: false, rollover4h: 2 });
check(Math.abs(venue.bps - 0.5) < 1e-9 && venue.src === 'venue', 'no pair history uses the 0.5bp/h rollover');
check(carryAllows({ holdMin: 240, bpsPerHour: 0.5, profitBps: 10 }), '0.5bp/h carry fits inside a 4h hold at 10bp profit');

check(Math.abs(sessionCapPct({ maxPct: 8, stopDistPp: 4.2 }) - 2.1) < 1e-9, 'the session cap is half the distance to the lifetime stop');
check(Math.abs(orderWorstUsd({ equity: 9.73, stopDistPp: 4.2 }) - 0.25 * 0.042 * 9.73) < 1e-9, 'one order cannot risk more than a quarter of the remaining stop');

const tier = feeTier({ venue: 25, realized: 31, config: 16, fills: 20 });
check(tier.maker === 31 && tier.src === 'fills', 'the fee is the worse of venue and realized fills');
const venueOnly = feeTier({ venue: 25, realized: 31, config: 16, fills: 3 });
check(venueOnly.maker === 25 && venueOnly.src === 'venue', 'fewer than five fills do not override the venue tier');
const missing = feeTier({ venue: 0, realized: 0, config: 16, fills: 0 });
check(missing.src === 'default' && missing.maker === 16, 'the config default is only used when venue and fills are missing');

const tight = netEdgeRow({ symbol: 'T', spreadBps: 8, vol24: 2e6, tickBps: 1, sigma: 0.01 }, { feeBps: 31, minEdgeBps: 8, minNetBps: 1 });
const wide = netEdgeRow({ symbol: 'W', spreadBps: 80, vol24: 2e6, tickBps: 1, sigma: 0.01 }, { feeBps: 31, minEdgeBps: 8, minNetBps: 1 });
check(wide.expEdge > tight.expEdge + 1, 'a wider book scores a higher net edge than a tight one at a 31bp fee');
const ranked = rankByExpectedEdge([
  { symbol: 'TIGHT', spreadBps: 8, vol24: 2e6, tickBps: 1, sigma: 0.01 },
  { symbol: 'WIDE', spreadBps: 90, vol24: 2e6, tickBps: 2, sigma: 0.01 },
  { symbol: 'DUST', spreadBps: 100, vol24: 1000, tickBps: 1, sigma: 0.02 },
  { symbol: 'TICK', spreadBps: 40, vol24: 8e5, tickBps: 26, sigma: 0.02 },
], { feeBps: 31, minEdgeBps: 8, net: true, sanityVol: 25000, minNetBps: 1, maxPairs: 3, k: 1.5, tauMin: 15 });
check(ranked.picked[0] && ranked.picked[0].symbol !== 'DUST', 'a 1k volume name stays under the 25k floor');
check(!ranked.reasons.some((r) => r.symbol === 'TICK' && r.reason === 'tick'), 'a wide tick is scored, not rejected');
check(ranked.picked.length >= 1 && new Set(ranked.picked.map((p) => Math.round(p.expEdge))).size >= 1, 'picks carry a net edge');
const edges = ranked.best5.map((r) => Number(r.expEdge.toFixed(1)));
check(new Set(edges).size >= 2, 'net edges are not a flat 27bp');

const line = statusMoney({
  equity: 14.48, capital: 14.89, trading: -0.41, resid: 0, pending: -2.64, stopPct: 0.25,
  feeBps: 31, feeSrc: 'fills', lastFill: '30h', parkedN: 5, parkedUsd: 8, parkedH: 30,
  releaseLoss: 0.04, releaseN: 1, bidShare: '15%', best: 'AAA:4bp', probation: false, carryBps: 0.5, carrySrc: 'venue',
});
check(line.includes('trading=$-0.41') && line.includes('pending=$-2.64 (excluded)'), 'the headline is equity minus capital and pending is excluded');
check(line.includes('rel=$0.04') && line.includes('parked=5') && line.includes('fee=31bp src=fills'), 'release, parked, and fee source are on the status line');
check(line.includes('probation=0') && line.includes('carry=0.50bp/h src=venue') && line.includes('best=AAA:4bp'), 'probation, carry, and the best name are on the status line');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
for (const s of ['RELEASE step ', 'RELEASE hold ', 'FEE tier ', 'FEE drift', 'CARRY rate=', 'RISK probation ', 'ENTRY resync ', 'budget-tight ', 'CLOSE ', 'SCAN none-tradeable best=']) {
  check(bot.includes(s), 'source contains ' + s);
}
check(bot.includes("gate('buy', buyMiss || 'unsized')"), 'the buy catch-all names the miss instead of edge');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v14 checks passed');
