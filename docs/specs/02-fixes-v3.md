# Remaining fixes after commit 666efc6 (Oct 4, 5:05 AM PT)

1. **exit-book.js `tickExits`:**
   - Remove a row once its order fills: check `orderRegistry.get(row.orderId).status === 'filled'` or the live position falling below the minimum size. Right now a filled exit keeps getting re-posted forever and fails with insufficient balance.
   - Re-read the position quantity each tick (amount + hold − open sells), rather than reusing the queued qty.
   - Step the price down: `px = max(bestAsk, mid*(1+EXIT_HALF_BPS/1e4) - k*step)`, with the floor at `basis*(1+2*fee)` (use `pnl.avgBuy`) until `EXIT_MAX_AGE_MS` (7200000) has passed. After that, post at the touch.
   - Skip quantities below `max(ordermin, MIN_ORDER_USD/mid)`, so dust never goes out.
   - Clear the exit row if the symbol re-enters `mmAlloc`, so it doesn't fight `coverInventory`.
   - `row.since` is never updated. Track `lastPostAt` instead and re-post only when `now - lastPostAt >= EXIT_STEP_MS`.
2. **Adopted orders (index.js ~L408):** attach each adopted order to `pairState.get(pair).ladder.buys/sells` (with symbol, level 1, size, price), or cancel any adopted order whose pair isn't in `mmAlloc`. Right now they hold cash or coins the strategy can't see: `onBids` $1.00 with `bids` $0 in the earlier run.
3. **Insufficient-funds spam (159 in 20 min, mostly HONEY sells):** in `strategy.js` `coverInventory()` (L836), `pinL1` sells (L418–423) and `slideSameSide` (L573), size sells from `available = amount − Σ(open sell sizes for the symbol in pairState)`. Skip if that is below the minimum. Add a 60 s per-pair cooldown after an INSUFFICIENT failure.
4. **P3, real fees and mid:** all 57 fills since restart still show `feeSource: 'pending'` with fee 0 at log time, and `mid` is null.
   - In `orders.js` `markOrderFromExchange`, call `ex.getOrderStatus(orderId)` (it already queries `/orders/historical/fills`), then `pnl.adjustFee` and `logFeeUpdate` with `src:'venue'`, and set `rec.taker` from `liquidity_indicator`.
   - Set `rec.mid` from `midRing`/ticker at fill time and pass it into `logFill`.
5. **Bank equity (index.js ~L224/343):** `bankHoldings()` returns `{asset, qty}` with no `value`, so `bankEquity` is always 0. Price each holding with the ticker mid (`qty*mid`).
   - The bank portfolio GET still returns 403 (seen 4:42 AM PT), so check that the bank key can view the bank portfolio, and log which portfolio the fallback `/accounts` call actually reads.
   - Persist the total banked amount across restarts in `logs/state-ladder.json`.
6. **P4, caps while rising:** `strategy.js` `resizeLeg()` is unchanged. Remove the `ret <= 0` conditions at L185, L190 and L191 so `INV_NAME_MAX_FRAC` (0.30), `INV_BOOK_MAX_FRAC` (0.45) and `CASH_FLOOR_FRAC` (0.35) always apply.
7. **P5:**
   - `effPairs` only sets `MM_MAX_PAIRS_HARD` for rotation. Also use it in `resizeLeg` (L192 `pairs`) and `getMmOrderSizeUsd`.
   - Use `max(MIN_ORDER_USD, ordermin*mid*1.05)` for the minimum.
   - Stop names that are over `effPairs` (still in their minimum hold) from bidding: only top-`effPairs` names get bids, the rest only sell.
8. **P8:** expose `recon: {gapUsd, gapPct, alert}` in `/api/status` and the dashboard, using a rolling 1 h window as well as the session total.
9. **Cosmetic:** index.js L111 still prints `rotateMin=900s`; print `ROTATE_MIN_HOLD_MS` instead.
