# crypto-mm ladder: spec v11 (Oct 6, 2026, 10:15 PM PT)

## Design intent (read first)
- **What the bot is:** a **post-only, two-sided spread capturer**. It keeps one bid and one ask per coin outside the fee. After a fill it places another order on the same side and skews the other side (README; `261bc7d`/`00e2c60`, Sep 26).
- **Momentum tilt (rise-hold):** while a coin's 1-minute price is rising, it holds back part of the coin and widens the ask. When the rise stops, it sells that part at the best ask (`639058b`/`838ace3`, Sep 29).
- **Markets:** the **scanner picks them** (15-minute volatility rank over every online USDC product). No coin names are hardcoded as logic. Names below are **examples only** of observed failures.
- **Blake's lead priority (unchanged from v10):** when order criteria are met, keep **open bids + asks ≈ total wallet equity**. Capital works as resting post-only quotes on the selected set. It does not sit in USDC, and inventory does not sit without an ask.
- **What v11 does:**
  - Fixes the **sell-reservation leak** that zeroed every ask and blocked every exit (the real cause of "no asks", "no exits" and "false dust").
  - Turns `BOOK_TARGET_FRAC` into an **actual sizing input**: a capital allocator across eligible pairs, instead of a reporting number.
  - Makes the trend/peak gates **shape** price and size instead of vetoing. Removes `sibling` as a veto. Rotates the set when **every** selected pair is truly blocked.
  - Adds an **ask invariant**: every tradable position has a resting sell. Rise-hold sets the price; it never means "no ask".
  - Classifies dust by **venue minimums at the current price**, and handles sub-minimum crumbs.
  - Keeps the v10 deposit→`TRANSFER` path, widens it, and adds a test.
- `ALLOW_MARKET_EXIT=0` stays. Everything is post-only. The stranded-coin taker (v8) is unchanged and is still the only market path.

**Status (live, code `3bdfea8` = v10 + sibling patch; verified by file hash on the server; restart at 8:39 PM PT Oct 6):**
- At 9:49 PM PT: startEq $16.62 → $16.35. Maker after fees +$0.11, price −$0.37, 25 fills. `book=$0.00 / target=$14.71`.
- At 10:09 PM PT: equity $16.30, cash $6.48, **inventory $9.82 (60% of equity) with 0 asks and 0 bids**. `exits`: DIMO $1.52 and MNDE $2.84 have `lastErr:"no id"` and no order; ORCA/HNT have `lastErr:"below venue min"`.
- Over 181 WORKING samples (30 s apart, 8:39–10:10 PM PT):
  - bids were $0 in **152 (84%)**, and asks $0 in **111 (61%)**;
  - the largest book seen was about $2.6 against a target of about $14.7;
  - inventory went from $1.48 to $9.89 while cash went from $13.64 to $6.48. Bids filled, but nothing could be sold.
- **`SELL CLAMP` 307 times:** FORT 133, MNDE 120, DIMO 51. Every one says `free≈0` (e.g. `SELL CLAMP MNDE want=103.2 free=1.4e-14`) while the coin is fully held and has **no** open order.
- `BID BLOCK` 445: sibling 160, trend 97, peak 85, cap 76, rip 27. `ROTATE idle` 9 times, **7 of them for `sibling`**.
- Still good: 0 market orders, 0 taker fees, 0 `Insufficient balance`, scanner 402/402, venue fees confirmed.

Line numbers are at `3bdfea8`. Check them before editing.

## v10 post-mortem: what was meant to happen and why it didn't
| v10 item | Intended | What happened (code + logs) |
|---|---|---|
| P0a book≈equity | Open bids+asks size up toward `BOOK_TARGET_FRAC`×equity | **Report-only.** The only sizing code that reads the target is `cashFloorBlocks()` (`strategy.js` L131-140), which relaxes the cash floor. No code sizes **toward** `bookGap`. Each pair still gets one `CLIP_MAX_USD`=$1.50 L1 bid (`resizeLeg` L384), and deeper levels are gated by `heavierBare`/`isTopWeight` (L732). Even with all gates open, bids top out near pairs×$1.50. |
| P0b sticky park | Clear `parked` when focused | **Done.** 0 `PARK` lines and 0 `park` blocks. |
| P0c focus | Whole set is focus under $25 | **Done** (`effectiveFocusN`, `isTopWeight` L687). |
| P0d idle release | Rotate only truly blocked pairs | **Partial, harmful.** `index.js` L204-225 skips `park`/`cash` but counts **`sibling`**, an account-level throttle. 7 of 9 idle rotations were for `sibling`. DIMO left the set this way at 8:55 PM PT and later became an exit that never posted. |
| P0e sibling | Never zero every bid | **Partial.** `3bdfea8` lets one "leader" bid when the book has none (`siblingHasBareBids` L1111). Once the leader has a bid, any heavier gate-passing pair with no bid blocks every lighter pair. Result: bids are serialized to about 1 clip. `sibling` is still the #1 block reason (160). |
| P1 deposits | Book a deposit as a `TRANSFER` | **Untested** (no deposit since restart). The heuristic needs `noFill` for 60 s **and** `qtyStable()` (`pnl.js` L127-149). The Oct 6 deposit came with position changes, so it would **still be missed** (see item 5). |
| P2 insufficient | Fewer than 5 per hour | **Done**: 0 `Insufficient balance`. But the fix overshot into the reservation leak (item 1). |
| P3 dust exits | Post exits for $0.15+ leftovers | **Doesn't apply on this venue.** Coinbase `quote_min_size` is **$1** (ORCA/HNT/MNDE/DIMO/FORT/META all report `quote_min_size=1`). A $0.25 post-only sell can never be accepted. ORCA/HNT rows sit at `below venue min` forever. |

### Root cause 1: sell reservations never expire, so every ask and exit is clamped to 0
**Where:**
- `src/shared/free-qty.js` `noteBalances()` L6-41 and `sellable()` L73-79
- `src/shared/exchange.js` `limitOrder()` sell clamp L258-281 and `cancelOrder()` L420-424
- `src/shared/portfolio.js` L48 (`positions[sym].amount += avail`) and L106

**Mechanism:**
1. `balances` stores Coinbase **`available_balance`** (L48), which **already excludes** the holds of open orders.
2. Every sell placement adds a reservation keyed to its order id (`exchange.js` L280 and L256).
3. A reservation is removed only if:
   - (a) the next snapshot shows `available` **dropped** by at least half its size (L32-35), or
   - (b) the grace check at L39 passes: `now − max(r.at, cut) ≥ 15 s`.
   But `noteBalances` runs right after the fetch, so `now − cut` is just the fetch latency (well under 1 s). **Check (b) never passes.**
4. `pinL1` places a new L1 sell and then cancels the old one (L595-606). `softStop` cancels the ladder sells and re-posts (L854-869). Each time, the old order's hold is released while the new one is placed, so `available` stays flat and (a) never matches.
5. **`cancelOrder` never calls `dropReservation`.** Every cancelled sell leaves a permanent reservation.
6. Reservations pile up until `Σ reserved ≥ balance`. `sellable` → 0, and every later sell returns `{skipped:'free'}` (L275) with a `SELL CLAMP` line.

**Proof from logs:**
- MNDE `free` fell step by step as `PIN L1 SELL` re-priced: 2.7 → 0.1 → 0 → 1.4e-14 (9:59–10:01 PM PT). It then clamped every 30 s for 70+ minutes.
- FORT: `COVER SELL FORT 111.43` at 8:45:31 PM PT, then `softStop` cancelled the ask, then `SELL CLAMP FORT want=50.36 free=0` from 8:45:34 PM PT on. After `ROTATE_STOP_RET` (8:50 PM PT), `EXIT queue FORT 116.27` clamped 133 times.
- The control case: CTX was a fresh coin with no prior ladder sells. Its exit posted and stepped normally (`EXIT sell CTX` ×3).

**Consequences:**
- **No asks** on held inventory.
- **No exits** for FORT/DIMO/MNDE/LCX. `exit-book.js` L186-201 turns `{skipped}` into `lastErr:'no id'`.
- **"False dust":** `quoteSnap()` L203-213 labels any held coin with no ask that isn't `cooled` or `riseHold` as **`dust` by default**. MNDE $2.86 was not classified as dust and therefore left without an ask. It had no ask because of the leak, and the fallback label then called it dust.
- **Inventory risk:** the soft stop cancels the resting ask (L854-857) and then can't post a replacement. It removes the very sell it is meant to place. 208 `SOFT STOP` lines, 0 soft-stop orders.

### Root cause 2: the book target never reaches sizing, and the gates serialize bids
- **No allocator.** Sizing is per leg: `min(cashLeft, nameRoom, clipMax, cashShare)` (`resizeLeg` L384). Nothing spreads `bookGap` across eligible pairs.
- **The `sibling` veto** (L1111-1137, called at L557 and in `bidGate`) lets bids out one pair at a time.
- **The pending-bid double count** inflates `cap`:
  - `resizeLeg` calls `notePendingBid` (L396) on **every** successful sizing, including retries and sizings whose `limitOrder` later fails. `notePendingBid` **adds** (`row.usd += usd`, L96) and refreshes `at`.
  - The bid is then **also** counted in `openBidUsd` once it is open.
  - `costHeld()` (L141-147) sums both.
  - Evidence: `SKEW inv MINA u=0.74` and `NMR u=0.76` with **0** and $0.12 of inventory (10:00–10:07 PM PT). `cap` blocked bids 76 times.
- **Binary trend/peak/rip vetoes flicker:** 24 `CANCEL tight buy` (`pinL1` L615-624) pulled bids within about a minute of posting.
- **Startup `tape`:** `liveTapeReady()` (L668-673) needs 8 mid samples in the window, so right after a restart (8:45 PM PT) FORT and LRDS sat at `tape`. Minor, but it delays the first book.

## 1. Fix the sell-reservation leak (P0 prerequisite; do first)
**Change:**
1. **One rule:** `sellable(sym) = snapshot.available(sym) − Σ reservations with placedAt > snapshot.fetchedAt`. Drop **every** reservation older than the latest snapshot's `fetchedAt`, unconditionally: Coinbase `available` already reflects that order's hold. Remove the balance-drop matching and the grace check (`free-qty.js` L20-40).
2. **`cancelOrder`/`cancelPair`/`cancelAll`** call `dropReservation(orderId)` (or `dropSymbolReservations` for pair cancels) and `invalidateLiveCache()`.
3. **Replace order for sells:** `pinL1` re-price and `softStop` cancel the old sell, wait for the cancel to be acknowledged, invalidate the cache, read a fresh snapshot, and then size the new sell from `sellable`. If the new sell clamps, re-post the old size and price instead of leaving no ask.
4. **Self-heal:** if `sellable(sym) < venueMin` but the registry has **no** open sell for `sym` and the last snapshot is under 10 s old, drop `sym`'s reservations, log `RESERVE RESET <sym> n=… qty=…`, and retry once.
5. API: `/api/status.reservations = {count, qty:{sym:…}, oldestSec}` and `markets[].sellableQty`.

**Acceptance (from status/logs):**
- 0 `SELL CLAMP` lines for a symbol that has no open sell order (check `SELL CLAMP` against `markets[].asks` and `exits[].orderId`).
- `reservations.oldestSec` < 30 at every status tick.
- `markets[].sellableQty` is within one lot of the venue `available` when no sell was placed in the last 15 s.
- `RESERVE RESET` fires under once per hour after the fix (it is a safety net, not the mechanism).

## 2. Ask invariant: every tradable position has a resting sell
**Rule:** for each symbol (in-set **or** out-of-set) with `tradableQty` (item 4) > 0, there is a resting post-only sell within `ASK_ENSURE_MS` (60 s). In-set coins use ladder asks. Out-of-set coins use exit rows.

**Change:**
1. **Rise-hold sets the price, never "no ask."** While rising, the held fraction (`riseHoldFrac`) is still posted, at the rise price:
   - The non-held part sits at the normal L1 ask.
   - The held part is a second sell at `riseSellHalf × RISE_HOLD_ASK_MULT` (default 2.0) above mid.
   - If either part is below the venue minimum, post the whole position as one order at the rise price.
   - When the rise ends (`flatTape`), re-price the held order to the best ask, as today. This keeps the design: no cheap sells into a rise, and the coin is always offered.
2. **The soft stop re-prices; it doesn't remove.** It consolidates sells by replacing them (item 1.3). If its sell would be below the minimum (`sell=0`, 115 times), it leaves the existing asks alone instead of cancelling them.
3. **`ensureBothSides` / `pinL1` sell side** run every `ASK_ENSURE_MS` for any in-set coin with `tradableQty > 0` and no open sell, regardless of bid gates.
4. **Exits:**
   - Out-of-set positions with `tradableQty > 0` get an exit order within 2 min of `EXIT queue`.
   - `lastErr` must name the real cause: `clamp` (with `sellable`/`reserved`) | `belowMin` | `postOnly` | `venue:<msg>`. Never a bare `no id`.
5. **Count exits in the book.** `working.bookNotional` = in-set bids + in-set asks + resting exit orders, since all of them are equity on the book.
6. **`askWhy` enum** (replaces the `dust` fallback in `quoteSnap` L208-213): `noInv | belowMin | clamp | cooled | pending`. `riseHold` is no longer a no-ask reason. There is no default label: if none applies, it is a bug, so log `ASK MISSING <sym>`.

**Acceptance:**
- Every `markets[]` or `wallet[]` row with `tradableQty > 0` has `askUsd > 0`, or an `exits[]` row with an `orderId`, within 2 min, checked on every status tick after the first 5 min from restart.
- 0 `ASK MISSING` lines.
- `askWhy` is never `dust`.
- An out-of-set coin worth ≥ $1 that leaves the set (FORT/DIMO/MNDE-like) shows `EXIT sell` within 2 min of `EXIT queue`.

## 3. Book≈equity: allocate capital; gates shape and select
### 3a. Allocator (makes `BOOK_TARGET_FRAC` real)
Each processing tick (`index.js`, before `processPair` runs for the set):
1. `tradableEq = totalEquity − untradeableDust` (item 4).
2. `bookTarget = BOOK_TARGET_FRAC × tradableEq`. `askBook` = all resting sells (ladder plus exits).
3. `bidBudget = min(freeQuote × 0.95, max(0, bookTarget − askBook))`.
4. `eligible` = in-set pairs whose bid is not **hard-vetoed** (3b). Give each eligible pair `budget_i = bidBudget × w_i / Σw` (scanner weight × tape mult), capped at `capFor − costHeld` (per-coin cap stays).
5. Each pair posts its budget as `ceil(budget_i / CLIP_MAX_USD)` clips (at most `BID_CLIPS_MAX` = 3) on L1..Ln, stepped by `gridStep`. **Clip size is unchanged.** Depth comes from more clips, not bigger clips.
   - Remove the `heavierBare`/`isTopWeight` depth gate (L732) for allocated clips.
6. Expose `working.{tradableEq, bookTarget, askBook, bidBudget, eligible:[sym…], alloc:{sym:usd}}`.

### 3b. Gates: veto vs. shape
| Gate | v11 role | Rule |
|---|---|---|
| `cap` | **Veto** (per-name) | `costHeld ≥ capFor`. Inventory risk stays a hard cap. |
| `rip` | **Veto** (per-name) | As today. |
| `tape` | **Veto**, warm start | Seed the mid ring from `px-ladder.jsonl` / vol-scan mids on startup so `liveTapeReady` holds within about 60 s of restart. |
| `peak` | **Veto only with inventory ≥ 1 clip** (as v9 intended); otherwise **shape** | Flat book: bid at 2× the normal offset, size ×0.5. |
| `trend` | **Shape**; veto only if severe | `ret5m < TREND_BID_MIN_5M` (−1%): bid offset ×`TREND_SHAPE_MULT` (2.0), size ×0.5. Veto only below `TREND_VETO_5M` (−2.5%). |
| `sibling` | **Removed** | The allocator orders capital by weight. No veto. |
| `cash` | **Removed as a veto** | The allocator's `bidBudget` already limits spend to free cash. |

- Keep `BID_GATE_HYST_MS`. Shaping changes the price and size of a resting bid via the normal requote path; it doesn't cancel it.

### 3c. Selection when the whole set is blocked
- If **every** in-set pair has a **hard veto** on bids **and** `tradableQty = 0` for `SET_BLOCKED_MS` (10 min), rotate out the pair blocked longest.
- Its replacement is the best-ranked scanner candidate whose **preview** gate passes: no rip, `ret5m ≥ TREND_VETO_5M`, tape ready.
- Log `ROTATE blocked <sym> <why> <min>m -> <new>`.
- **Idle release counts only hard vetoes** (`cap|rip|tape|trend-veto|peak-veto`), never `sibling`/`cash`/`park`.
- Pairs holding inventory are not rotated for being idle; their ask (item 2) is their work.

**Acceptance (P0, from `/api/status.working`):**
- Within **10 min** of a restart, with ≥ 1 eligible pair and free cash ≥ 2 clips: `bookNotional ≥ 0.6 × tradableEq`.
- Over any 1 h window with ≥ 2 eligible pairs: time-weighted `bookNotional / tradableEq ≥ 0.75`.
- Samples with `bids=$0` while `freeQuote ≥ 2 × CLIP_MAX_USD` and `eligible.length ≥ 1`: **under 10%** (was 84%).
- 0 `BID BLOCK … reason=sibling` and 0 `reason=cash`.
- 0 `ROTATE idle` with reason `sibling`, `cash` or `park`.
- `markets[].quote.bidWhy` is empty for every `eligible` pair that has an allocation ≥ 1 clip.
- Per-coin cap holds: no coin's `costHeld` > `capFor` + 1 minimum order.

## 4. Dust classification from venue minimums; sub-minimum crumbs
**Where:**
- `exchange.js` `getProducts()` L65 keeps only `ordermin = base_min_size`.
- `exit-book.js` `sweepStranded()` L59-84 uses `DUST_EXIT_USD` and the snapshot `mid`.
- `quoteSnap()` L208-213 uses the fallback label.

**Change:**
1. Store `baseMin = base_min_size`, `baseInc = base_increment` and `quoteMin = quote_min_size` (all public product fields) per product. Refresh with `PRODUCTS_REFRESH_MS`.
2. `tradableQty(sym) = floor(sellable, baseInc)`. A position is **tradable** iff `tradableQty ≥ baseMin` **and** `tradableQty × bestBid ≥ quoteMin`. Use the live book's best bid, not the snapshot mid or a stale value.
3. Remove `DUST_EXIT_USD` for selling. The venue minimum is the floor. `MIN_ORDER_USD` stays the floor for **new entries** (bids) only.
4. **Sub-minimum crumbs (ORCA/HNT ~$0.25 at `quoteMin=$1`): known-untradeable dust.**
   - No exit row, no retry spam. List them under `/api/status.dust.untradeable = [{symbol, qty, usd, quoteMin}]` with `dust.untradeableUsd`.
   - Exclude them from `tradableEq` (the book target), the `ASK MISSING` check and recon alerts. Keep them in `equity`/`wallet`, since they are real value.
   - **No top-up buys for coins outside the set.** Buying about $0.75 of a coin the scanner did not pick, just to clear a minimum, is a new trade decision outside the scanner. It also adds inventory risk for no spread capture. That violates "scanner picks markets."
   - **Crumbs merge when the scanner picks the coin.** If such a coin is later selected, its crumb becomes ladder inventory, and the next sell includes it (sell size = the full `tradableQty`).
   - **Prevent new crumbs.** When the remainder after a sell or exit would fall below `quoteMin`, size the sell to the full balance. Exit and soft-stop orders always sell the full `tradableQty`.

**Acceptance:**
- MNDE-like ($2.86 at `quoteMin=1`) is never in `dust` and always has an ask or exit order (item 2).
- ORCA/HNT-like crumbs are in `dust.untradeable` only, with no exit row and no `lastErr` churn.
- `recon.alert` is not raised by them.
- New sub-`quoteMin` remainders after the bot's own sells fall to near 0 per day.

## 5. Deposits as `TRANSFER` (keep v10; widen; add a test)
v10's heuristic (`pnl.js` L118-151) is kept. Two gaps:
- It requires **no fill for 60 s** and **stable quantities**. The Oct 6 deposit (5:53 PM PT) came with position changes (`LCX 18.33→0.04`, `DIMO 2.43→0.04`), so it would still be `unattributed`.
- The venue path (`venue-recon.js` v2 transactions) is unproven.

**Change:**
1. **Explained-cash rule:** `residualCash = ΔquoteTotal − Σ(fill cash flows since the last mark: sell proceeds − buy cost − fees)`. If `|residualCash| ≥ DEPOSIT_DETECT_USD`, and `Δequity − Δ(mark-to-market of held qty)` agrees within tolerance, call `noteTransfer(residualCash, 'cash-residual', id)`. This works during fills.
2. Keep the venue path and the id/amount dedupe (v10, `noteTransfer` L92-95).

**Test note (required, no secrets):**
- Add `scripts/test-pnl-transfer.mjs`, driving `createPnl()` with synthetic `live` snapshots:
  - (a) +$10 USDC with no fills → one `TRANSFER +10.00`, `unattributed` unchanged;
  - (b) +$10 during two fills that move qty → one `TRANSFER +10.00`;
  - (c) −$5 withdrawal → `TRANSFER -5.00`;
  - (d) the venue path reporting the same deposit afterwards → no double count;
  - (e) a fill-only cash move → no transfer.
  - Run it in CI or `npm test`.
- **Live check** (Blake, when convenient): deposit a small amount ($2–5) of USDC. Expect, within 1 min: a `TRANSFER` line, `pnl.netDeposits` up by that amount, `unattributed` and `walletGain` unchanged, `recon.alert` false.

## Non-goals
- No hardcoded coin names as markets to trade. The scanner picks; names here are examples only.
- No `ALLOW_MARKET_EXIT=1`, rotation dumps or startup flattening. No taker paths beyond the existing v8 stranded taker.
- No buying to top up crumbs for coins outside the set.
- No bigger clips or larger per-coin caps. Depth comes from more clips under the same `capFor`.
- No removal of rise-hold. It now sets the price of a resting ask instead of withholding it.
- No secrets, keys, account ids, wallet addresses or SSH details in commits (public repo).
- No production edits from this spec commit. SuperGrok implements from this file.

## Config deltas
```
BOOK_TARGET_FRAC=0.90          # unchanged; now drives the allocator (3a)
BID_CLIPS_MAX=3                # new (3a): max allocated bid clips per pair
CLIP_MAX_USD=1.5               # unchanged
INV_NAME_MAX_FRAC=0.25         # unchanged (hard cap)
TREND_BID_MIN_5M=-0.01         # now a shape threshold (3b)
TREND_VETO_5M=-0.025           # new (3b)
TREND_SHAPE_MULT=2.0           # new (3b): bid offset multiplier under trend/peak shaping
SET_BLOCKED_MS=600000          # new (3c)
ASK_ENSURE_MS=60000            # new (2)
RISE_HOLD_ASK_MULT=2.0         # new (2.1)
RESERVE_GRACE_MS=              # remove (1)
DUST_EXIT_USD=                 # remove for sells (4); venue quote_min/base_min decide
DEPOSIT_DETECT_USD=1.0         # unchanged
ALLOW_MARKET_EXIT=0            # unchanged
STRANDED_TAKER=1               # unchanged
```

## Implementation order
1. Item 1: the reservation leak. It is small, and it unblocks every ask and exit.
2. Item 2: the ask invariant, rise-hold pricing, soft-stop replace, real `lastErr`.
3. Item 4: venue-minimum classification (needed by 2 and 3a).
4. Item 3: the allocator, gate shaping, `sibling`/`cash` removal, blocked-set rotation, warm tape, and the pending-bid fix (`notePendingBid` only after a successful placement; **set**, don't add; clear when the order shows as open or fails; `costHeld` counts open bids **or** pending, never both).
5. Item 5: deposit residual rule, then the test script.

## Done means
After a restart, `/api/status` shows:
- `bookNotional / tradableEq` ≥ 0.6 within 10 min, and ≥ 0.75 time-weighted over an hour with eligible pairs;
- every tradable position with a resting sell within 2 min;
- 0 orphan `SELL CLAMP`s;
- crumbs only in `dust.untradeable`;
- the deposit test passing.
