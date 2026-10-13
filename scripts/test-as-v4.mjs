import fs from 'fs';
import {
  adaptiveHalf, cashBudget, exitLossNotional, gradualHoldExit, holdingClass,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const floor = adaptiveHalf({ feeBps: 16, profitBps: 10, sigma: 0.001, k: 1.5, touchSpreadBps: 8 });
check(floor.bps + 1e-9 >= 26 && floor.src === 'floor', 'half never sits under fee plus profit');
const vol = adaptiveHalf({ feeBps: 16, profitBps: 10, sigma: 0.003, k: 1.5, touchSpreadBps: 8 });
check(Math.abs(vol.bps - 45) < 1e-6 && vol.src === 'vol', 'k times sigma widens the half');
const touch = adaptiveHalf({ feeBps: 16, profitBps: 10, sigma: 0.001, k: 1.5, touchSpreadBps: 80 });
check(Math.abs(touch.bps - 40) < 1e-6 && touch.src === 'touch', 'half the touch wins when it is widest');
check(adaptiveHalf({ feeBps: 16, profitBps: 10, sigma: 0.01, k: 1.5, touchSpreadBps: 800, maxHalfBps: 200 }).bps <= 200, 'half stays inside the max');

const net = cashBudget({ free: 0.75, restingCost: 1, equity: 5.59, netOfHolds: true });
check(Math.abs(net - (0.75 - Math.max(5.59 * 0.01, 0.1))) < 1e-9, 'coinbase available is not charged for resting buys again');
check(cashBudget({ free: 0.75, restingCost: 0.5, equity: 5.5 }) < cashBudget({ free: 0.75, restingCost: 0, equity: 5.5 }), 'kraken still subtracts resting buys');

check(holdingClass({ qty: 10, mid: 0.2, minNotional: 1 }) === 'inventory', 'a holding above the venue minimum is inventory');
check(holdingClass({ qty: 2, mid: 0.2, minNotional: 1 }) === 'dust', 'a holding under the venue minimum is dust');
check(holdingClass({ qty: 0.1, mid: 100, minNotional: 1, minSize: 1 }) === 'dust', 'a holding under the base minimum is dust');

const lossN = exitLossNotional({ equity: 12, feeBps: 16, sigma: 0.002, holdMin: 240, maxLossPct: 0.015 });
const lossFrac = 2 * 0.0016 + 0.002 * Math.sqrt(240 / 15);
check(Math.abs(lossN - (12 * 0.015) / lossFrac) < 1e-9, 'exit loss caps notional at 1.5 percent of equity');
check(lossN * lossFrac <= 12 * 0.015 + 1e-9, 'a forced exit of that clip loses at most 1.5 percent');

const maxH = 240;
check(gradualHoldExit({ entry: 100, ageMin: 0.74 * maxH, maxHoldMin: maxH, feeBps: 16, profitBps: 10 }) === 0, 'before 75 percent of the hold cap the v2 floor stays');
const startPx = 100 * (1 + (16 + 10) / 10000);
check(Math.abs(gradualHoldExit({ entry: 100, ageMin: 0.75 * maxH, maxHoldMin: maxH, feeBps: 16, profitBps: 10 }) - startPx) < 1e-9, 'the walk starts at entry plus fee plus profit');
const midPx = gradualHoldExit({ entry: 100, ageMin: 0.875 * maxH, maxHoldMin: maxH, feeBps: 16, profitBps: 10, carryPerUnit: 0 });
const bePx = 100 * (1 + 16 / 10000);
check(midPx > Math.min(startPx, bePx) && midPx < Math.max(startPx, bePx), 'the walk is toward breakeven before the cap');
check(Math.abs(gradualHoldExit({ entry: 100, ageMin: maxH, maxHoldMin: maxH, feeBps: 16, profitBps: 10, touch: 90 }) - bePx) < 1e-9, 'at the cap the exit is breakeven');
const stepped = gradualHoldExit({ entry: 100, ageMin: maxH + 15, maxHoldMin: maxH, feeBps: 16, profitBps: 10, touch: 90, halfBps: 40 });
const step = 100 * (40 / 10000) * 0.25;
check(Math.abs(stepped - (bePx - step)) < 1e-6 && stepped > 90, 'after the cap the exit steps a quarter spread and does not cross the touch');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
check(!bot.includes('logFill'), 'fill lines are json objects, not the positional fill log');
check(bot.includes('half_src='), 'the sent half records its source');
check(bot.includes('netOfHolds: true'), 'coinbase budget does not subtract holds twice');
check(bot.includes('vol-warmup'), 'a short sample is a warmup gate, not a 15bp sigma');
check(bot.includes('LEDGER orphan'), 'an unmatched margin fee is logged');
check(bot.includes("type === 'rollover'"), 'only rollover is funding');
check(!/type === 'margin'[\s\S]{0,80}fundingBorrow/.test(bot), 'a margin row is not funding');
check(bot.includes('dust=$') && bot.includes('inv=$'), 'status prints dust and inventory');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v4 checks passed');
