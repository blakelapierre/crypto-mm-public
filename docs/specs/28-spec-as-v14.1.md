# AS v14.1: as-cb false `BUDGET bug`, oversized bids after the first clip, and a fee stuck on the default

Small fix on top of v14, which is live in `20bb670` ("Fix AS v14 live gates"). Where they conflict, v14.1 wins. as-kraken is unchanged except for the fee rule in C3, which must leave its live 31 bp untouched. Line numbers refer to `src/bots/as/index.js` and `src/bots/as/quote.js` at `20bb670`.

Design rules still hold: post-only maker orders only, no hardcoded coins, a book near 90% of equity (ex-dust), and no loosening of the margin rails.

## Symptom (since the restart at 6:32 PM PT Oct 17, about 1h of logs)

- **`BUDGET bug` logged 169 times in about 150 loops**, mostly for the names ranked last: DRV 78, NMR 37, EIGEN 23, ICNT 20, GTC 7, BLAST 3, ALEO 1. A typical loop looks like this: `BUDGET free=2.94 held=3.99 reserve=0.15 → b=6.93 slots=6 clip=$1.04`, then `BUDGET bug EIGEN b=$6.93`, `BUDGET bug DRV b=$6.93`, `BUDGET bug NMR b=$6.93`.
- **28 `INSUFFICIENT_FUND` rejects on buys**: ICNT 11, INDEX 6, GTC 4, EIGEN 3, BLAST 3, DRV 1. Every one of them is far above the logged clip:

  | Order | Notional | Logged clip | Free cash |
  |---|---|---|---|
  | `BUY ICNT 34.2 @ 0.1548` | $5.29 | $1.04 | $2.94 |
  | `BUY EIGEN 20.65 @ 0.2488` | $5.14 | $1.04 | ~$0.2–3 |
  | `BUY INDEX 10.761 @ 0.4028` | $4.33 | $1.06 | ~$3.8 |
  | `BUY BLAST 195138 @ 0.00002227` | $4.35 | $1.06 | ~$3.8 |
  | `BUY GTC 17.12 @ 0.2538` | $4.35 | $1.06 | ~$3.8 |

  Each reject logs `BUDGET halve <SYM>` and `BACKOFF <SYM> funds n`, and after the backoff the next try has the **same** size (ICNT tried 34.2, 34.1, 34.1, 34.4, 34.2, then 28.3–28.6).
- **Fee is still the default.** Every loop logs `FEE tier source=default venue and fills unavailable` / `fee=40bp src=default` (148 times since midnight server time). But `state.feeCache.makerBps = 35` was refreshed from `transaction_summary` at 7:28 PM PT, and `state.feeSamples` holds 20 maker fills that paid **35.0 bp** (all 90 maker fills in `logs/fills-as-cb.jsonl`: $0.642 fees on $183.31 notional = 35.0 bp).
- State at 7:29 PM PT: equity $14.52 against $14.89 capital (−$0.37 real), 6 fills since the restart, book 61% (75% ex-dust), `free=$3.77`.

## C1 + C2 (P0): one root cause behind both the false alarm and the oversized bids

### What happens

`20bb670` removed `budget.slots = slots - 1` from the per-row Coinbase sizing, but kept computing each row's clip from the **remaining** budget divided by the **full** slot count (index.js 2125–2134):

```js
wantUsd = slotClipUsd({ budget: left, slots, venueMin: minUsd });          // left shrinks every row
if (!(wantUsd + 1e-9 >= minUsd) && left + 1e-9 >= minUsd) wantUsd = Math.min(left, Math.max(minUsd, left * 0.9));
```

Walk through the 6:47 PM PT loop (`b=6.93 slots=6`):

1. First funded row: `6.93 × 0.9 / 6 = $1.04`. That is the logged clip, and the row takes about $1.04.
2. Second funded row: `left = 5.89`, so `5.89 × 0.9 / 6 = $0.88`. That is under the $1 venue minimum, so `slotClipUsd` (quote.js 970–976) returns **0**. The fallback on line 2133 then sets `wantUsd = max(1, 5.89 × 0.9) = $5.30`. This is ICNT's `34.2 × 0.1548 = $5.29`.
3. `takeBuyBudget` (index.js 2395, quote.js 239) caps only at `budget.left` ($5.89), so the $5.30 order passes. `budget.left` drops to about $0.57.
4. Every later in-slot row (EIGEN, DRV, NMR) now has `left < $1`, so `wantUsd = 0` and `buySz = 0` at line 2144, **with no gate set**. At 2457–2468 the catch-all sees no gate, compares `budget.start` ($6.93, the budget before any row spent it) with `minUsd`, and logs `BUDGET bug`.

Three things make the oversized order fail at the venue instead of being caught:

- **Locked cash is counted as spendable.** `budget.start` is `min(bidRoomShare, cash + heldBuys)` (index.js 3199–3202), so it includes cash locked in other rows' resting bids (`held=3.99`). A row's resting bid is deducted only when that row is reached (2414–2416, 2491–2494). A row sized earlier in the loop can spend cash that a later row's resting bid holds. `budget.freeRoom` (2391) is real free cash, but it is only used for the `grow` decision (2393), never as a cap.
- **`BUDGET halve` does nothing on Coinbase.** On `funds`, syncSide sets `state.budgetHalveUntil` and halves `budget.left` (1679–1687). Next loop, `cashBudget(... halve)` at 3173 is **overwritten** by `bidRoomShare` at 3199, so `b` stays at $6.93 and the same $5.30 clip comes back after every backoff.
- **The deferred-buy reload (3242–3246) re-derives `budget.left` from `cashBudget`.** That path skips the slot clip entirely, so any buy deferred after a shock can also be sized above the clip.

### C1 (P0): the `BUDGET bug` alarm is mostly false, but it points at the real bug in C2

The alarm fires because the check uses `budget.start` while sizing used the depleted `budget.left`. It is false in the sense that nothing is mis-sized for those rows: the budget really was spent, just wrongly (on one oversized ICNT bid). Fix:

1. Every path that leaves `buySz = 0` on Coinbase must set an explicit gate:
   - `budget-spent left=$X clip=$Y` when the loop's budget is used up by earlier rows (`left < minUsd`).
   - `free-cash free=$X need=$Y` when the free-cash cap (C2) blocks it.
   - `max-q` when `q >= MAX_Q` (line 2144), and `no-bid` when `bidPx <= 0`.
2. Keep `BUDGET bug`, but make it compare `budget.left` (not `budget.start`) and fire only when `left >= clip`, `free >= clip`, the row is in a slot, and no gate is set. That should never happen after C2. If it does, log it once per symbol per hour with `left`, `free`, `clip`, `wantUsd`, `q` and `bidPx`, not every loop.
3. `budget-spent` and `free-cash` must not pull an existing resting bid. Treat them like `budget` on line 2489.

### C2 (P0): every Coinbase bid goes through the clip and the free-cash cap

1. **One clip per loop.** Compute `budget.clip = slotClipUsd({ budget: budget.start, slots, venueMin })` once at 3206 and store it on `budget`. Each row's `wantUsd = min(budget.clip, budget.left, budget.free)`. Never divide the remaining budget by the full slot count again.
2. **Delete the 90% fallback on line 2133.** When `budget.clip < minUsd` but `budget.start >= minUsd`, the clip is exactly `minUsd` (one minimum-size order), never `left × 0.9`. `fundedSlots` already guarantees `clip >= venueMin` whenever `b × 0.9 >= venueMin`.
3. **Free-cash cap.** Add `budget.free = book.cash − reserve` (venue-available cash; Coinbase `available` is already net of resting orders). It is decremented by every new order's `cost` (size × px × feeMul). A **resize or replace** of an existing order may use `free + that order's own notional`, because the cancel releases it, but only when the cancel is confirmed before the new order is sent. Otherwise cap at `free`. Pass `free` into `takeBuyBudget` as a second ceiling (`room = min(left, free + curNotional×mul)`), and remove `curNotional: 0` at 2396 so the existing order's cash is counted the same way in both places.
4. **Reserve resting bids up front.** Before the row loop, subtract every resting bid we intend to keep (not pulled, same price within 15 bp) from `budget.left`, so row order cannot let one row spend another's locked cash. Then skip the per-row `curN` deductions at 2416 and 2494 so nothing is counted twice.
5. **Same rules on every send path:** fresh orders, requotes in `syncSide`, `grow`, dust top-ups, and the deferred-buy loop at 3240–3247. The `budget.shocked` reload must reapply `clip` and `free`, not just `cashBudget`. As a final guard, syncSide (1625–1636) must skip any buy whose `cost > min(budget.clip, free + own) + 1e-6` and log `SKIP <SYM> clip need=$X clip=$Y free=$Z`.
6. **Make the funds backoff real.** On an `INSUFFICIENT_FUND` reject:
   - Invalidate the cache and refetch balances before the next buy in the same loop (already done in the deferred loop; do it in the direct path too).
   - Set `state.budgetHalveUntil` (10 min) and apply the halve **after** `bidRoomShare` at 3199–3202, so it actually lowers `b`.
   - Re-arm the symbol's backoff as now (20/40/80/160 s).
   - The next attempt for that symbol must be no larger than `min(clip, free)` at the time. If a second funds reject hits the same symbol within the halve window, size it at `minUsd` only until a buy fills or the window ends.
   - Log `BUDGET halve <SYM> b=$X→$Y free=$Z`.
7. **Book target is unchanged.** The bids still aim for the 90% ex-dust book through `bidRoomShare`/`fundedSlots`. This change only stops one row from taking the whole remainder. With the 6:47 PM PT numbers, the six slots should rest about 6 × $1.04 bids across six names, not one $5.30 bid and five gates.

## C3 (P1): Coinbase fee stuck on the 40 bp config default

### What happens

`loadMakerFee` (index.js 417–481) gets `venueBps = 35` from `transaction_summary` (`state.feeCache.makerBps = 35`) and `realized = 35.0 bp` from 20 fee samples. It then calls `feeTier({ venue, realized, config: FEE_BPS, fills })` (quote.js 1424–1433), which takes **`Math.max(venue, realized, config)`**. `FEE_BPS` is `MAKER_FEE_BPS=40` from `configs/as-coinbase.env:54` (index.js 47), so the config wins, `src = 'default'`, and the log falsely says "venue and fills unavailable".

The as-kraken fix in `20bb670` worked only because Kraken's real fee (31 bp) is **above** its 16 bp default. On Coinbase, the real fee is **below** the default, so the max keeps the default. Because `feeSource === 'default'`, the main loop (2921) also re-runs `loadMakerFee` every loop instead of hourly.

Effect: every edge and floor uses 40 bp instead of 35. That means a round-trip need of 2×40+8 = 88 bp instead of 78 (`SCAN reject SAND reason=tick val=16.9 need=88.0 fee=40.0`). It also means cost floors (`costFloorPx` at 3186, `roundTripFloorPx` at 2095/2439) and release floors are about 10 bp higher than needed, and the edge rank and `best=` are understated.

### Fix

1. Change `feeTier` precedence:
   - If the venue tier is known (fresh or stale ≤ 24h), `maker = max(venue, realized)`.
   - If only fills are known (≥ 5 maker samples), use `realized`.
   - Use `config` **only** when neither exists.
   - `src` is `venue`, `fills`, `stale` or `default` to match.
   - Keep the `FEE drift` override (realized > venue + 3 bp, n ≥ 10 → use realized). This keeps the bot conservative when the venue under-reports, and it is what holds Kraken at 31 bp.
2. Keep `MAKER_FEE_BPS` in the env as the cold-start fallback only. Do not edit the config value, and add no per-coin fee constants.
3. Only print `FEE tier source=default venue and fills unavailable` when `venueBps == 0` **and** `realized.n < 5`. Otherwise print `FEE tier maker=35.00bp ... src=venue` (or `fills`).
4. Once `src` is not `default`, the main-loop refresh goes back to hourly (or `FEE_TIER_MS`).
5. Every consumer must use the live `makerFeeBps`: status (`fee=`/`src=`), `costFloorPx`, `roundTripFloorPx`, `edgeGate`, `feeMul` in budget math, the scanner `need`, release floors, and `PAIR` lines. Existing `state.entry` cost floors are recomputed from entry price plus the live fee on the next loop. No stored floor keeps 40 bp.
6. **Safety.** If the live fee would *drop* by more than 15 bp at once, log `FEE drop old=X new=Y src=...` and apply it, since it comes from the venue or fills. The floor never goes below `entry × (1 + 2×fee + MIN_EDGE)`, so every exit stays fee-positive.

## Tests (`scripts/test-as-v14.mjs` or a new `scripts/test-as-v14-1.mjs`)

- `slotClip` stays the same across rows. With `b=6.93, slots=6, venueMin=1` and six in-slot rows, each row gets $1.04 (±lot rounding), and no row gets more than the clip.
- `free` cap. With `b=6.93, free=2.94` and one resting $1.04 bid kept, at most two new $1.04 bids are sized, and the rest gate `free-cash`. No order is ever above `min(clip, free + own)`.
- Small budget. With `b=1.30, slots=1`, the clip is $1.17 and there is no `left×0.9` path. With `b=0.95`, nothing is sized and the gate is `budget-spent`.
- Halve. After a funds reject, the next loop's `b` is ≤ 50% of the pre-reject `b`, and the same symbol's next size is ≤ the new clip.
- `feeTier({ venue: 35, realized: 35, config: 40, fills: 20 })` gives `{ maker: 35, src: 'venue' }`. `feeTier({ venue: 0, realized: 0, config: 40, fills: 0 })` gives `{ maker: 40, src: 'default' }`. `feeTier({ venue: 16, realized: 31, config: 16, fills: 20 })` gives 31 `fills` (Kraken unchanged).
- Run the smoke test before restarting, as v12 requires.

## Acceptance (first hour after deploy, from `journalctl -u crypto-mm-as-coinbase` and `/api/status`)

1. `grep -c "BUDGET bug"` = **0**. Every gated in-slot name shows a specific reason in the `AS` status line (`bgate=budget-spent`, `bgate=free-cash`, `bgate=slots`, `bgate=max-q`), not a bare `bgate=budget` with a `BUDGET bug` line.
2. `grep -c INSUFFICIENT_FUND` on **buys** ≤ 1 per hour, and never two in a row for the same symbol.
3. Every `BUY <SYM> size @ px` line on as-cb has `size × px ≤ clip × 1.02`, where `clip` is from the `BUDGET ... clip=$` line of the same loop. There are no buys over $1.50 while `clip ≈ $1.04–1.10`.
4. The `BUDGET` line shows `free=` and the new `clip=`, and the sum of new bid notional in a loop is ≤ `free` at the start of that loop.
5. After a funds reject, `BUDGET halve <SYM> b=$X→$Y` shows Y ≤ X/2, and the next `BUY <SYM>` is ≤ the halved clip.
6. `FEE tier maker=35.00bp ... src=venue` (or `src=fills`) at startup. The status line shows `fee=35bp src=venue` (or `fills`), and `FEE tier source=default` appears **0** times while `transaction_summary` succeeds. `SCAN reject ... need=` shows 78.0, not 88.0. `/api/status` `feeTier` (or the bot's `feeBps`/`feeSrc`) reads 35 / `venue`.
7. Existing parked floors come down by about 10 bp on the next loop (for example the STRK floor 0.07975 drops by about 0.1%). No order is ever placed below its entry plus the round-trip fee.
8. as-kraken still logs `maker fee 31.xx bp source=fills` (or `venue`). It must not drop to 16.
9. Book: within an hour, as-cb rests bids on most slotted names at about the clip, and `book=` (ex-dust) trends toward 90% instead of sitting at 61–75% with one oversized bid rejected.
