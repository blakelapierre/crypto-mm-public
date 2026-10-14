import fs from 'fs';
import {
  rankByNetEdge, minBookSpreadBps, haltPhase, haltTimeoutPx, haltExitBound,
  widenOpenDecision, openGateWhy, unexplainedJump, dustTopupUsd, bookSlots, openClipUsd,
  tradableBookTarget, positionAboveMin,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const rows = [
  { symbol: 'TIGHT', spreadBps: 20, vol24: 5e6, tickBps: 1 },
  { symbol: 'EDGE', spreadBps: 80, vol24: 400000, tickBps: 2 },
  { symbol: 'WIDE', spreadBps: 400, vol24: 2e6, tickBps: 1 },
  { symbol: 'THIN', spreadBps: 90, vol24: 1000, tickBps: 1 },
  { symbol: 'COARSE', spreadBps: 90, vol24: 2e6, tickBps: 20 },
];
const picked = rankByNetEdge(rows, {
  feeBps: 16, minEdgeBps: 8, minVol: 250000, maxSpreadBps: 250, targetVol: 1e6, evalN: 40, maxPairs: 2,
});
check(picked.picked.length === 1 && picked.picked[0].symbol === 'EDGE', 'a maker keeps the pair whose spread clears the fee');
check(picked.picked.every((p) => p.spreadBps + 1e-9 >= 2 * 16), 'no pair is inside two maker fees');
check(picked.rejected.feeSpread >= 1 && picked.feeSpread.includes('TIGHT'), 'a tight book is a fee-spread reject');
check(picked.rejected.vol >= 1 && picked.rejected.wide >= 1 && picked.rejected.tick >= 1, 'volume, width and tick each count');
check(minBookSpreadBps({ feeBps: 40, minEdgeBps: 8 }) === 88, 'coinbase minimum spread is two fees plus the edge');
const many = [];
for (let i = 0; i < 12; i++) many.push({ symbol: 'T' + i, spreadBps: 20, vol24: 5e6 - i, tickBps: 1 });
many.push({ symbol: 'LATE', spreadBps: 120, vol24: 4e6, tickBps: 1 });
for (let i = 0; i < 30; i++) many.push({ symbol: 'Z' + i, spreadBps: 20, vol24: 3e6 - i, tickBps: 1 });
const top = rankByNetEdge(many, { feeBps: 16, minEdgeBps: 8, minVol: 250000, maxSpreadBps: 250, evalN: 40, maxPairs: 1 });
check(top.evaluated === 40 && top.picked[0] && top.picked[0].symbol === 'LATE', 'the edge past the tight names is still eligible');

const hour = 3600 * 1000;
check(haltPhase({ halted: 'session-loss', since: 0, now: hour, holdMs: 6 * hour, maxMs: 24 * hour }) === 'A', 'the first hours stay on the cost floor');
check(haltPhase({ halted: 'session-loss', since: 0, now: 6 * hour, holdMs: 6 * hour, maxMs: 24 * hour }) === 'B', 'after the hold the exit may step');
check(haltPhase({ halted: 'session-loss', since: 0, now: 24 * hour, holdMs: 6 * hour, maxMs: 24 * hour }) === 'C', 'a day stuck re-baselines');
check(haltPhase({ halted: 'day-loss', since: 0, now: 48 * hour }) === '', 'day-loss does not use the session phases');

const bound = haltExitBound({ cost: 100, side: 'long', maxLossPct: 0.015, equity: 100, qty: 10, haltLossUsed: 0 });
check(Math.abs(bound - 99.9) < 1e-9, 'one percent of equity binds before 1.5 percent of a large coin');
const stepped = haltTimeoutPx({ cost: 100, side: 'long', touch: 90, halfBps: 40, steps: 4, maxLossPct: 0.015, equity: 1000, qty: 1, haltLossUsed: 0 });
check(stepped < 100 && stepped + 1e-9 >= 100 * 0.985, 'a halt exit steps down and stops at the loss bound');
check(haltTimeoutPx({ cost: 100, side: 'long', touch: 90, halfBps: 40, steps: 0, maxLossPct: 0.015 }) === 100, 'the first halt step stays at cost');

const wide = widenOpenDecision({ px: 100, side: 'buy', mid: 115, needBps: 110, touch: 100, otherTouch: 130, maxDistBps: 150 });
check(wide.why === 'ok' && wide.half + 0.5 >= 110, 'a wide book is capped from the mid, not the far touch');
const far = widenOpenDecision({ px: 100, side: 'buy', mid: 100, needBps: 200, touch: 99.9, otherTouch: 100.1, maxDistBps: 150 });
check(far.why === 'max-dist' && far.half + 0.5 >= 200, 'distance past the cap is max-dist even when the half would have paid');
check(openGateWhy(far).startsWith('max-dist') && !openGateWhy(far).includes('fee-edge'), 'a max-dist block is not called a fee miss');
check(openGateWhy({ why: 'below-need', half: 40, need: 110 }) === 'fee-edge half=40 need=110', 'fee-edge is printed only when the sent half is short');
check(openGateWhy({ why: 'below-need', half: 200, need: 110 }) === '', 'a half that already pays is not called fee-edge');
check(widenOpenDecision({ mid: 0, side: 'buy', needBps: 10 }).why === 'no-mid', 'no mid is its own reason');

check(Math.abs(unexplainedJump({ prev: 10, next: 30, quiet: true }) - 20) < 1e-9, 'a cash jump with no fill is unexplained');
check(unexplainedJump({ prev: 10, next: 30, quiet: false }) === 0, 'a fill or a transfer explains the jump');
check(unexplainedJump({ prev: 10, next: 10.4 }) === 0, 'noise inside five percent is ignored');

check(Math.abs(dustTopupUsd({ dustUsd: 0.4, venueMin: 1 }) - 0.6) < 1e-9, 'a dust bid covers only the gap to the venue minimum');
check(bookSlots({ budget: 18, maxPairs: 3, venueMin: 1 }) === 3, 'slots scale with cash up to the pair cap');
check(bookSlots({ budget: 2, maxPairs: 3, venueMin: 1 }) === 1, 'a small budget does not open empty slots');
const clip = openClipUsd({ budget: 18, slots: 3, clipMax: 1, venueMin: 1 });
check(Math.abs(clip - 6) < 1e-9, 'a one-dollar clip cap does not keep the book under the target');
const target = tradableBookTarget({ equity: 25, dust: 2.86, reserve: 0.25, frac: 0.9, askCover: 0 });
check(target.bidRoom > 0.8 * (25 - 2.86 - 0.25), 'bids aim at the book on equity after dust and reserve');
check(!positionAboveMin({ qty: 0.2, mid: 1, minNotional: 1 }), 'dust does not block flat');
check(positionAboveMin({ qty: 2, mid: 1, minNotional: 1 }), 'inventory still blocks flat');
check(positionAboveMin({ qty: 1, mid: 0, minNotional: 1 }), 'an unpriced position is not called flat');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
check(bot.includes('SCAN none-tradeable'), 'an empty scan is logged');
check(bot.includes('SCAN picked='), 'the hourly scan names what it kept');
check(bot.includes('risk=halt-timeout') || bot.includes("'halt-timeout'"), 'a stepped halt exit is tagged');
check(bot.includes('hold-timeout'), 'a stuck halt can re-baseline while holding');
check(bot.includes('pollCoinbaseTransfers'), 'coinbase transfers are read from the ledger');
check(bot.includes('TRANSFER '), 'a deposit is logged as capital');
check(bot.includes('EQUITY jump unexplained'), 'an unbooked jump pauses new risk');
check(bot.includes('dust-budget'), 'a dust bid is not called a sell budget');
check(bot.includes('below-min'), 'a sell under the venue minimum says so');
check(bot.includes('max-dist'), 'a far quote says max-dist');
check(bot.includes('GATES n='), 'gate lines are counted hourly');
check(!bot.includes("if (VENUE !== 'kraken') return;"), 'coinbase is not skipped in the transfer poll');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v6 checks passed');
