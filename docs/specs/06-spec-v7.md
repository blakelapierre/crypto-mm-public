# crypto-mm ladder: spec v7 (Oct 4, 2026, 7:55 PM PT)

**Status:** commits `3399b33`, `ebea1f5`, `11fb4f6` and `558ed14`. The session started at 11:31:22 AM PT with `startEquity` $11.21. At 7:47:59 PM PT equity was $9.65 (−$1.56).

**P&L breakdown (7:47:59 PM PT):** maker +$2.67, fees −$0.92 (net +$1.75 on 324 fills), price −$2.22, gap −$1.09. Market-making itself is profitable. The losses come from **stranded coins** the bot no longer quotes (MAMO $2.04, PLU $1.41, HNT $0.28) and from one unexplained −$1.00 cash step.

**Exits are broken:**
- 1 successful `EXIT sell` all session (DOGINME).
- PLU's exit failed **1,008×** with `Too many decimals`.
- Rotation exits queue only the *available* quantity read before the cancel (MAMO 0.8, PLU 0.042), then drop the row as dust.

**Insufficient-funds failures:** 975 this session, 110 in the last hour (DIMO 46, HONEY 44, GTC 14, KAIO 6).

**Fees are still estimated:** 324/324 fills have `feeSrc:'pending'` at exactly 35.0 bps, and the logs say `fee=… est`.

## v6 item status
| v6 item | Status | Notes |
|---|---|---|
| A Exit tick crash | **Done** | `getLive()` before `tickExits`, plus a 15 s `setInterval` (`index.js` L222-234). No more `live is not defined`. |
| B Orphans block bids | **Done** | `bookInv` counts MM-set symbols only (`strategy.js` L187-189). Bids are live. There is no `BID BLOCK` reason log. |
| C Transfers on total USDC | **Partial** | `cash = free + hold`, and jumps are only logged as unconfirmed (36 `CASH JUMP` lines, 0 booked). There is no transactions API. The check sits *after* the valuation-skip `return` (`pnl.js` L101-104), so it is skipped exactly when it matters (see item 3). |
| D Bank | **Partial** | The `/accounts` fallback was removed and `bankEquity: null`. The dashboard shows `$0`, not "unreadable". There is no uuid or HTTP-status log, and nothing is persisted. |
| E Insufficient-funds sells | **Regressed** | `3399b33` set `held = heldRaw` (L244) with no reservation, so every sell leg sizes from the full balance (975 failures). There is no `FUNDS_COOL_MS` cooldown and no `limitFails` counter. |
| F Real fees | **Missing** | The `ebea1f5` code path exists (`orders.js` L33-39, `exchange.js` L316), but 0/324 fills are `venue`. |
| G Edge check | **Partial** | Per-market `edgeBps` is shown (for example DIMO 13 bps). There is no `placeMid`, no rolling capture−fee, and no auto-widen. |
| H Exit hardening | **Missing** | No lot formatting (PLU `9.09233645` rejected 1,008×), no cost floor and no `freeQty`. |
| I Per-coin cap counts open bids | **Missing** | `strategy.js` L180-184 still uses `held` only. |
| J Recon | **Partial** | `gapPct` = 0.031. No `gap1hUsd`, and `RECON ALERT` fired 704× (every tick). |

## Work list (in priority order)

### 1. Stranded holdings: sweep every holding not quoted into the exit queue, and sell it
**Where:**
- `src/bots/ladder/index.js` rotation exit L190-198 (`cancelPair` then `queueExit(a.symbol, a.pair, pos.amount)` using the **pre-cancel** `live`).
- Startup L475-479.
- `src/shared/exit-book.js` `queueExit()` L3-11 and `tickExits()` L17-44.

**Why:**
- On rotation the coins are still locked in the sells being cancelled, so `pos.amount` is only the unlocked remainder (MAMO 0.8 of 256, PLU 0.042 of 9.09).
- `tickExits` then reads the same cached `live`, sees under $1 and **deletes the row**.
- Nothing ever re-scans, so MAMO, PLU and HNT have sat unquoted since 1:37, 4:02 and 1:42 PM PT.

**Change:**
1. **`sweepStranded(live)` on every exit tick (15 s) and at startup.** For each `live.positions[sym]` not in `mmAlloc`:
   - Compute `qty = amount + hold`.
   - If `qty*mid ≥ MIN_ORDER_USD` and the coin isn't in `exitBook`, call `queueExit(sym, pair, qty, mid)`.
   - Remove the separate startup and rotation `queueExit` calls; the sweep replaces them.
   - Holdings below the minimum are **dust**. List them in `/api/status.dust` with their value, exclude them from caps, and never post them.
2. On rotation exit: `await ex.cancelPair(pair)`, then `invalidateLiveCache()`, then wait one poll. The sweep picks the coin up on the next tick.
3. `tickExits`:
   - `free = freeQty(sym)` from a **fresh** `getLive()`.
   - Drop a row only if `(amount+hold)*mid < MIN_ORDER_USD` (true dust), not because coins are temporarily locked.
   - Format the quantity with `formatVolume(free, lotDecimals)` (`src/shared/sizing.js` L27); `queueExit` must store `lotDecimals` and `priceDecimals` from `productMap`.
   - On `Too many decimals`, refetch the product increments once and retry, then mark the row `error` (no 15 s retry loop).
4. **Stepped post-only exit:**
   - Start at `max(bestAsk, mid*(1+EXIT_HALF_BPS))`.
   - Step down `EXIT_STEP_BPS` every `EXIT_STEP_MS`, floored at `bestAsk` (post-only, never crossing).
   - After `EXIT_MAX_AGE_MS`, join the touch: re-post at bestAsk on every tick until filled.
   - On `INVALID_LIMIT_PRICE_POST_ONLY`, retry once at `bestAsk + 1 tick`.
5. **Stranded stop-loss (opt-in, default off):**
   - If `STRANDED_TAKER=1` and the coin's mid has fallen `STRANDED_STOP_PCT` below its queue-time mid, or the row is older than `STRANDED_MAX_AGE_MS`, send **one** limit IOC sell at bestBid for `free` (taker, 75 bps).
   - Log it as `taker:true` and record its fills.
   - This is the only taker path allowed while `ALLOW_MARKET_EXIT=0`.
   - Cost check: a $2 exit costs about $0.015 in taker fee, against MAMO's −$0.72 price P&L.
6. Track the stranded P&L separately: `/api/status.exits[]` rows get `{qty, value, sinceMid, mid, pnlUsd, ageMin, steps, lastErr}`.

**Acceptance:**
- Within 60 s of a restart, MAMO and PLU appear in `exits` with `steps ≥ 1` and a live order id; HNT appears under `dust`.
- No coin outside `mmAlloc` worth ≥ $1 goes more than 30 s without an exit row.
- 0 `Too many decimals` errors.
- Every exit fills or is (optionally) stopped out within `EXIT_MAX_AGE_MS` + 15 min.

### 2. Size sells from free quantity (DIMO oversize)
**Where:** `src/bots/ladder/strategy.js`:
- `resizeLeg()` sell branch L237-246 (`held = heldRaw`)
- `pinL1()` L368+
- EXPAND grid ≈L700-720
- `slideSameSide()` L585+
- `coverInventory()` L848-870 (`available = pos.amount`)

**Why:** in one 2 s tick, PIN L1, EXPAND L2/L3 and SLIDE each size from the same cached `pos.amount` and all post. Examples: `DIMO sell L1 47.9`, then `L2 37.7`, then `L3 21.8` against about 48 free. The exchange has not yet applied holds for orders placed seconds earlier, and `3399b33` removed the locked-quantity subtraction completely.

**Change:**
1. Add a per-symbol **reservation ledger**, `sellReserve: Map<sym, qty>`.
2. Put one helper, `freeQty(sym)`, in a new file `src/shared/free-qty.js`:
   - Start from the venue `available` (`pos.amount`).
   - Subtract registry sells for `sym` placed less than 10 s ago (not yet reflected in `available`).
   - Subtract `sellReserve[sym]`.
3. Every sell path reserves before posting (`size = min(want, freeQty*0.995)`, lot-formatted, skipped if under the minimum), and releases on reject or cancel.
4. After any cancel or FREE, call `invalidateLiveCache()`.
5. On `Insufficient balance`, cool down that pair+side for `FUNDS_COOL_MS` and refresh `live`.
6. Expose `/api/status.limitFails = {insufficient, decimals, postOnly, other}` as 1 h rolling counts.

**Acceptance:**
- Under 5 `Insufficient balance` per hour, all pairs combined.
- The sum of open sell sizes for any symbol is never above `amount+hold`.
- `limitFails` is present.

### 3. Gap cause (−$1.09)
**Evidence:**
- **−$1.005 of the gap landed in one step at 2:03:33 PM PT.** The `WORKING` lines show equity going $10.83 → $9.81 between 2:01:03 and 2:01:33 PM PT, with cash $6.96 → $5.96 (−$1.00) and **no fill, no tracked bid (`bids=$0.00`) and inventory unchanged** ($3.87 → $3.85).
- `pnl.markHoldings` didn't see it. The valuation-skip guard (`pnl.js` L101-104) had frozen `lastEquity` at $10.81 from 1:59:33 PM PT, because a normal GFI sell fill dropped `positionsValue` 6.14 → 4.51 more than 8 s before the 30 s mark.
- Skipping also bypasses the `CASH JUMP` check. When a fill finally landed within 8 s of a mark (2:03:33 PM PT), the whole step went to GAP.
- The guard fired **206 times in about 33 episodes** this session. Every sell fill that settles more than 8 s before a mark trips it.
- **Likely sources of the $1.00:**
  - **(a) An untracked order filling.** MAMO bids (L1 128, L2 129 and L3 130.1 MAMO at ≈$1.00 each) were posted 1 s before MAMO's 1:37 PM PT rotation exit. `pairState.delete()` dropped them from tracking. MAMO now holds 255.9 (about 2 × 128), so two bids appear to have filled with no fill recorded.
  - **(b) A $1.00 USDC transfer.**

  `cancelPair()` (`exchange.js` L358-365) lists open orders with `?product_id=`. Coinbase's list-orders filter is `product_ids`; if `product_id` is ignored, that call returns up to 50 open orders across *all* products, so it can cancel the wrong orders or miss the right ones. Errors are swallowed.

**Change:**
1. **Replace the 20% skip guard:**
   - Always mark.
   - If `|Δequity| > max($0.50, 5%)` with no recorded fill in the last 60 s, log `EQUITY STEP` with the per-asset diff (`qty`, `mid`, `midSource`) and the free/hold USDC diff.
   - Book the step to a named bucket (`unattributed`), not the silent gap.
   - Run the `CASH JUMP` check on every tick.
2. **`cancelPair`:**
   - Use `product_ids=<pair>`, and verify every returned order's `product_id === pair` before cancelling.
   - Then re-list and confirm 0 open. If any remain, log `CANCEL LEFTOVER` and keep them in the registry with `why:'orphan'`.
3. **Never drop tracking of live orders on rotation.** Move the leaving pair's registry entries to an `orphanOrders` set that `pollOpenOrders` still polls, so their fills are recorded and fee-adjusted.
4. **Venue reconciliation every 5 min:**
   - Fetch `/orders/historical/fills?start_sequence_timestamp=<last>` for **all products**.
   - Any fill whose `order_id` isn't in the registry goes through `recordFill` with `why:'untracked'` and is logged `UNTRACKED FILL`.
   - Also fetch USDC account transactions (deposit/withdrawal/transfer) and book them via `noteTransfer` with a txn id.

**Acceptance:**
- Replaying 1:59–2:04 PM PT produces an `EQUITY STEP` line naming the asset or transfer.
- Over 2 h, `|gap| < $0.05` or every step is in a named bucket.
- 0 `CANCEL LEFTOVER` after rotation exits.

### 4. Remaining v6 items
- **4a Real fees (v6 F):** `orders.js` L33-39 and `pollOpenOrders` L69. For every `needFee` order call `GET /api/v3/brokerage/orders/historical/fills?order_ids=<id>` (also when the WS is on), sum `commission`, call `pnl.adjustFee`, and write `fee` rows with `src:'venue'`. **Acceptance:** at least 95% of fills are `venue` within 60 s, and the fills ledger shows `feeSrc:'venue'`.
- **4b Per-coin cap counts open bids (v6 I):** `strategy.js` L180-184 and L225 (`nameRoom`). Use `held + openBidsFor(sym)`. **Acceptance:** each coin's inventory plus bids ≤ 25% of equity at every tick.
- **4c Edge (v6 G):** store `placeMid` at place time, add `/api/status.edge[pair] = {n, captureBps, driftBps}` over 1 h, and auto-widen +25 bps when `captureBps − feeBps < 0` with n ≥ 5. **Acceptance:** the fields are present, and a pair with negative edge widens.
- **4d Bank (v6 D):** log the bank uuid and HTTP status, and show `bank: unreadable` when `bankEquity` is null. Persist `bankedTotal` and `transfers` in `logs/state-ladder.json`. **Acceptance:** the dashboard says "unreadable" or matches the Coinbase portfolio within $0.01, and survives a restart.
- **4e Recon (v6 J):** add `gap1hUsd`, alert once per state change (704 repeated alerts today), and add the `unattributed` bucket from item 3. **Acceptance:** at most one alert per episode.
- **4f** Throttled `BID BLOCK <sym> reason=…` log (v6 B follow-up).

## Config (~$9.65 equity)
```
MM_MAX_PAIRS=4
LIVE_FOCUS_N=3
MIN_ORDER_USD=1
CLIP_EQ_FRAC=0.12
CLIP_MAX_USD=1.5
INV_NAME_MAX_FRAC=0.25
INV_BOOK_MAX_FRAC=0.45
CASH_FLOOR_FRAC=0.35
MIN_HALF_SPREAD_BPS=110
MAX_HALF_SPREAD_BPS=180
MAKER_FEE_BPS=35
POST_ONLY=true
MM_LEVELS=1
ROTATE_MIN_HOLD_MS=1800000
ALLOW_MARKET_EXIT=0
EXIT_TICK_MS=15000
EXIT_HALF_BPS=40
EXIT_STEP_BPS=10
EXIT_STEP_MS=120000
EXIT_MAX_AGE_MS=3600000      # was 7200000
STRANDED_TAKER=0             # set 1 to allow one IOC exit for stranded coins only
STRANDED_STOP_PCT=8
STRANDED_MAX_AGE_MS=7200000
FUNDS_COOL_MS=60000
RECENT_SELL_RESERVE_MS=10000
VENUE_RECON_MS=300000
BANK_START_PCT=0
BANK_ROTATE_PCT=0
BANK_ONLY_QUOTE=1
RECON_GAP_USD=0.05
```
