# crypto-mm ladder: spec v6 (Oct 4, 2026, 7:50 AM PT)

**Status:** commit `1b555ea` ("Stop false transfers and queue orphan exits"). The bot restarted at 7:29:32 AM PT. At 7:43:59 AM PT equity was $12.143 (cash $5.83, coins $6.31 = 52%), against a start of $12.149. Real P&L is **−$0.006**, with no transfers booked. The fake +$1.01 transfer is gone.
**The bot is deadlocked.** It has **0 bids on all 4 pairs**, 2 fills in 14 min ($0.04 of dust sells), and $5.83 of cash sitting idle. Orphans HONEY ($4.87) and PLU ($1.41) push book inventory to 52%, above `INV_BOOK_MAX_FRAC` 0.45, so every bid returns 0. The exits that would clear them **never post**: `tickExits` throws `live is not defined` on every tick.
**Fees** are still `pending` at a flat 35.0 bps. Maker capture on the 2 fills is +32 bps, which is below the fee. There have been 0 market orders (7 blocked) and 9 INSUFFICIENT failures, all HONEY cover sells at 7:32–7:34 AM PT.

## v5 item status
| v5 item | Status | Notes |
|---|---|---|
| 1 False transfers | **Partial / latent bug** | The equity-delta heuristic is gone, and so is the fake +$1.01; 0 transfers since restart. The new rule (`pnl.js` `markHoldings` L106-110) flags any **free**-USDC move of ≥$0.50 with no fill for 8 s. Placing or cancelling a $1.50 bid moves `freeQuote` by $1.50, so this **will book false transfers as soon as bids resume**. There is still no transactions-API confirmation and no persistence. |
| 2 Valuation glitch | **Done** | Last-known-mid fallback (`portfolio.js` L85-89), and `markHoldings` skips a mark if positions drop more than 20% with no fill. 0 `VALUATION GAP` lines so far. |
| 3 Real venue fees | **Missing** | 2/2 fills are `feeSrc:'pending'` at exactly 35.0 bps. `orders.js` is unchanged. |
| 4 Locked-qty sells | **Partial / bug** | `resizeLeg` subtracts open ladder sells from `pos.amount`. But `pos.amount` is already *available* (exchange holds excluded), so this double-subtracts and under-sizes sells. `coverInventory` (L846-867) is unchanged: it posted `COVER SELL HONEY 1487.8 avail=1495.3` 6 times, giving 9× `Insufficient balance` (stale cache while adopted orders were still held). There is no `FUNDS_COOL_MS` cooldown and no `limitFails` counter. |
| 5 Caps / orphan exits | **Partial / bug** | Orphans are queued at startup (PLU) and on rotation (HONEY), but the exits never run (see bug A). The per-coin cap still ignores that coin's open bids. The book cap counts orphans, so bids are blocked indefinitely. |
| 6 Maker edge check | **Missing** | There is no `placeMid` and no `edge` in the API (`edgeBps: null`). Fill mid is stamped at detection only. |
| 7 Exit-queue hardening | **Partial** | It no longer falls back to `row.qty`, and it drops rows below the minimum order. Missing: `lotDecimals` formatting, the cost floor and `freeQty`. **None of it has run** (bug A). |
| 8 Bank | **Missing / bug** | `refreshBankHoldings` falls back to `/accounts`, which returns the **trading** portfolio. So the dashboard "bank" panel shows **$6.35** that is really HONEY/PLU/etc. in the trading wallet. `index.js` L361 adds that to `equity`, which double-counts once those coins have mids. `banked` is 0, and nothing is persisted. |
| 9 Recon in API | **Partial** | `gapPct` was added, but it is `|gap|/max(1, volNow)`, and `volNow` is ~0, so it equals `gapUsd`. There is no `gap1hUsd` and no alert-on-change. The gap is +$0.0005, which is fine. |

## Work list (in priority order)

### A. Exit tick crashes (blocker)
**Where:** `src/bots/ladder/index.js` vol-rotate loop. `let live` is declared inside the `try` at L156 but used outside it at L210 (`tickExits(ex, orderRegistry, live)`).

**Change:**
1. Hoist `let live = null;` above the `try`.
2. Better: call `await getLive()` right before `tickExits`.
3. Run `tickExits` on its own 15 s timer, not once per rotate interval.

**Acceptance:** no `exit tick` warnings, an `EXIT sell PLU @ …` line within 60 s of startup, and the PLU and HONEY rows show `lastPostAt > 0` and `steps ≥ 1` in `/api/status.exits`.

### B. Bids deadlocked by orphan inventory
**Where:** `src/bots/ladder/strategy.js` `resizeLeg()` buy branch, L187 and L196-197.

**Change:**
1. Compute `bookInv` from **MM-set symbols only** (`liveMmAlloc`) plus open bids. Count exit-book inventory separately.
2. If `exitInv > INV_BOOK_MAX_FRAC*eq`, still allow L1 bids on MM pairs up to `CLIP_MAX_USD` each, as long as `cashFrac ≥ CASH_FLOOR_FRAC`.
3. Log `BID BLOCK <sym> reason=<book|cash|name|rank|ret>` (throttled) so blocks are visible.

**Acceptance:** with orphans above 45%, every MM pair that passes the `ret`/rank gates has one bid within 30 s, and cash stays at or above 35% of equity.

### C. Transfer detection must use total USDC
**Where:** `src/shared/pnl.js` `markHoldings()` L99-112.

**Change:**
1. Use `cash = freeQuote + quoteHold` (holds on bids are not transfers), and also skip the check for 10 s after any place or cancel.
2. Require confirmation from `/v2/accounts/{USDC}/transactions` or the v3 portfolio-transfer history (deposit/withdrawal/transfer types, deduped by id) before calling `noteTransfer`.
3. Without confirmation, log `CASH JUMP unconfirmed` and do not change `startEquity`.
4. Persist `transfers` in `logs/state-ladder.json`.

**Acceptance:** 1 h of normal bid placing and cancelling produces 0 transfers. A real deposit produces exactly 1.

### D. Bank holdings are the trading wallet
**Where:** `src/shared/bank.js` `refreshBankHoldings()` L90-120; `index.js` L242, L361-362 and L372.

**Change:**
1. Delete the `/accounts` fallback, because it reads the default portfolio.
2. If `BANK_PORTFOLIO_UUID` is unset, or the portfolio GET fails (log the status code, e.g. 403), set `bankHoldings = null` and show **"bank: unreadable"**. Never fall back to the trading balances.
3. Price bank assets from the ticker WS or REST product best bid/ask for all assets.
4. Keep `bankEquity` out of `working.equity` until it is verified.

**Acceptance:** the dashboard bank panel equals the Coinbase "trade bot bank" portfolio within $0.01, or reads "unreadable". No trading-wallet asset appears in it.

### E. Insufficient-funds sells
**Where:** `strategy.js` `resizeLeg()` sell branch L235-242, and `coverInventory()` L846-867.

**Change:**
1. Use one helper, `freeQty(sym) = pos.amount (already net of exchange holds) − Σ open sells for sym that the exchange hasn't reflected yet` (registry entries placed less than 5 s ago, plus exit-book orders).
2. Do **not** subtract every open ladder sell from `amount`; that double-counts.
3. `coverInventory` must use `freeQty`, `invalidateLiveCache()` after any FREE/cancel, and wait one poll before re-sizing.
4. On INSUFFICIENT, cool that pair/side down for `FUNDS_COOL_MS` (60 s).
5. Expose `limitFails {insufficient, postOnly, other}` in `/api/status`.

**Acceptance:** fewer than 5 INSUFFICIENT per hour, and each sell size is within 1 lot of the free qty.

### F. Real venue fees (carried from v5 #3)
**Where:** `src/shared/orders.js` `markOrderFromExchange()`/`pollOpenOrders()`.

**Change:** fetch `/orders/historical/fills?order_ids=` for each filled order (including when the WS is on), sum `commission`, call `pnl.adjustFee`, and set `feeSource='venue'` and `taker` from `liquidity_indicator`.

**Acceptance:** at least 95% of fills are `venue` within 60 s, and the fee bps are not a constant 35.0.

### G. Maker edge check (carried from v5 #6)
**Change:**
1. Store `placeMid` at place time and log `placeMid` and `fillMid` per fill.
2. Report `/api/status.edge[pair] = {n, captureBps, driftBps}` over a rolling 1 h window.
3. If `captureBps − feeBps < 0` with n ≥ 5, raise that pair's half-spread by 25 bps, capped at `MAX_HALF_SPREAD_BPS`.

**Acceptance:** `edge` is non-null, and pairs with negative edge widen automatically.

### H. Exit-queue hardening (carried from v5 #7)
**Where:** `src/shared/exit-book.js` `tickExits()`.

**Change:**
1. Use `freeQty`, and format the qty with `lotDecimals` from `productMap` (pass it in).
2. Floor the price at `avgBuy*(1+2*fee)` until `EXIT_MAX_AGE_MS`, then post at bestAsk (post-only).
3. If the exchange has no book (`getBook` returns null), log it rather than silently `continue`.

**Acceptance:** 0 failed exit posts, and HONEY and PLU fill or are dropped within 2 h.

### I. Per-coin cap counts open bids
**Where:** `strategy.js` L180-184 and L225.

**Change:** use `held + openBidsFor(a.symbol)` for both `cap*hard` and `nameRoom`.

**Acceptance:** each coin's inventory plus bids ≤ 25% of equity at every tick.

### J. Recon
**Change:**
1. Compute `gapPct` against cumulative traded notional (`buyUsd+sellUsd`), not `volNow`.
2. Add `gap1hUsd`.
3. Alert once per state change, not every tick (`RECON ALERT gap=-0.0621` fired at 7:30 AM PT during startup settling).

**Acceptance:** fields are present, and there are no alerts in a steady state.

## Minor
- Startup runs the "MM start from saved set" rebalance 4× (7:29:35–7:29:57 AM PT). Run it once.
- `bank skim 0.5%` is logged even though `BANK_START_PCT=0`. Print the real pct.
- Coverage sells below `MIN_ORDER_USD` still post (DIMO $0.036, POND $0.004). Skip anything under the minimum.

## Config (~$12.1 equity, unchanged except as noted)
```
MM_MAX_PAIRS=5
LIVE_FOCUS_N=3
MIN_ORDER_USD=1
CLIP_EQ_FRAC=0.12
CLIP_MAX_USD=1.5
INV_NAME_MAX_FRAC=0.25
INV_BOOK_MAX_FRAC=0.45      # MM-set inventory only (item B)
CASH_FLOOR_FRAC=0.35
MIN_HALF_SPREAD_BPS=110
MAX_HALF_SPREAD_BPS=180
MAKER_FEE_BPS=35
POST_ONLY=true
MM_LEVELS=1
ROTATE_MIN_HOLD_MS=1800000
ALLOW_MARKET_EXIT=0
EXIT_HALF_BPS=40
EXIT_STEP_BPS=10
EXIT_STEP_MS=120000
EXIT_TICK_MS=15000          # new (item A)
EXIT_MAX_AGE_MS=7200000
FUNDS_COOL_MS=60000
BANK_START_PCT=0
BANK_ROTATE_PCT=0
BANK_ONLY_QUOTE=1
RECON_GAP_USD=0.05
```
