# Spec AS v3: as-cb cash budget, as-kraken fill rate and carry, P&L that reconciles

Status: **active**. Supersedes `15-spec-as-v2.md` (implemented in `f90f550` and `b6637c7`). Line numbers refer to `src/bots/as/index.js` at `b6637c7`. Check them before editing.

Design constants (unchanged): no hardcoded coin names (the scanner picks markets); post-only only; deposits and withdrawals are capital, never P&L; open book ≈ 90% of equity when order criteria are met; venue max leverage on Kraken with the v1/v2 rails.

## Post-mortem of v2 (observed Oct 12, 2026, 7:14 AM to ~5:05 PM PT)

v2 worked where it was aimed: the reduce-only unwind fired (`RAIL margin-cut ml=199.55` at 7:40 AM PT, RENDER and part of AAVE sold maker within a minute) and the margin level recovered. What is left:

- **as-kraken fill drought**: 2 fills at 7:40-7:41 AM PT, then **none for ~7h** until one AAVE buy at 2:44 PM PT, then 4 ALGO/AVAX fills at ~4:00 PM PT. 17 fills total since the v1 start. Every quote logs `half=26bp` (fee 16 + profit 10). `configs/as-kraken.env` sets `MIN_HALF_BPS=60` / `MAX_HALF_BPS=200`, but the status line shows 26bp, so either the env knob is dead or the log is wrong. Settle that.
- **One fill pushes it onto the rail**: the single 0.0508 AAVE buy at 159.74 (~$8.11 notional at 5×) dropped ml from ~466% to ~284%. It has been on `railMode=stop` since, ml 272-286, `book=176%` of equity, holding AAVE long 0.0768 (~$12.4 cost) and ALGO long 71.4 (~$8.6 cost) on $11.98 equity.
- **Carry**: `fundingBorrow=$0.56` on ~$12 equity (~4.6% in under a day). Nothing in sizing or hold time looks at it.
- **P&L does not reconcile (kraken)**: `adj=-0.30` vs `maker -0.02 − fees 0.42 + inv −0.45 − fund 0.56 = −1.45`, a residual of +$1.15. The hourly `RECON` was −0.26…−0.42 all day and jumped to **+1.09** at 4:25 PM PT, right after the ALGO/AVAX round trip. Likely cause: `pollTransfers` (lines 255-272) adds `abs(min(0, amount))` of every ledger row of type `margin` to `fundingBorrow`. On Kraken, `margin` ledger rows carry realized P&L on position close (and opening fees), not only funding, so losses on closed positions are counted as funding **and** in `inv`/`maker`, while gains are dropped. Rollover rows are correct carry.
- **as-cb cash starved**: `eq=$5.48-5.52 free=$0.69-0.75 book=18-20%` against the 90% target. **3,748 `INSUFFICIENT` buy rejects since restart, ~360 per hour** (more than the ~180 seen earlier), every hour flat. `state.orders` tracks 73 entries and `state.symbols` 29 names (mostly ladder leftovers: UP, SHDW, NEON, DRB, MNDE, etc. are just what is held, not a list to code in). Only 5 fills all day (MOODENG, LPT ×2, ...). It still places fresh buys (e.g. `BUY PLU 6.76 @ 0.14794 half=200bp`, ~$1.00) with $0.75 free.
- **as-cb RECON** steady at −$0.08/−0.09 all day, spread as −0.00/−0.01 across ~25 leftover names: rounding of tiny marks plus fees, but it never gets explained.

## P0-1: as-cb cash budget

Lines 895-905 subtract `restingBuyNotional` once, but buys are still sent far above free cash.

- One budget per loop: `budget = free_quote − Σ(resting buy notional incl. fee) − reserve(1% of equity, min $0.10)`. Every new buy decrements it **before** submit; a buy that does not fit is resized down to the venue minimum or skipped (logged once per loop as `SKIP <sym> budget`, not sent).
- Never submit a buy whose `price × size × (1 + fee)` exceeds the remaining budget. Target: **zero** `INSUFFICIENT` rejects in a normal hour; if one happens, re-read balances and halve the budget for 10 min.
- Priority while `free < 25% of equity`: no new buys on names with no position; spend only on the best one or two scanner names. Leftover asks first.
- Unwind leftovers near the touch: every held coin (scanner pick or not) gets a full-balance post-only ask at best ask, stepping toward one tick above best bid over ~2h if unfilled. Legacy lots use the bot-start mark as basis and the v2 24h decay to the touch; shorten that to 6h while free cash is below 25% of equity. Coins under the venue minimum stay in equity as `dust`, retried when price moves.
- Book target counts resting leftover asks + budgeted buys; with $0.70 free, the book reaches 90% through asks, not by stacking unfunded bids.

## P0-2: as-kraken sizing so one fill cannot trip the rail

- Before placing any opening order, compute the margin level **as if it and every other resting opening order filled**: `ml_after = equity / (used_margin + Σ notional_i / lev_i) × 100`. Only place it if `ml_after ≥ AS_MARGIN_LEVEL_RESUME` (350). Size down to fit; skip if below the venue minimum.
- This replaces `equity × leverage × 0.8` as the binding cap whenever it is tighter. Leverage stays the venue max per pair (the `levOk` map is fine); what changes is notional per clip. With ~$12 equity that is roughly ≤ $4-5 notional per opening clip, not ~$8.
- Count both sides: an opening bid and an opening ask on the same pair both use margin until one fills.

## P0-3: as-kraken fill rate

Investigate and log, then tune, in this order:

1. **Rail gating**: log once per loop which quotes were suppressed and why (`GATE <sym> <side> stop|cut|halt|budget|vol|carry`). During 7:41 AM - 2:44 PM PT ml was ~456% (above 350), so quoting should have been on. Confirm whether `onRail`/`cutLatch`/backoff (`state.backoff`, `stepAway`) kept sides off the book after the morning unwind.
2. **Width vs volatility**: log `sigma` (per-loop realized, bp) and the queue distance `|quote − touch|` in bp per side. If the half-spread is more than ~2× the measured 15-min move, fills cannot happen; then pick pairs (scanner) whose measured range covers `2 × (fee + profit)`. Do not lower the half below `fee + profit`.
3. **Fix the `MIN_HALF_BPS` / `MAX_HALF_BPS` env path**: either honour it or remove it from the env; the log must show the half actually sent.
4. **Pair choice**: rank scanner candidates by expected maker fills per hour at `fee + profit` width (recent trade count and range), not just 24h volume and touch spread. Keep `MM_MAX_PAIRS`.
5. Inventory skew: when holding a position, the exit side moves to the floor-respecting touch and the opening side widens (AS reservation shift), so inventory turns over instead of sitting.

## P0-4: carry cost in decisions (Kraken)

- Track carry per position from Kraken `rollover` ledger rows (and the opening fee), in $ and bp/hour of notional.
- Choose leverage and size with carry: expected hold time × carry rate must be < half of the profit bps; if not, drop to lower notional.
- **Max hold**: after `AS_MAX_HOLD_MIN` (default 240 min) a position's exit floor decays linearly from `entry + fee + profit` to `entry + fee + accrued carry` (break-even after carry) over the next 2h, then to the touch. Log `HOLD <sym> <min> carry=$x`.
- Prefer flattening: while a position is open, opening quotes on the same side are off; only the reducing side quotes.

## P1: P&L that reconciles

- Ledger parsing: only `rollover` rows (and margin opening/rollover **fee** fields) go to `fundingBorrow`. Kraken `margin` ledger `amount` (realized position P&L) must not be counted as funding; it is already in fills/`inv`. Fees: count each fee once (trade `fee` from fills; ledger `fee` only for rows that have no fill).
- Identity, both venues, every status line: `equity − startEquity − transfers = netMaker + inventoryPnl − fundingBorrow + residual`. Print `resid=` in the status line and in `/api/status`. Alert (once/hour log) when `|resid| > max($0.05, 1% equity)`.
- Define each term so it cannot overlap: `netMaker` = fill-price edge vs mid at fill minus fees; `inventoryPnl` = mark change on held inventory (incl. leftovers and margin positions) since fill or since start; `fundingBorrow` = carry only.
- Persist the components in `data/as-*.json` so the identity holds across restarts.
- Transfers stay venue-record only.

## P2

- Prune `state.orders`/`knownIds`/`exec` (kraken has ~1,740 entries) to open orders + last 24h.
- The deploy watch reads git on the server with `git -c safe.directory=/opt/crypto-mm` because of git's dubious-ownership check. If SuperGrok's deploy runs git as a user other than the repo owner, set `safe.directory` for that user (or `chown` the checkout) so `git pull` in the deploy does not fail silently.

## Acceptance

- as-cb: 0 `INSUFFICIENT` rejects per hour in steady state; free cash rising as leftovers sell; book ≥ 80% of equity within 24h, made of funded orders.
- as-kraken: no single fill takes ml below 300%; `GATE` reasons logged; at least several maker fills per active hour on chosen pairs while ml ≥ 350%; no position held past max hold + 2h without a resting exit at the touch.
- Both: `resid` within ±$0.05 (or 1% of equity) on every status line; `fundingBorrow` equals Kraken rollover/fee rows only.
