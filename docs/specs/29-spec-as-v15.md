# AS v15: as-cb book coverage at 41%, parked and sub-minimum holdings with no exit, as-kraken stuck at 2x, and stale transfer bookkeeping

This builds on v14.1, which is live on streambox as `85da4dc` ("Do not skip a Coinbase bid that is the clip after lot rounding"). Where they conflict, v15 wins. Line numbers refer to `src/bots/as/index.js` and `src/bots/as/quote.js` at `85da4dc`.

Design rules still hold:
- post-only maker orders only
- no hardcoded coins (the scanner picks the markets, and every rule below is per market from venue metadata)
- a book near 90% of tradable equity, not counting dust
- no loosening of the margin rails (`AS_LIFETIME_DD_PCT`, the day and session loss caps, the Kraken margin-level target in `krakenNotionalRoom`)
- the original ladder design: an inventory-skewed two-sided quote per name, with a cost floor on exits

## Symptom (Oct 20–21 PT, server logs in BST = PT+8)

**as-cb**, status line at about 1:30 AM PT Oct 21:

```
AS eq=$13.30 capital=$13.89 trading=$-0.60 (-4.3%) pending=$-2.64 (excluded) stopDist=20.7pp fee=35bp src=venue
lastFill=7h parked=1 $2.67 oldest=75h bidShare=38% free=$5.02 inv=$2.67 (1) dust=$3.47 (27)
fills=203/0 book=41% (ex-dust 55%) tracked=4 lev=3 xfer=pending $-2.64 idle=135m
BUDGET free=4.88 held=2.14 reserve=0.13 → b=7.15 slots=6 clip=$1.07
```

- Book coverage went from 74% to 41% over Oct 20, and there has been no fill since 6:29 PM PT Oct 20.
- Five of the seven tracked names have their bid held back by `max-dist`:

  ```
  GATE GTC buy max-dist need=110 dist_touch=2091 cap=150 spread_med=25
  GATE DOOD buy max-dist need=110 dist_touch=2136 cap=150 spread_med=17
  GATE USELESS buy max-dist need=110 dist_touch=941 cap=150 spread_med=10
  GATE ZRO buy max-dist need=110 dist_touch=366 cap=150 spread_med=10
  ```

- STRK (q=1.51) is parked. Its exit floor of 0.0735 sits about 17–18% above mid (`a1797bp`), and it has been held for 75 hours.
- $5.02 of cash is free, but only about $2.1 rests in bids.
- 27 dust holdings are worth $3.47 (26% of equity). One of them is LIGHTER: 0.31 coins, about $0.99, which is under the $1 venue minimum, so no exit can be placed for it.

**as-kraken** has been idle since 7:05 PM PT Oct 17 (`idle=7767m`):

```
AS eq=$9.73 capital=$12.28 trading=$-2.55 (-20.8%) stopDist=4.2pp fee=31bp lastFill=78h
bidShare=100% best=ALTHEA probation=1 free=$9.73 book=0% tracked=0 lev=2
ALTHEA half=bgate=min-size/agate=margin
SCAN reject STRK reason=min-gt-room min=$6.25 room=$5.40
SCAN reject AKT  reason=min-gt-room min=$5.90 room=$5.40
IDLE free=$9.73 (100%) reason=BLUR:vol,GOAT:vol,KAITO:vol,KAVA:vol
```

## Root causes

### R1 (as-cb): the bid budget counts held inventory as if it were resting asks

The budget block is at index.js 3282–3315. `tradableBookTarget` (quote.js 704) computes `bidRoom = 0.9 × (equity − dust − reserve) − askCover`. `askCover` adds up the **mark value of every inventory holding** (`countAskCover`, quote.js 1383), whether or not an ask is actually resting for it. A parked holding counts at half.

Inventory is not book. When an ask is gated or parked, its value still reduces the bid room. That cash then sits idle (`free=$5.02`) while the book is reported at 41%.

`book=` itself is calculated from resting orders, so the number the target is steered by and the number we report as coverage measure two different things.

### R2 (as-cb): the max-distance gate removes a name for the whole loop, and nothing fills its slot

`widenOpenDecision` (quote.js 630–655) measures the distance from our price to the **touch** (`dist_touch`) and compares it with `cap = max(150, spread_med/2 + need)`.

The logged distances (366–2136 bp) are far larger than `need + spread_med/2`, which is about 120 bp. A price placed at `mid − need` cannot be 2091 bp from the best bid unless the `mid` we used and the touch disagree. Either the mid is stale (it comes from the feed or the ring) or the touch is a thin or stale top of book.

In both cases the gate returns `px: 0`. The row is still counted in `slots`, its share of the budget is not given to another name, and no replacement name is pulled from the scanner. Each gated name therefore lowers coverage by one clip (about $1.07).

### R3 (as-cb): a parked holding has no exit path

`countAskCover` calls a holding parked when its cost floor is more than 5% above mid. Nothing then works it down. `gradualHoldExit` and `releaseStep` are reached only through the idle-release path, and `rel=$0.00 (0)` shows that path has released nothing in 75 hours. STRK is now 18% under its floor. Its ask is effectively never placed, so it adds neither fills nor coverage.

### R4 (as-cb): sub-minimum holdings are classed as dust and then ignored

`holdingClass` (quote.js 459) puts anything under `quoteMin` or `baseMin` into dust. `dustCanExit` (1303) then refuses an exit for it, and `dustTopupUsd` never runs because the name is no longer in a slot.

LIGHTER (0.31 coins, about $0.99) cannot be sold alone, and a small bid to bring it over the minimum is never placed. 27 such holdings tie up $3.47, about 26% of equity, which the 90% target simply drops from the base.

### R5 (as-kraken): the leverage ramp can never leave 2x

At index.js 3203–3211, when `lost` is true the code writes `state.levRamp = { step, lev, since: now }` **every loop**. The window then restarts each loop, so:

- the 2-hour positive step never comes due;
- the 6-hour idle notch needs `fillsSince === 0` over that window and never accrues;
- `lost` is based on trip history, and with no new trades it never clears.

The bot is therefore stuck at `lev=2` instead of venue max (`LEV_CAP` is `max`, so the ceiling is 10).

At 2x, `krakenNotionalRoom` gives about $5.40 of room. Every scanned name with a venue minimum above $5.40 is rejected (`min-gt-room`). ALTHEA, the one name left, fails `min-size` on the bid. Its ask is gated by `margin` because a short open also needs room, and the per-side `lossCap` is small with only 4.2 pp left before the lifetime stop.

This is a deadlock, not a halt. The bot is not stopped by the rails. It is stopped by a ramp bug that keeps it below the leverage the rails already allow.

### R6 (bookkeeping): a legacy pending of −$2.64 that can never settle, and stale halt fields

- **How book-transfer handles marks.** `book-transfer` already shifts `equityMarks`: `settleTransfer` calls `applyCapitalShift` (quote.js 1144), which shifts the marks, `startEquity`, `prevEquity`/`lastEquity` and the reset baselines. Commit `27406f8` is unrelated; it only restored the `formatPrice` export. The day-loss risk after a manual booking comes from two other gaps:
  1. **`haltEquity` is not cleared when a halt is cleared.** `clearLossHalt` sets it to 0, but the live state still holds `haltEquity=17.38` with `halted=null`, and `applyCapitalShift` keeps shifting that stale value. Any code that reads `haltEquity > 0` as "a halt reference exists" uses a number from before the $10.01 withdrawal.
  2. **The day window compares marks against `haltEquityNow`.** `haltEquityNow` is `equity − (pending − pendingShift)`. With the legacy pending below, that adds +$2.64 to one side only.
- **The −$2.64 pending.** `state.transferPending = { usd: −2.6368, since: 4:38 PM PT Oct 15 }` has no `id`, no `source`, and `pendingShift` is null. It was written by an older build before `openPending` stored those fields.
  - `settleTransfer` matches a pending only within 2% of its amount. The Oct 16 −$10.01 and Oct 20 −$1.00 bookings were too far off to match it, so it has stayed open for 5½ days.
  - Since `pendingShift` is null, the capital shift was never recorded as applied. The pending is "excluded" from trading P&L in the display, but `haltEquityNow` adds it back.
  - −$2.64 matches the STRK parked value on Oct 15 ($2.6–2.7) better than any ledger entry. It is most likely an unexplained-jump detection made while STRK's mark moved, not a real transfer.

## Fixes

### F1 (P0, as-cb): steer the book by what actually rests

1. In the budget block, replace inventory `askCover` with **resting ask notional** (the sum of `px × size` over our open asks), plus asks that this loop will place within the same per-name clip.
2. `bidRoom = 0.9 × tradable − restingAsks − restingBids(other names)`, capped by free cash minus reserve. Keep the v14.1 free-cash cap and the one-clip-per-loop rule.
3. Report the same number: `book=` and the target must use the same numerator (resting bids plus resting asks) and the same denominator (equity − dust − reserve). Add `cover=$X/$Y` to the `BUDGET` line.

### F2 (P0, as-cb): a gated slot goes back to the pool

1. Before `widenOpenDecision`, check that the mid is fresh: use the venue book's `(bid+ask)/2`, and only when it is no older than one loop. If the feed or ring mid differs from the book mid by more than `max(need, spread_med)`, use the book mid and log `MID stale sym src=… diff=…bp` once per symbol per hour.
2. If a name still gets `max-dist`, release its slot this loop: subtract it from `slots` and recompute `clip` over the names that remain.
3. If fewer than `fundedSlots` names can quote, pull the next scanner candidates (ranked by `rankByExpectedEdge`, excluding names on probation or cooldown) until the slots are filled or the candidates run out.
4. Do not raise `AS_MAX_QUOTE_DIST_BPS`. The cap stays, and the fix is to measure distance against a fresh mid.

### F3 (P1, as-cb): parked holdings get a stepped exit

1. If a holding has been parked for more than `AS_PARK_STEP_H` (default 6h), place its ask at `max(touchAsk, floor − k × step)`, post-only. `step` comes from `releaseStep`. `k` grows by one every `AS_PARK_STEP_H`.
2. Bound the loss with the existing `exitLossNotional` / `riskAllowsLoss`. The realized loss per step may not exceed `releaseWorstLoss`, and it may never push the account past the lifetime stop minus 2 pp.
3. A parked holding counts toward cover only through its resting ask (F1). Log `PARK step sym k=… px=… floor=… worst=$…`.

### F4 (P1, as-cb): sub-minimum holdings get a top-up so they can exit

1. For each holding with `0 < value < quoteMin` (or `qty < baseMin`) on a market the scanner still lists, place one post-only bid to bring it over the minimum, sized by `dustTopupUsd`, at the passive bid. This happens only when the topped-up position's expected exit at the floor is within `releaseWorstLoss`. After the bid fills, the holding is inventory and gets a normal ask.
2. Top-ups share the clip budget at the lowest priority, at most one per loop.
3. Holdings on delisted or unscanned markets, or where a top-up would cost more than the holding is worth, stay dust. List them in a `DUST list` line every hour (sym, qty, $) and leave them out of the target. This applies to LIGHTER only through the generic rule: no name is ever coded.

### F5 (P0, as-kraken): fix the ramp so the bot can trade at venue max inside the rails

1. When `lost` is true, keep the step but **do not** reset `since` every loop. Set `since` only when the step changes or when a new losing trip closes.
2. Raise the leverage notch based on how long the bot has been idle with no new losing trip, not on fills counted since a moving `since`. After `idleStepMs` (6h) with no new loss, step up one notch, up to `LEV_CAP` (venue max). Log `LEV idle notch Nx`.
3. Leverage changes only how much margin an order uses. `krakenNotionalRoom` still enforces the margin-level target (`stop × 1.2` or `resume`). The lifetime stop (25%), the day and session loss caps, and the per-side `lossCap` from `riskAllowsLoss` are unchanged.
4. When stopDist is under 5 pp, every opening side's worst-case loss (`orderWorstUsd`) must fit within `(stopDist − 1 pp) × capital`. If a minimum-size order cannot meet that, the gate is `stop-room` (a new explicit reason), not `min-size` or `margin`.
5. If every scanned name is blocked by `min-gt-room` for more than 6h, log `IDLE deadlock room=$X minMin=$Y lev=N` once per hour so the stall shows up in monitoring.

### F6 (P0, bookkeeping)

1. `clearLossHalt` and `controlResume` must clear `haltEquity`, `haltNotional` and `haltLossPlan`. `applyCapitalShift` must shift `haltEquity` only while `halted` is set.
2. **Migrate legacy pendings.** On load, a `transferPending` with no `id` gets `id='legacy-<since>'` and `source='legacy'`, plus `pendingShift` equal to the shift actually applied. The default is 0, because none was recorded.
3. **Settle or expire pendings.** A pending is checked against the venue ledger (Coinbase `transaction_summary` and the account ledger) every hour.
   - If a matching entry is found within 2%, book it.
   - If none is found after 72h, close it as `unexplained` and move the amount into an `unexplained` bucket. That bucket is shown in the status line (`unexplained=$-2.64`), and it is excluded from trading P&L and from every halt calculation.
   - The bot never pauses or halts because of a pending or unexplained amount.
4. **Day and session windows use transfer-neutral equity:** `equity − pendingOpen − unexplained`, on both the mark side and the current side. Add a unit test where a manual `book-transfer` of ±$X right after a mark leaves `day`, `session` and `lifetime` drawdown within 0.01 pp of their values before the booking.
5. The −$2.64 pending today: after deploying F6, the migration plus the 72h rule closes it as `unexplained` on the first loop, because it is 5½ days old. No manual `clear-pending` is needed. P&L stays real equity minus capital, with the unexplained amount listed separately.

## Acceptance criteria

as-cb, within 2h of restart:
- `book=` (ex-dust) is ≥ 85%, and it averages ≥ 88% over any 6h window while free cash exceeds one clip.
- The `BUDGET` line shows `cover=` consistent with the summed resting orders, within $0.05.
- No name holds a slot while gated by `max-dist` for more than one loop. When slots are short, logs show `SLOT release` and `SCAN pull`.
- `MID stale` fires only when the feed and book mids really disagree.
- Every parked holding older than 6h has a resting post-only ask with a `PARK step` log. Each step's worst-case loss is ≤ `releaseWorstLoss`.
- Every sub-minimum holding on a scanned market either gets a top-up bid within 6h or appears in `DUST list` with a reason.
- All orders are post-only. No coin names appear in code or config.

as-kraken, within 8h of restart:
- `lev` climbs above 2 by idle notches up to venue max (unless a new losing trip closes), and each notch is logged.
- It quotes at least one scanned name, or logs `stop-room` or `IDLE deadlock` with numbers.
- No order is sent whose `orderWorstUsd` would cross `stopDist − 1 pp`.
- Margin level stays ≥ the `krakenNotionalRoom` target. The rails are unchanged in config (diff of `AS_LIFETIME_DD_PCT`, `AS_DAY_LOSS*`, `AS_SESSION_LOSS*` and the margin target is empty).

Bookkeeping:
- After restart, `transferPending` is null, `unexplained=$-2.64` is shown, and trading P&L equals `equity − capital`.
- `haltEquity` is 0 whenever `halted` is null.
- A test `book-transfer` of +$1 and −$1, booked through the control file in a test harness and not live, leaves day, session and lifetime drawdown unchanged and trips no halt.
- No pause or halt is ever caused by a pending or unexplained amount.

Unit tests in `quote.js` for `tradableBookTarget` (resting cover), `leverageNotch` with `lost` and a fixed `since`, the pending migration and expiry, and `clearLossHalt` clearing `haltEquity`.
