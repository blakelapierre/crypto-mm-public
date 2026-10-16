import { krakenOpeningPlan, lifeTradingText, rankByExpectedEdge, expectedEdgeRow, widenOpenDecision, slotClipUsd, roundTripPadBps, dustCanExit } from '../src/bots/as/quote.js';
import { postOnlyRetryPx } from '../src/shared/sizing.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const old = krakenOpeningPlan({
  equity: 9.65, lev: 2, resume: 350, bookFrac: 0.9,
  sides: ['PUFFER:buy', 'PUFFER:sell', 'ANIME:buy', 'ANIME:sell'].map((id, i) => ({
    id, side: id.endsWith('buy') ? 'buy' : 'sell', want: 1.5, min: 5, lossCap: 3.5, expEdge: 10 - i,
  })),
});
check(old.sides.every((s) => s.fit === 0), 'a five-dollar minimum is not rounded up from a 1.50 clip');
check(old.sides.every((s) => s.reason === 'min-size'), 'loss cap under the minimum is min-size, not budget');
check(!old.sides.some((s) => s.reason === 'budget'), 'kraken never labels a side budget');

const fit = krakenOpeningPlan({
  equity: 9.65, lev: 2, resume: 350, bookFrac: 0.9,
  sides: [
    { id: 'A:buy', side: 'buy', want: 20, min: 5, lossCap: 10, expEdge: 30 },
    { id: 'A:sell', side: 'sell', want: 20, min: 5, lossCap: 10, expEdge: 20 },
    { id: 'B:buy', side: 'buy', want: 20, min: 5, lossCap: 10, expEdge: 10 },
    { id: 'B:sell', side: 'sell', want: 20, min: 5, lossCap: 10, expEdge: 5 },
  ],
});
const placed = fit.sides.filter((s) => s.fit > 0);
check(placed.length === 1 && placed[0].id === 'A:buy' && placed[0].fit + 1e-9 >= 5, 'one side rests at least at the minimum when the room can pay it');
check(fit.room > 5 && fit.room < 6, 'ramp leverage, not the pair cap, sets the room');
check(fit.sides.filter((s) => !s.fit).every((s) => s.reason === 'margin'), 'sides that release their share say margin');

const moved = postOnlyRetryPx({ side: 'buy', original: 0.020496, freshBid: 0.0208, freshAsk: 0.0209, inc: 0.000001 });
check(moved <= 0.020496 + 1e-12, 'a buy retry does not chase a higher bid');
const down = postOnlyRetryPx({ side: 'buy', original: 0.020726, freshBid: 0.020496, freshAsk: 0.0205, inc: 0.000001 });
check(down <= 0.020496 + 1e-12, 'a buy retry steps back to the fresh bid');
const sell = postOnlyRetryPx({ side: 'sell', original: 0.020501, freshAsk: 0.0202, freshBid: 0.0201, inc: 0.000001 });
check(sell + 1e-12 >= 0.020501, 'a sell retry does not step down through the rejected price');

const row = { symbol: 'AERGO', spreadBps: 20, vol24: 2e6, tickBps: 1, sigma: 0 };
const ranked = rankByExpectedEdge([row], { feeBps: 35, minEdgeBps: 8, minVol: 0, maxPairs: 1, k: 1.5, tauMin: 15 });
check(ranked.picked.length === 1, 'a 20bp coinbase book is tradeable by quoting wider than the touch');
const edge = expectedEdgeRow(row, { feeBps: 35, minEdgeBps: 8 });
check(edge.expHalf + 1e-9 >= roundTripPadBps({ feeBps: 35, minEdgeBps: 8 }), 'the expected half is not inside the round-trip pad');
const inside = widenOpenDecision({ px: 1, side: 'buy', mid: 1, needBps: 78, touch: 0.999, otherTouch: 1.001, maxDistBps: 150, inc: 0.0001 });
check(inside.why !== 'ok' || inside.half + 0.5 >= 78, 'a quote is not sent inside the pad');

const text = lifeTradingText({ trading: 0.89, baseline: 24.90, resid: 2.30, pending: -2.64 });
check(text.includes('+3.6% trading'), 'life percent is trading pnl, not the residual');
check(text.includes('resid=$2.30') && text.includes('pending=$-2.64'), 'residual and pending stay beside the percent');
check(!text.includes('+13.5'), 'the residual is not called a gain');

const one = Math.min(slotClipUsd({ budget: 20, slots: 1, venueMin: 1 }), 25 * 0.5);
const six = slotClipUsd({ budget: 20, slots: 6, venueMin: 1 });
check(one > 10 && one <= 12.5, 'one coinbase name may take half of equity, not a sixth');
check(six < 4, 'splitting by the pair cap is the old thin book');

check(dustCanExit({ qty: 10, mid: 0.2, minSize: 1, minNotional: 1 }), 'a holding that clears both minimums can exit');
check(!dustCanExit({ qty: 0.1, mid: 0.2, minSize: 1, minNotional: 1 }), 'dust under the lot is not an exit');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('as v11 checks passed');
