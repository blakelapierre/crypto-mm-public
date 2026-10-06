# crypto-mm ladder: spec v9 (Oct 6, 2026, 9:05 AM PT)

## Design intent (read first)
- **What the bot is:** a **post-only, two-sided spread capturer**. It keeps one bid and one ask per coin outside the fee. After a fill it places another order on the same side and skews the other side (README; `261bc7d`/`00e2c60`, Sep 26).
- **Momentum tilt (rise-hold):** while a coin's 1-minute price is rising, it holds back part of the coin from sells and widens the ask. When the rise stops, it sells that held part at the best ask (`639058b`/`838ace3`, Sep 29).
- **Markets:** the **scanner picks them** (15-minute volatility rank over every online USDC product). No coin names are hardcoded as logic; names below are examples only.
- **What v9 does:**
  - Makes the scanner see the **whole universe** again. One delisted product is blanking a batch of 25.
  - Makes a selected pair **actually quote**, or say why it isn't, and frees the slot if it stays idle.
  - Keeps **inventory small**, which is where the money is lost: a cost-based per-coin cap with no bypasses, a skew that starts at zero inventory, one trend gate, and de-risking that starts at the turn instead of at the −4% stop.
  - Routes **every sell through one sizer**, so it never asks for more coin than is free.
  - Fixes the fee labels. The fees are real; the labels say "pending".
- Everything stays post-only. The stranded-coin taker (v8 item 2) is the only market path.

**Status:**
- Code is at `50ecf81` (server and GitHub match). The bot restarted Oct 4 at 8:40 PM PT.
- Session from 8:40 PM Oct 4 to 9:00 AM Oct 6:
  - equity $9.39 → $6.87 (wallet −$2.52)
  - maker +$8.24, fees −$3.06 (net maker **+$5.19**)
  - price **−$7.63**, other −$0.08
  - 734 fills
- **No working bid in 74%** of the 4,346 half-minute status samples, and **no orders at all in 45%**. At 9:00 AM PT, NMR ("quoting, held 255m") and BLAST were both 0/0.

Line numbers are at `50ecf81`. Check them before editing.

## v8 status (from code and the logs since 8:40 PM PT Oct 4)
| v8 item | Status | Evidence |
|---|---|---|
| 1 Exit queue | **Done** | 52 `EXIT sell`, 0 decimals errors, 0 shrink re-posts, 77 post-only retries handled. `/api/status.exits` and `dust` are present. |
| 2 Stranded taker | **Done, fee gap** | 1 event (PLU 9.09, $1.40). `strandedTaker.fee`/`feesSession` show 0, but the venue charged a taker fee (`pnl.takerFees` 0.0105). |
| 3 Sell sizing | **Partial, failing** | `free-qty.js` is used only in the `resizeLeg` sell branch. **1,460** `Insufficient balance` (~40/h vs. the target of <5/h); 956 come right after a `COVER SELL`. See item 3. |
| 4 Real fees | **Done; labels wrong** | 734/734 fills have a venue fee row (35.0 bps = the tier maker rate, matching `transaction_summary`). But every fill still shows `feeSource:'pending'` in the API and the ledger. See item 4. |
| 5 Rising cap | **Partial** | `capFor` is in place, but the cap leaks (min-size bump, slide and skew bypass it). MNDE reached ~$6.5 (~80% of equity) at 11:41 PM PT Oct 5. |
| 6a Equity steps | **Done** | Skip guard removed, 0 `EQUITY STEP`, session gap −$0.08, `gap1hUsd` $0.0004. 376 `CASH JUMP unconfirmed` lines are noise (item 5). |
| 6b Orphan orders | **Partial** | `rec.orphan` is set, and 0 untracked fills were seen. There is no re-list or `CANCEL LEFTOVER` after `cancelPair`. |
| 6c Venue recon | **Done** | Cursor, transfers and state file are in place. 0 untracked fills and 0 transfers this session. |
| 6d Bank unreadable | **Done** | `bankUnreadable` is in the API. |
| 6e Open bids in cap | **Done, leaks** | `openBidUsd()` is counted, but see item 2c. |
| 6f Recon/logs | **Partial** | `gap1hUsd` and `gapPct` are done. `BID BLOCK` is **missing** (0 lines); item 1b replaces it. |
| 7 Banking | **Done** (unchanged) | Skims stay 0. |

## 1. Scanner: one bad product blanks a batch (top priority)
### 1a. Batch 400 on `best_bid_ask`
**Where:**
- `src/shared/vol-scan.js` `fetchAllMids()` L15-65; the REST batch loop is L45-63, called from `createVolScan()` L204.
- `src/shared/exchange.js` `getProducts()` L48-66.
- `src/bots/ladder/index.js` L461 loads `productMap` **once** at startup.

**Root cause:**
- Pairs without a websocket mid (L36-39) are fetched 25 at a time. A 400 on the batch is caught at L59-61, and the whole batch is dropped.
- IP-USDC was delisted around 8:20 AM PT Oct 5: `market/products` no longer lists it, and `market/products/IP-USD` returns 404. But it stays in `productMap` because products load once and L56 filters only `is_disabled`.
- From then on, every scan logs `vol scan batch skip 25 Coinbase 400 …product_ids=IP-USDC…` (1,452 times, about 59/h). The universe shrinks from **n=403 to n=378**: exactly one batch of 24 good products is missed every minute, and the bad id is always in it.

**Change:**
1. **Bisect on 400.** On a 4xx for a batch:
   - Split it in half and retry each half (120 ms apart), recursing down to single ids (at most ~2·log2(25) ≈ 10 extra calls).
   - Any **single** id that still returns 4xx goes into `quarantine[id] = {reason, status, firstAt, until: now + VOL_QUARANTINE_MS}`.
   - Mids from the good halves are used in the **same** scan.
   - 5xx or timeouts: retry the batch once, with no bisect and no quarantine.
2. **Quarantine with TTL.** `fetchAllMids` and the ranker skip quarantined ids. After `until`, probe the id alone once; on success remove it, on failure double the TTL (up to 24 h). Log `SCAN QUARANTINE <id> <status>` once per id and `SCAN RELEASE <id>` when it clears.
3. **Tradable filter in `getProducts()` L56.** Keep a product only if all of these hold:
   - `status === 'online'` (when present)
   - `!is_disabled`, `!trading_disabled`, `!cancel_only`, `!view_only`
   - not in auction mode (when the field exists)
   - `limit_only` and `post_only` are fine, because we only post limits.
4. **Refresh products** every `PRODUCTS_REFRESH_MS` (30 min) and right after a new quarantine.
   - Products that disappear leave the scan universe.
   - If the bot holds a delisted coin, its exit row gets `lastErr:'not tradable'` and it goes to `dust` (no order attempts).
5. **Log the full failing batch once** (ids only, no headers) instead of the 80-character truncation at L60.
6. **API:** `/api/status.scanner = {universe, scanned, wsMids, restMids, missing, batchErrors1h, bisectCalls1h, quarantined:[{id, status, untilPT}], productsAt, lastScanAt}`. The dashboard shows `scanner n=402/402 q=1`.

**Acceptance:**
- Within one scan of restart, `n` equals the online universe (402 today, not 378).
- 0 `vol scan batch skip` lines after the first minute.
- `scanner.quarantined` lists the bad id with a TTL, and `scanner.missing` = 0.
- A product flipped to `trading_disabled` leaves the universe within 30 min.

### 1b. Selected pairs that don't quote
**Where (every gate that can silently zero a bid):**
- `src/bots/ladder/strategy.js`:
  - `processPair()` PARK branch L679-704 (not in the top `LIVE_FOCUS_N` 1m weights and not rising)
  - `liveTapeReady()` early return at L706, which also skips cover
  - `generateLadder()` L150: `buyLevels = 0` when the 15m return < 0 or in rip cooldown
  - `resizeLeg()` buy branch L193-261:
    - L197: `ENTER_RET_MIN` on the **15m** return
    - L199: name cap
    - L225: book cap
    - L226: cash floor
    - L229: rank ≥ pairs
  - `pinL1()` L401: no bid when the **1m** return < 0; L420: `siblingHasBareBids`
  - `ensureBothSides()` L497 `buyGate`
- `src/bots/ladder/index.js` L172 labels every in-set pair `quoting, held Nm`, whatever it is doing.

**What happened (6:26–8:48 AM PT Oct 6, 2 fills):**
- NMR showed 0/0 in 224 of 283 samples, ARPA 79/80, BLAST 71/73, and RLC 75/80.
- From the price log, the 15m-return-below-0 OR 1m-return-below-0 condition was true **62–84%** of the time on these coins (NMR 72%, BLAST 84%). Three overlapping trend gates on different windows block bids most of the time on any high-range coin. The 1m sign flips every few seconds, so the bid also flickers (320 REQUOTE, 121 FREE L3 in the window).
- With no inventory there is no ask either.
- The slot is never freed: rotation needs a candidate scoring ≥1.5× the incumbent, and the scanner was missing 25 products. NMR sat selected and idle for 255 minutes.

**Change:**
1. **One bid gate.** Add `bidGate(a, live) → {ok, reason}` and call it from `generateLadder`, `resizeLeg`, `pinL1` and `ensureBothSides`.
   - Remove the separate 15m (L150, L197) and 1m (L401) trend checks; the trend rule is item 2a.
   - Reasons: `park | tape | trend | peak | cap | book | cash | rank | cool | rip | sibling`.
2. **Quote state per pair.** Keep `quote = {bids, asks, bidWhy, askWhy, since, idleMin}`, with `askWhy` one of `noInv | dust | cooled | riseHold`.
   - Expose it in `/api/status.markets[].quote`.
   - Replace the L172 text with the real state, for example `idle 41m: bid=trend ask=noInv`.
   - Log `BID BLOCK <sym> reason=<r>` only when the reason changes (this also closes v8 item 6f).
3. **Idle release.** If an in-set pair has had no open bid **and** no inventory above `MIN_ORDER_USD` for `IDLE_RELEASE_MS` (15 min):
   - Rotate it out even inside `ROTATE_MIN_HOLD_MS`. There is nothing to exit.
   - Add it to `watch` with the normal re-entry cooldown, and fill the slot from the scanner.
   - Log `ROTATE idle <sym> <bidWhy> <min>m`.
4. **De-flicker:** a bid pulled by `bidGate` may be re-posted only after the reason has cleared for `BID_GATE_HYST_MS` (30 s).

**Acceptance:**
- No in-set pair shows `quoting` while it has 0 orders.
- Every 0-bid pair has a `bidWhy`.
- A pair idle for 15 min with no inventory is replaced on the next rotation tick.
- Samples with no working bid fall from 74% to under 30% over 12 h.
- REQUOTE+FREE churn per fill drops by half.

## 2. Inventory risk: the main loss driver
**What the logs say** (price log plus fills, 8:40 PM Oct 4 to 8:48 AM Oct 6; the reconstruction gives −$6.74 of the −$7.63 price P&L):
- **Size is the driver.** Price P&L by the dollar inventory held in a coin: <$1 **+0.15**, $1–2 **−1.37**, $2–3 **−0.45**, ≥$3 **−5.07**.
  - Holdings of $3 or more (about 35–45% of equity) made 75% of the loss.
  - Peak per-coin inventory: MNDE $6.54 (11:41 PM PT Oct 5, 134 min above $3), MAMO $4.59, KAIO $4.50, DIMO $4.37, RAD $5.48, WELL $4.25.
- **The loss happens at the turn, not deep in the slide.** Price P&L by how far the coin was below its 15m high:
  - 0–0.5%: −4.51
  - 0.5–1%: −1.75
  - 1–2%: −2.08
  - 2%+: **+1.60**
  - By trailing 5m return, every positive bucket lost (−7.3 total), and the negative buckets made +0.8.
- **Buying the dip is not what hurts.** Buy fills averaged a positive 15m forward return in every pre-fill bucket except a 5m return of −1% to −2% (n=9, −0.5%) and −1% to −0.5% off the high (n=29, −1.0%).
- **The −4% stop is late:**
  - Its 52 firings came at a median 5.8% below the 15m high.
  - Where the price was logged afterwards, it rose: +0.2% at 5m, +1.3% at 15m, +4.8% at 60m (median).
  - Most stops had already-sold inventory; the coin was lost earlier.
  - A trigger at 1.5% off the 15m high fired a mean of 19.5 min earlier at a median price 3.3% better.

So: keep inventory small, de-risk at the turn, don't panic-sell deep drawdowns, and use a mild trend gate.

### 2a. Trend gate (in `bidGate`, item 1b)
- `trend`: no bids while the **5m** return < `TREND_BID_MIN_5M` (−1.0%). Re-enable when the 5m return is ≥ −0.25% and the 1m return is ≥ 0. On the 6:26–8:48 window this blocks 10–33% of the time, vs. 62–84% today.
- `peak`: no bids while the coin is ≥ `PEAK_OFF_PCT` (1.5%) below its 15m high **and** the 1m return ≤ 0 **and** the coin's inventory ≥ 1 clip. A flat book can still bid the dip, which the data supports.

### 2b. Per-coin cap on **cost**, with no bypass
**Where:** `strategy.js`:
- `capFor()` L78-85 and `inventoryUsd()` L74-77 (cap on **mark value**: a falling coin frees room to buy more)
- the `resizeLeg` buy branch L193-261 (L257 bumps `useUsd` up to `minUsd` even when `nameRoom` is ~0; L260 does the same for `minV`)
- `slideSameSide()` L606-630 and `skewOtherSide()` L632-664, which post `filledLeg.size`/`best.size` with **no** `resizeLeg`

**Change:**
1. `costHeld(sym) = remaining qty × average cost` (from `holdBasis`/`recordFill`) **+ open bids**. Cap: `costHeld ≤ capFor(sym)`. A falling coin never gains room.
2. Bump to the minimum only if `nameRoom ≥ minUsd`; otherwise return 0 with reason `cap`. The same rule applies on L260.
3. All buy placements go through `resizeLeg` and `bidGate`: slide-buy, skew-buy, pin, ensure, EXPAND, placeLadder. No raw `filledLeg.size` buy.
4. Re-read `openBidUsd` **after** each placement in the same tick. Keep a per-symbol `pendingBidUsd` until the next snapshot so two legs can't both see the same room.
5. **Rising cap (decision for Blake):** the data puts the loss on large holdings near the 15m high, which is exactly what `RISE_COIN_CAP_PCT=0.35` allows. I recommend `RISE_COIN_CAP_PCT=0.25` (that is, off) until 24 h of v9 data. The code keeps the knob.

### 2c. Inventory-aware skew that starts at zero inventory
**Where:** `inventorySkew()` L97-107. Its `target = min(0.45, 0.9/n)` is 0.45 at 2 pairs, so **no skew happens until a coin is already at 45% of equity**, above every cap.

**Change:**
- `u = costHeld/capFor` (from 0 to 1).
- **Bid:** half-spread `= base × (1 + INV_SKEW_BID_K·u)` (K=1.0: twice as wide at the cap), and size `= clip × (1 − u)`. Below the minimum order, no bid (`cap`).
- **Ask:** half-spread `= max(feeFloor, base × (1 − INV_SKEW_ASK_K·u))` (K=0.4), and never below the break-even over basis that `coverInventory` already uses (L881-885).
- Log `SKEW` only when `u` moves by ≥0.1.

### 2d. De-risk at the turn, before the stop
**Where:** the rise-hold release in the `resizeLeg` sell branch L262-293 (`HOLD EXIT` only sells the held-back fraction); `rotate.js` `planRotation()` L19 and L36-42 (`ROTATE_STOP_RET` on the 15m return); `exit-book.js` `queueExit()` L42.

**Change:**
1. **Soft stop (new):** if `costHeld > TRIM_TO_CLIPS × clip` and (the coin is ≥ `PEAK_OFF_PCT` off its 15m high with 1m ≤ 0, **or** the 5m return < `TREND_BID_MIN_5M`):
   - pull bids;
   - consolidate the coin's ladder asks into **one** post-only sell of everything above 1 clip, at `max(bestAsk, feeFloor over basis)` and stepping like an exit row (`EXIT_STEP_*`);
   - log `SOFT STOP <sym> off=… ret5=… sell=…`.
   - The last clip stays on the normal ladder, so spread capture continues.
2. **Hard stop at `ROTATE_STOP_RET`:** queue the exit **in the same call** (`queueExit(sym, pair, amount+hold, …)` before `pairState.delete`), sized at the full balance, and take over the soft-stop order instead of cancelling and re-posting it. No taker; the data says prices rebound after these stops. Keep −4%.
3. **Rise-hold release:** when the rise ends (`flatTape`), release the held fraction **and** anything above `TRIM_TO_CLIPS × clip` at the best ask.

**Acceptance (12 h):**
- No coin's `costHeld` exceeds `capFor` plus one minimum order.
- 0 minutes with any single coin at ≥40% of equity.
- Time with coin inventory ≥ $3 drops by more than 80% vs. this session.
- Every hard stop with inventory ≥ `MIN_ORDER_USD` has an `EXIT` row in the same second.
- `SOFT STOP` lines precede most hard stops.
- Price P&L per $100 traded improves vs. this session's −$7.63 on $871 of fills (−$0.88 per $100).

## 3. Oversized sells: one sizer for every sell
**Where (the actual path):**
- `strategy.js` `coverInventory()` L869-896:
  - L873 `available = pos.amount`, L888 `size = need × 0.995`, from the **8 s cached** snapshot (`portfolio.js` `fetchLivePortfolio()` L17-21, `ACCOUNT_CACHE_MS` 8000).
  - It does **not** use `freeQty()` or `cooled()`.
  - It is called on every `processPair` pass (L865, unthrottled), on every PARK pass (L702), after each buy fill (L853), and on the fade check (L726).
  - The `openCover` guard (L876) only sees **successful** cover orders, so a failed cover retries every pass.
- `slideSameSide()` L606-630 and `skewOtherSide()` L632-664 post sells of `filledLeg.size`/`best.size` with no free-qty check.
- `exchange.js` `limitOrder()` reserves sells (L296) and cools the side (L269), but the reservation is time-based (10 s, `free-qty.js`) and only `resizeLeg` reads it.

**Evidence:**
- 1,460 `Insufficient balance`: 1,178 on sell L1, 240 on sell L2–L5, 42 on buys.
- **956 of them directly follow a `COVER SELL` line** (GTC 197, MNDE 170, DIMO 160, KAIO 124, …).
- Example, Oct 5, 3:11:55 PM PT: `SLIDE SELL MNDE 59.2`, then 1 s later `COVER SELL MNDE 60.1 avail=60.4` fails. The cover was sized from a snapshot taken before the slide's hold.

**Change (definitive):**
1. **A choke point in `ex.limitOrder` for sells:** `size = min(size, sellable(base))`, floored to the lot. If the result is below `ordermin` or `MIN_ORDER_USD`, return `{skipped:'free'}` without calling the venue, and log `SELL CLAMP <sym> want=… free=…` (throttled). Every path gets this, including future ones.
2. **`sellable(sym) = snapshot.amount − Σ reservations placed after that snapshot's fetch time`.** Reservations are keyed by order id and dropped when (a) a snapshot fetched **after** the placement arrives, or (b) the order is rejected. Drop the fixed 10 s window.
3. Call `invalidateLiveCache()` after every successful sell placement, cancel and fill, so the next sizer reads a fresh snapshot (one accounts call per change, bounded by the existing cache for reads).
4. **`coverInventory`:**
   - Skip when `cooled(pair,'sell')`.
   - Size `min(want, sellable)`.
   - If the ladder already has open asks for the coin, cover only the free remainder (≥ minimum), or cancel and consolidate. It never posts on top of them.
   - Throttle it to once per `COVER_MS` (20 s) per pair at all four call sites.
   - Record failed attempts in `openCover`-like state so it doesn't retry every pass.
5. **`slideSameSide`/`skewOtherSide` sells** size through `resizeLeg` (sell branch) like every other leg.
6. On `Insufficient balance`: cool the side (as now), invalidate the cache, and **drop the reservation**. Report `limitFails` as 1-hour rolling counts (`insufficient1h`, …), not session totals.

**Acceptance:**
- Under 5 `Insufficient balance` per hour, all pairs combined, over 12 h. 0 directly after a `COVER SELL`.
- Per symbol, the sum of open sell sizes ≤ `amount + hold` at every status tick.
- `SELL CLAMP` lines appear instead of venue errors.

## 4. Fee labels: fees are real, labels say "pending"
**Where:**
- `src/shared/orders.js` L31-36: the fill is logged with the estimate and `feeSource:'pending'`. The venue fee arrives later at L38-52.
- L49 `postFill({...})` sends the venue fee **without** `feeSource`, so `src/web/server.js` L1319 (`{...existing, ...fill}`) keeps `'pending'`.
- `src/shared/fill-log.js`:
  - the `fill` shape (L16-25) has `feeSrc` frozen at write time;
  - the `fee` shape has **no src column**, so `logFeeUpdate()` L198-212 drops `src:'venue'`;
  - `feeCounts.venue` counts every fee row, and `pending` is never incremented.
- `orders.js` L74-77 stops polling `needFee` after 5 min with no hand-off.

**Evidence:**
- 734 fills and 734 type-4 fee rows, 733 at exactly 35.0 bps (the venue's maker rate for tier "Advanced 1"; `transaction_summary` agrees).
- The newest fills in `/api/status.fills` all show `feeSource:'pending'` with real venue fee values (e.g. 0.003524955 on $1.00713).
- The console prints `fee=… est` on every fill (734/734).

**Change:**
1. At fill time, label the estimate `est` (not `pending`). When the venue fee lands, `postFill({..., orderId, feeSource:'venue', ts:<original fill ts>})`.
2. Add `src` to the `fee` shape (append the column; keep old readers working). Count `venue` only for `src:'venue'`. `pending` = registry fills with `needFee` (live count).
3. After 5 min, hand off instead of dropping: leave the fill with no venue fee row, so `venue-recon` `pendingFillsSince()` (`fill-log.js` L159-196) picks it up on the next `VENUE_RECON_MS` pass. Run the backfill **every** pass, not just once.
4. Record the stranded taker's real commission in `strandedTaker.fee`/`feesSession` (from the same fills lookup).
5. Make `fees.venueN` and `fees.venue` the same count.

**Acceptance:**
- In `/api/status.fills`, every fill older than 2 min shows `feeSource:'venue'`.
- `fees.pending` equals the number of fills younger than ~5 min.
- `strandedTaker.feesSession` > 0 after a taker exit.

## 5. Remaining v8 items
- **5a (v8 6b) Leftovers after rotation:** after `cancelPair` (`index.js` L194), list the pair's open orders. Log anything still open as `CANCEL LEFTOVER` and keep tracking it (`rec.orphan`).
  - **Acceptance:** 0 untracked fills after rotation (still 0 in recon).
- **5b (v8 6a) `CASH JUMP` noise:** `pnl.js` L117 compares free USDC only, so placing or cancelling a bid looks like a $1.5 "jump" (376 lines).
  - Compare `free + hold` and log only when it is unexplained by fills or transfers.
  - **Acceptance:** under 5 lines per day with no transfers.
- **5c Rotation market-exit noise:** `liquidateSymbols` (`index.js` L221) logs `skip market exit` on every rotation (102 lines).
  - Skip the call when `ALLOW_MARKET_EXIT=0`; the exit row from item 2d covers it.

## Config (~$6.9 equity)
```
MM_MAX_PAIRS=4                 # effPairs = floor(eq / 2.5) = 2 today
LIVE_FOCUS_N=3
MIN_ORDER_USD=1
CLIP_MAX_USD=1.5
INV_NAME_MAX_FRAC=0.25         # now on cost basis incl. open bids (2b)
RISE_COIN_CAP_PCT=0.25         # recommend off; v8 chose 0.35 (Blake's call, 2b.5)
INV_BOOK_MAX_FRAC=0.45
CASH_FLOOR_FRAC=0.35
INV_SKEW_BID_K=1.0             # new (2c)
INV_SKEW_ASK_K=0.4             # new (2c)
TREND_BID_MIN_5M=-0.01         # new (2a)
PEAK_OFF_PCT=0.015             # new (2a, 2d)
TRIM_TO_CLIPS=1                # new (2d)
ROTATE_STOP_RET=-0.04
ENTER_RET_MIN=                 # remove; replaced by bidGate (1b)
BID_GATE_HYST_MS=30000         # new (1b)
IDLE_RELEASE_MS=900000         # new (1b)
VOL_SCAN_REST_CHUNK=25
VOL_QUARANTINE_MS=21600000     # new (1a), doubles to 24 h max
PRODUCTS_REFRESH_MS=1800000    # new (1a)
COVER_MS=20000                 # new (3)
FUNDS_COOL_MS=60000
ACCOUNT_CACHE_MS=8000          # reads only; invalidated on every placement/cancel/fill (3)
STRANDED_TAKER=1
ALLOW_MARKET_EXIT=0
VENUE_RECON_MS=300000
BANK_START_PCT=0
BANK_ROTATE_PCT=0
BANK_ONLY_QUOTE=1
```
