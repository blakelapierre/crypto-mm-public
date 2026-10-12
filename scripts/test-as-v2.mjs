import fs from 'fs';
import {
  asQuote, halfSpread, minHalfBps, exitBound, clampToBand, halveToward, backoffSec,
  feeToBps, applyEntry, entryAvg, positionPnl, opensRisk, touchExit,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

check(minHalfBps(16, 10) === 26, 'kraken min half is fee+profit');
check(minHalfBps(40, 10) === 50, 'coinbase min half is fee+profit');
check(Math.abs(halfSpread({ feeBps: 16, profitBps: 10, touchHalfBps: 2, maxHalfBps: 200 }) - 0.0026) < 1e-12, 'half ignores a tight touch');
check(halfSpread({ feeBps: 16, profitBps: 10, touchHalfBps: 40, maxHalfBps: 200 }) === 0.004, 'half can widen to the touch');
check(halfSpread({ feeBps: 16, profitBps: 10, maxHalfBps: 10 }) === 0.0026, 'fee floor beats a lower max');

const q = asQuote({ mid: 2, q: 0, sigma: 0.0001, minHalf: 0.0026, maxHalf: 0.02 });
check(q && q.half + 1e-12 >= 0.0026, 'as quote respects min half');
check(q.ask >= 2 * (1 + 0.0026) - 1e-9 && q.bid <= 2 * (1 - 0.0026) + 1e-9, 'both sides clear one half');

const floor = exitBound({ entry: 2, side: 'long', feeBps: 16, profitBps: 10 });
check(Math.abs(floor - 2 * (1 + (32 + 10) / 10000)) < 1e-12, 'long exit floor is entry * (1+2*fee+profit)');
const ceil = exitBound({ entry: 2, side: 'short', feeBps: 16, profitBps: 10 });
check(Math.abs(ceil - 2 * (1 - (32 + 10) / 10000)) < 1e-12, 'short exit ceiling is entry * (1-2*fee-profit)');
check(exitBound({ entry: 2, side: 'long', feeBps: 16, profitBps: 10, legacy: true, ageMs: 0, touch: 1.9 }) === floor, 'legacy floor starts at the profit floor');
const midLegacy = exitBound({ entry: 2, side: 'long', feeBps: 16, profitBps: 10, legacy: true, ageMs: 12 * 3600 * 1000, touch: 1.9 });
check(Math.abs(midLegacy - (floor + 1.9) / 2) < 1e-9, 'legacy floor is halfway to the touch at 12h');
check(exitBound({ entry: 2, side: 'long', feeBps: 16, profitBps: 10, legacy: true, ageMs: 24 * 3600 * 1000, touch: 1.9 }) === 1.9, 'legacy floor is the touch after 24h');

check(clampToBand(2.5, 2, 0.02) === 2.04, 'band caps a far ask');
check(halveToward(2.4, 2, 1) === 2.2, 'first too-far step halves the distance');
check(halveToward(2.4, 2, 3) === 2, 'third too-far step is the touch');
check(backoffSec(1) === 20 && backoffSec(2) === 40 && backoffSec(3) === 80, 'backoff doubles from 20s');
check(backoffSec(12) === 600, 'backoff caps at 10 min');
check(feeToBps(0.16) === 16 && feeToBps(0.0016) === 16 && feeToBps(16) === 16, 'fee units become bps');

let e = applyEntry(null, { side: 'buy', size: 2, price: 10 });
e = applyEntry(e, { side: 'buy', size: 2, price: 12 });
check(e.basis === 'fill' && e.longQty === 4 && entryAvg(e, 'long') === 11, 'vwap of two buys');
e = applyEntry(e, { side: 'sell', size: 1, price: 13 });
check(e.longQty === 3 && entryAvg(e, 'long') === 11, 'a sell reduces qty and keeps vwap');
e = applyEntry(e, { side: 'sell', size: 4, price: 9 });
check(e.longQty === 0 && Math.abs(e.shortQty - 1) < 1e-12 && entryAvg(e, 'short') === 9, 'oversell flips to a short');

check(opensRisk(1, 'buy') && !opensRisk(1, 'sell'), 'a buy opens a long');
check(opensRisk(-1, 'sell') && !opensRisk(-1, 'buy'), 'a sell opens a short');
check(opensRisk(0, 'buy') && opensRisk(0, 'sell'), 'either side opens a flat book');
check(touchExit('sell', 10, 10.02, 0.01, 40) === 10.02, 'tight spread joins the ask');
check(Math.abs(touchExit('sell', 10, 11, 0.01, 40) - 10.01) < 1e-9, 'wide spread sits one tick above the bid');
const pnl = positionPnl({ longQty: 2, longCost: 20, shortQty: 0, shortCost: 0 }, { long: 2, short: 0, mid: 11 });
check(Math.abs(pnl - 2) < 1e-12, 'long mark pnl uses entry');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
const ex = fs.readFileSync(new URL('../src/shared/exchange.js', import.meta.url), 'utf8');
check(!/TOO_FAR[\s\S]{0,120}6 \* 3600/.test(bot), 'a too-far reject does not dust the coin');
check(bot.includes('AS_PROFIT_BPS') && bot.includes('AS_MARGIN_LEVEL_RESUME'), 'profit and resume knobs');
check(bot.includes('fillsN') && bot.includes('fillsH') && bot.includes('fillCount'), 'status fills are since start and last hour');
check(bot.includes('reduceOnly') && bot.includes('positionQty'), 'reduces carry the margin size');
check(bot.includes('cancelOpening'), 'opening orders cancel before a rail exit');
check(bot.includes('cutLatch'), 'cut exits keep quoting until margin is back at the stop');
check(/reason !== 'below-min' && reason !== 'too-far'/.test(bot), 'a too-far reject reprices next loop instead of backing off');
check(/if \(reducing \|\| marginSell\)/.test(ex), 'reduce-only buys clamp to the position');
check(ex.indexOf('marginSell') < ex.indexOf('const free = sellable'), 'leveraged sells skip the spot free clamp');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v2 checks passed');
