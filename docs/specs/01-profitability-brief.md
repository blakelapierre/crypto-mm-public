# crypto-mm `ladder` bot: change brief (profitability fixes)

Repo: `/opt/crypto-mm` (paths below are relative to it). Line numbers are from the copy running on Oct 4, 2026; check them before editing.
**Hard constraints:** keep scanner-driven market selection (no hardcoded `SYMBOLS`). Post-only maker orders are the default. Never commit secrets.

## 1. Evidence (session Oct 3 9:26 PM PT → Oct 4 2:57 AM PT, Coinbase, Advanced 1: 35 bps maker / 75 bps taker)

- Equity in the trading portfolio went from $4.85 to $3.71 (raw −$1.15). Of that, $0.415 was skimmed to the "trade bot bank" portfolio, so the true change is **−$0.73 (−15%)**. The trading portfolio has fallen from $6.94 to $3.71 since 5:13 PM PT, across 5 restarts.
- Dashboard buckets: PRICE −0.312, MAKER +0.320, FEES −0.270, **GAP −0.469** (the largest).
- **The GAP is unrecorded market orders.** Rotation fired 306 `MM exit`/`MM enter` events in 5.5 h (~56/h). That produced 144 `MARKET SELL (leave rotation)` (~$39 attempted, 48 failed with INSUFFICIENT_FUND) and 17 `seed` market buys (~$22.6). They bypass `orderRegistry`, so they never reach `pnl.recordFill`. The dashboard shows taker fees = 0, and per-symbol buys ($48.45) can't reconcile with sells ($28.61).
- **Whipsaw churn.** BLAST was rotated in and out 58× and market-sold 33×, yet BLAST rose **+31%** during the session; its price P&L is −$0.19. HONEY (+30%) was rotated 49×.
- **The limit-order side is healthy.** Across 232 limit fills, the median capture vs mid was 85 bps (mean ~70–75). Post-fill drift for buys was +7.5 bps at 5 m and +108 bps at 15 m (favorable); sells were −60 bps at 15 m (upside left on the table). There's no adverse selection problem.
- **Inventory is too heavy.** 76% of equity is in coins ($2.83 of $3.71), spread over 34 assets, mostly dust from coin-skims to the bank. There were 50 `PREVIEW_INSUFFICIENT_FUND` failures with 5 pairs on ~$0.88 cash.
- Every fill has `mid=null` and an estimated fee (`feeSource: pending`). As a result, MAKER uses a stale `lastMid` and fees are never confirmed with the venue.

**Takeaway:** remove taker/market churn, cap inventory, and make the books reconcile. The maker edge (~85 bps half-spread against a 35 bps fee) is what makes money.

## 2. Changes, in priority order

### P1. Rotation churn: hysteresis, minimum hold, slower cadence
**Files:** `src/shared/rotate.js` `planRotation()` (L5–80); `src/bots/ladder/index.js` rotation loop (L123–186).
- **Problem:** the fall exit drops a name after `FALL_EXIT_MS` = 60 s if its 1 m return is below −0.2% (L19–23). The `RISE SWAP` block (L60–72) evicts any held name whose return is lower than a new riser's, and it ignores `VOL_ROTATE_MIN_MS`. The `CASH FLOOR flatten` (L38–47) also force-exits names. The loop runs every 60 s (`VOL_ROTATE_MS`, index.js L184).
- **Change:**
  1. Enforce `ROTATE_MIN_HOLD_MS` (default 1800000 = 30 m) for every exit reason, including fall exits, swaps, and cash floor. Allow only one emergency exit, `ROTATE_STOP_RET`: the 15 m return falls below −0.04 **and** the name is held at least `ROTATE_STOP_MIN_MS` (300000).
  2. Replace the 1 m `ret1` test with a 15 m window and hysteresis. Exit only if `rangePct < VOL_EXIT_PCT` **and** the score has stayed below the entry score × `ROTATE_EXIT_HYST` (0.6) for `ROTATE_CONFIRM_TICKS` (3) consecutive scans.
  3. RISE SWAP: swap only if the candidate's score is at least `SWAP_SCORE_MULT` (1.5) × the worst held name's score, the worst name is past its minimum hold, and **at most one swap happens per `SWAP_COOLDOWN_MS` (900000)**. Add `ROTATE_MAX_PER_HOUR` (4) as a global cap.
  4. Re-entry cooldown: a name that left can't re-enter for `REENTER_COOLDOWN_MS` (1800000). The existing `watch` map (index.js L153–160) can be reused.
  5. Default `VOL_ROTATE_MS=300000`.
  6. Score names on spread and volume viability rather than raw 15 m return. Rank on `rangePct` and the quoted book spread. Skip any pair whose book spread is above `MAX_BOOK_SPREAD_BPS` (250) or whose 24 h volume is below `MIN_24H_VOL_USD` (50000).
- **Acceptance:** over a 6 h live run, fewer than 25 rotation events and no name rotated more than 2×. No name exits sooner than 30 m after entry except through `ROTATE_STOP_RET`, and each such exit is logged with its reason.

### P2. Rotation exits with post-only limits, not market orders
**Files:** `src/shared/bank.js` `liquidateSymbols()` (L171–198), `seedNewInventory()` (L200–223); `src/shared/exchange.js` `_touchThenMarket` (L155–190), `marketBuy` (L192), `marketSell` (L209); `src/bots/ladder/index.js` L174–179; `src/bots/ladder/strategy.js` `coverInventory()` (L836–862).
- **Change:**
  1. At index.js L177, replace `liquidateSymbols(...)` with an **exit-work queue**. Move leaving names into `exitBook: Map<symbol, {qty, basis, since}>`. Each tick, post a **post-only** sell at `max(bestAsk, mid*(1+EXIT_HALF_BPS/1e4))` with `EXIT_HALF_BPS` default 40, using `ex.limitOrder` so it gets registered. Step the price down toward `bestAsk` every `EXIT_STEP_MS` (120000), but never below `basis*(1+2*fee)` until `EXIT_MAX_AGE_MS` (7200000) has passed.
  2. Max-age fallback: after `EXIT_MAX_AGE_MS`, sell at the touch (post-only at bestAsk) for one more `EXIT_STEP_MS`. Only then allow a market sell, and only if the notional is at least `MARKET_EXIT_MIN_USD` (2) and `ALLOW_MARKET_EXIT=1` (default **0**).
  3. **Never market-sell dust.** Skip any position below `max(ordermin*price, MIN_ORDER_USD)`. Dust stays put; it isn't sold or skimmed.
  4. Remove the `seedNewInventory` market buys (L220) and let normal L1 post-only bids build inventory. If seeding is kept, it should be a post-only bid at the bid, gated by `SEED_MODE=limit|off` (default `off`).
  5. Set `MARKET_TOUCH_WAIT_MS` default to 0 whenever market orders are disabled, so `_touchThenMarket` isn't reached at all.
- **Acceptance:** the console shows zero `MARKET SELL` and `MARKET BUY` lines with defaults on. Exit orders appear in the fill log as `place`/`fill` rows with `why:'exit'`. There are no INSUFFICIENT_FUND errors from exits.

### P3. Full order and fill ledger with real Coinbase fees
**Files:** `src/shared/exchange.js` `marketBuy`/`marketSell` (L192–221), `limitOrder` (L223–282, registry `set` at L249/269/280), `getOrderStatus` (L284–320, which already calls `/orders/historical/fills` at L307), `coinbaseFee` (L14); `src/shared/orders.js` `markOrderFromExchange()` (L6–47); `src/shared/pnl.js` `recordFill()` (L45–83); `src/shared/fill-log.js` `logFill()` (L169).
- **Change:**
  1. Register **every** order in `orderRegistry`, including market orders (`res.success_response.order_id`), touch orders, and bank-related orders. Include `{taker:true, ordertype:'market', why}` where relevant.
  2. On FILLED, or on CANCELLED/EXPIRED with `filledSize > 0` (**partial fills are currently dropped at orders.js L46**), fetch `/api/v3/brokerage/orders/historical/fills?order_ids=` and record the actual `size`, `price`, `commission`, and `liquidity_indicator` (MAKER/TAKER). Set `rec.taker` from `liquidity_indicator`.
  3. Stamp `rec.mid` with the book mid at **order placement** and at **fill detection** (from the ticker WS / `midRing`). Use the fill-time mid for MAKER (pnl.js L54). Store both so the adverse-selection drift can be computed later.
  4. Keep the "est" fee only until the venue fee arrives, then reconcile with `adjustFee` (already present). Log `fee` rows with `src:'venue'`.
- **Acceptance:** for a session, the sum of ledger buys and sells per symbol, plus starting and ending holdings, reconciles quantity within lot rounding. `takerFees` is non-zero whenever any taker fill happens. At least 95% of fills have `feeSource:'venue'`. |GAP| stays at or below 2% of traded notional (see P8).

### P4. Inventory discipline
**Files:** `src/bots/ladder/strategy.js` `resizeLeg()` buy branch (L178–231), `inventoryCapUsd()` (L77–81), `riseHoldFrac()` (L43–49).
- **Change:**
  1. Make `DEPLOY_CASH` default `0` (L218). When `ret>0`, L219–224 currently size an L1 bid to **all** `cashLeft`.
  2. Apply the per-name cap `cap*INV_CAP_HARD` (L184) **always**, and remove the `ret <= 0` exemptions at L185, L190, and L191. The book cap (`INV_BOOK_MAX_FRAC`) and the cash floor (`CASH_FLOOR_FRAC`) must block new buys regardless of trend.
  3. Clip each order to `min(CLIP_EQ_FRAC*equity, room)`, but never below the exchange minimum; if the minimum is larger than the room, skip the bid.
  4. `inventorySkew()` (L82–92): keep it, but point the target at `INV_SKEW_TARGET` (default 0.15).
- **Defaults:** `DEPLOY_CASH=0`, `INV_NAME_MAX_FRAC=0.30`, `INV_CAP_HARD=1.0`, `INV_BOOK_MAX_FRAC=0.45`, `CASH_FLOOR_FRAC=0.35`, `CLIP_EQ_FRAC=0.25`.
- **Acceptance:** total inventory stays at or below 45% of equity, and no single name exceeds 30%, sampled every status tick (except transient overshoot from a single fill of at most one clip).

### P5. Pair count scaled to equity and minimum order
**Files:** `src/shared/rotate.js` L9 (`hardMax`); `src/bots/ladder/index.js` L129; `src/shared/portfolio.js` `getMmOrderSizeUsd()` (L231–236); strategy.js `resizeLeg` L192.
- **Change:** compute `effPairs = clamp(floor(freeQuote_plus_inventory / (minOrderUsdEff * PAIR_CASH_K)), 1, MM_MAX_PAIRS)`. `minOrderUsdEff = max(MIN_ORDER_USD, ordermin*mid*1.05)` across candidates, and `PAIR_CASH_K` defaults to 2.5, so each pair can carry one bid plus one ask of inventory. Recompute every rotation tick and use it for `hardMax`, `pairs`, and the `getMmOrderSizeUsd` divisor. At $3.70 this gives 1 pair; at $25, 5 pairs.
- **Acceptance:** `PREVIEW_INSUFFICIENT_FUND` errors stay below 1 per hour, and the log prints `effPairs=` on every change.

### P6. Bank skim: no dust, no collisions, equity includes the bank
**Files:** `src/shared/bank.js` `skimToBank()` (L123–169); index.js L174 (rotation skim), L396–401 (startup skim), L414–417 (orphans skimmed at 100%); `src/shared/pnl.js` `snapshot()` (L109–124); `src/web/server.js` (Wallet KPI).
- **Change:**
  1. Skim **USDC only**, only from **realized** profit since the last skim, only when the amount is at least `BANK_MIN_USD` (0.25), and at most every `BANK_INTERVAL_MS` (3600000). Remove the coin skims (L139–149 loop) and the rotation skim at index.js L174 (`BANK_ROTATE_PCT` → removed, or default 0).
  2. Skip skimming entirely while any exit or sell order for that asset is open. That removes the race between INSUFFICIENT_FUND failures and sells.
  3. Pause skimming while the session's `walletGain` is negative, so working capital isn't drained while the bot is losing.
  4. Dashboard: show `tradingEquity`, `bankEquity` (bank holdings × mid), and **`totalEquity = trading + bank`**. Compute alert drawdowns on `totalEquity`.
- **Defaults:** `BANK_START_PCT=0`, `BANK_ROTATE_PCT=0`, `BANK_MIN_USD=0.25`, `BANK_INTERVAL_MS=3600000`, `BANK_ONLY_QUOTE=1`.
- **Acceptance:** no `BANK move` rows for non-USDC assets, no new dust assets created, and the dashboard total equals the sum of the trading and bank portfolios in Coinbase within $0.01.

### P7. Restarts must not cancel-and-flatten with market orders
**Files:** `src/bots/ladder/index.js` `main()` L394 (`cancelAll` at startup), L403–421 (`startup sell non-MM` → `liquidateSymbols`, then a 100% skim), L422 `rebalanceCombined`; `src/shared/portfolio.js` `rebalanceCombined()` (L238–301; market sells at ~L262/278, market buys at ~L298/323); `configs/ladder.env` `CANCEL_ALL_ORDERS_ON_STARTUP=true`, `PORTFOLIO_FRACTION=0.25`.
- **Change:**
  1. At startup, **adopt** open orders (load them into `orderRegistry`/`pairState` from `/orders/historical/batch?order_status=OPEN`) instead of cancelling them. Default `CANCEL_ALL_ORDERS_ON_STARTUP=false`.
  2. Hand non-MM holdings to the P2 exit-work queue (post-only); never market them.
  3. Disable the market-cap sleeve: `PORTFOLIO_FRACTION=0` by default, so `rebalanceCombined` does nothing and doesn't trigger CoinGecko.
  4. Persist `pnl` start equity and the bank baseline to `logs/state-ladder.json`, so a restart doesn't reset the session P&L. The sessions table should still split per run.
- **Acceptance:** a restart produces no market orders and no cancel storm, existing post-only orders survive it, and wallet P&L carries across it.

### P8. P&L reconciliation metric and alert
**Files:** `src/shared/pnl.js` `snapshot()` L109–124 (it already computes `other`); `src/bots/ladder/index.js` `emitStatus()` L200–354; `src/web/server.js`.
- **Change:** add `gapPctNotional = |otherPnl| / max(1, tradedNotional)` and `gapUsd`, computed on a rolling 1 h window and for the whole session. When `|gapUsd| > RECON_GAP_USD` (0.05) **or** `gapPctNotional > RECON_GAP_PCT` (0.02), log `RECON ALERT` with the top contributors (unregistered orders, partial cancels, bank moves, unpriced assets). Add `recon:{gapUsd,gapPct,alert}` to `/api/status` and show it in red on the dashboard. Optionally pause new bids while the alert is active, controlled by `RECON_PAUSE=1` (default 0).
- **Acceptance:** with P2 and P3 in place, a 6 h run keeps |GAP| at or below 2% of notional and fires no alerts. Injecting one unregistered market order in dry-run testing (a fake fill) fires the alert.

### P9 (small, recommended)
- `MIN_HALF_SPREAD_BPS=100` (round trip ≥200 bps against 70 bps of fees). Keep `MAX_HALF_SPREAD_BPS=160`, `MAKER_FEE_BPS=35`, `POST_ONLY=true`, `MM_LEVELS=1`.
- Sells were 60 bps early at 15 m. Consider `RISE_SELL_EXTRA_BPS=40` (already the default) and leave `RISE_INV_HOLD` at its default 0.08. Don't add hold logic until P1–P8 have landed.
- Log every fill to `fills-ladder.jsonl` with `mid` (currently always `null`) and `why` (`l1`, `cover`, `exit`, `slide`, `seed`).

## 3. Default config summary (`configs/ladder.env` and/or liveConfig)
```
# rotation (P1)
VOL_ROTATE_MS=300000
VOL_ROTATE_MIN_MS=1800000
ROTATE_MIN_HOLD_MS=1800000
ROTATE_STOP_RET=-0.04
ROTATE_STOP_MIN_MS=300000
ROTATE_EXIT_HYST=0.6
ROTATE_CONFIRM_TICKS=3
SWAP_SCORE_MULT=1.5
SWAP_COOLDOWN_MS=900000
ROTATE_MAX_PER_HOUR=4
REENTER_COOLDOWN_MS=1800000
FALL_EXIT_RET=-0.04
FALL_EXIT_MS=300000
MAX_BOOK_SPREAD_BPS=250
MIN_24H_VOL_USD=50000
# exits (P2)
EXIT_HALF_BPS=40
EXIT_STEP_MS=120000
EXIT_MAX_AGE_MS=7200000
ALLOW_MARKET_EXIT=0
MARKET_EXIT_MIN_USD=2
SEED_MODE=off
MARKET_TOUCH_WAIT_MS=0
# inventory (P4)
DEPLOY_CASH=0
INV_NAME_MAX_FRAC=0.30
INV_CAP_HARD=1.0
INV_BOOK_MAX_FRAC=0.45
CASH_FLOOR_FRAC=0.35
CLIP_EQ_FRAC=0.25
INV_SKEW_TARGET=0.15
# pairs (P5)
MM_MAX_PAIRS=5
PAIR_CASH_K=2.5
MIN_ORDER_USD=1
# bank (P6)
BANK_START_PCT=0
BANK_ROTATE_PCT=0
BANK_ONLY_QUOTE=1
BANK_MIN_USD=0.25
BANK_INTERVAL_MS=3600000
# startup (P7)
CANCEL_ALL_ORDERS_ON_STARTUP=false
PORTFOLIO_FRACTION=0
# recon (P8)
RECON_GAP_USD=0.05
RECON_GAP_PCT=0.02
RECON_PAUSE=0
# spreads (P9)
MIN_HALF_SPREAD_BPS=100
MAX_HALF_SPREAD_BPS=160
MAKER_FEE_BPS=35
POST_ONLY=true
MM_LEVELS=1
```
Add the new keys to `src/shared/live-config.js` (key list L5–40) so they can be tuned live.

## 4. Testing plan
1. **Unit/offline:** replay `logs/archives/px-ladder-*.jsonl` and `vol-scan-ladder.json` through `planRotation()` with the new rules. Assert fewer than 25 rotations per 6 h and that no exit happens before the minimum hold. Replay tonight's fills plus the reconstructed market orders through `createPnl()` and assert GAP ≈ the taker fees plus spread cost.
2. **Dry run:** `DRY_RUN=true` (`env.js` L73; `exchange.js` registers `dry-` order ids at L248 and turns market calls into no-ops at L194/L210). Dry orders never fill, so this checks order flow and logging, not P&L. Run for 2 h and check:
   - zero `MARKET` lines
   - exit queue posts and steps
   - `effPairs` correct for the equity
   - no cancel storm on restart
   - recon metric present
   - a fake injected fill triggers `RECON ALERT`
3. **Live small:** use the current ~$3.70 (`effPairs` = 1) for 24 h. Pass criteria:
   - zero market orders
   - |GAP| at or below 2% of notional
   - fewer than 25 rotations
   - inventory at or below 45%
   - INSUFFICIENT_FUND below 1 per hour
   - `walletGain + bank` at or above 0 after fees

   If 24 h passes, add capital in steps (e.g. $25 → `effPairs` = 3, then larger). Re-check the same metrics at each step.
4. **Rollback:** keep the old `configs/ladder.env` as `ladder.env.bak`. Every new behavior should sit behind its env key so it can be reverted without a code change.
