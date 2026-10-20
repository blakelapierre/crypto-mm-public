import fs from 'fs';
import {
  loopClipUsd, planCoinbaseBids, coinbaseWantUsd, applyBudgetHalve, feeTier, takeBuyBudget, slotClipUsd,
} from '../src/bots/as/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((symbol) => ({ symbol, inSlot: true }));
const even = planCoinbaseBids({ start: 6.93, slots: 6, venueMin: 1, free: 20, rows });
const clip = loopClipUsd({ budget: 6.93, slots: 6, venueMin: 1 });
check(Math.abs(clip - 1.0395) < 1e-9, 'b=6.93 slots=6 clips at $1.04');
check(even.rows.length === 6 && even.rows.every((r) => Math.abs(r.usd - clip) < 1e-9), 'each of six rows gets the same clip');
check(even.rows.every((r) => r.usd <= clip + 1e-9), 'no row is larger than the clip');
check(even.clip === clip, 'the clip is computed once for the loop');

const capped = planCoinbaseBids({
  start: 6.93, slots: 6, venueMin: 1, free: 2.94,
  rows: [
    { symbol: 'KEEP', keep: true, own: 1.04, inSlot: true },
    { symbol: 'N1', inSlot: true },
    { symbol: 'N2', inSlot: true },
    { symbol: 'N3', inSlot: true },
    { symbol: 'N4', inSlot: true },
    { symbol: 'N5', inSlot: true },
  ],
});
const fresh = capped.rows.filter((r) => !r.keep && r.usd > 0);
const gated = capped.rows.filter((r) => r.gate === 'free-cash');
check(fresh.length === 2 && fresh.every((r) => Math.abs(r.usd - clip) < 1e-9), 'free=2.94 sizes two new $1.04 bids beside one kept bid');
check(gated.length === 3, 'the rest gate free-cash');
check(capped.rows.every((r) => r.usd <= Math.min(clip, 2.94) + 1e-9), 'no order exceeds min(clip, free)');

const small = planCoinbaseBids({ start: 1.30, slots: 1, venueMin: 1, free: 5, rows: [{ symbol: 'ONE', inSlot: true }] });
check(Math.abs(small.clip - 1.17) < 1e-9 && Math.abs(small.rows[0].usd - 1.17) < 1e-9, 'b=1.30 slots=1 clips at $1.17');
check(small.rows[0].usd < 1.30 * 0.9 + 0.02, 'a small budget does not hand the row the leftover');
const broke = planCoinbaseBids({ start: 0.95, slots: 1, venueMin: 1, free: 0.95, rows: [{ symbol: 'NONE', inSlot: true }] });
check(broke.rows[0].usd === 0 && broke.rows[0].gate === 'budget-spent', 'b=0.95 sizes nothing and gates budget-spent');
check(coinbaseWantUsd({ clip: 0, left: 0.95, free: 0.95, venueMin: 1 }).gate === 'budget-spent', 'a zero clip is budget-spent, not a 90% leftover');

const before = 6.93;
const after = applyBudgetHalve(before, true);
check(after <= before / 2 + 1e-9, 'a funds reject halves b');
const slotsAfter = 3;
const nextClip = loopClipUsd({ budget: after, slots: slotsAfter, venueMin: 1 });
const next = planCoinbaseBids({ start: after, slots: slotsAfter, venueMin: 1, free: after, rows: [{ symbol: 'SAME', inSlot: true }] });
check(next.rows[0].usd <= nextClip + 1e-9 && next.rows[0].usd <= after + 1e-9, 'the next size is within the halved clip');
check(slotClipUsd({ budget: before, slots: 6, venueMin: 1 }) === clip, 'slotClip itself is unchanged');

const taken = takeBuyBudget(6.93, { price: 0.15, wantSize: 40, curNotional: 0, feeBps: 35, minNotional: 1, free: 1.04, lot: 2 });
check(taken.send && taken.size * 0.15 <= 1.04 + 1e-9, 'takeBuyBudget will not spend more than free');

const cb = feeTier({ venue: 35, realized: 35, config: 40, fills: 20 });
check(cb.maker === 35 && cb.src === 'venue', 'a 35bp venue tier beats the 40bp config');
const cold = feeTier({ venue: 0, realized: 0, config: 40, fills: 0 });
check(cold.maker === 40 && cold.src === 'default', 'config is only the cold start');
const kraken = feeTier({ venue: 16, realized: 31, config: 16, fills: 20 });
check(kraken.maker === 31 && kraken.src === 'fills', 'kraken stays on the 31bp fills');
const stale = feeTier({ venue: 35, realized: 0, config: 40, fills: 0, stale: true });
check(stale.maker === 35 && stale.src === 'stale', 'a stale venue tier still beats config');

const src = fs.readFileSync(new URL('../src/bots/as/index.js', import.meta.url), 'utf8');
check(!src.includes('left * 0.9') && !src.includes('left*0.9'), 'the leftover 90% fallback is gone');
check(src.includes('BUDGET halve ') && src.includes('b=$') && src.includes('applyBudgetHalve'), 'the halve logs b and is applied to the budget');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('v14.1 ok');
