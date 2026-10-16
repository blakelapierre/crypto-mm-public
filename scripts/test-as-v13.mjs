import fs from 'fs';
import { krakenNotionalRoom, krakenOpeningPlan, leverageNotch, mlAfter, accountVsCapital, statusMoney, pairQuotePlan, minAboveRoom } from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const room = krakenNotionalRoom({ equity: 9.65, lev: 2, stop: 300, bookFrac: 0.9 });
const used = room.notional / 2;
const ml = mlAfter(9.65, used);
check(ml + 1e-6 >= 300 * 1.2, 'a fill of the planned room leaves margin level at or above stop x 1.2');
const looser = mlAfter(9.65, (room.notional + 0.05) / 2);
check(looser < 300 * 1.2, 'the room is the largest notional that still holds stop x 1.2');
check(room.notional > 5 && room.notional < 5.5, 'at 2x the stop buffer is about $5.36, not the resume $5.51');
const room3 = krakenNotionalRoom({ equity: 9.65, lev: 3, stop: 300, bookFrac: 0.9 });
check(room3.notional > 7.5 && mlAfter(9.65, room3.notional / 3) + 1e-6 >= 360, 'one notch to 3x clears a seven-dollar minimum and still holds the floor');
const legacy = krakenNotionalRoom({ equity: 9.65, lev: 2, resume: 350, bookFrac: 0.9 });
check(legacy.notional > 5 && legacy.notional < 6, 'callers that still pass resume keep the old room');

const empty = krakenOpeningPlan({
  equity: 9.65, lev: 2, stop: 300, bookFrac: 0.9,
  sides: [
    { id: 'a:buy', side: 'buy', want: 0, min: 5, lossCap: 10, expEdge: 1 },
    { id: 'a:sell', side: 'sell', want: 20, min: 12, lossCap: 20, expEdge: 2 },
  ],
});
check(empty.sides.every((s) => s.fit > 0 || s.reason), 'a side with no size always has a reason');
check(empty.sides.find((s) => s.id === 'a:buy').reason === 'room-used', 'an unrequested side is room-used, not a blank');
check(empty.sides.find((s) => s.id === 'a:sell').reason === 'margin', 'a minimum above the whole room is margin');
check(!empty.sides.some((s) => s.reason === 'edge'), 'opening plan never calls a miss edge');

const idle = leverageNotch({ step: 0, elapsedMs: 0, positive: false, lost: false, fills: 0, idleMs: 6 * 3600 * 1000, maxLev: 10 });
check(idle.advanced && idle.idle && idle.lev === 3, 'six hours with no fills and no loss steps 2x to 3x once');
const stay = leverageNotch({ step: 1, fills: 0, idleMs: 12 * 3600 * 1000, positive: false, lost: false, maxLev: 10 });
check(!stay.advanced && stay.lev === 3, 'the idle notch does not climb a second time');
const early = leverageNotch({ step: 0, fills: 0, idleMs: 5 * 3600 * 1000, maxLev: 10 });
check(!early.advanced && early.lev === 2, 'five idle hours stays at 2x');
const lost = leverageNotch({ step: 1, elapsedMs: 3 * 3600 * 1000, positive: false, lost: true, fills: 0, idleMs: 8 * 3600 * 1000, maxLev: 10 });
check(!lost.advanced && lost.lev === 3, 'a loss does not step leverage up');

const vs = accountVsCapital({ equity: 9.65, capital: 12.28, pending: 0 });
check(Math.abs(vs + 2.63) < 0.001, 'equity against capital is about -2.63 after a session reset');
const line = statusMoney({ equity: 9.65, capital: 12.28, trading: vs, resid: 0, pending: 0, stopPct: 0.25 });
check(line.includes('trading=$-2.63') && line.includes('-21.4%'), 'kraken status prints trading against capital');
check(line.includes('stopDist=3.6pp'), 'distance to the 25% lifetime stop is visible');
check(line.includes('resid=$0.00') && line.includes('capital=$12.28'), 'resid and capital stay on the line');
const same = statusMoney({ equity: 15.78, capital: 24.90, trading: 0.89, resid: 1.98, pending: -10.01 });
check(same.includes('trading=$0.89') && !same.includes('stopDist='), 'coinbase status is unchanged when no stop is passed');

const now = 1_000_000;
const probe = pairQuotePlan({
  altname: 'AAAUSD', symbol: 'AAA', leverageBuy: [2, 3], leverageSell: [2], now,
});
check(probe.needsProbe && probe.orderPair === 'AAAUSD:BTNL' && !probe.marginOk, 'public leverage only means probe, not a live :BTNL order');
const spot = pairQuotePlan({ altname: 'BBBUSD', symbol: 'BBB', leverageBuy: [], leverageSell: [], now });
check(spot.longOnly && spot.orderPair === 'BBBUSD' && !String(spot.orderPair).includes(':BTNL'), 'a pair with no leverage is long-only on the plain name');
const denied = pairQuotePlan({
  altname: 'CCCUSD', symbol: 'CCC', leverageBuy: [2], leverageSell: [2], now,
  denied: { until: now + 1000, reason: 'unknown-pair' },
});
check(denied.deniedMargin && denied.longOnly && !denied.orderPair.endsWith(':BTNL'), 'a denied margin name is not sent to :BTNL again');
const cached = pairQuotePlan({
  altname: 'DDDUSD', symbol: 'DDD', leverageBuy: [2], leverageSell: [2], now,
  probe: { marginOk: true, orderPair: 'DDDUSD:BTNL', at: now - 1000 },
});
check(cached.marginOk && cached.orderPair === 'DDDUSD:BTNL' && !cached.needsProbe, 'a fresh probe is reused instead of rebuilding the pair');
const min = minAboveRoom({ ordermin: 2, price: 4, quoteMin: 1, room: 5.36 });
check(min.reject && min.min === 8, 'ordermin times price above the room is rejected');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
check(bot.includes('PAIR deny '), 'an unknown pair is denied');
check(bot.includes('reason=min-gt-room'), 'a minimum above the room is logged');
check(bot.includes("gate('sell', spotOpen ? 'margin' : 'unsized')"), 'the sell fallback is unsized or margin, not edge');
check(!bot.includes("opensRisk(netQty, 'sell')) gate('sell', 'edge')"), 'sell edge is not the catch-all');
check(bot.includes('stop: ML_STOP'), 'kraken room is sized from the margin stop');
check(!bot.includes("return (rec.altname || symbol + 'USD') + ':BTNL'"), 'order pairs are not rebuilt as :BTNL for every symbol');

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('as v13 checks passed');
