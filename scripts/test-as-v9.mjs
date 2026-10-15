import crypto from 'crypto';
import fs from 'fs';
import {
  roundTripPadBps, roundTripFloorPx, oppositeFloorPx, edgeGate, roundTripNet, pairCooldownMs,
  churnSignal, lifetimeHalt, lifetimePct, resetAllowed, leverageNotch, expectedEdgeRow, rankByExpectedEdge,
  cbTransferAllowed, transferUsd, pendingTrigger, haltRiskAction, bookSlotsScaled, slotClipUsd,
  widenOpenDecision, idleRelax, marksForPending,
} from '../src/bots/as/quote.js';
import { coinbaseJwt, coinbaseJwtUri } from '../src/shared/coinbase.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const pad = roundTripPadBps({ feeBps: 16, minEdgeBps: 8 });
check(pad === 40, 'round trip pad is two fees plus the minimum edge');
const floor = roundTripFloorPx({ entry: 0.22, side: 'long', feeBps: 16, minEdgeBps: 8, tick: 0.0001 });
check(floor + 1e-12 >= 0.22 * 1.004, 'a long close is at least two fees and the edge above 0.22');
check(Math.abs(floor / 0.0001 - Math.round(floor / 0.0001)) < 1e-6, 'the close rounds away from entry onto the tick');
const oneFee = 0.22 * (1 + 26 / 10000);
check(!edgeGate({ px: oneFee, floor, side: 'sell', risk: '' }).ok, 'a one-fee close is not sent');
check(edgeGate({ px: oneFee, floor, side: 'sell', risk: 'halt-delever' }).ok, 'halt-delever may cross the round-trip floor');
check(edgeGate({ px: floor, floor, side: 'sell' }).ok, 'a close on the floor is allowed');
check(!edgeGate({ px: oneFee, floor, side: 'sell', risk: 'halt-timeout' }).ok, 'halt-timeout is not a floor exemption');
const opp = oppositeFloorPx({ fillPx: 0.22, side: 'buy', feeBps: 16, minEdgeBps: 8, tick: 0.0001 });
check(opp + 1e-12 >= 0.22 * 1.004, 'the opposite ask after a buy is outside the round trip');
const net = roundTripNet({ entry: 0.22, exit: 0.2205, qty: 33, feeBps: 16, side: 'long' });
check(net < 0, 'buying and selling 33 ADA one tick apart loses money after both fees');
check(pairCooldownMs({ losing: true, losses24h: 1, cooldownMin: 60 }) === 60 * 60 * 1000, 'one losing round trip cools the pair for an hour');
check(pairCooldownMs({ losing: true, losses24h: 2 }) === 6 * 3600 * 1000, 'two losing round trips cool the pair for six hours');
check(churnSignal({ fills: 6, fees: 0.78, capture: 0.08 }), 'six fills with fees above capture is churn');
check(!churnSignal({ fills: 5, fees: 1, capture: 0 }), 'five fills is not yet churn');

check(!lifetimeHalt({ equity: 9.65, baseline: 12.29, ddPct: 0.25 }), 'a 21.5% drawdown is not yet the lifetime rail');
check(lifetimeHalt({ equity: 9.2, baseline: 12.29, ddPct: 0.25 }), 'a 25% drawdown halts and does not auto-reset');
check(Math.abs(lifetimePct({ equity: 9.65, baseline: 12.29 }) * 100 + 21.48) < 0.05, 'lifetime percent is versus the original base');
check(resetAllowed({ resets: [0], now: 1000, max: 1, windowMs: 86400000 }) === false, 'a second automatic reset inside 24h does not fire');
check(resetAllowed({ resets: [0], now: 90000000, max: 1, windowMs: 86400000 }) === true, 'a reset older than a day does not count');
const step = leverageNotch({ step: 0, elapsedMs: 2 * 3600 * 1000, positive: true, maxLev: 10 });
check(step.advanced && step.lev === 3, 'two quiet hours with a winning round trip steps 2x to 3x');
const held = leverageNotch({ step: 1, elapsedMs: 3 * 3600 * 1000, positive: false, lost: true, maxLev: 10 });
check(!held.advanced && held.lev === 3, 'a losing round trip does not step leverage up');

const tight = expectedEdgeRow({ spreadBps: 20, sigma: 0 }, { feeBps: 16, minEdgeBps: 8, k: 1.5, kappa: 1.5, tauMin: 15 });
check(tight.tradeable && tight.expHalf + 1e-9 >= 40 && tight.expEdge > 0, 'a tight book is still tradeable when the quote is wider than the touch');
check(tight.expHalf + 1e-9 >= tight.need, 'the required half is never inside round-trip fees plus edge');
const ranked = rankByExpectedEdge([
  { symbol: 'TIGHT', spreadBps: 20, vol24: 5e6, tickBps: 1 },
  { symbol: 'THIN', spreadBps: 80, vol24: 1000, tickBps: 1 },
  { symbol: 'WIDE', spreadBps: 400, vol24: 2e6, tickBps: 1 },
], { feeBps: 16, minEdgeBps: 8, minVol: 250000, maxSpreadBps: 250, maxPairs: 2 });
check(ranked.evaluated === 3 && ranked.picked.some((p) => p.symbol === 'TIGHT'), 'the scanner scores every name, not the first eight tight books');
check(ranked.best5.length >= 1, 'best candidates are kept even when some are rejected');

const wide196 = widenOpenDecision({
  px: 98, side: 'buy', mid: 100, needBps: 110, touch: 99.02, otherTouch: 100.98, maxDistBps: 150, spreadMedBps: 196,
});
check(wide196.cap + 1e-9 >= 208 && wide196.why === 'ok', 'a 196bp book uses a cap of at least 208 and the bid is placed');
const wide152 = widenOpenDecision({
  px: 98.5, side: 'buy', mid: 100, needBps: 110, touch: 99.24, otherTouch: 100.76, maxDistBps: 150, spreadMedBps: 152,
});
check(wide152.cap + 1e-9 >= 186 && wide152.cap > 150, 'a 152bp book does not keep the 150bp cap');

check(transferUsd({ amount: 20.01, px: 1, status: 'completed' }) === 20.01, 'a positive send amount is a deposit');
check(transferUsd({ amount: -4, px: 1 }) === -4, 'a negative amount is a withdrawal');
check(transferUsd({ amount: 20, px: 1, status: 'pending' }) === 0, 'an unfinished transfer is not booked');
check(cbTransferAllowed('send') && cbTransferAllowed('intx_deposit'), 'wallet sends and exchange deposits count');
check(!cbTransferAllowed('advanced_trade_fill') && !cbTransferAllowed('buy'), 'fills are not transfers');
check(pendingTrigger({ resid: 20.01, equity: 25.5, fillDelta: 0 }) === 20.01, 'a residual with no fill becomes pending capital');
check(pendingTrigger({ resid: 20, equity: 25, fillDelta: 1 }) === 0, 'a fill explains the residual');
const shifted = marksForPending({ marks: [{ t: 1, eq: 25.48 }, { t: 2, eq: 25.4 }], gross: 25.48, pending: 19.18 });
check(Math.abs(shifted.marks[0].eq - (25.48 - 19.18)) < 1e-9 && shifted.shifted === 19.18, 'pending cash is taken out of the day marks');
const kept = marksForPending({ marks: [{ t: 1, eq: 100 }], gross: 110, pending: 30 });
check(kept.marks[0].eq === 100 && kept.shifted === 0, 'a real earlier peak is not shifted by a new deposit');
const restored = marksForPending({ marks: shifted.marks, gross: 25.48, pending: 0, shifted: shifted.shifted });
check(Math.abs(restored.marks[0].eq - 25.48) < 1e-9 && restored.shifted === 0, 'booking the pending puts the day marks back');
check(haltRiskAction({ notional: 80, equity: 10, haltEquity: 10, equityNow: 10, ageH: 0.1, maxLev: 2 }) === 'delever', 'a 8x book de-levers to 2x on the halt');
check(haltRiskAction({ notional: 15, equity: 10, haltEquity: 10, equityNow: 9.7, ageH: 1, maxLev: 2, extraLossPct: 0.02 }) === 'cap-exit', 'another 2% after the halt exits the rest');
check(haltRiskAction({ notional: 15, equity: 10, haltEquity: 10, equityNow: 10, ageH: 6, maxLev: 2, maxHoldH: 6 }) === 'cap-exit', 'six hours of halt is a cap exit');
check(bookSlotsScaled({ budget: 14, venueMin: 1, maxPairs: 6 }) >= 3, 'fourteen dollars opens several coinbase slots');
check(slotClipUsd({ budget: 14, slots: 6, venueMin: 1 }) > 1, 'each slot is a share of the cash, not a one-dollar cap');
const relaxed = idleRelax({ idleMin: 61, minEdgeBps: 8, volFloor: 250000 });
check(relaxed.relaxed && relaxed.minEdgeBps === 2 && relaxed.volFloor === 125000, 'an hour of idle cash relaxes edge to break-even plus 2bp and halves volume');
check(coinbaseJwtUri('GET', '/v2/accounts/x/transactions?limit=25') === 'GET api.coinbase.com/v2/accounts/x/transactions?limit=25', 'the jwt uri keeps the query string');
check(coinbaseJwtUri('GET', '/api/v3/brokerage/accounts?limit=250') === 'GET api.coinbase.com/api/v3/brokerage/accounts', 'advanced trade signs the path without the query');

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const token = coinbaseJwt(
  { coinbaseApiKey: 'organizations/x/apiKeys/y', coinbaseApiSecret: pem },
  'GET',
  '/v2/accounts/x/transactions?limit=25',
);
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
check(payload.uri === 'GET api.coinbase.com/v2/accounts/x/transactions?limit=25', 'a signed v2 transactions request includes limit=25');

const bot = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
const quote = fs.readFileSync(new URL('../src/bots/as/quote.js', import.meta.url), 'utf8');
const src = bot + '\n' + quote;
for (const s of [
  'TRANSFER error', 'TRANSFER pending', 'TRANSFER inferred', 'TRANSFER source=',
  'xfer=blind', 'xfer=pending', 'pollCoinbaseTransfers', 'cbTxCursor', 'book-transfer',
  'SCAN empty', 'SCAN reject', 'SCAN best ', 'SCAN alert none-tradeable', 'IDLE ',
  'SCAN relax', 'halt-delever', 'halt-cap', 'day-kill', 'lifetime-rail',
  'HALT risk', 'ORDER stale', 'ordersSyncedAt', 'life=$', 'capitalBaseline',
  'roundTripFloorPx', 'CHURN ', 'edge need=', 'AS_MAX_RESETS_PER_DAY', 'hold-timeout',
  'EQUITY jump unexplained',
]) {
  check(src.includes(s), 'source contains ' + s);
}
check(!bot.includes('state.equityPauseUntil = now'), 'unknown money does not pause new risk');
check(!bot.includes("if (VENUE !== 'kraken') return;"), 'coinbase transfers are not skipped');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('as v9 ok');
