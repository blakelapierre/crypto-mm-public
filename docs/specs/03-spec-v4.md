# crypto-mm ladder: spec v4 (Oct 4, 2026, 6:49 AM PT)

**Status:** no commits since `666efc6` (5:05 AM PT); the bot has run continuously since 5:06 AM PT. A $10 deposit at about 6:27 AM PT took equity from $2.55 to $12.55; at 6:48 AM PT it was $12.51 (cash $10.43, coins $2.08), with 165 fills, 0 market orders, maker +$0.41, fees −$0.26 and price −$0.20.
**Broken:** the deposit is booked as gap/"other" (+$9.93, which triggered 46 RECON ALERTs). Fees are still estimated: all 165 fills show `feeSource:'pending'`, exactly 35.0 bps, `mid=null`. 297 LIMIT FAILs since 6:00 AM PT, and the log is throttled to 1 per 15 s per pair/side, so the real count is higher. Clips of about $1.50 stack while a coin is rising (DOGINME about $9.6 bought 6:29–6:44 AM PT).
**Done since v3 (no work needed):** the rotate.js trim loop; all market orders gated behind `ALLOW_MARKET_EXIT=0`; the startup orphan skim removed; effPairs recomputed from equity (it went 1 → 5 after the deposit); open orders registered at startup; partial fills on cancel recorded.

Line numbers refer to the files as of commit 666efc6.

---

## P0. Deposit/withdrawal detection (adjust startEquity, not P&L)
**Where:**
- `src/shared/pnl.js` `markWallet()` L81 and `snapshot()` L109–124 (`other` at L120).
- `src/bots/ladder/index.js` `emitStatus()` L218.

**Change:**
1. Add `pnl.noteTransfer(usd)`, which does `startEquity += usd` and pushes `{ts, usd, src}` onto `transfers[]`.
2. Detect transfers in two ways:
   - **(a)** Each status tick, call `GET /api/v3/brokerage/transaction_summary`, or `/v2/accounts/{usdc}/transactions` filtered on deposit/withdrawal/transfer types. Apply each new transaction id once.
   - **(b)** Fallback: if Δcash > max(0.5, 5% of equity) between ticks with no fills or bank moves in that window, treat Δcash as a transfer and log `TRANSFER detected`.
3. Bank moves go through the same path: `moveFunds` calls `noteTransfer(-usd)` instead of adding to `bankedRun` inside `other`.
4. Expose `pnl.transfers` and `pnl.netDeposits` in `/api/status`.
5. Persist `startEquity`, `transfers` and `bankedTotal` in `logs/state-ladder.json` (see P5).

**Acceptance:** after the 6:27 AM PT $10 deposit, `walletGain` and `otherPnl` stay within ±$0.05 of their pre-deposit values. `startEquity` becomes about $12.55, and one `TRANSFER +10.00` line is logged. No RECON ALERT fires on a deposit.

## P1. Equity-scaled sizing with caps that always apply (including while rising)
**Where:** `src/bots/ladder/strategy.js` `resizeLeg()` L173–231, `inventoryCapUsd()` L77–81; `src/shared/portfolio.js` `getMmOrderSizeUsd()` L231–236; index.js L143–145.

**Change:**
1. Remove the `ret <= 0` exemptions at L185, L190 and L191, so these always block new buys:
   - per-name cap `INV_NAME_MAX_FRAC`
   - total book cap `INV_BOOK_MAX_FRAC`
   - `CASH_FLOOR_FRAC`
2. Delete the `deploy && ret > 0` branches at L219–224, even when `DEPLOY_CASH=1`.
3. Count **open buy notional** against the caps: `held + Σopen bids for symbol ≤ cap`, and `positionsValue + Σall open bids ≤ bookCap`. Today, four $1.50 DOGINME bids were placed at 6:29 AM PT, each one passing the cap separately.
4. Size each order as `clip = clamp(equity*CLIP_EQ_FRAC, minOrderEff, CLIP_MAX_USD)`, where `minOrderEff = max(MIN_ORDER_USD, ordermin*mid*1.05)`.
5. Pairs: `effPairs = clamp(floor(equity / (minOrderEff*PAIR_CASH_K)), 1, MM_MAX_PAIRS)`. Pass it into `resizeLeg` (L192 `pairs`) and `getMmOrderSizeUsd`, not only into `MM_MAX_PAIRS_HARD`. Names over `effPairs` (still in their minimum hold) get no bids, only sells.

**Acceptance:** with $12.5 equity, every status tick shows:
- each coin's inventory plus open bids ≤ 25% of equity
- total inventory plus open bids ≤ 45%
- cash ≥ 35%

Every order is between $1 and CLIP_MAX_USD ($2). A replay of 6:27–6:40 AM PT never shows more than $3.13 in DOGINME.

## P2. Insufficient-funds and invalid-order fixes
**Where:** `strategy.js` `coverInventory()` L836–862, `pinL1()` sells L418–423, `slideSameSide()` L573–597, `skewOtherSide()` L599–631; `src/shared/exchange.js` `limitOrder()` failCtx L249–257.

**Change:**
1. Add a helper `freeQty(symbol) = pos.amount − Σ(size of open sells for symbol across pairState, exitBook and adopted orders)`. Every sell sizes to `min(want, freeQty*0.995)`, formatted with `formatVolume(..., lotDecimals)`. Skip if the result is below `minV`.
2. Make cover idempotent: if a cover sell is already open for the symbol, don't place another. Today `COVER SELL` fired 139 times since 6:00 AM PT.
3. After an INSUFFICIENT failure, cool that pair/side down for `FUNDS_COOL_MS=60000` and invalidate the live cache.
4. Fix the logged error object: `msg = err.message || JSON.stringify(err.error_response || err)`. Ten BLAST failures currently log `[object Object]`.
5. Keep throttling the log, but count every failure (`limitFails[pair:side:reason]++`) and expose that in `/api/status`.

**Acceptance:** fewer than 5 INSUFFICIENT failures per hour, and 0 "Too many decimals" and 0 `[object Object]` errors over 2 hours. At most 1 open cover sell per symbol.

## P3. Exit-queue fixes
**Where:** `src/shared/exit-book.js` `queueExit()` L3–7, `tickExits()` L11–28; index.js L162 and L192.

**Change:**
1. At queue time, skip dust: `qty*mid < max(MIN_ORDER_USD, ordermin*mid)`. Today the bot queued HONEY 0.022 and PLU 0.032, which then failed as dust or with "too many decimals".
2. Each tick, re-read `freeQty`. Remove the row when its order is `filled`, or when `freeQty` is below the minimum.
3. Format the quantity with `lotDecimals` and the price with `quote_increment`.
4. Pricing: `px = max(bestAsk, mid*(1+EXIT_HALF_BPS/1e4) − steps*EXIT_STEP_BPS/1e4*mid)`, with the floor at `avgBuy*(1+2*makerFee)` until `EXIT_MAX_AGE_MS`. After that, post at bestAsk (post-only).
5. Track `lastPostAt` and replace the order only when `now − lastPostAt ≥ EXIT_STEP_MS`. The current `row.since` check is wrong.
6. If the symbol re-enters `mmAlloc`, cancel the exit order and drop the row.
7. Expose `exitBook` in `/api/status`.

**Acceptance:** each queued exit either fills or is dropped as dust within `EXIT_MAX_AGE_MS`, with 0 failed exit posts. The dashboard lists open exits with their age.

## P4. Real fees and mid on every fill (P3 from the brief: not done)
**Where:** `src/shared/orders.js` `markOrderFromExchange()` L6–58 and `pollOpenOrders()` L60+; `src/shared/exchange.js` `getOrderStatus()` (fills call about L318); `src/shared/fill-log.js` `logFill()`.

**Change:**
1. After FILLED, or a cancel with a partial fill, queue `needFee`. Within 10 s, call `/orders/historical/fills?order_ids=` and sum `commission`.
2. Then call `pnl.adjustFee`, `logFeeUpdate(src:'venue')` and set `rec.feeSource='venue'`. Set `rec.taker = liquidity_indicator==='TAKER'`.
3. `pollOpenOrders` currently skips `needFee` rows when the WS is on; make it always process them.
4. Stamp `rec.mid` from the ticker WS / `midRing` at detection, and log it in the fill row (currently `mid=null`).

**Acceptance:** at least 95% of fills have `feeSource:'venue'` within 60 s. The fees KPI equals the sum of Coinbase fills commission within $0.001. The fee-bps distribution isn't a constant 35.0.

## P5. Bank fixes
**Where:** `src/shared/bank.js` `refreshBankHoldings()` L90–121, `skimToBank()` L123–169, `noteBankedUsd()` L26; index.js L344 `bankEquity`.

**Change:**
1. Price holdings: `value = qty*mid`. `bankEquity` is always 0 today because the holdings have no `value` field.
2. Make the bank key able to view the bank portfolio (403 seen at 4:42 AM PT). Log which portfolio uuid the fallback `/accounts` call reads. If it isn't the bank portfolio, set `bankEquity=null` and show "unreadable" rather than a wrong number.
3. Persist `bankedTotal` and the transfer ledger in `logs/state-ladder.json`, loaded at startup, so the counter doesn't reset.
4. Skim only USDC and only realized profit (honour `BANK_ONLY_QUOTE`). Skip while any sell is open for the asset, and skip while session `walletGain < 0`.
5. Dashboard: show trading equity, bank equity and their total.

**Acceptance:**
- the dashboard bank equity matches the Coinbase "trade bot bank" portfolio within $0.01
- `bankedTotal` survives a restart
- no non-USDC bank moves happen

## P6. Recon in the API
**Where:** index.js `emitStatus()` L218–224 and `postStatus` L340+; `src/web/server.js`.

**Change:**
1. Add `recon: {gapUsd, gapPct: |gap|/max(1, notional), gap1hUsd, alert, reasons:[]}` to `/api/status`.
2. Exclude detected transfers and bank moves from the gap (P0).
3. Show `alert` in red on the dashboard, and alert once per state change rather than every 30 s.

**Acceptance:** the field is present and stays under $0.05 over a quiet 2 h run. Injecting an unrecorded fill in dry-run turns `alert` true within 1 tick.

## P7. Only 2 of 5 listed pairs quote
**Where:** `strategy.js` `siblingHasBareBids()` L864–876 (gates bids at L387 and L539), `harvestLowWeightBids()` L878–915 (cancels lower-weight bids), `isTopWeight()`/`LIVE_FOCUS_N` (default 2, L104 and L644).

**Change:** after P1 caps exist, set `LIVE_FOCUS_N=effPairs`. Change `siblingHasBareBids` to block only when cash is below `clip*(bare siblings)`, not unconditionally. Have `harvestLowWeightBids` run only when `freeQuote < clip`.

**Acceptance:** with $12.5 equity and effPairs ≥ 3, at least 3 pairs hold an L1 bid or ask at least 80% of the time. No harvest happens while cash ≥ clip.

## P8. Cosmetic
index.js L112 prints `rotateMin=900s`; print `ROTATE_MIN_HOLD_MS`. The rotation log says `MM exit X (>=15m)`; print the actual hold time.

---

## Recommended config for ~$12.5 equity (`configs/ladder.env`)
```
MM_MAX_PAIRS=5
PAIR_CASH_K=2.5
LIVE_FOCUS_N=3
MIN_ORDER_USD=1
CLIP_EQ_FRAC=0.12
CLIP_MAX_USD=2
DEPLOY_CASH=0
INV_NAME_MAX_FRAC=0.25
INV_CAP_HARD=1.0
INV_BOOK_MAX_FRAC=0.45
CASH_FLOOR_FRAC=0.35
MIN_HALF_SPREAD_BPS=100
MIN_SPREAD_BPS=200
MAX_HALF_SPREAD_BPS=160
MAKER_FEE_BPS=35
POST_ONLY=true
MM_LEVELS=1
VOL_ROTATE_MS=300000
ROTATE_MIN_HOLD_MS=1800000
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
