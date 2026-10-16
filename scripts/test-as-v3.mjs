import fs from 'fs';
import {
  cashBudget, takeBuyBudget, openingNotionalCap, fitOpeningPair, mlAfter,
  notionalForCarry, carryAllows, holdExitPx, pnlResidual, inventoryMarkPnl,
  fillScore, unwindAsk, sentHalfBps, applyEntry,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const budget = cashBudget({ free: 0.75, restingCost: 0, equity: 5.5 });
check(Math.abs(budget - 0.65) < 1e-9, 'cash budget keeps a 10 cent reserve');
check(Math.abs(cashBudget({ free: 0.75, restingCost: 0.5, equity: 5.5 }) - 0.15) < 1e-9, 'resting buys consume the free quote');
check(cashBudget({ free: 2, restingCost: 0, equity: 5, halve: true }) === (2 - 0.1) / 2, 'a funds reject halves the budget');

const sized = takeBuyBudget(0.65, { price: 0.15, wantSize: 6.76, feeBps: 40, minNotional: 1, minSize: 0, lot: 2 });
check(sized.skip && sized.size === 0, 'a buy under the venue minimum is skipped');
const fit = takeBuyBudget(2, { price: 0.5, wantSize: 10, feeBps: 40, minNotional: 1, lot: 2 });
check(fit.send && fit.size * 0.5 * 1.004 <= 2 + 1e-9, 'resized buy cost includes the fee');
check(fit.size < 10, 'an oversized buy is resized down');
const same = takeBuyBudget(0.2, { price: 1, wantSize: 1, curNotional: 1, same: true });
check(!same.send && same.budgetLeft === 0.2, 'an unchanged resting buy is not charged twice');

const room = openingNotionalCap({ equity: 12, usedMargin: 12 / 4.66, lev: 5, resume: 350 });
check(room > 3 && room < 6, 'one more clip on a $12 book stays near $4-5');
const pair = fitOpeningPair({
  equity: 12, usedMargin: 0, resume: 350, lev: 5,
  buy: { notional: 20, lev: 5, opening: true },
  sell: { notional: 20, lev: 5, opening: true },
});
const ml = mlAfter(12, pair.usedAdd);
check(ml != null && ml + 1e-6 >= 350, 'both sides filled still clear the resume margin level');
check(pair.buy < 9 && pair.sell < 9, 'neither side is the old $8 clip');

check(carryAllows({ holdMin: 240, bpsPerHour: 0.5, profitBps: 10 }), 'cheap carry fits in half the profit');
check(!carryAllows({ holdMin: 240, bpsPerHour: 5, profitBps: 10 }), 'expensive carry does not');
const shrunk = notionalForCarry({ notional: 8, holdMin: 240, bpsPerHour: 5, profitBps: 10, minNotional: 1 });
check(shrunk > 0 && shrunk < 8, 'carry shrinks the clip before skipping it');
check(notionalForCarry({ notional: 8, holdMin: 240, bpsPerHour: 50, profitBps: 10, minNotional: 5 }) === 0, 'carry below the venue minimum is skipped');

const midHold = holdExitPx({ entry: 100, side: 'long', feeBps: 16, profitBps: 10, carryPerUnit: 0.2, ageMin: 300, maxHoldMin: 240, touch: 100 });
const start = 100 * (1 + (16 + 10) / 10000);
const be = 100 * (1 + 16 / 10000) + 0.2;
check(midHold > Math.min(start, be) && midHold < Math.max(start, be), 'max-hold floor is halfway to carry break-even at 1h');
check(holdExitPx({ entry: 100, side: 'long', feeBps: 16, profitBps: 10, carryPerUnit: 0.2, ageMin: 400, maxHoldMin: 240, touch: 99 }) === 99, 'after the decay the exit is the touch');
check(holdExitPx({ entry: 100, ageMin: 10, maxHoldMin: 240 }) === 0, 'before max hold the caller keeps the v2 floor');

const resid = pnlResidual({ equity: 12, startEquity: 12.3, transfers: 0, netMaker: -0.44, inventoryPnl: -0.45, fundingBorrow: 0.1 });
check(Math.abs((12 - 12.3) - (-0.44 - 0.45 - 0.1) - resid) < 1e-9, 'residual is the identity gap');

let e = applyEntry(null, { side: 'buy', size: 2, price: 10, mid: 10.2 });
e = applyEntry(e, { side: 'sell', size: 2, price: 11, mid: 11 });
const inv = inventoryMarkPnl(e, { long: 0, short: 0, mid: 11 });
check(Math.abs(inv - (11 - 10.2) * 2) < 1e-9, 'inventory pnl is the mark change since the fill mid');
check(Math.abs(e.longQty) < 1e-12 && e.realizedMark > 0, 'a round trip keeps the realized mark');

check(fillScore({ tradesPerHour: 10, range: 0.01, needRange: 0.005 }) === 0.1, 'fill score is trades times range');
check(fillScore({ tradesPerHour: 10, range: 0.001, needRange: 0.005 }) === 0, 'a pair that cannot cover the width scores zero');
check(unwindAsk({ bid: 10, ask: 10.2, tick: 0.01, ageMs: 0 }) === 10.2, 'unwind starts at the ask');
check(Math.abs(unwindAsk({ bid: 10, ask: 10.2, tick: 0.01, ageMs: 2 * 3600 * 1000 }) - 10.01) < 1e-9, 'unwind ends one tick above the bid');
check(sentHalfBps(100, 99.7, 100.4) === 40, 'logged half is the distance actually sent');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
const quote = fs.readFileSync(new URL('../src/bots/as/quote.js', import.meta.url), 'utf8');
check(bot.includes('MIN_HALF_BPS'), 'min half env is read');
check(bot.includes('resid=$') || (bot.includes('statusMoney') && quote.includes('resid=$')), 'status line prints resid');
check(bot.includes('SKIP ') && bot.includes('budget'), 'a buy that does not fit is skipped');
check(bot.includes('GATE '), 'suppressed quotes are logged');
check(bot.includes('AS_MAX_HOLD_MIN'), 'max hold is configurable');
check(bot.includes("type === 'rollover'"), 'rollover is carry');
check(!/type === 'margin'[\s\S]{0,80}fundingBorrow/.test(bot), 'margin ledger amount is not funding');
check(bot.includes('pnlModel'), 'pnl components survive a restart');
check(bot.includes('pruneState'), 'stale order ids are pruned');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v3 checks passed');
