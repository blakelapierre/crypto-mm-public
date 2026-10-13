# Spec AS v4: funding that is only funding, as-cb off the dust pile, as-kraken losses from fees and exits

Status: **active**. Supersedes `16-spec-as-v3.md` (implemented in `7b3547d`). Line numbers refer to `src/bots/as/index.js` at `7b3547d`. Check them before editing.

Design constants (unchanged): no hardcoded coin names (the scanner picks markets; any coin named below is only an example of what was held or traded); post-only only; deposits and withdrawals are capital, never P&L; open book ≈ 90% of equity (`BOOK_TARGET_FRAC`) when order criteria are met; venue max leverage on Kraken with the v1-v3 rails. Max leverage stays **available**; v4 caps how much of it a single quote may **use**.

## Post-mortem of v3 (observed Oct 12, 8:57 PM PT restart to Oct 13, ~1:00 AM PT)

v3 landed cleanly: no market orders, no `INSUFFICIENT` rejects, gate reasons logged (`GATE <sym> <side> <reason>`), hold-cap exits fired (AAVE/AVAX closed 9:03-9:09 PM PT), margin level 650%+ after. What is left:

- **as-kraken status at ~12:55 AM PT**: `eq=$11.55 adj=-0.73 maker=-0.02 fees=0.70 inv=+0.68 fund=0.79 resid=+0.11 fills=28/3 book=214% lev=10 ml=659`. The residual is back (+$0.11; it was $0.00 right after the restart) and `fund=0.79` is mostly not funding (P0-1).
- **as-kraken fills**: 61 lines in `logs/fills-as-kraken.jsonl`, all maker. Realized results are dominated by fees (~$0.025-0.027 per ~$8 fill, i.e. 31bp round trip) and two losing exits (RENDER unwind ≈ −$0.55 on Oct 12 ~7:43 AM PT, AAVE hold-cap exit ≈ −$0.20 on Oct 12 ~9:05 PM PT). Real carry is ≈ $0.015/day.
- **as-kraken half below floor**: status shows `AVAX half=20bp` while the env comment says the honored floor is 26bp (16 fee + 10 profit). `MIN_HALF_BPS` is now 26 in `configs/as-kraken.env`, so the v3 60-vs-26 mismatch is resolved, but the 20bp half means some path still bypasses `halfFor` (line ~113).
- **as-cb idle**: `eq=$5.59 free=$0.75 book=18% fills=9/0`, no fill since Oct 12 9:32 PM PT (DIA sell), at most one ~$1 bid. Since the restart the journal has **15,972 `GATE` lines: 9,998 `buy budget`, 5,124 `buy vol`, 425 `buy backoff`, 425 `sell backoff`**. `state.symbols` holds 29 names, almost all ladder leftovers in `state.belowMin` (dust) with no asks at all.
- **as-cb `sig=15bp` on ~15 of 29 names**: identical values look like a fallback, not a measurement; `buy vol` gates are decided on it.
- **as-cb fills logged twice, in two formats**: `logs/fills-as-cb.jsonl` (12 lines) and `logs/fills-as-coinbase.jsonl` (9 lines), and both bots' fill logs interleave JSON objects with positional arrays (`[3, …]`) and date markers (`[6,"2026-10-13"]`). Status says `fills=9`.

## P0-1: funding counts only funding (as-kraken)

Verified at lines 306-326 (`pollTransfers`): for ledger type `margin`, any `fee > 0` not matched by `feeAlreadyOnFill` is added to `fundingBorrow` and attributed as carry. `feeAlreadyOnFill` (line 268) requires an **exact** fee match within **180s**; Kraken books the margin-row fee under a different rounding and often outside that window, so most margin fees fall through. Every step of `fund` lines up with a fill, not with the 4-hour rollover schedule:

| When (PT) | Actually | Amount |
|---|---|---|
| Oct 12 2:54 AM | early fill fees | $0.01 |
| Oct 12 7:43 AM | RENDER unwind loss (realized P&L booked as funding) | $0.55 |
| Oct 12 9:03-9:10 PM | AAVE/AVAX close + reopen fees | $0.11 |
| Oct 12 11:28-11:33 PM | ADA close + reopen fees | $0.08 |
| Oct 13 12:25-12:41 AM | AVAX fill fees | $0.08 |
| Oct 12 8:57 PM restart | v3 re-count trimmed old total | −$0.04 |

The per-coin `state.carry` totals equal the fill fees for those coins. Real borrow cost at Kraken's usual 0.02% open + 0.02%/4h on ~$12.60 average borrowed is ≈ **$0.015/day (~0.13% of equity)**, ≈ $0.04 so far.

Fix:
- `fundingBorrow` = sum of **`type=rollover`** ledger rows only (amount + fee, once).
- `type=margin` rows: dedupe against fills by **`refid` / `ordertxid` → fill `orderId`** (keep a map from the fills log), never by fee value or time. A margin-row fee that matches a fill is already in `fees`; one that matches no fill after 10 min is logged `LEDGER orphan <refid>` and counted in `fees`, not funding.
- Margin-row `amount` (realized P&L on close) goes into price / inventory P&L, not funding.
- Append every raw ledger row (all types, id + full row, no keys) to `logs/ledger-as-kraken.jsonl`, once per id.
- At startup, **recompute** `fundingBorrow`, `state.carry` and fees from `ledger-as-kraken.jsonl` + the fills log rather than trusting the persisted totals in `data/as-kraken.json`.
- Identity must hold every loop: `maker + inv − fees − fund = Δequity − transfers`, `|resid| ≤ $0.02`; log `RECON` hourly with each part.
- Carry in sizing (`notionalForCarry`, `GATE … carry`) uses the rollover rate only. Today `GATE AVAX sell carry` / `GATE AAVE sell carry` fire on an inflated carry figure.

Acceptance: `fund` ≈ $0.04-0.05 after restart recompute; it only steps on rollover timestamps (every 4h per open position).

## P0-2: as-cb unwinds leftovers and fills the book

Verified:
- `markDust` (line 464) is called on any `below-min` reject (line 690) and on long positions at line 900/923; once in `state.belowMin` a name gets no ask until price moves >1% from the mark at which it was marked (line 921). 28 of 29 held names are in this state.
- `cashBudget` (quote.js) = `free − restingBuyCost − max(1% equity, $0.10)`. Coinbase's `available` balance **already excludes funds on hold for open buys**, so resting buys are subtracted twice. With `free=$0.75`, one ~$1 resting bid and the $0.10 reserve, budget is $0 → the 9,998 `buy budget` gates. `CLIP_MAX_USD=1` also caps each clip at $1.

Fix:
- Classify each holding by `qty × mid` vs the venue minimum notional (and base min size, rounded to the lot): **above min = inventory**, below min = **dust**. Only dust goes to `belowMin`; drop the "price moved 1%" re-check for inventory.
- Every inventory holding gets a full-balance post-only ask at the best ask (one tick inside if spread allows), stepping toward one tick above best bid over the hold cap (`AS_MAX_HOLD_MIN`, default 240 for legacy lots), then resting at the touch. Exit floor above entry does not apply to legacy lots (basis = bot-start mark).
- Status line: `dust=$X (n)` included in equity, plus `inv=$Y (n)` for unwinding holdings.
- `cashBudget`: on Coinbase use `available` as-is (do not subtract resting buys again); on Kraken keep the subtraction only if the venue figure does not already net holds. Log `BUDGET free=… held=… reserve=… → b=…` once per loop.
- Sizing: book target 80-90% of equity = resting asks (inventory) + bids. Spread freed cash over up to `MM_MAX_PAIRS` scanner names, clip = `min(budget / names_without_bid, max(CLIP_MAX_USD, venue min × 1.2))`. `CLIP_MAX_USD` becomes a floor-aware cap, not a hard $1.
- Fix the `sig` fallback: if a name has fewer than N mid samples, gate as `vol-warmup`, do not substitute 15bp and then gate on it.

Acceptance: within 2h of restart, `book ≥ 80%`, every non-dust holding has an ask, ≥ 2 names with bids when free cash allows, zero `INSUFFICIENT`.

## P0-3: as-kraken losses come from fees and exits, not carry

Investigate first (log, then tune):
1. **Adverse selection**: for every fill record mid at +1, +5, +15 min (`markout_bp`, signed in our favour). Summarise per pair and per side hourly. If 5-min markouts average worse than −(half-spread), the half is too tight for that pair or the quotes are getting picked off.
2. **Width vs volatility**: half today ranges 20-165bp with `sig=7-11bp`. Make the half adaptive: `half = max(fee + profit, k × sigma_15m, ½ touch spread)` with `k` from config (start 1.5), and log `half_src=floor|vol|touch`. Never below `MAKER_FEE_BPS + AS_PROFIT_BPS` (fix the 20bp AVAX case).
3. **Size by exit loss**: before placing an opening clip, compute the loss of a hold-cap exit `= notional × (2 × fee + expected adverse move over AS_MAX_HOLD_MIN)` using measured sigma × √(hold/15m). Size so that loss ≤ `AS_MAX_EXIT_LOSS_PCT` of equity (default 1.5%). Venue max leverage stays set on the order; this caps notional, so leverage is available, not always used. Log `SIZE <sym> lev=max used=<x> cap=vol|margin|exit`.
4. **Gradual hold-cap exit**: today `holdExitPx` jumps from the floor to the touch when age > `AS_MAX_HOLD_MIN`. Step instead: from 0.75 × hold cap start moving the exit from `entry + fee + profit` toward breakeven, then toward the touch in steps of ¼ half-spread per 15 min, crossing breakeven only after the hold cap. Never cross the spread (post-only).

Acceptance: hourly report shows fees, markouts and exit P&L per pair; a single fill cannot create a position whose forced exit loses > 1.5% of equity.

## P1

- **Fill logs**: one file per bot (`fills-<BOT>.jsonl`), one JSON object per line; stop writing positional arrays and date markers into it (move them to a separate compact log if needed). Merge/retire `fills-as-coinbase.jsonl`. Status `fills=` must equal the line count since start.
- **Markouts** written into the fill row when known (`m1`, `m5`, `m15`), and into a `markouts-<BOT>.jsonl` summary.
- **Kraken residual** +$0.11 at 12:55 AM PT must be explained by P0-1; if not, log the parts that disagree.
- **Min half honored everywhere**: one function decides the sent half; status line prints the half actually sent (`sentHalfBps`).
- **Hourly `RECON`** for both bots with `dust`, `inv`, `fund`, `fees`, `markout5`.

## Out of scope / unchanged
Post-only only; no coin lists; transfers only from venue ledger records; kill switch 8% session / 12% day; margin rails 300/200/150, resume 350.
