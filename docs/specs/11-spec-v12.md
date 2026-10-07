# crypto-mm ladder: spec v12 (Oct 6, 2026, 11:50 PM PT)

## Design intent (read first)
- **What the bot is:** a **post-only, two-sided spread capturer**. It keeps a bid and an ask per coin outside the fee. After a fill it places another order on the same side and skews the other side (README; `261bc7d`/`00e2c60`, Sep 26).
- **Momentum tilt (rise-hold):** while a coin's 1-minute price is rising, it holds back part of the coin and widens the ask. When the rise stops, it sells that part at the best ask. Since v11, rise-hold sets the ask **price**; it never means "no ask."
- **Markets:** the **scanner picks them** (15-minute volatility rank over every online USDC product). No coin names are hardcoded as logic. Names below are **examples only** of observed failures.
- **Blake's order target: 90%.** When order criteria are met, **open book notional (bids + asks) ≥ 90% of tradable equity**. `BOOK_TARGET_FRAC=0.90` stays the default, and **the acceptance bar follows the target**: if Blake changes `BOOK_TARGET_FRAC`, every "90%" below means that new value (85% means `BOOK_TARGET_FRAC − 0.05`).
- **What v12 does:**
  - Removes three places where bids already resting are counted as spent **twice**. Together they hold the book to about a third of the target.
  - Fills the pair set with enough eligible pairs to hold 90% under the existing per-coin cap.
  - Fixes the sells placed right after a sell fill that the venue rejects as insufficient.
  - Rejects scanner picks that are already past the stop.
  - Gives the dashboard one source of truth for the set.
- `ALLOW_MARKET_EXIT=0` stays. Everything is post-only. The per-coin cap (`INV_NAME_MAX_FRAC=0.25`) and clip size (`CLIP_MAX_USD=1.5`) stay. The book gets deeper by adding **pairs and clips**, not bigger orders.

**Status (live; `587e29c` + `19caf70`; hashes and config match the repo; restarted 10:41 PM PT Oct 6):**
- **Deposit detection works.** The $7 USDC deposit at 11:28 PM PT logged `TRANSFER +7.00 cash-residual`, start rebased to $23.23, `unattributed=0`, recon gap 0.03%.
- **The book doesn't scale.** Over 124 WORKING samples (10:41–11:44 PM PT), book/target averaged **34%** (median 33%; one sample at 88%).
  - At 11:43 PM PT: bids $7.31, asks $0.37, target $19.83, `budget=$13.97`, `eligible=SQD,BLAST,ORCA`, `alloc={SQD:1.50, BLAST:3.24, ORCA:2.93}`.
  - After the deposit, **only RLC was eligible from 11:31 to 11:36 PM PT**, with bids $1.00–1.50 against a $19.8 budget.
- **18 `Insufficient balance`, all on SELLs**, none on USDC. **17 of 18** came 0.7–8 s after a **sell fill in the same coin**.
- **ORCA was picked by the scanner** at 11:37 PM PT (`RISE SWAP out RLC for ORCA`; `MM enter … ORCA 2.75% ret=1.77%`). It is not a top-up of unselected dust: its 0.09 leftover merged as v11 item 4 intended.
- **The set churns:** the same tick added POND (ret15 **−6.16%**) and LCX (**−3.70%**). Both left by `ROTATE_STOP_RET` at **age 301 s**, the first tick they were allowed to.
- **The dashboard was showing the previous set.** `selection.rows` is built **before** rotation, so it showed the old set for up to `VOL_ROTATE_MS` (5 min); BLAST was quoting while labelled `out: pair cap 4`.
- **Still good:** 40 fills with venue fees, empty exit queue, `reservations.count=0`, 0 `RESERVE RESET`, 0 `ASK MISSING`, 0 market orders, 0 taker fees, scanner 402/402.
- **Ask check:** at 11:41 PM PT every position above the venue minimum had an ask. (Only sub-$1 crumbs are held, plus BLAST with a resting ask.) The POND ask gap at 10:51 PM PT came from item 2 (an insufficient sell, then a 60 s sell cooldown).

Line numbers are at `19caf70`. Check them before editing.

## v11 post-mortem
| v11 item | Intended | What happened |
|---|---|---|
| 1 Reservation leak | Asks/exits never clamp to 0 | **Done.** 0 stuck reservations, exits posted (11 `EXIT sell`). Overcorrected into item 2: reservations drop as soon as the snapshot's `fetchedAt` passes, but the venue balance can lag a fill. |
| 2 Ask invariant | Every tradable position has an ask | **Mostly done.** 0 `ASK MISSING`. Gaps of up to 60 s come from item 2: an insufficient sell → `coolSide(pair,'sell')` (`exchange.js` L325-326, `FUNDS_COOL_MS=60000`). |
| 3a Allocator | Spread (target − asks) over eligible pairs | **Built, but held to about a third** by the double counting in P0.1, the clip ceiling in P0.2 and too few eligible pairs (P0.3). |
| 3b Gate shaping | Veto only cap/rip/tape/severe trend/peak-with-inventory | **Done** (`hardBidVeto` L186-200). 41 `BID BLOCK` vs 445 in v10. |
| 3c Blocked-set rotation | Rotate to pairs that pass | **Partial.** `previewGate` (L1001-1009) doesn't check ret15 against `ROTATE_STOP_RET`. Picks were stopped out at 301 s. Additions removed by `previewGate` after `planRotation` (`index.js` L252) leave slots empty until the next 5-min tick. |
| 4 Venue-minimum dust | Crumbs only in `dust.untradeable` | **Done** (`19caf70` fixed the hold double count). ORCA/HNT/STX etc. are listed with `quoteMin:1`. |
| 5 Deposits | `TRANSFER` for deposits, including during fills | **Done, verified live** with $7. One noise pair at 11:09 PM PT: `TRANSFER +1.51` then `−1.51` 30 s later (net 0). See P3. |

## P0. The book reaches ≥ 90% of tradable equity, including after deposits
### P0.1 Bids already resting are counted as spent twice (root cause; three places)
Coinbase `available_balance` for USDC **already excludes** the holds of open bids (`portfolio.js` L44: `freeQuote += avail; quoteHold += hold`). Three sizing steps subtract the open bids again. Each makes the book stall at roughly half; stacked, they explain the 34% average.

1. **`planBook()`** (`strategy.js` L940-974): `bidBudget = min(freeQuote × 0.95, bookTarget − askBook)` (L957).
   - `bidBudget` is used as the **total** bid target to split across pairs.
   - But `freeQuote` has already lost the existing bids, so each new bid shrinks the next tick's budget.
2. **Per-pair room** (L964-966, L971): `room = capFor − costHeld`, and `costHeld` includes the pair's open + pending bids. So `alloc` is the **remaining** room.
   - `resizeLeg` then computes `remain = alloc − (openBidUsd + pendingBidUsd)` (L416-418), subtracting the same bids a second time.
   - Proof: at 11:43 PM PT, SQD had $2.81 of bids, and `alloc.SQD=1.50` ≈ cap $5.81 − $2.81 open − $1.50 pending. So `remain=0`, and SQD stopped at about half its cap.
3. **`resizeLeg` cash** (L405-414): `cashLeft = (freeQuote − Σ other pairs' open bids − pending) × 0.92 × 0.9`. Again `freeQuote` is already net of those bids.

**Change (one consistent ledger):**
- `quoteTotal = freeQuote + quoteHold` (all USDC, free or on bids).
- `bidTarget = min(quoteTotal × CASH_DEPLOY_FRAC, bookTarget − askBook)`, with `CASH_DEPLOY_FRAC` default 0.97 to leave room for fees and rounding. This is the **total** bid notional wanted, including bids already resting.
- `alloc_i` = pair *i*'s **total** bid target = `min(capRoom_i, bidTarget × w_i/Σw)`.
  - `capRoom_i = capFor − inventoryCost_i`: **inventory only, not its own bids**. The cap still holds, because a pair's total bids are at most `capRoom`, so if they all fill, cost = cap.
  - Pairs that hit `capRoom` pass their unused share to the other eligible pairs (water-fill), so the bid target isn't lost.
- `resizeLeg` buy: `remain_i = alloc_i − (openBid_i + pending_i)`, subtracted **once**.
  - Cash check: `size ≤ freeQuote × 0.98`. `freeQuote` is already net of all resting bids; don't subtract other pairs' bids again.
  - Drop the stacked `capitalSafetyMargin × orderSizeHaircut` (0.828) on buys. Venue rounding is covered by `CASH_DEPLOY_FRAC`.
- `pendingBidUsd` stays as the 15 s in-flight guard. It is never added to a number that already includes the order as open.

### P0.2 The clip ceiling is below the target
- `generateLadder` posts `min(BID_CLIPS_MAX, ceil(alloc/clip))` bid levels (L335-338), with `BID_CLIPS_MAX=3` and `CLIP_MAX_USD=1.5`. That is **at most $4.50 per pair**.
- With 4 pairs that is at most $18. With $23.23 equity the target is $19.83, so **90% is unreachable even with every gate open.**
- **Change:**
  - `clips_i = ceil(alloc_i / CLIP_MAX_USD)`, limited by `BID_CLIPS_MAX` (new default **8**, a sanity bound only).
  - Each tick, if `alloc_i − openBid_i ≥ 1 clip`, add the next level below the deepest open bid (`gridStep` spacing). Don't wait for a ladder rebuild or `EXPAND`.
  - If `openBid_i − alloc_i ≥ 1 clip` (for example after a fill or a cap change), cancel the deepest level only.

### P0.3 Enough eligible pairs to hold 90% under the per-coin cap
- With `INV_NAME_MAX_FRAC=0.25`, the bids alone can cover 90% only with **≥ 4 eligible pairs** (4 × 25% = 100%). 3 pairs give at most 75%, and 1 pair (RLC, 11:31–11:36 PM PT) gives at most 25%.
- `MM_MAX_PAIRS=4` leaves no spare slot for a pair under a hard veto.
- **Change:**
  1. `MM_MAX_PAIRS=6`. `effPairs = min(MM_MAX_PAIRS, floor(eq / (MIN_ORDER_USD × PAIR_CASH_K)))` stays, so small accounts still get fewer pairs.
  2. **Target pair count:** `needPairs = ceil(BOOK_TARGET_FRAC / INV_NAME_MAX_FRAC) + 1` (5 by default). While `eligible.length < needPairs` and `effPairs` allows it, fill free slots from the scanner on the **next scan tick** (`cfg.volScanMs`, 60 s), not on the 5-min rotation tick.
     - Empty slots don't wait for `SWAP_COOLDOWN_MS`/`ROTATE_MIN_HOLD_MS`; those apply only to **swapping out** a held pair.
  3. **Candidate filter** (applied in `planRotation`, before choosing, so a rejected pick doesn't leave an empty slot):
     - all of `previewGate`, plus
     - **`ret15 > ROTATE_STOP_RET + STOP_MARGIN`** (default margin 0.01, so ret15 > −3%). This prevents POND/LCX-like picks that are stopped at 301 s;
     - not in `watch` cooldown.
  4. Log `BOOK SHORT reason=<pairs|cap|cash|veto|clips> have=$x need=$y` once per minute while `bookNotional < bookTarget × 0.95`, so any shortfall has a named cause.

### P0.4 Deposits and restarts
- `planBook` already runs each status tick (`index.js` L446, L544-562). After a `TRANSFER` or a restart, also force `refreshAlloc()` and allow slot-filling on the next scan tick.
- The book must climb within 10 min (see acceptance).

### P0.5 Measure the book from the venue's view
- 36 of 124 samples had `onBids` (venue USDC hold) more than $0.50 above the tracked `bids` (for example 11:35 PM PT: `bids=$0.00`, `onBids=$4.52`). In-flight cancels and replacements make the tracked ladder disagree with the venue.
- **Change:**
  - `bookNotional` = Σ open orders in the **order registry**, covering in-set ladders, exits, orphans and leftovers.
  - Add `working.venueBook = quoteHold + Σ(base hold × mid)` as a cross-check.
  - Log `BOOK DRIFT` when the two differ by more than 1 clip for more than 60 s.

**Acceptance (P0, read from `/api/status.working`):**
- New fields: `bookPct = bookNotional / tradableEq`, `bookPct1h` (time-weighted over the last 60 min), `eligible`, `needPairs`, `shortReason`.
- **Within 10 min** of a restart **or** a booked `TRANSFER`, with ≥ 1 eligible pair: `bookPct ≥ 0.85` (= `BOOK_TARGET_FRAC − 0.05`).
  - If fewer than `needPairs` pairs are eligible, the bar is `min(0.85, eligible × INV_NAME_MAX_FRAC + askBook/tradableEq)`, and `shortReason='pairs'` must be shown.
- **Each hour** in which some pair was eligible for ≥ 90% of the hour: `bookPct1h ≥ 0.90` (= `BOOK_TARGET_FRAC`).
- `Σ alloc ≥ 0.95 × bidTarget` whenever `eligible.length ≥ needPairs`. This checks that the allocator itself isn't short.
- For every eligible pair: `openBid_i ≥ alloc_i − 1 clip` within 2 min of `alloc_i` changing.
- `eligible.length ≥ min(needPairs, effPairs)` in ≥ 80% of samples. 0 additions with ret15 ≤ `ROTATE_STOP_RET + STOP_MARGIN`.
- `|bookNotional − venueBook| ≤ 1 clip` in ≥ 95% of samples.
- Per-coin cap holds: no coin's inventory cost + open bids > `capFor` + 1 minimum order.

## P1. Insufficient-balance sells right after a sell fill
**Evidence:** 18 fails, all sells (BLAST, POND, NEON, DIMO, GTC). 17 of 18 came 0.7–8 s after a sell fill in the same coin. Example from 10:50 PM PT:
- `FILL … sell POND` at :06.7
- `PIN L1 SELL POND 759` at :08.3 fails
- `ASK POND 799` at :11.7 and :14.7 fail
- `ASK POND 531` at :16.9 succeeds

The bot's view had about 268 POND more than the venue.

**Cause (`free-qty.js` L7-22, `fill-log.js` L229, `exchange.js` L325-326):**
- v11 drops every reservation once a snapshot with a later `fetchedAt` arrives, and the fill handler only invalidates the cache.
- The snapshot fetched right after a fill still counts the just-sold coins as available. Coinbase settles a fill (hold release and balance debit) separately from the accounts read, so the next replacement sell is sized to the pre-fill amount.
- The venue rejects it, `coolSide` blocks sells for 60 s, and the coin has no ask for that time (the POND ask gap at 10:51 PM PT).

**Change:**
1. **Fill debit ledger:** on every sell fill (WebSocket or poll), record `{sym, size, at}`.
   - `sellable = available − reservations − Σ fill debits newer than the snapshot's settle point`.
   - A debit clears once a snapshot fetched ≥ `SELL_SETTLE_MS` (3 s) **after** the fill shows the balance down by at least that size, or after 30 s.
2. **Reservations** placed within `SELL_SETTLE_MS` before a snapshot's `fetchedAt` are kept until the next snapshot. This covers the same lag at placement.
3. **On `Insufficient balance` for a sell:**
   - Don't apply the 60 s cooldown.
   - Wait `SELL_SETTLE_MS`, invalidate the cache, then retry **once** with `min(size, fresh sellable)`.
   - Cool only if the retry also fails, and only for 15 s.
4. **Never send a sell below `quoteMin`/`baseMin`** (for example `BLAST sell L2 1`, `POND sell L2 1`). Skip it locally as `belowMin`.

**Acceptance:** `limitFails.insufficient1h ≤ 1`; 0 insufficient fails within 10 s of a same-coin fill; no tradable position goes > 20 s without an ask after one of its sells fills.

## P2. One source of truth for the set (dashboard = state)
**Cause:**
- `index.js` builds `selection.rows` at L188-207 from the **pre-rotation** `mmAlloc`, then changes the set at L251-294.
- The rows aren't rebuilt until the next `VOL_ROTATE_MS` tick (5 min, L321).
- `markets[].why` reads the stale rows (L431). That is why BLAST was quoting under `out: pair cap 4`, and the panel showed DIMO/RLC while POND/LCX/ORCA were quoted.

**Change:**
1. Keep a single `setState = {version, updatedAt, pairs:[{symbol, pair, enteredAt, role}]}`, written **only** where `mmAlloc` is reassigned (after `planRotation`) and saved with `mm-set-ladder.json`. `selection`, `markets`, `planBook`, `blockedLeave` and idle release all read it.
2. Each `markets[]` row has a `role` of `in | exit | orphan | dust`, so non-set quotes (exits, leftovers) are visible and never labelled "out: pair cap".
3. Rebuild `selection.rows` from `setState` on every status tick (30 s). The rows add the scanner's top non-set candidates with their `why`, for example `out: ret15 −6.2% < stop+margin`, `out: watch 12m`, `out: rip`.
4. Expose `selection.version`/`updatedAt` and `working.setVersion`. The dashboard shows "set v<N> @ <time PT>".

**Acceptance:**
- At every status tick, the symbols with `role='in'` in `markets[]` = `selection.rows` with `state='in'` = `mm-set-ladder.json` symbols = `working.eligible` ∪ vetoed in-set pairs.
- 0 `markets[]` rows quoting with an `out:` label.

## P3. Minor
- **ORCA-like crumbs:** no change in policy. A crumb coin is quoted **only** when the scanner selects it, with the same entry rules as any coin; the leftover then merges into inventory. Add `markets[].selectedBy = 'scanner'` with its `rangePct`/`ret15` at entry, so it is visible why a crumb coin is being quoted.
- **Transfer noise:** `cash-residual` booked `+1.51` then `−1.51` 30 s apart (11:09 PM PT), one clip at the moment a bid was placed or filled. Require the residual to persist across **2 consecutive marks** (or be confirmed by the venue path) before calling `noteTransfer`. **Test:** add case (f) to `scripts/test-pnl-transfer.mjs`: a bid placed and cancelled within one mark → no transfer.
- **Re-entry after a stop:** a pair stopped out by `ROTATE_STOP_RET` keeps the `watch` cooldown (`REENTER_COOLDOWN_MS`). Log it in `selection.rows` as `out: watch`.

## Non-goals
- No hardcoded coin names as trading choices. The scanner picks; names here are examples only.
- No `ALLOW_MARKET_EXIT=1`, rotation dumps or taker paths beyond the existing v8 stranded taker.
- No bigger per-coin cap or bigger clips. 90% comes from correct accounting, more clips under the same cap and enough eligible pairs.
- No top-up buys of crumbs for coins the scanner hasn't selected.
- No change to rise-hold (it sets the ask price only).
- No secrets, keys, account ids, wallet addresses or SSH details in commits (public repo).
- No production edits from this commit. SuperGrok implements from this file.

## Config deltas
```
BOOK_TARGET_FRAC=0.90          # unchanged default; acceptance bars follow it (85% = target − 0.05; hourly = target)
CASH_DEPLOY_FRAC=0.97          # new (P0.1): share of all USDC (free + on bids) that bids may total
MM_MAX_PAIRS=6                 # was 4 (P0.3); effPairs still scales with equity
BID_CLIPS_MAX=8                # was 3 (P0.2); sanity bound only, clips come from alloc
STOP_MARGIN=0.01               # new (P0.3): pick only if ret15 > ROTATE_STOP_RET + margin
SELL_SETTLE_MS=3000            # new (P1)
FUNDS_COOL_MS=15000            # was 60000; only after a settled retry also fails (P1)
CLIP_MAX_USD=1.5               # unchanged
INV_NAME_MAX_FRAC=0.25         # unchanged (hard cap)
VOL_ROTATE_MS=300000           # unchanged for swaps; empty slots fill on the scan tick (P0.3)
ALLOW_MARKET_EXIT=0            # unchanged
```

## Implementation order
1. P0.1: the single-ledger fix (small, and the biggest gain).
2. P0.2: clips from alloc, plus the per-tick top-up and trim.
3. P1: fill debit ledger and settled retry (so the new depth doesn't create insufficient fails).
4. P0.3: pair count, slot fill on the scan tick, stop-margin filter. P0.4: refresh on deposit or restart.
5. P2: `setState` single source and dashboard roles. P0.5: book from the registry plus the venue check.
6. P3: the minor items.

## Done means
After a restart or deposit, `/api/status.working.bookPct` is ≥ 0.85 within 10 min and `bookPct1h` is ≥ 0.90. `limitFails.insufficient1h` is ≤ 1. The dashboard set, `markets[].role='in'` and `mm-set-ladder.json` always match. Per-coin caps and post-only hold.
