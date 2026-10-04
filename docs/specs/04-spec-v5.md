# crypto-mm ladder: spec v5 (Oct 4, 2026, 7:18 AM PT)

**Status:** commits `de867b7` and `d845396`. The bot restarted at 7:07:08 AM PT. At 7:18 AM PT equity was $12.36: cash $5.82, coins $6.54 (53%, including the orphan PLU $1.39). 26 fills, 0 market orders sent (9 attempts blocked by `ALLOW_MARKET_EXIT=0`).
**P&L before the glitch (7:16 AM PT):** wallet −$0.124 = price −$0.078 + maker −$0.002 − fees $0.077 + gap +$0.033. **Maker capture is about 0** (median −0.9 bps against the stamped mid). Fees are still estimated at a flat 35.0 bps, which leaves no edge.
**Critical new bug:** at 7:16:36 AM PT equity briefly read $11.34 (coins valued at $1.51). At 7:17:06 AM PT it read $12.35 again, and the new cash-jump detector booked that rebound as `TRANSFER +1.01`. `startEquity` became $13.46, so the dashboard now shows a fake −$1.10 wallet loss and a −$0.93 RECON gap.

## v4 item status
| v4 item | Status | Notes |
|---|---|---|
| P0 deposits | **Partial / bug** | Only a cash-jump heuristic; no transactions API. Booked a valuation glitch as a deposit. |
| P1 sizing/caps | **Partial** | The rising-tape exemptions and `DEPLOY_CASH` are gone, and clip ≤ `CLIP_MAX_USD`. The book cap counts open bids, but the **per-coin cap doesn't count that coin's open bids**. Orphans (PLU) count toward the book cap but are never worked out. Total coins reached 53%. |
| P2 insufficient funds | **Partial** | Cover sells are idempotent now, but 67 LIMIT FAILs (throttled log) in 10 min, 20 of them after 7:15 AM PT. PIN/SLIDE/EXPAND sells still size from `pos.amount` without subtracting coins locked in open sells. |
| P3 exit queue | **Partial** | Dust skip, fill removal, `lastPostAt`, steps, max-age and clear-on-re-enter are in. Missing: lot-decimal formatting, a cost-basis floor, and a free-quantity check (`pos.amount \|\| row.qty` falls back to the stale qty). Not exercised yet. |
| P4 real fees/mid | **Partial** | Mid is stamped on 26/26 fills, but taken from the ring at *detection*, not at placement. Fees: 26/26 `pending`, flat 35.0 bps. **The fills API is still not called.** |
| P5 bank | **Partial** | `BANK_ONLY_QUOTE` respected. Holdings are priced only for coins the bot is quoting (POND $1.56; the rest $0). `working.bankEquity` is still 0. No `state-ladder.json` persistence. Bank read access (403) unverified. |
| P6 recon in API | **Partial** | `recon {gapUsd, alert, transfers}` is present. Missing: `gapPct`, a 1 h window, and alert-on-change. |
| P7 pairs quoting | **Done-ish** | `effPairs=4`, 4 MM pairs all hold sell orders. Bids are 0 right now (book cap). |
| P8 cosmetic | **Done** | |

## Work list (in priority order)

### 1. Fix false transfers
**Where:** `src/shared/pnl.js` `markWallet()` (cash-jump block).

**Change:**
1. Remove the equity-delta heuristic.
2. Detect transfers from **cash only** (the USDC balance changing with no fills, order holds or bank moves in the window), confirmed by `GET /api/v3/brokerage/transaction_summary` or `/v2/accounts/{USDC}/transactions` (deposit/withdrawal/transfer types). Apply each transaction id once.
3. Ignore any tick where `positionsValue` drops by more than 20% with no fills: that is a valuation glitch, so skip the mark entirely.
4. Persist the transfers in `logs/state-ladder.json`.

**Acceptance:** replaying 7:16–7:17 AM PT produces no transfer. A real $10 deposit produces exactly one, and `walletGain` changes by less than $0.05.

### 2. Valuation glitch
**Where:** `src/shared/portfolio.js` `fetchLivePortfolio()` L17–103 (mid lookup L83–88).

**Change:** when a position has no fresh book or ring mid, value it at its last known mid instead of dropping it to 0. Count `hold` (locked in open sells) in `valueQuote`. Log `VALUATION GAP <sym>` when it falls back.

**Acceptance:** over 2 h, equity never moves more than 3% between ticks without a fill or transfer.

### 3. Real venue fees
**Where:** `src/shared/orders.js` `markOrderFromExchange()` and `pollOpenOrders()`.

**Change:**
1. On every fill, queue `needFee`. `pollOpenOrders` must process `needFee` rows even with the WS on: its filter currently returns false when `wsOn`.
2. Call `/orders/historical/fills?order_ids=` and sum `commission`.
3. Call `pnl.adjustFee` and `logFeeUpdate(src:'venue')`, and set `feeSource='venue'`. Set `rec.taker` from `liquidity_indicator`.

**Acceptance:** at least 95% of fills are `venue` within 60 s, and the fee bps distribution is not a constant 35.0.

### 4. Locked-quantity-aware sells (insufficient funds)
**Where:** `src/bots/ladder/strategy.js` `resizeLeg()` sell branch (≈L235–263), `pinL1()` sell (≈L418–423), `slideSameSide()` (≈L576), `generateLadder`/EXPAND sells, `coverInventory()` (≈L839).

**Change:**
1. Add `freeQty(sym) = pos.amount − Σ open sell sizes for sym (all ladders, exitBook, adopted)`.
2. Size every sell to `min(want, freeQty*0.995)`, formatted with `lotDecimals`. Skip if it's under the minimum.
3. After an INSUFFICIENT failure, cool that pair/side down for `FUNDS_COOL_MS` and invalidate the live cache.
4. Count every failure in `/api/status` `limitFails`.

**Acceptance:** fewer than 5 INSUFFICIENT failures per hour.

### 5. Per-coin cap counts open bids; orphans exit
**Where:** `strategy.js` `resizeLeg()` (`held >= cap*hard` and `nameRoom`); `src/bots/ladder/index.js` startup (`skip market exit n=15`).

**Change:**
1. Use `held + openBidsFor(symbol)` in both places.
2. At startup, call `queueExit()` for every non-MM holding at or above the minimum order (PLU $1.39 today) instead of skipping it.
3. When several bids could fill at once, reserve their total so it can't exceed `INV_BOOK_MAX_FRAC`.

**Acceptance:** at every status tick:
- each coin's inventory plus open bids ≤ 25% of equity
- total inventory plus open bids ≤ 45% (overshoot of at most one clip)
- orphans are queued and worked out

### 6. Maker edge check
**Where:** `strategy.js` `pinL1`/`placeLadder` (`logEvent('place', …mid)`), `orders.js` fill path.

**Change:**
1. Store `placeMid` on each registry entry when the order is placed.
2. Log both `placeMid` and `fillMid` in each fill row.
3. Compute maker P&L against `placeMid`, and report adverse-selection drift (`fillMid` vs price) separately in `/api/status` `edge: {captureBps, driftBps}`.
4. If the rolling 1 h capture minus fee is below 0 for a pair, widen that pair's `MIN_HALF_SPREAD_BPS` by 25 bps, capped at `MAX_HALF_SPREAD_BPS`.

**Acceptance:** `edge` is present per pair, and any pair with negative net capture is widened automatically.

### 7. Exit-queue hardening
**Where:** `src/shared/exit-book.js` `tickExits()`.

**Change:**
1. Use `free = freeQty(sym)` (no `|| row.qty` fallback).
2. Format the quantity with `lotDecimals`.
3. Floor the price at `avgBuy*(1+2*fee)` until max age; after max age, post at bestAsk.
4. Drop the row if `free*mid < MIN_ORDER_USD`.

**Acceptance:** 0 failed exit posts, and every exit fills or is dropped within `EXIT_MAX_AGE_MS`.

### 8. Bank
**Where:** `index.js` status (`working.bankEquity`); `src/shared/bank.js` `refreshBankHoldings()`.

**Change:**
1. Compute `bankEquity` with ticker mids for **all** bank assets, falling back to the ticker WS or a REST best-bid/ask for assets the bot isn't quoting.
2. Log which portfolio uuid the holdings came from. Return `bankEquity=null` if it isn't the bank portfolio, or if the GET returns 403.
3. Persist `bankedTotal` in `logs/state-ladder.json`.
4. Show trading + bank = total on the dashboard.

**Acceptance:** the bank equity matches the Coinbase "trade bot bank" portfolio within $0.01, and the total survives a restart.

### 9. Recon in the API
**Change:** add `gapPct = |gap|/max(1, notional)`, `gap1hUsd`, and alert once per state change. Exclude transfers and bank moves from the gap.

## Config (~$12.4 equity)
```
MM_MAX_PAIRS=5
PAIR_CASH_K=2.5
LIVE_FOCUS_N=3
MIN_ORDER_USD=1
CLIP_EQ_FRAC=0.12
CLIP_MAX_USD=1.5
INV_NAME_MAX_FRAC=0.25
INV_CAP_HARD=1.0
INV_BOOK_MAX_FRAC=0.45
CASH_FLOOR_FRAC=0.35
MIN_HALF_SPREAD_BPS=110
MAX_HALF_SPREAD_BPS=180
MAKER_FEE_BPS=35
POST_ONLY=true
MM_LEVELS=1
ROTATE_MIN_HOLD_MS=1800000
VOL_ROTATE_MS=300000
ALLOW_MARKET_EXIT=0
SEED_MODE=off
EXIT_HALF_BPS=40
EXIT_STEP_BPS=10
EXIT_STEP_MS=120000
EXIT_MAX_AGE_MS=7200000
FUNDS_COOL_MS=60000
BANK_START_PCT=0
BANK_ROTATE_PCT=0
BANK_ONLY_QUOTE=1
RECON_GAP_USD=0.05
CANCEL_ALL_ORDERS_ON_STARTUP=false
PORTFOLIO_FRACTION=0
```
