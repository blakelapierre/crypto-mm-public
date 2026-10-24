import fs from 'fs';
import {
  offsetBps, sideTarget, complementPx, nextBounds, trailDecision, weightedClips, effPairCap,
} from '../src/bots/tier/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}
function near(a, b, eps = 1e-6) { return Math.abs(Number(a) - Number(b)) < eps; }

check(offsetBps({ makerBps: 35, edgeBps: 10 }) === 45, 'offset is the fee tier plus 10bp');
check(offsetBps({ makerBps: 0, edgeBps: 10, fallbackBps: 40 }) === 50, 'a missing fee tier uses the fallback');
check(near(sideTarget(100, 45, 'buy'), 99.55), 'bid sits fee+10 under mid');
check(near(sideTarget(100, 45, 'sell'), 100.45), 'ask sits fee+10 over mid');

const bid = sideTarget(100, 45, 'buy');
const back = complementPx('buy', bid, 45);
check(near(back, sideTarget(100, 45, 'sell')), 'a buy fill asks the other side of the same offset');
const sell = sideTarget(100, 45, 'sell');
check(near(complementPx('sell', sell, 45), bid), 'a sell fill bids the other side of the same offset');
const bounds = nextBounds({ side: 'buy', fillPx: bid, offsetBps: 45, bidCeil: 90 });
check(near(bounds.askFloor, back) && bounds.bidCeil === 0 && bounds.complementSide === 'sell', 'a buy clears the bid ceiling and sets the ask floor');

const up = trailDecision({ side: 'buy', mid: 101, offsetBps: 45, resting: 99.55, touchBid: 100.8, touchAsk: 101.2, tick: 0.01 });
check(up.action === 'replace' && up.why === 'trail' && near(up.px, 100.54, 1e-9), 'a rising market trails the bid up');

const down = trailDecision({ side: 'buy', mid: 99, offsetBps: 45, resting: 99.55, touchBid: 99.4, touchAsk: 99.7, tick: 0.01 });
check(down.action === 'keep' && (down.why === 'hold' || down.why === 'hyst'), 'a falling market does not chase the bid down');

const letFill = trailDecision({ side: 'buy', mid: 99, offsetBps: 45, resting: 99.55, touchBid: 99.2, touchAsk: 99.4, tick: 0.01 });
check(letFill.action === 'keep' && letFill.why === 'let-fill', 'a bid the market has reached is left to fill');

const freshCross = trailDecision({ side: 'buy', mid: 100, offsetBps: 45, resting: 0, touchBid: 99.2, touchAsk: 99.4, tick: 0.01 });
check(freshCross.action === 'place' && freshCross.why === 'post-only' && freshCross.px < 99.4, 'a new bid that would take is pulled to one tick outside');

const askDown = trailDecision({ side: 'sell', mid: 99, offsetBps: 45, resting: 100.45, touchBid: 98.9, touchAsk: 99.1, tick: 0.01 });
check(askDown.action === 'replace' && askDown.why === 'trail' && askDown.px < 100 && askDown.px > 98.9, 'a falling market trails the ask down');

const askUp = trailDecision({ side: 'sell', mid: 101, offsetBps: 45, resting: 100.45, touchBid: 100.2, touchAsk: 100.4, tick: 0.01 });
check(askUp.action === 'keep', 'a rising market does not chase the ask up');

const comp = trailDecision({ side: 'sell', mid: 100, offsetBps: 45, resting: 0, bound: back, touchBid: 99.9, touchAsk: 100.1, tick: 0.01 });
check(comp.action === 'place' && comp.why === 'complement' && near(comp.px, 100.45, 1e-9), 'the complement ask comes in at fee+10 off the fill fair');

const stuck = trailDecision({ side: 'sell', mid: 99, offsetBps: 45, resting: back, bound: back, touchBid: 98.8, touchAsk: 99.0, tick: 0.01 });
check(stuck.action === 'keep', 'the ask does not trail through the complement floor');

const ceil = trailDecision({ side: 'buy', mid: 102, offsetBps: 45, resting: 0, bound: 99.55, touchBid: 101.8, touchAsk: 102.1, tick: 0.01 });
check(ceil.action === 'place' && ceil.why === 'complement' && near(ceil.px, 99.55, 1e-9), 'the complement bid comes in at the ceiling, not the higher mid');

const chased = trailDecision({ side: 'buy', mid: 102, offsetBps: 45, resting: 99.55, bound: 99.55, touchBid: 101.8, touchAsk: 102.1, tick: 0.01 });
check(chased.action === 'keep', 'a bid does not trail up through the complement ceiling');

const better = trailDecision({ side: 'sell', mid: 100, offsetBps: 45, resting: 0, bound: 100.45, touchBid: 100.8, touchAsk: 100.9, tick: 0.01 });
check(better.action === 'place' && better.px > 100.45, 'a complement that would cross rests at the touch when that price is better');

const worse = trailDecision({ side: 'buy', mid: 102, offsetBps: 45, resting: 101, bound: 99.55, touchBid: 101.5, touchAsk: 101.6, tick: 0.01 });
check(worse.action === 'replace' && near(worse.px, 99.55, 1e-9), 'a bid above its ceiling is pulled back to the complement');

const hyst = trailDecision({ side: 'buy', mid: 100.02, offsetBps: 45, resting: 99.55, touchBid: 99.9, touchAsk: 100.1, tick: 0.01, hystBps: 2 });
check(hyst.action === 'keep', 'a 2bp trail stays put');

const clips = weightedClips([2, 1, 1, 1], { free: 2.08, reserve: 0.1, minUsd: 1, maxUsd: 1.5 });
check(clips.filter((n) => n > 0).length === 1 && clips[0] === 1.5, 'thin cash funds the heaviest name up to the clip cap');
const split = weightedClips([2, 1], { free: 3.2, reserve: 0, minUsd: 1, maxUsd: 1.5 });
check(split[0] > split[1] && split[0] <= 1.5 && split[1] >= 1, 'extra cash follows the weight');
check(effPairCap({ equity: 12.92, maxPairs: 6, minUsd: 1, cashK: 2.5 }) === 5, 'slot cap matches the ladder cash formula');

const src = fs.readFileSync(new URL('../src/bots/tier/index.js', import.meta.url), 'utf8');
check(src.includes('planRotation'), 'selection is the ladder rotation');
check(src.includes('sizeWeightForSymbol'), 'size uses the ladder weight');
check(src.includes('setSizeUniverse'), 'weights are over the live set');
check(!src.includes('liquidateSymbols') && !src.includes('marketSell') && !src.includes('cancelPair'), 'no market sell and no blanket pair cancel');
check(src.includes("'as-cb-'") || src.includes('"as-cb-"'), 'startup cancels leftover as-cb orders');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('tier ok');
