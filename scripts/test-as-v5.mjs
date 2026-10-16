import fs from 'fs';
import {
  openingMinHalfBps, costFloorPx, posEffectOf, quoteCapture, riskAllowsLoss, stepToward, roundUpReduce,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const need = openingMinHalfBps({ feeBps: 16, bufferBps: 6, profitBps: 10, minEdgeBps: 8, minHalfBps: 26 });
check(need >= 16 + 6 + 10, 'opening half covers fee, buffer and profit');
check(2 * need - 2 * 16 >= 8, 'round trip nets the minimum edge');
check(openingMinHalfBps({ feeBps: 35, bufferBps: 6, profitBps: 10, minEdgeBps: 8, minHalfBps: 110 }) === 110, 'env floor still wins when it is wider');

const floor = costFloorPx({ entry: 10.4, side: 'long', feeBps: 16, profitBps: 10 });
check(Math.abs(floor - 10.4 * 1.0026) < 1e-9, 'long cost floor is entry plus fee plus profit');
check(costFloorPx({ entry: 100, side: 'short', feeBps: 16, profitBps: 10 }) < 100, 'short cost floor is below entry');

check(posEffectOf({ side: 'buy', size: 1 }) === 'open', 'a flat buy opens');
check(posEffectOf({ longQty: 2, side: 'buy', size: 1 }) === 'add', 'a buy on a long adds');
check(posEffectOf({ longQty: 2, side: 'sell', size: 1 }) === 'reduce', 'a partial sell reduces');
check(posEffectOf({ longQty: 2, side: 'sell', size: 2 }) === 'close', 'a full sell closes');
check(posEffectOf({ longQty: 1, side: 'sell', size: 2 }) === 'flip', 'an oversized sell flips');

const cap = quoteCapture({ side: 'sell', price: 10.29, size: 1, mid: 10.4 });
check(cap != null && cap < 0, 'capture uses the quote mid, not the fill price');
check(quoteCapture({ side: 'buy', price: 10, size: 1, mid: 0 }) == null, 'a missing mid is not stored as the fill price');

check(riskAllowsLoss({ ml: 180, cut: 200 }) === 'margin', 'a cut-rail margin level may cross the cost floor');
check(riskAllowsLoss({ adverseFrac: 0.04, stopPct: 0.03 }) === 'stop', 'a 3 percent adverse move is a stop');
check(riskAllowsLoss({ ageMin: 500, maxHoldMin: 240 }) === 'hold', 'twice the hold cap is a hold exit');
check(riskAllowsLoss({ haltKind: 'day-loss' }) === 'halt', 'day-loss may cross');
check(riskAllowsLoss({ haltKind: 'session-loss' }) === '', 'session-loss does not force a loss');

const stepped = stepToward({ from: 100, to: 90, halfBps: 40, steps: 1, entry: 100 });
check(stepped < 100 && stepped > 90, 'a risk exit steps toward the touch');
check(stepToward({ from: 100, to: 90, halfBps: 40, steps: 0, entry: 100 }) === 100, 'the first step stays on the cost floor');

check(roundUpReduce({ size: 0.0043, minSize: 0.1, posQty: 0.0043 }).dust, 'a remainder under the minimum is dust');
check(roundUpReduce({ size: 0.05, minSize: 0.1, posQty: 0.2 }).size === 0.1, 'a reduce rounds up when the position can hold the minimum');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
check(bot.includes('fee-edge'), 'a quote that cannot pay the fee is gated');
check(bot.includes('CAPTURE missing'), 'a fill without a quote mid is logged');
check(bot.includes('SESSION reset'), 'a flat halt can start a new session');
check(bot.includes('CONTROL '), 'a control file can reset the session');
check(bot.includes('tb.e'), 'kraken equity is the marked balance');
check(bot.includes('ex-dust'), 'book percent is also reported without dust');
check(bot.includes('DUST stuck'), 'unstuckable dust is listed');
check(bot.includes('risk='), 'an exit through the cost floor names its risk');
check(bot.includes("type === 'rollover'"), 'rollover is still the only funding');
check(!/type === 'margin'[\s\S]{0,80}fundingBorrow/.test(bot), 'margin ledger amount is not funding');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v5 checks passed');
