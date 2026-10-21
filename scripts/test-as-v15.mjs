import fs from 'fs';
import {
  tradableBookTarget, leverageNotch, migrateLegacyPending, controlResume,
  stopRoomBudget, krakenOpeningPlan, parkStepPlan, releaseWorstLoss,
  dustTopupDecision, windowDrawdowns, applyCapitalShift, lossHalts,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const base = 13.3 - 3.47 - 0.13;
const target = 0.9 * base;
const room = tradableBookTarget({ equity: 13.3, dust: 3.47, reserve: 0.13, frac: 0.9, restingAsks: 1.2, restingBids: 2.1 });
check(Math.abs(room.base - base) < 1e-9, 'tradable base is equity minus dust and reserve');
check(Math.abs(room.cover - 3.3) < 1e-9, 'cover is resting bids plus asks');
check(Math.abs(room.target - target) < 1e-9 && Math.abs(room.bidRoom - Math.max(0, target - 3.3)) < 1e-9, 'bid room is the target minus resting cover');
const asksOnly = tradableBookTarget({ equity: 13.3, dust: 3.47, reserve: 0.13, frac: 0.9, restingAsks: 1.2 });
check(Math.abs(asksOnly.bidRoom - Math.max(0, target - 1.2)) < 1e-9, 'omitted resting bids are not invented');
const legacy = tradableBookTarget({ equity: 25, dust: 2.86, reserve: 0.25, frac: 0.9, askCover: 0 });
check(legacy.bidRoom > 0.8 * (25 - 2.86 - 0.25), 'an ask-cover caller still aims at the book');

const stuck = leverageNotch({ step: 1, lost: true, idleMs: 8 * 3600 * 1000, repeatIdle: true, fills: 0 });
check(!stuck.advanced && stuck.step === 1, 'lost does not advance, even with a long idle clock');
const climb = leverageNotch({ step: 0, lost: false, idleMs: 6 * 3600 * 1000, repeatIdle: true, fills: 5 });
check(climb.advanced && climb.idle && climb.lev === 3, 'an idle notch climbs once with historical fills');
const early = leverageNotch({ step: climb.step, lost: false, idleMs: 6 * 3600 * 1000 - 1000, repeatIdle: true, fills: 5 });
check(!early.advanced && early.step === climb.step, 'the next notch waits for another full idle window');
const once = leverageNotch({ step: 0, lost: false, idleMs: 8 * 3600 * 1000, fills: 0 });
check(once.advanced && once.step === 1, 'the old idle notch still climbs a single step from zero');
const twice = leverageNotch({ step: once.step, lost: false, idleMs: 8 * 3600 * 1000, fills: 0 });
check(!twice.advanced, 'without repeatIdle a later idle hour does not climb again');

const since = Date.now() - 6 * 86400000;
const expired = migrateLegacyPending({
  transferPending: { usd: -2.64, since }, haltEquity: 17.38, haltNotional: 3, halted: null, pendingShift: null,
}, Date.now());
check(expired.expired && expired.state.transferPending == null, 'a pending older than 72h expires');
check(Math.abs(expired.state.unexplained + 2.64) < 1e-9, 'the expired amount becomes unexplained');
check(expired.state.haltEquity === 0 && expired.state.haltNotional === 0, 'stale halt equity is cleared when nothing is halted');
const youngSince = Date.now() - 3600 * 1000;
const young = migrateLegacyPending({ transferPending: { usd: -1, since: youngSince }, halted: null }, Date.now());
check(!young.expired && young.migrated, 'a young pending is migrated, not expired');
check(young.state.transferPending.id === 'legacy-' + youngSince && young.state.transferPending.source === 'legacy', 'a missing id becomes legacy-<since>');
check(young.state.pendingShift === 0, 'an unrecorded pending shift stays zero');

const resumed = controlResume({ halted: 'day-loss', haltEquity: 17.38, haltNotional: 4, haltLossPlan: { X: 1 } });
check(resumed.state.halted == null && resumed.state.haltEquity === 0 && resumed.state.haltNotional === 0, 'resume clears halt equity and notional');
check(resumed.state.haltLossPlan && Object.keys(resumed.state.haltLossPlan).length === 0, 'resume clears the halt loss plan');

const stop = stopRoomBudget({ stopDistPp: 4.2, capital: 12.28 });
check(stop.bind && Math.abs(stop.usd - 0.032 * 12.28) < 1e-9, 'under 5pp the worst loss fits in stopDist minus 1pp');
check(!stopRoomBudget({ stopDistPp: 20, capital: 12 }).bind, 'the stop room does not bind with 20pp left');
const plan = krakenOpeningPlan({
  equity: 9.73, lev: 2, stop: 300,
  sides: [{ id: 'A:buy', side: 'buy', want: 8, min: 6.25, lossCap: stop.usd, stopRoom: true, expEdge: 5 }],
});
check(plan.sides[0].reason === 'stop-room' && !(plan.sides[0].fit > 0), 'a minimum that cannot fit the stop room is stop-room, not min-size');

const earlyPark = parkStepPlan({ idleH: 5, entry: 1, costFloor: 1.2, touch: 1, qty: 1, stepH: 6 });
check(earlyPark.k === 0 && !earlyPark.ok, 'a parked holding does not step before the window');
const stepped = parkStepPlan({
  idleH: 12, entry: 1, costFloor: 1.2, touch: 1, qty: 2, feeBps: 0,
  stepH: 6, stepBps: 150, maxLossBps: 800, stopDistPp: 20, capital: 100,
});
check(stepped.k >= 1 && stepped.ok, 'a 12h park places a step inside the stop room');
check(stepped.worst <= releaseWorstLoss({ entry: 1, floor: stepped.px, qty: 2, feeBps: 0 }) + 1e-9, 'the step loss is the release worst case');
const blocked = parkStepPlan({
  idleH: 102, entry: 1, costFloor: 1.2, touch: 0.5, qty: 100, feeBps: 0,
  stepH: 6, stepBps: 150, maxLossBps: 800, stopDistPp: 3, capital: 10,
});
check(blocked.k >= 1 && !blocked.ok, 'a step that would pass the stop minus 2pp is not placed');

const gap = dustTopupDecision({ dustUsd: 0.99, venueMin: 1 });
check(Math.abs(gap.usd - 0.01) < 1e-9 && gap.reason === '', 'a sub-min holding is topped up by the gap');
const costly = dustTopupDecision({ dustUsd: 0.2, venueMin: 1 });
check(costly.usd === 0 && costly.reason === 'cost', 'a top-up that costs more than the holding stays dust');
const unlisted = dustTopupDecision({ dustUsd: 0.99, venueMin: 1, listed: false });
check(unlisted.reason === 'unlisted' && unlisted.usd === 0, 'an unlisted market stays dust');

function draw(equity, capital, mark) {
  return windowDrawdowns({ equity, capital, dayMark: mark, sessionMark: mark, lifeMark: mark });
}
const before = draw(9900, 10000, 10000);
const up = draw(9901, 10001, 10001);
const down = draw(9899, 9999, 9999);
for (const k of ['day', 'session', 'lifetime']) {
  check(Math.abs(before[k] - up[k]) < 0.01, k + ' drawdown stays within 0.01pp after a +1 book');
  check(Math.abs(before[k] - down[k]) < 0.01, k + ' drawdown stays within 0.01pp after a -1 book');
}
const haltBefore = lossHalts({
  sessionTrading: -100, dayTrading: -100, lifeTrading: -100,
  sessionCapital: 10000, dayCapital: 10000, lifeCapital: 10000,
  sessionLoss: 0.08, dayLoss: 0.12, lifetimeDd: 0.25,
});
let shifted = applyCapitalShift({
  startEquity: 10000, originEquity: 10000, capitalBaseline: 10000, lifetimeTransfers: 0,
  equityMarks: [{ t: 1, eq: 10000 }], prevEquity: 10000, lastEquity: 10000,
  halted: null, haltEquity: 17.38,
}, 1, 'book');
check(shifted.haltEquity === 17.38, 'a shift does not move halt equity while the bot is not halted');
shifted = applyCapitalShift({ ...shifted, halted: 'day-loss', haltEquity: 10000 }, -1, 'book');
check(Math.abs(shifted.haltEquity - 9999) < 1e-9, 'a shift moves halt equity only while a halt is set');
const haltAfter = lossHalts({
  sessionTrading: -100, dayTrading: -100, lifeTrading: -100,
  sessionCapital: 10001, dayCapital: 10001, lifeCapital: 10001,
  sessionLoss: 0.08, dayLoss: 0.12, lifetimeDd: 0.25,
});
check(haltBefore.dayHalt === haltAfter.dayHalt && haltBefore.sessionHalt === haltAfter.sessionHalt && haltBefore.lifetimeHalt === haltAfter.lifetimeHalt, 'booking a dollar does not flip a halt');
check(!haltAfter.dayHalt && !haltAfter.sessionHalt && !haltAfter.lifetimeHalt, 'the booked book is still inside the rails');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
for (const s of ['SLOT release ', 'SCAN pull ', 'PARK step ', 'DUST list ', 'MID stale ', 'IDLE deadlock ', 'LEV idle notch ', 'stop-room', 'cover=$', 'PENDING expire ']) {
  check(bot.includes(s), 'source contains ' + s);
}
check(bot.includes('since: sinceNow'), 'a ramp that did not step keeps its clock');
check(bot.includes('state.haltLossPlan = {}'), 'clearing a halt drops the loss plan');
check(!bot.includes("if (VENUE !== 'kraken') return;"), 'coinbase is not skipped by a venue return');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v15 checks passed');
