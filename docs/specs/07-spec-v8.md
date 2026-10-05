# crypto-mm ladder: spec v8 (Oct 4, 2026, 8:30 PM PT)

## Design intent (read first)
- **What the bot is:** a **post-only, two-sided spread capturer**. It keeps one bid and one ask per coin outside the fee. After a fill it places another order on the same side and skews the other side (README; `261bc7d`/`00e2c60`, Sep 26).
- **Momentum tilt (rise-hold):** while a coin's 1-minute price is rising, it holds back part of the coin from sells and widens the ask. When the rise stops, it sells that held part at the best ask (`639058b`/`838ace3`, Sep 29).
- **Markets:** the **scanner picks them** (15-minute volatility rank). No coin names are hardcoded as logic; names below are examples only.
- **What v8 does:**
  - Restores a **reliable exit**, so coins the bot stops quoting always get sold.
  - Restores a **modest momentum lean**: rising coins may go up to 35% of equity instead of 25%.
  - Swaps estimated fees for real ones.
- Everything else stays post-only. Idle-cash deployment stays off, and rotation never market-sells ("dumps").

**Status:**
- Commit `f426b9c`. The bot restarted at 8:01:01 PM PT.
- The stranded-coin sweep works: PLU 9.05 and MAMO 254.6 posted at 8:01 PM PT, the first real exits.
- The exit loop has two bugs (1a and 1b below). At 8:03:42 PM PT it cancelled the 9.05 PLU sell and reposted 0.04 PLU.
- Last session (11:31 AM to 7:48 PM PT): maker +$2.67, fees −$0.92 (all estimated), price −$2.22 (mostly stranded coins), gap −$1.09.

Line numbers are at `f426b9c`. Check them before editing.

## 1. Exit queue: step down, sell the full balance, never shrink
**Where:** `src/shared/exit-book.js` `tickExits()` L45-86 and `queueExit()`/`sweepStranded()` L15-43; `src/bots/ladder/index.js` L227 and L234 (the sweep result is discarded); `src/shared/sizing.js` `formatPrice` L24 and `formatVolume` L27.

**Bugs:**
- **(a)** L57-58 compute `free = pos.amount` and `continue` when it is 0. While the exit order is open it holds every coin, so free is 0. As a result the price never steps down and never reaches the max-age fallback.
- **(b)** L66 sells `free * 0.995`, leaving a 0.5% leftover. On the next step, L68 cancels the full order and reposts that leftover. At 8:03:42 PM PT this turned PLU 9.05 into 0.04.
- **(c)** The price isn't rounded to the quote increment (MAMO `0.007877384`).
- **(d)** The dust list is computed and thrown away.
- **(e)** There is no post-only retry on the exit path.

**Change:**
1. **Step-down is driven by the open exit order, not by free qty.**
   - Each row keeps `{orderId, price, size, postedAt, steps}`.
   - Each tick, if `row.orderId` is open (registry or venue status), do nothing until `now − postedAt ≥ EXIT_STEP_MS`.
   - Then `newPx = max(bestAsk, mid*(1 + EXIT_HALF_BPS − steps*EXIT_STEP_BPS))`. After `EXIT_MAX_AGE_MS`, use `newPx = bestAsk`.
   - Re-post only if `newPx < row.price` by at least 1 quote increment, or the order is no longer at the best ask after max age.
2. **The size to post is the full sellable balance:** `size = formatVolume(floorToLot(open exit size + free), lotDecimals)`.
   - Cancel first, then refresh `live`, then post `formatVolume(amount, lot)`. `amount` is now everything, because the cancel released the hold.
   - No `0.995` factor.
3. **Never replace a larger exit with a smaller one.**
   - If the new size is smaller than `row.size` by more than 1 lot, don't cancel. Keep the working order and log `EXIT keep <sym> size=<n> (would shrink to <m>)`.
   - Coins freed later (for example from a partial fill or a released hold) get a second order only if they are worth at least `MIN_ORDER_USD` on their own.
4. **Price rounding:** `px = formatPrice(px, pairDecimals)`, rounded **up** to the quote increment for sells. Store `pairDecimals` and `lotDecimals` from `productMap` in `queueExit`. If they are missing, fetch the product once.
5. **Post-only retry:**
   - On `INVALID_LIMIT_PRICE_POST_ONLY`, or a null id from `ex.limitOrder`, retry once at `bestAsk + 1 increment`.
   - If that also fails, set `row.lastErr` and try again next tick.
   - On `Too many decimals`, refetch the increments once, then mark the row `error`.
6. **Dust in the API:** `index.js` keeps the `sweepStranded()` return value and exposes `/api/status.dust = [{symbol, qty, value}]`. Each exit row shows `{qty, size, price, value, sinceMid, mid, pnlUsd, ageMin, steps, lastErr, taker}`.

**Acceptance:**
- Replaying a coin like PLU (9.09 held): exactly one working exit order of size `floorToLot(9.09)`, whose price steps down every `EXIT_STEP_MS` and is never re-posted smaller.
- `steps` rises while the order is open.
- After `EXIT_MAX_AGE_MS`, the order sits at the best ask.
- 0 `EXIT sell` lines with a value under `MIN_ORDER_USD`.
- 0 prices off the quote increment, and 0 decimals errors.
- `/api/status.dust` is present.

## 2. Stranded-coin taker fallback (decision: on by default)
**Where:** `exit-book.js` `tickExits()`; `src/shared/exchange.js` `marketSell()` L216-230 (gated by `ALLOW_MARKET_EXIT` at L217); `src/shared/pnl.js` `recordFill`.

**Rule:**
- Only for coins **not in `mmAlloc`** whose exit row has reached `bestAsk` (the max-age step) and has stayed unfilled for `STRANDED_TAKER_AFTER_MIN` (30) minutes.
- **One** market sell per coin per exit row.
- Limits:
  - At most `STRANDED_TAKER_MAX_USD` (5) per exit; sell only that much and leave the rest on the post-only exit.
  - At most `STRANDED_TAKER_PER_HOUR` (2) taker exits per rolling hour, all coins combined.
- `ALLOW_MARKET_EXIT` stays 0 for everything else: no rotation dumps, no startup flattening, no seeding.

**Change:**
1. Add `ex.marketSell(pair, qty, {reason:'stranded'})`. The gate at L217 allows it only when `reason === 'stranded'` and `STRANDED_TAKER=1`. Every other caller stays blocked.
2. Cancel the exit order, refresh `live`, then market-sell `min(amount, STRANDED_TAKER_MAX_USD/mid)` rounded to the lot.
3. Record the fills with `taker:true` and the real commission (item 4), so the cost lands in `TAKER` and `fees`.
4. Log `STRANDED TAKER <sym> qty=… usd=… age=…m`.
5. Add `/api/status.strandedTaker = {count1h, countSession, usdSession, feesSession, last:[…]}`.
6. Mark the row `taker:true` so it cannot taker again.

**Acceptance:**
- A coin outside the set that sits unfilled at the best ask for 30 min is sold by exactly one market order of at most $5.
- A third candidate within the same hour waits.
- No market order appears for coins in the set, or on rotation.
- `TAKER` P&L and `strandedTaker` match the venue fills.

## 3. Sell sizing from free quantity (fix the v7 regression)
**Where:** `src/bots/ladder/strategy.js`:
- `resizeLeg()` sell branch L237-246 (L244 `held = heldRaw − locked`)
- `pinL1()` L368+
- `slideSameSide()` L585+
- EXPAND ≈L700-720
- `coverInventory()` L848-870 (L852 `available = pos.amount`)

**Why:** `pos.amount` is already the venue's *available* quantity, with holds removed. Subtracting open ladder sells again under-sizes sells. Before `f426b9c` there was no subtraction at all, so several sells sized from the same cached balance in one tick (975 insufficient-funds failures last session).

**Change:**
1. Add a new `src/shared/free-qty.js` with `freeQty(sym) = pos.amount − reserved(sym)`.
   - `reserved(sym)` covers sells placed in this or recent ticks that the cached balance doesn't yet reflect (registry entries younger than `RECENT_SELL_RESERVE_MS`, 10 s), plus `sellReserve[sym]`.
   - **Do not** subtract older open sells.
2. Every sell path calls `reserveSell(sym, size)` before posting and `releaseSell` on reject or cancel. Size each sell as `min(want, freeQty)`, rounded to the lot, and skip it if under the minimum.
3. Call `invalidateLiveCache()` after any cancel, FREE or rotation, and refresh before re-sizing.
4. On `Insufficient balance`, cool down that pair+side for `FUNDS_COOL_MS` (60 s), and count it via `noteLimitFail` **from `ex.limitOrder`**. Today only the exit path counts. Report `limitFails` as 1-hour rolling counts.

**Acceptance:**
- Under 5 `Insufficient balance` per hour, all pairs combined.
- The sum of open sell sizes per symbol is never above `amount+hold`.
- An L1 sell after a fill sizes to the full free balance (no shrink from double-counting).

## 4. Real fees from Coinbase
**Where:** `src/shared/orders.js` L28-70 (`needFee`), `src/shared/exchange.js` fee parse L10-22 and L300-320, `src/shared/fill-log.js`.

**Change:**
1. For each filled order, call `GET /api/v3/brokerage/orders/historical/fills?order_ids=<id>`.
   - Sum `commission` and set `liquidity_indicator` → `taker`.
   - Run this even when the user websocket is on.
   - Retry with backoff for up to 5 min.
2. Call `pnl.adjustFee(orderId, venueFee)`, set `feeSource='venue'`, and append a fee row with `src:'venue'`.
3. **Backfill:** at startup and hourly, scan the fill log for `feeSrc:'pending'` rows from the last 48 h and fetch their fills in batches.
4. Cross-check against `GET /api/v3/brokerage/transaction_summary` (`total_fees`, fee tier). Show `fees: {venue, pending, estBps, realBps, tier}` in `/api/status`.
5. Replace the quoting fee input (`MAKER_FEE_BPS`) with the realized maker bps once at least 20 venue fills exist.

**Acceptance:**
- At least 95% of fills are `venue` within 5 min.
- 0 `pending` rows older than 1 h after the backfill.
- `realBps` is shown.
- The session fee total matches `transaction_summary` within 1%.

## 5. Rising-coin cap (decision)
**Where:** `strategy.js` `inventoryCapUsd()` L77-81 and the buy branch of `resizeLeg()` L179-230 (`held >= cap*hard`, `room`, `nameRoom` at L221 and L227, `bookCap` L198, cash floor L200). Use the rise-hold condition at L245-249 (`rising && !flatTape`, `riseHoldFrac`).

**Change:**
1. `capFor(sym) = eq * (riseActive(sym) ? RISE_COIN_CAP_PCT : INV_NAME_MAX_FRAC)`, with `RISE_COIN_CAP_PCT=0.35` and `INV_NAME_MAX_FRAC=0.25`.
2. Compare it against `held + openBidsFor(sym)` (item 6c).
3. The 45% total (`INV_BOOK_MAX_FRAC`) and the 35% cash floor (`CASH_FLOOR_FRAC`) stay **hard** whether or not the coin is rising.
4. When the rise ends and the coin is above 25%:
   - Stop bidding it.
   - Let normal asks and the rise-hold release at the best ask trim it, with no taker.
   - Log `TRIM <sym> over cap`.
5. Idle-cash deployment stays removed.

**Acceptance:**
- A rising coin can reach at most 35% of equity, and a flat or falling one at most 25% plus one clip.
- Total inventory never exceeds 45% plus one clip.
- Cash never drops below 35%.
- Every trim fill is post-only maker.

## 6. Remaining v7 gap work
- **6a Name unexplained equity steps.** `src/shared/pnl.js` `markHoldings()` L99-112:
  - Remove the 20% "skip mark" guard (L101-104); it fired 206× last session and froze equity marks.
  - Always mark. If `|Δequity| > max($0.50, 5%)` with no recorded fill in the last 60 s, log `EQUITY STEP` with the per-asset diff (qty, mid, mid source) and the free/hold USDC diff, and book it to an `unattributed` bucket in `/api/status.pnl`.
  - Run the `CASH JUMP` check on every tick.
  - **Acceptance:** over 2 h, `|gap| < $0.05`, or every step is named.
- **6b Track orders on coins that rotated out.** `index.js` L190-198:
  - Before `pairState.delete`, move the pair's open registry entries to `orphanOrders`, which `pollOpenOrders` keeps polling so their fills are recorded.
  - After `cancelPair`, re-list the pair's orders; anything still open is logged `CANCEL LEFTOVER` and kept tracked.
  - **Acceptance:** 0 untracked fills after rotation.
- **6c Venue reconciliation every `VENUE_RECON_MS` (5 min):**
  - Fetch fills for all products since the last cursor. Any fill not in the registry goes through `recordFill` with `why:'untracked'` and is logged `UNTRACKED FILL`.
  - Fetch USDC deposit, withdrawal and transfer transactions and book them via `noteTransfer` with the transaction id (deduped). Persist both in `logs/state-ladder.json`.
  - **Acceptance:** an injected test transfer is booked once, and untracked fills show up in the log and API.
- **6d Bank shows "unreadable".** `src/shared/bank.js` `refreshBankHoldings()` L90-110 and `src/web/server.js`:
  - When holdings are `null`, show "bank: unreadable".
  - Log the bank uuid and the HTTP status (e.g. 403) once per change.
  - **Acceptance:** the dashboard never shows "$0" for an unreadable bank.
- **6e The per-coin cap counts open bids.** `strategy.js` L179-184, L221 and L227: use `held + openBidsFor(sym)`.
  - **Acceptance:** each coin's inventory plus open bids stays within `capFor(sym)` at every tick.
- **6f Recon and logs:**
  - Add `gap1hUsd`.
  - Compute `gapPct` against traded notional.
  - Add a throttled `BID BLOCK <sym> reason=<book|cash|name|rank|ret>` log.

## 7. Banking
Keep `BANK_START_PCT=0`, `BANK_ROTATE_PCT=0` and `BANK_ONLY_QUOTE=1`. Revisit profit skims once item 4 shows **positive net after real fees** over at least 24 h. No code change in v8 beyond 6d.

## Config (~$9.6 equity)
```
MM_MAX_PAIRS=4
LIVE_FOCUS_N=3
MIN_ORDER_USD=1
CLIP_EQ_FRAC=0.12
CLIP_MAX_USD=1.5
INV_NAME_MAX_FRAC=0.25
RISE_COIN_CAP_PCT=0.35         # new (item 5)
INV_BOOK_MAX_FRAC=0.45         # hard
CASH_FLOOR_FRAC=0.35           # hard
MIN_HALF_SPREAD_BPS=110
MAX_HALF_SPREAD_BPS=180
MAKER_FEE_BPS=35               # fallback only once venue fees exist (item 4)
POST_ONLY=true
MM_LEVELS=1
ROTATE_MIN_HOLD_MS=1800000
VOL_ROTATE_MS=300000
ALLOW_MARKET_EXIT=0            # everything except the stranded fallback
EXIT_TICK_MS=15000
EXIT_HALF_BPS=40
EXIT_STEP_BPS=10
EXIT_STEP_MS=120000
EXIT_MAX_AGE_MS=3600000
STRANDED_TAKER=1               # new (item 2)
STRANDED_TAKER_AFTER_MIN=30
STRANDED_TAKER_MAX_USD=5
STRANDED_TAKER_PER_HOUR=2
FUNDS_COOL_MS=60000
RECENT_SELL_RESERVE_MS=10000
VENUE_RECON_MS=300000
BANK_START_PCT=0
BANK_ROTATE_PCT=0
BANK_ONLY_QUOTE=1
RECON_GAP_USD=0.05
```
