# crypto-mm ladder: spec v13 (Oct 7, 2026, 4:55 PM PT)

## Design intent (read first)
- **What the bot is:** a **post-only, two-sided spread capturer**. It keeps a bid and an ask per coin outside the fee. After a fill it places another order on the same side and skews the other side.
- **Momentum tilt (rise-hold):** while a coin's 1-minute price is rising, it holds back part of the coin and widens the ask on that part. Rise-hold sets the ask **price**; it never means "no ask."
- **Markets:** the **scanner picks them** (15-minute volatility rank over every online USDC product). No coin names are hardcoded as logic. Names below are **examples only** of observed failures.
- **Blake's order target: 90%.** When order criteria are met, **open book notional (bids + asks) ≥ 90% of tradable equity**. `BOOK_TARGET_FRAC=0.90` stays. Acceptance: **≥ 85% within 10 min** of a restart or deposit, and **`bookPct1h` ≥ 90%** each full hour. If Blake changes `BOOK_TARGET_FRAC`, "90%" means the new value and "85%" means `BOOK_TARGET_FRAC − 0.05`.
- **What v13 does:**
  - **P0:** stops inventing deposits and withdrawals. Only a venue transfer record moves `startEquity`. Fills are captured from cumulative fill quantity, so partial fills on cancelled orders stop vanishing. Adds a way to void a wrong transfer.
  - **P1:** fixes the hot-reload bug that parked every non-rising pair after 4:29 PM, and puts held coins on asks. That missing ask side is the real gap to 90%, not the pair count.
  - **P2:** every sellable position gets a resting full-balance ask, floored to the venue increment.
  - **P3:** floors sell sizes so retries can succeed, and stops pairs sizing bids in parallel from the same cash.
  - **P4:** fixes the status `running` flag and guards against a second ladder process.
- `ALLOW_MARKET_EXIT=0` stays. Everything is post-only. `CLIP_MAX_USD=1.5`, `BID_CLIPS_MAX=8`, `MM_MAX_PAIRS=6` and the default per-coin cap of 0.25 stay.

**Status (live, read-only check at 4:50 PM PT):**
- **Code:** `/opt/crypto-mm` is at `af81074`, and the ladder, shared and web sources under `src/` match the repo byte for byte.
  - The ladder process started at **1:50:22 PM PT** with `b85218e`.
  - `strategy.js` was hot-swapped to `af81074` at **4:29:37 PM PT** (`strategy reloaded`, SIGUSR2). `index.js` and the shared modules still run the 1:50 PM load (unchanged in `af81074`).
  - A **second ladder process** booted at 4:29:49 PM PT. It adopted the 10 open orders, ran the startup sweep and rebalance (the market buy was skipped because `ALLOW_MARKET_EXIT=0`), and exited about 20 s later before reaching the MM loop. It also rotated the logs mid-session.
- **Real P&L:** equity **$21.19** against the real start of **$23.23** (10:41 PM PT Oct 6 plus the $7 deposit) is **−$2.04 (−8.8%)**. Since the 1:50 PM restart (start $21.83) it is −$0.64 (−2.9%).
  - The dashboard shows start **$18.91** and wallet **+$2.28**. Both are fake: `netDeposits −2.91`, `unattributed +1.39`, recon `gapUsd 1.27` (2.5% of volume).
- **False transfers (Blake made no transfer):** all eight `cash-residual` bookings since midnight are false.

| Time (PT) | Booked | startEq after | What really happened | Lasted |
|---|---|---|---|---|
| 1:20:33 AM | −1.50 | 21.73 | HONEY bid `e94d1168` (603.1 @ 0.002487) filled around a cancel; the fill was never reported | permanent |
| 3:50:54 AM | +1.73 | 23.45 | a sell fill that never reached the ledger | permanent |
| 6:31:20 AM | +1.11 | 24.57 | a partial fill (105.09 of 138.81) on a resting ask, unrecorded until the order completed | 11 min |
| 6:42:51 AM | −1.11 | 23.45 | the same order's FILLED event recorded the full 138.81, so the earlier partial was counted twice | (mirror) |
| (1:50 PM restart rebased start to $21.83 and dropped the four overnight entries) | | | | |
| 2:55:59 PM | −1.39 | 20.44 | INV bid `f8c1ca44` (0.1471 @ 10.20) partially filled 0.1359 ($1.39), then cancelled by `TRIM BID INV L2` at 2:55:22 PM; the partial was lost | permanent |
| 3:02:00 PM | −1.51 | 18.93 | a ~$1.50 buy never reached the ledger (order not identified from logs; the venue fills endpoint will name it) | permanent |
| 3:23:33 PM | −1.44 | 17.50 | stale balance snapshot: fills recorded in the ledger before the cached balances showed them | 30 s |
| 3:24:33 PM | +1.42 | 18.91 | the mirror of the row above, once the balances caught up | (mirror) |

  - Holdings proof for 2:55 PM: the INV ask (0.2729) plus free INV (0.1522) total **0.4251**, while recorded buys total 0.1451 + 0.1441 = **0.2892**. The 0.1359 difference × 10.20 + fee = **$1.39**.
  - A replay of `pnl.markHoldings`'s rule over the logged marks (`WORKING` cash + onBids) and the fill log reproduces **all eight bookings** and no others. This makes a usable regression fixture (P0.6).
- **Book** (317 samples, 1:50–4:29 PM PT, before the reload): **70%** of tradable equity on average (78% of target); ≥ 90% in only 6% of samples.
  - The pairs weren't the limit: with ≥ 5 pairs eligible the book averaged **72%**.
  - **Asks covered 26–37% of held coin value**, and coins were 36% of equity. Bids used 75% of USDC.
  - After the reload, eligible pairs dropped from **5.1 to 2.9** on average, and 18 `PARK flat … not in top 4` lines appeared in 20 min (0 in the 2 h 40 m before). That is why the 4:47 PM check read "4 eligible, need 5" at 58%.
- **Exits:** at 4:50 PM the asks on HONEY, VARA and LRDS covered their holdings. GEOD ($0.91) and ORCA ($0.26) are under the $1 minimum.
  - DRB held ~$4.5 with **no working ask for 72 min** (2:25–3:37 PM PT). Every full-balance ask was rounded **up** (23159.54 → 23160), rejected, and retried at the same size: **464 `SELL RETRY`**, 457 logged `Insufficient balance` sells.
- **Insufficient balance, 1:50–4:29 PM PT:** 458 sells (all DRB rounding) and 56 logged buys (MET 16, LCX 9, BLAST 8, W 5, …). The status at 4:50 PM shows `insufficient1h=11` (buys) and `other1h=4`. The 4 "other" are Coinbase `500 INTERNAL` errors.
- **`running` flag:** `/api/status.running.ladder=false` and `/bots → ladder:false` while PID 157084 is up and posting status.
- **Still good:** 0 market orders, 0 taker fees, venue-confirmed fees at 35 bps (117 venue, 0 pending), scanner 403/403 with 0 missing, `exits=[]`, 0 stuck reservations.
  - SuperGrok's post-v12 commits cut churn: logged placements per fill went from **56** (12:09 AM–1:50 PM) to **9.4** (1:50–4:29 PM, `REQUOTE_MOVE_BPS=100`) to about **6** since `af81074`.

Line numbers are at `af81074`. Check them before editing.

## v12 post-mortem (and what SuperGrok changed since)
| v12 item | Result | Notes |
|---|---|---|
| P0.1 count resting bids once | **Done** | `planBook` uses `quoteTotal = free + hold` (`strategy.js` 976–978); `resizeLeg` subtracts open bids once (411–412) and checks cash against `freeQuote × 0.98` (408). |
| P0.2 clips from alloc, per-tick top-up and trim | **Done** | `ADD BID`/`TRIM BID` in `shapeBidDepth` (921–958). But each clip shrinks (`shape.sizeMult`, skew) while the count is `ceil(alloc / 1.5)` (340), so bids land under alloc (P1.4). `TRIM` is also the cancel that lost the 2:55 PM partial fill (P0). |
| P0.3 6 pairs, need 5, stop-margin filter | **Done** | `MM_MAX_PAIRS=6`, `needPairs=5` (981), `STOP_MARGIN=0.01` (`rotate.js` 65). |
| P0.4 refresh on deposit or restart | Done | `refreshAlloc()` on a new transfer (`index.js` 586–590). It now also fires on **fake** transfers. |
| P0.5 venue book cross-check | **Done** | `working.venueBook`, `BOOK DRIFT`. |
| P1 post-fill insufficient sells | **Partly** | The fill-debit ledger and settled retry exist (`free-qty.js`, `exchange.js` 355–371). The retry can't succeed when the size is rounded up (P3.1). |
| P2 one set source | **Done** | `selection.rows` match `markets[].role='in'`; `selectedBy` is shown. |
| P3 transfer persistence (2 marks) | **Failed** | Eight false transfers since midnight (P0.2). |
| (post-v12) `b85218e` requote at 100 bps, `af81074` scale the ladder instead of rebuilding | **Done, works** | Churn dropped about 6× (Status). Side effect: under `af81074`, `pinL1` allows only **one** ask (`maxOpen=1`, 603–610) and never moves it toward the touch once it rests (P2.3). |

## P0. No false transfers; only venue evidence moves `startEquity`
### P0.1 Root cause A: the fill ledger misses partial and unreported fills
- **The user WebSocket passes status only.** `startCoinbaseUserWs` calls `onStatus(id, status)` with no fill fields (`coinbase.js` 186–193). `cumulative_quantity`, `avg_price`, `filled_value` and `total_fees` are dropped.
- **`markOrderFromExchange` records a cancelled order's partial fill only if `detail.filledSize` exists** (`orders.js` 68–78). From the WebSocket it never does, so a partial fill followed by any cancel (`TRIM BID`, `PARK`, `SCALE drop far bid`, soft stop, rotation) is lost. Example: 2:55 PM INV.
- **A FILLED event books the whole order size at completion** (`orders.js` 23–49). Partial fills along the way are unrecorded until then, so the ledger lags by up to the order's lifetime. Example: the 6:31/6:42 AM pair.
- **No fallback sees the venue's truth:**
  - REST polling is off while the WebSocket is on (`orders.js` 94–95).
  - `getOrderStatus` answers from the bot's own registry under the WebSocket (`exchange.js` 447–451).
  - `cancelOrder` throws away the `batch_cancel` reply (`exchange.js` 509–515).
  - Venue recon skips every fill whose order id is in the registry (`venue-recon.js` 84), and it runs only every 5 min.

### P0.2 Root cause B: the balance snapshot is older than the fill ledger, and the two-mark rule can't tell
- `emitStatus` marks with `getLive()` (`index.js` 404), which returns the shared account cache for up to `ACCOUNT_CACHE_MS=8000` (`portfolio.js` 18–22). Fills reach `fillCash` the moment the WebSocket reports them (`pnl.js` 64). A fill recorded after the cached read shows up as a residual of about −(its cash).
  - 3:23 PM: the HONEY sell recorded at 3:22:59.6 PM wasn't in the 3:23:03 PM snapshot (coins +$1.51, cash −$1.51). At the next mark, the DRB sell recorded **0.27 s** before the 3:23:33.9 PM mark wasn't in that snapshot either.
- **The two-mark rule matches any two fills.** Nearly every fill is one $1.0–1.5 clip, so two different stale fills agree within the 2% tolerance (`pnl.js` 171–176). At 2:55 PM the "second" mark reused an identical snapshot (cash $0.32 / onBids $7.53 both times).
- **The equity cross-check is always true.** `residual − residualCash = step − mtm − qtyVal − dCash ≈ 0` by construction (`pnl.js` 167–172). So the test reduces to "cash moved ≥ $1 more than recorded fills."
- **Booking zeroes `sinceFill` while the baseline excludes the late fill** (`pnl.js` 181). When the balances catch up, the mirror image is booked (3:24 PM +1.42; 6:42 AM −1.11).
- **The booked transfer then creates fake P&L.** The `explained = recentTransfer` offset turns the next ~0 equity step into `unattributed` (`pnl.js` 226–239): `EQUITY STEP 1.39 unattributed` at 2:57:29 PM.
- **Equity never moved in any of the eight cases** (for example $21.49 → $21.41 → $21.44 around 2:55 PM). A real deposit moves equity by its full amount.

### P0.3 Fix: capture every fill from the venue
1. **WebSocket:** pass the whole order event to `markOrderFromExchange`: `cumulative_quantity`, `leaves_quantity`, `avg_price`, `filled_value`, `total_fees`, `status`.
2. **Incremental fill accounting:** per order, keep `filledQty`/`filledValue`/`feesAccounted`. On any event (OPEN, FILLED, CANCELLED, EXPIRED) where `cumulative_quantity > filledQty`, call `pnl.recordFill` and `logFill` for the **delta only** (size, value and fees as deltas).
   - FILLED books only the remainder.
   - CANCELLED with a partial books the partial, then marks the order cancelled.
   - Sell deltas also call `noteSellFill`/`consumeHoldSale` for the delta.
3. **`cancelAndSettle(ex, o)`:** one helper for every cancel path (`TRIM BID` 935–937, `PARK` 1138–1142, `SCALE drop` 612–613, `cancelSide`, `cancelCrossed`, `softStop` 874–893, rotation, `exit-book.js`).
   - Read the `batch_cancel` result.
   - Then fetch `GET /orders/historical/{id}` (REST, even with the WebSocket on). Run its `filled_size`/`average_filled_price`/`total_fees` through step 2.
   - Mark the leg cancelled only after that.
4. **Venue recon:** don't skip registry orders. Compare the venue fills per order (sum of `size` by `order_id`, deduped by `entry_id`/`trade_id`) with `filledQty`, and book any shortfall as `LATE FILL <sym> <side> <size> @ <px>`.
   - Run recon every 60 s (`VENUE_RECON_MS=60000`), and immediately after any `CASH UNEXPLAINED` (P0.4).
5. **Poll backstop:** while the WebSocket is on, still REST-poll each order cancelled in the last 60 s once, and sweep open orders slowly (one every 30 s).

### P0.4 Fix: where transfers come from
1. **Only a venue transfer record changes `startEquity`.** This is the existing `/v2/accounts/{id}/transactions` path (`venue-recon.js` 103–127), deduped by record id.
   - At boot and once an hour, log the `type` strings and signed amounts of the last 25 USDC-account records. No ids, addresses or account numbers go in the public logs.
   - Widen the type match if a real deposit type is missing. Last night's $7 deposit was booked by `cash-residual`, not by this path, so it must be checked.
2. **`cash-residual` and `equity-step` become detectors, not bookings.** Remove both `noteTransfer` calls (`pnl.js` 178, 217).
   - Use an **uncached** balance read for marks (`fetchLivePortfolio(…, {fresh:true})`, or bypass the cache in `emitStatus`).
   - Snapshot `fillCash` at the moment of the read: `sinceFill` counts only fills whose `recordedAt ≤ snapshot.fetchedAt`. Later fills carry over to the next mark.
   - Always advance the baseline (`lastCash`, `lastPosMap`, `lastEquity`). Never zero carried fills.
3. **A residual is a suspect, not a transfer.** For `|residualCash| ≥ DEPOSIT_DETECT_USD`:
   - Log `CASH UNEXPLAINED <usd>` and push `{ts, usd, equityStep, qtyStable}` to `recon.suspect[]`.
   - Run P0.3.4 recon right away.
   - A suspect clears when a late fill explains it (within $0.05).
   - If one is still open after 10 min **and** equity stepped by about the same amount with quantities stable, show it as `recon.pendingTransfer` for operator confirmation (P0.5). Never apply it automatically.
4. **Remove the `explained = recentTransfer` offset** (`pnl.js` 228–230). A venue-booked transfer changes `startEquity` only; it never creates `unattributed`.
5. **`recon.alert`** stays true while any suspect is open for more than 5 min, or `|gapUsd| > max($0.10, dust)`.

### P0.5 Fix: persist the baseline; void or add a transfer
- **Persist** `startEquity`, `startedAt`, `transfers[]`, `unattributed` and the per-order `filledQty` in `logs/pnl-state-ladder.json` (gitignored). A restart (like 1:50 PM) or a reload then doesn't silently rebase.
  - Add `pnl.sessionId`. Blake can start a fresh session only on purpose (`PNL_NEW_SESSION=1` at boot).
- **Override file** `logs/transfer-overrides.json` (operator-edited, gitignored), read at boot and on every status tick:
  `{"void": ["<transfer id>"], "add": [{"usd": 7, "ts": 1791..., "note": "deposit"}], "confirm": ["<pending id>"]}`
  - A void reverses its `startEquity` effect and removes any `unattributed` it created. The entry stays in `transfers[]` with `status:"voided"`. Log `TRANSFER VOID <id> start=<new>`.
  - Helper: `node scripts/void-transfer.mjs <id>` appends to the file.
- **Show provenance:** each `transfers[]` entry gets `src` ∈ `venue | operator | legacy-inferred` and `status`. The dashboard flags anything that isn't `venue`/`operator`.
- **This session:** void the four `cash-residual:*` entries (`29856835`, `29856842`, `29856863`, `29856864`). The start returns to **$21.83** (1:50 PM restart), `unattributed` 0, wallet ≈ −$0.64.
  - Optional: start the session from the persisted overnight baseline (operator `add`), so the dashboard shows the real −$2.04 vs $23.23.

### P0.6 Tests (extend `scripts/test-pnl-transfer.mjs`; keep a–f passing in spirit)
- Existing cases a and c (cash-only ±$10/−$5 with no venue record) must now produce **0 transfers** and one `pendingTransfer`. They book only with a venue record or an operator `add`/`confirm`.
- **g (3:23 PM, stale snapshot):** marks (cash + hold / coins / equity): 11.93/9.42/21.34 → 10.42/10.93/21.35 → 11.85/9.52/21.38 → 13.28/8.10/21.37 → 14.79/6.58/21.37.
  - Fills: HONEY buy $1.4999 (fee 0.0052) at +9 s; HONEY sell $1.4408 (0.0050) at +26 s; DRB sell $1.4234 (0.0050) at +60.7 s (0.27 s before mark 3); DIMO sell $1.519 (0.0053) at +103 s.
  - Each snapshot's `fetchedAt` is 1 s before its mark.
  - Expect 0 transfers, `unattributed` 0, no suspect left open after the last mark.
- **h (2:55 PM, partial on a cancelled order):** INV bid 0.1471 @ 10.20. The WebSocket sends OPEN with `cumulative_quantity=0.1359`, then CANCELLED with `cumulative_quantity=0.1359`.
  - Expect one fill of 0.1359 recorded once, 0 transfers.
  - The same with no WebSocket partial and only the REST check in `cancelAndSettle` gives the same result.
- **i (6:31 AM, partial then FILLED):** an ask of 138.81 gets a partial of 105.09, then FILLED.
  - Expect two fills (105.09, then 33.72) and never 138.81 at once. 0 transfers.
- **j (lost fill):** a fill missing from the WebSocket appears in venue recon. Expect `LATE FILL` booked once and the suspect cleared, with `startEquity` unchanged.
- **k (persistence/void):** book a legacy inferred transfer, restart (reload the state file), void it. `startEquity` and `unattributed` return to their prior values, and the void survives another restart.
- **l (real deposit):** a venue record of +$10 plus a matching equity step books exactly once, even if a cash suspect for the same amount was open.

## P1. The book reaches ≥ 90% of tradable equity
### P1.1 The hot reload desynchronised the strategy (cause of "4 eligible" at 4:47 PM)
- SIGUSR2 swaps `strat` to a fresh `strategy.js` module (`index.js` 17–23). But `index.js` still calls the **old** module's `setLiveMmAlloc` (64, 699), `quoteSnap` (216, 485) and `holdInfo` (482–483).
- In the new module `liveMmAlloc` stays `[]`, so:
  - `isTopWeight()` returns false for every pair (`strategy.js` 725), and
  - `effectiveFocusN()` returns 4 instead of 6, though equity $21 < `FOCUS_ALL_EQ_USD=25` (716–722).
  - Every pair that isn't rising in the last minute is **parked and its bids pulled** (1123–1146; `PARK flat` at 1131), then unparked when the 1-minute return turns positive. Eligible pairs fell from 5.1 to 2.9 on average.
- Also lost on reload: `pendingBids`, `holdStart`, `focusLocked`, `pinAt`/`pinMid`, `quoteSnap._miss` and the other module state. The status `quote` fields come from the old module.
- **Fix:** remove the in-process hot reload. Deploy = graceful restart (adopt open orders, P0.5 persistence keeps the baseline).
  - If a reload is kept, it must rebind **every** export through `strat.*`, call `strat.setLiveMmAlloc(mmAlloc)` and `strat.setLivePairState(pairState)` immediately, and carry module state across.
  - Either way, expose `working.strategyLoadedAt` and `working.strategyHash` (a git hash or file hash).

### P1.2 Held coins aren't on asks; `short=pairs`/`short=cash` hide it
- Before the reload, book ≈ 0.3 × coins (36% of equity) + 0.75 × USDC (64%) ≈ 59% of equity ≈ 70% of tradable. **With ≥ 5 eligible pairs it was still 72%.** More pairs alone can't reach 90%.
- `bidTarget = min(quoteTotal × 0.97, bookTarget − askBook)` (`strategy.js` 979). With asks at ~30% of coins, `bookTarget − askBook` exceeds what USDC can fill, so the label reads `cash`. It really means "coins not on asks."
- `shortReason` checks `pairs` first (`index.js` 576), so with 4 eligible the label hides the binding cause.
- **Fix:** P2 (every sellable coin on a full-balance ask). Then `askBook ≈ tradable coin value`, and `bidTarget` is reachable from USDC.
- **Reason order:** `asks` (when `tradableCoinUsd − askBook > 1 clip`), then `cash`, `cap`, `clips`, `pairs`, `veto`.
  - `pairs` only when `Σ capRoom over eligible + askBook < bookTarget`, meaning more pairs really are needed.
  - Add `working.askGapUsd` and `working.capRoomUsd`.

### P1.3 Size the per-coin cap from the eligible count (bounded)
- With 4 eligible pairs and asks covering coins, 4 × 25% can hold 90% only if every pair reaches its cap. Weights and trims leave some room unused.
- **Change:** `capFrac = clamp(BOOK_TARGET_FRAC × 1.1 / max(1, nEligible), INV_NAME_MAX_FRAC, INV_NAME_MAX_FRAC_CEIL)`.
  - New key `INV_NAME_MAX_FRAC_CEIL=0.33`. That gives 0.25 at ≥ 4 eligible, 0.33 at 3, and never more than 0.33.
  - It applies to `capFor` (78–85) and `planBook`'s room. `RISE_COIN_CAP_PCT` follows the same ceiling.
  - `needPairs = ceil(BOOK_TARGET_FRAC / capFrac)`, which is 4 at 0.25.
- Risk limits stay: no coin's inventory cost + open bids > `capFrac × equity` + 1 minimum order. With fewer than 3 eligible pairs the bar is `min(0.85, nEligible × CEIL + askBook/tradableEq)` and `shortReason='pairs'`.

### P1.4 Bids land under alloc, and pairs spend the same cash in parallel
- **Clip count:** `clips = ceil(alloc / CLIP_MAX_USD)` (340), but each clip is shrunk by skew and shape (311, 416).
  - **Fix:** `effClip = CLIP_MAX_USD × the same multipliers` and `clips = min(BID_CLIPS_MAX, ceil(alloc / effClip))`. The last clip takes the remainder if it's ≥ the venue minimum.
- **Parallel spending:** all pairs run `processPair` at once (`index.js` 702–704), and each sizes from the same cached `freeQuote` (`resizeLeg` 408). They overspend, get rejected (P3), then sit out `FUNDS_COOL_MS`.
  - **Fix:** a quote ledger in `free-qty.js`: `spendable = freeQuote(snapshot) − Σ bids placed after snapshotAt + Σ venue-confirmed cancels after snapshotAt`. Reserve before the POST, release on reject.
- **Status:** `working.bidsVsAlloc` = Σ open bids / Σ alloc.

## P2. Every sellable position has a resting ask for its full balance
### P2.1 `ensureAsk` subtracts resting asks twice (`strategy.js` 1075–1093)
- `avail = freeQty(available)` already excludes coins on hold for resting asks. Then `openSz ≥ avail × 0.9 → return` (1077) and `need = avail − openSz` (1087) subtract them again.
- `pinL1` caps a sell at `held × 0.9` (630), and `resizeLeg` sells use `hair = 0.9` (383, 454). Those leave a 10% remainder that `ensureAsk` then refuses to quote.
- **Fix:** unquoted = `avail` (free, not on hold). If it clears `baseMin`/`quoteMin`, post it, split into normal and rise-hold parts as today. When the remainder is under the minimum but remainder + smallest resting ask isn't, cancel that ask (via `cancelAndSettle`) and re-post one combined ask.
- The local check runs **every tick**. `ASK_ENSURE_MS` throttles only the venue refresh.

### P2.2 Floor every sell size to the base increment
- See P3.1. `formatVolume` rounds to nearest, so a full-balance ask can exceed the balance (DRB: 72 min with no working ask).

### P2.3 Keep the ask near the touch under `af81074` scaling
- `pinL1` allows `maxOpen = 1` for sells (603–610) and returns once one ask rests, even when the mid has fallen well below it. Only `softStop` re-prices.
- **Fix (no strategy change):** the non-rise-hold part of a coin's asks must sit within `[0.8, 2.2] × half` of the mid (the v12 L1 tolerance). If it drifts outside for more than `L1_PIN_MS`, re-price it with `cancelAndSettle`, then a full-size re-post. The rise-hold part keeps its wider price.

### P2.4 Coins outside the set and venue-minimum dust
- Coins that left the set keep a full-balance exit ask (exit book) until sold. Same invariant, same floor rounding.
- **Dust under `quoteMin`** (now GEOD $0.91, ORCA $0.26):
  - Keep it out of `tradableEq`, the book target and recon (as today).
  - Re-check every tick. Once `qty × bestBid ≥ quoteMin` (for example GEOD after a +10% move), post a full-balance post-only ask within one tick.
  - If the scanner selects the coin, the first post-fill ask sells the full balance, merging the crumb.
  - No top-up buys of coins the scanner hasn't selected (v12 non-goal). No market orders.
  - Status: `dust.untradeable[].pctToMin`.

### P2.5 Status
- Per market: `askCover = askQty / sellableQty` and `unquotedUsd`. `working.uncoveredUsd` = Σ unquoted value over sellable positions, excluding the 3 s sell-settle window and cooled pairs.

## P3. Insufficient-balance fails
### P3.1 Sells: rounding up (most of today's fails)
- `formatVolume` is `Number(v.toFixed(d))` (`sizing.js` 27–29), which rounds to nearest. Full-balance sells use it:
  - `ensureAsk` (1089, 1093), `softStop` (903), `coverInventory` (1330), and the settled retry (`exchange.js` 361, 396, 430).
  - So `23159.54 → 23160`. The retry recomputes `min(23160, 23159.54)` and rounds back to 23160, so it fails forever: 464 retries on DRB, 2:25–3:37 PM.
- **Fix:** `floorVolume(v, baseIncrement)` for every sell and for the settled retry. Use the product's `base_increment` rather than `lotDecimals` where available. Buys floor too.
  - Never send a sell above `sellable` after flooring. If the floored size is under the minimum, skip it locally (`belowMin`) without a venue call.

### P3.2 Buys: parallel cash use
- MET, LCX, BLAST, W and others failed within seconds of other pairs' placements. Fixed by the quote ledger (P1.4).
- On a buy `Insufficient balance`: refresh, re-size to `spendable`, retry once if ≥ the minimum, and cool only if that fails.

### P3.3 Counting and venue errors
- `failCtx` returns before `noteLimitFail` when the log is throttled (`exchange.js` 332–336), so `limitFails` undercounts. Count every fail, then throttle only the log line.
- Split `other` into `venue5xx` and `other`. Coinbase `500 INTERNAL` gets one retry after 1 s with a fresh client order id, then is counted as `venue5xx`, not as a bot fault.

## P4. Process status and single instance
- **`running` is false while the ladder runs.** `botRunning()` requires `!kid.killed` (`server.js` 59). Node sets `killed=true` once **any** signal is delivered, including the SIGUSR2 that `reloadBot` sends (63–68). After the 4:29:37 PM reload, the flag reads false.
- **That also lets a second instance start.** `startBot` treats a `killed` child as gone (33). The 4:29:49 PM boot was most likely a start issued after the reload.
- **Fix:**
  1. Running = `kid.exitCode == null && kid.signalCode == null`, set false only from the child's `exit` event. Don't use `kid.killed`.
  2. Expose `running.ladder = {up, pid, startedAt, strategyLoadedAt, strategyHash}` in `/api/status` and `/bots`.
  3. **Single-instance lock:** the ladder writes `logs/ladder.pid` at boot. If that pid is alive and is a ladder process, the new one logs `ALREADY RUNNING pid=<n>` and exits **before** adopting orders, sweeping or rotating logs. Log rotation happens only after taking the lock.
  4. If the bot is running but wasn't started by this web server (for example after a web restart), report it as up from the pid file. Don't offer `start`.

## Non-goals
- No market or taker orders; `ALLOW_MARKET_EXIT=0`.
- No hardcoded coins. No change to the scanner ranking, rise-hold logic, spreads, skew math or the `af81074` scaling design, apart from the P2.3 ask tolerance.
- No bigger clips or `MM_MAX_PAIRS`. The per-coin cap rises above 0.25 only via P1.3, bounded at 0.33, and only when fewer than 4 pairs are eligible.
- No new inferred-transfer heuristics that move `startEquity`. When in doubt it's a suspect or pending, never a booking.
- No top-up buys of unselected dust.
- No secrets, keys, account ids, wallet addresses or SSH details in commits (public repo).
- No production edits from this commit. SuperGrok implements and deploys.

## Config deltas
```
VENUE_RECON_MS=60000           # was 300000 (P0.3.4)
ACCOUNT_CACHE_MS=8000          # unchanged for trading; status marks read fresh balances (P0.4.2)
TRANSFER_OVERRIDES_FILE=logs/transfer-overrides.json   # new, gitignored (P0.5)
PNL_STATE_FILE=logs/pnl-state-ladder.json              # new, gitignored (P0.5)
INV_NAME_MAX_FRAC=0.25         # unchanged floor of the cap
INV_NAME_MAX_FRAC_CEIL=0.33    # new (P1.3), cap ceiling when < 4 pairs are eligible
ASK_TOL=0.8,2.2                # new (P2.3), ask band in multiples of half (non-rise-hold part)
BOOK_TARGET_FRAC=0.90          # unchanged; acceptance follows it
CLIP_MAX_USD=1.5  BID_CLIPS_MAX=8  MM_MAX_PAIRS=6  FUNDS_COOL_MS=15000  ALLOW_MARKET_EXIT=0   # unchanged
```

## Implementation order
1. **P4 lock and running flag, and P1.1** (stop hot reload; restart cleanly). This is small, and it removes the parking flap now affecting the live bot.
2. **P0.3** incremental fills and `cancelAndSettle`, then **P0.4** (no inferred bookings, fresh marks), then **P0.5** persistence and overrides, then **P0.6** tests. On deploy, void the four 2:55–3:24 PM entries.
3. **P3.1** floor rounding, then **P2.1/P2.3/P2.4** asks.
4. **P1.4** quote ledger and clip count, then **P1.2** reasons, then **P1.3** cap.
5. **P3.2/P3.3** and the P2.5 status fields.

## Done means (all readable from `/api/status`)
- **Transfers:** after deploy, `pnl.transfers` gains entries only with `src` ∈ {`venue`,`operator`}.
  - The four `cash-residual` entries show `status:"voided"`. `unattributed` is within ±$0.05.
  - `walletGain = lastEquity − startEquity`, where `startEquity` changes only by venue or operator transfers. It survives a restart.
  - `node scripts/test-pnl-transfer.mjs` passes, including g–l.
- **Fills:** `recon.lateFills1h` is reported (late fills are allowed, each booked once). `recon.suspect` is empty in ≥ 55 of 60 min. `recon.gapUsd` is within ±$0.10, or ±0.3% of session volume, whichever is larger.
- **Book:** `working.bookPct ≥ 0.85` within 10 min of a restart or venue-booked deposit, and `working.bookPct1h ≥ 0.90` for every full hour after the first (with ≥ 4 eligible pairs, or the P1.3 bar).
  - `working.askGapUsd ≤ max($1, 5% of tradable coin value)` in ≥ 95% of samples. `working.bidsVsAlloc ≥ 0.9`.
  - `shortReason='pairs'` only when `capRoomUsd + askBook < bookTarget`.
- **Exits:** every sellable position (in set or exiting) has `askCover ≥ 0.98` within 2 min of appearing, in ≥ 95% of samples. No position ≥ `quoteMin` goes more than 60 s without a resting ask.
  - Dust becomes an ask within one tick of crossing `quoteMin`.
- **Insufficient:** `limitFails.insufficient1h ≤ 2`, counted before log throttling. 0 sells sent above floored `sellable`. `venue5xx1h` is reported separately.
- **Process:** `running.ladder.up=true` with the right pid whenever the ladder posts status. A second start logs `ALREADY RUNNING` and exits without touching orders or logs. `working.strategyHash` matches the deployed commit.
- **Still:** 0 market orders, 0 taker fees, venue-confirmed fees, scanner `missing=0`.
