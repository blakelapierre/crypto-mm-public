# Spec AS v11: Kraken orders that fit the minimum, Coinbase book and residual, post-only retry direction

Status: **active, addendum to `23-spec-as-v10.md`** (`0aab022`). The live server is on `ac2fbb3` (v7–v9 = `9ac2f62`, JWT `4bac663`, pending day-loss fix `ac2fbb3`), deployed ~4:03–4:13 PM PT Oct 15. **v10 is not deployed yet.** Implement v10 + v11 together; where they conflict, **v11 wins**. Line numbers are from `ac2fbb3`.

Design constants (unchanged): original Avellaneda-Stoikov design; no hardcoded coin names; post-only maker only, never market orders; deposits/withdrawals are capital, never P&L; **unknown money is flagged, never pauses trading**; open book ≈ 90% of ex-dust equity; Kraken max leverage with rails (v9 ramp); kill switch 8% session / 12% day / 25% lifetime; no secrets in repo or logs.

## What of v9 landed (checked on `ac2fbb3`)

Landed: lifetime line (`life=$9.65 vs $12.28 (-21.5%)`), `lev=2` ramp start, expected-edge `SCAN best` lines and a wider Kraken universe (`rejected=488..536`), `SCAN reject` lines on Coinbase, `idle=` field, `TRANSFER inferred` path, round-trip floor/cooldown code.
Not working as intended: (a) Kraken names are picked but never quoted (P0-1 below, plus v10 P0-1 for the `vol` gate); (b) Coinbase still ranks by quoted touch spread (`rankByNetEdge`), not expected edge (v10 P0-2 covers it); (c) the status/dashboard `life=` on as-cb includes an unexplained residual (P0-3).

## Observed (Oct 15, 4:15–7:30 PM PT)

- **as-kraken:** `eq=$9.65 free=$9.65 book=0% tracked=0 lev=2 idle=148m`. Scanner picks PUFFER/ANIME (earlier POND/ARX, ZK best at `exp_edge=34.3 need=40.0`). Gates over 3h: `GATE ANIME buy/sell budget` (15), `PUFFER buy/sell budget`, `POND budget`, `ARX buy carry`, `ANIME buy vol`. No order sent since 7:30 AM PT.
- **as-cb:** 15+ AERGO fills 4:22–4:46 PM PT, then `no names`. Every candidate `SCAN reject <sym> reason=fee-spread val=3..9 need=72.0`. Status: `eq=$25.63 free=$21.96 life=$28.27 vs $24.90 (+13.5%) maker=$1.33 fees=$0.44 dust=$2.68 (29) resid=$2.30 xfer=pending $-2.64 book=0%`.
- `RECON drift parts=resid=2.30 … markout5=-72.0` at 6:25 PM PT (was `resid=-0.07` at 5:24 PM PT).
- Coinbase 401s: `GET /v2/accounts` (every start) and once `GET /api/v3/brokerage/transaction_summary` (fee tier) at 5:03 PM PT; v3 accounts work.
- AERGO post-only rejects: `LIMIT FAIL … buy @ 0.020496 INVALID_LIMIT_PRICE_POST_ONLY`, then `post-only retry buy 0.020496 -> 0.020726` which also failed; sell `0.020501 -> 0.020013` also failed.

## P0-1: Kraken "budget" gate with all cash free (root cause)

The Kraken opening size goes through three cuts in `quoteSymbol`, and none of them knows the venue minimum until the end:

1. `clip = clipFor(equity, lev)` with `CLIP_MAX_USD=1.5` in `configs/as-kraken.env`, then `Math.min(clip, liqNotionalCap)` → ~$1.5 per side.
2. `exitLossNotional` (1.5% of equity ÷ (2×fee + σ·√(240/15))): at PUFFER σ≈94bp that is $9.65×0.015/0.0408 ≈ **$3.5**.
3. The margin rail `fitOpeningPair` uses `room = equity / (AS_MARGIN_LEVEL_RESUME/100) = 9.65/3.5 ≈ $2.76` of margin, split by `rail.margin.slots` (2 names × 2 sides) → ~$1.38 margin → **~$2.8 notional per side at the 2× ramp**.

Then `if (!(fit.buy >= max(minUsd, ordermin × px))) gate('buy','budget')`. Kraken minimums (`ordermin × px`, `costmin`) on the picked pairs exceed the ~$1.4–2.8 left, so every side is zeroed and labelled `budget`. Any other zeroing that sets no label also falls through to the catch-all `gate('buy','budget')`, so `budget` hides the real cause.

Spec:
- **Remove `CLIP_MAX_USD` for Kraken** (or ignore it when `VENUE==='kraken'`). Size comes from the margin rail, the exit-loss cap and the 90% book target only.
- **Slots = names that can actually meet the minimum.** Before splitting margin room, compute each picked side's minimum notional (`max(costmin, ordermin×px)`). Allocate room to sides that fit, best `exp_edge` first; a side that can't fit releases its share to the others. If no side can fit at the current ramp leverage, quote **one** side (the better one) at exactly the minimum if margin room × lev ≥ minimum.
- **Margin room uses the ramp leverage directly:** at lev L, total opening notional ≤ equity × L × 0.9 (book target), while margin level after fill stays ≥ `AS_MARGIN_LEVEL_RESUME`. Log `SIZE <sym> room=$ min=$ lossCap=$ clip=$ fit=$` on each gate change.
- **No catch-all label.** Every zeroed side records the specific cause: `min-size`, `margin`, `loss-cap`, `carry`, `vol`, `edge`, `cooldown`, `halt`. `budget` is only for Coinbase cash budget.
- If the exit-loss cap is below the venue minimum for a name, the scanner must drop that name (`SCAN reject reason=min-size`) and pick the next, rather than holding a name it can't trade.

Acceptance: with equity $9.65, lev 2, two picked names and Kraken minimums of ~$5, at least one post-only order rests within 2 loops, or each name logs `min-size` with `room/min` values and the scanner swaps to a tradeable name; the string `GATE <sym> <side> budget` never appears for Kraken; unit fixture of the three cuts reproduces today's zeroing and passes after the change.

## P0-2: Coinbase fee hurdle and quoting wider (as-cb)

`need=72.0` = `2 × fee + AS_MIN_EDGE_BPS` applied to the **full quoted spread** in `rankByNetEdge` (edge = spread − 2×fee). That is a correct round-trip test for quoting at the touch, not a double count, but it is the only test, so a 3–9bp touch spread is always rejected.
- Use the **actual maker fee** from `transaction_summary` (logged 35bp at one start, 40bp at another after the fee-tier 401). Cache the last good tier in state; on a 401/failure keep the cached value and log `FEE tier stale since=…` instead of falling back to a default. Print `fee=` with its source in `SCAN` lines.
- Implement v10 P0-2 (`rankByExpectedEdge` for Coinbase). A name with σ-based expected half ≥ round-trip pad is tradeable by quoting at `mid ± pad` even when the touch is tighter, with size scaled by fill probability.
- Acceptance: `SCAN reject … need=` equals 2×(current fee)+edge with fee source shown; with ≥ $10 free and any name whose expected edge > 0, as-cb has ≥ 2 bids within 15 min of start (or `SCAN reject` lines for each top-20 name with `exp_edge`); ex-dust book ≥ 80% of the 90% target within 1h when ≥ 2 names qualify.

## P0-3: residual is not profit (as-cb)

`life=$28.27 vs $24.90 (+13.5%)` while `maker−fees ≈ +$0.89`. The gap is `resid=$2.30` plus `xfer=pending $-2.64` being netted into the left side. The $19.18 deposit is correctly booked (`TRANSFER inferred $19.18`, baseline $24.90).
- `life` P&L = realized + unrealized trading P&L (maker capture − fees + inventory MTM change) only. **Residual and pending are shown separately and excluded from the percentage**: `life=$X vs $base (+p% trading) resid=$r pending=$q`.
- A negative pending (`xfer=pending $-2.64`) must be explained: either a withdrawal/fee row, or dust revaluation. Log `TRANSFER pending sign=- source=<dust-mark|fee|unknown>`. Dust MTM swings must go into a `dust` P&L bucket, not resid.
- Unknown money still never pauses trading (v7).
- Acceptance: with today's numbers, as-cb shows `+≈3.6% trading` (≈$0.89 on $24.90), not +13.5%; resid/pending appear as separate fields on status, API and dashboard; `RECON drift` resid stays < $0.25 when no transfer occurs, or the bucket it moved to is named.

## P0-4: post-only retry must move away from the market

`src/shared/exchange.js` retry uses `bookSnap.bid − inc` / `bookSnap.ask + inc` from a snapshot taken before the order. When the book moved, the "retry" was **more aggressive** (buy 0.020496 → 0.020726, sell 0.020501 → 0.020013) and was rejected again.
- Fetch a fresh best bid/ask for the retry. Buy retry = `min(original, freshBid) ` snapped **down** to the increment (one tick below the fresh best ask if bid==ask−tick); sell retry = `max(original, freshAsk)` snapped **up**. Never retry at a price more aggressive than the rejected one.
- After 2 rejects on a side in 5 min, back off that side for one loop and log `POSTONLY backoff <sym> <side>`.
- Acceptance: unit test where the book moves up between snapshot and retry: buy retry ≤ original; live, no AERGO-style double reject with retry price beyond the original.

## P1-1: Coinbase v2 401 (reiterates v10 P0-3)

v2 `/v2/accounts` 401 is a key-scope issue, not the JWT (v3 works after `4bac663`). Stop calling v2 after the first 401 per process (`TRANSFER scope v2=denied`), rely on v3 balances + inferred transfers. Do not ask for new keys in logs. Acceptance as in v10.

## P1-2: 29 dust coins need exits or an explicit "stuck" list

Dust ($2.68 across 29 coins) has no orders. For each: if `qty ≥ baseMin` and `qty×px ≥ quoteMin`, place a post-only ask at max(cost floor, touch). Otherwise list it once an hour as `DUST stuck <sym> qty usd need_topup=$x` and topup only when free cash > ex-dust book target (v6 topup), at most 2 per hour. Dust stays out of budget and book math.
Acceptance: an hourly `DUST stuck` summary with count and $; every dust coin that meets venue minimums has a resting ask within one loop.

## P1-3: v9 lifetime rail sanity (as-kraken)

as-kraken is at −21.5% life vs the 25% rail. Confirm the rail fires on MTM equity (not cash) and requires the control file to resume; log `RAIL lifetime dist=<pp>` hourly when within 5pp.

## Out of scope / unchanged

v10 items (vol gate removal, slot math, v2 scope, JWT and pending day-loss fixes) stand unless changed above. Round-trip floor, churn cooldown, leverage ramp, halt de-lever/cap-exit, post-only only, no hardcoded coins, no secrets.
