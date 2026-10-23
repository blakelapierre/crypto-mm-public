# AS v16: as-cb bids pinned to stale last-sell anchors, quotes dropped at the distance cap instead of clamped, unreachable orders counted as book coverage, and park/release step-downs that never reach the order

This builds on v15, which is live on streambox as `5aa4d3b` (v15 implementation, `5451a56` "Implement AS v15…"). Where they conflict, v16 wins. Line numbers refer to `src/bots/as/index.js` and `src/bots/as/quote.js` at `5aa4d3b`.

**One correction to v15.** v15 F2 put the large `dist_touch` values down to a stale mid and said "Do not raise `AS_MAX_QUOTE_DIST_BPS`". The mid is fine. The real cause is the last-sell buy-back anchor (index.js 2089), which pins the bid under an old fill price. That price then flows through `widenOpenDecision`'s `min()` (quote.js 638). v16 keeps the cap where it is (150 bps) and removes the stale anchor.

Design rules still hold:
- post-only maker orders only
- no hardcoded coins (the scanner picks markets, and every rule below is per market from venue metadata and env)
- a book near 90% of tradable equity, counted in orders that can actually fill (see F3)
- no loosening of the margin rails (`AS_LIFETIME_DD_PCT`, the day and session loss caps, the Kraken margin-level target)
- the original ladder design: an inventory-skewed two-sided quote per name, with a cost floor on exits
- deposits and withdrawals are capital, not P&L, and unknown money is flagged but never pauses trading (v15 F6 is unchanged)

**New core rule: buys follow mid.** Every loop, a bid is re-priced from the current mid. No stored anchor (last fill, old slot price, dust arm flag) may hold a quote away from the market forever. If a constraint would push a quote past the distance limit, the quote is clamped to the limit. It is not dropped.

## Do bids follow mid today? Partly.

What happens to the bid inside `quoteSymbol`, in order (index.js at `5aa4d3b`):

1. **1962–1967:** `plan = halfFor(median spreads, σ)`, then `asQuote` (quote.js 6–26). The reservation price is `mid × (1 − clamp(q·γ·σ²τ, ±maxShift))`, and `bid = reservation × (1 − half)`. **This follows mid.** `mid` comes from `getBook` (`src/shared/exchange.js` 129–150): the Coinbase WS book (bid+ask)/2, with REST `best_bid_ask` as a fallback.
2. **1972–1980:** `bidPx = snap(model.bid)`. The bid is kept under mid, and with no long it is capped at `mid × (1 − plan.half)`. **This still follows mid.**
3. **2052–2060:** clamp to the band (`AS_MAX_FROM_MID` = 2%, quote.js 78). **This still follows mid.**
4. **2072–2076:** `oppBid = oppositeFloorPx(lastFill.price, 'sell')` is `lastSell × (1 − (2·35 + 8) bps)`, that is, last sell minus 78 bps (quote.js 747–756). `state.lastFill[sym]` is written at index.js 566 with no expiry.
5. **2089:** `if (!(pos.short > 0) && oppBid > 0) bidPx = Math.min(bidPx, oppBid)`. **This is where the bid stops following mid.** It runs *after* the 2% band clamp, so nothing bounds it. Once a market rallies past the last sell, the bid stays at that sell minus 78 bps, however old the fill.
6. **2150–2154:** `widenOpen(bidPx)`, then quote.js 630–654. `next = min(px, mid×(1−need))` keeps the anchored (lower) price. `distTouch` is measured against the touch, and **line 651** returns `{px: 0, why: 'max-dist'}` when it exceeds `cap = max(150, spreadMed/2 + need)`. The quote is **dropped**, not clamped.
7. **2663:** the buy `edgeGate` floor is `min(costShort, oppBid)` (quote.js 763–774). A re-priced bid above the anchor would still be rejected here, so any fix has to change both 2089 and 2663.

So the base quote tracks mid, but any market that has traded above its last sell loses its bid completely. It does not get a bid that follows the market up.

## Symptom (Oct 22 PT; server logs in BST = PT+8, all times below converted to PT)

**as-cb at about 10:50 PM PT Oct 22:** equity $12.91, capital $13.89 (−7.1%), free USDC $3.58. The last fill was a FORT sell at 3:46 PM PT (279 fills in total). There were no rejects and no crosses.

```
BUDGET free=1.95 held=1.50 reserve=0.13 → b=1.66 slots=1 clip=$1.49 cover=$10.33/$9.94
GATE FORT buy budget-spent left=$0.17 clip=$1.49
```

- **Resting book:** $10.33 against a $9.94 target. Only the ARB bid ($1.49, −104 bps, half `b110` floor) can fill; that is about 12% of the book.
  - STRK ask at about +2175 bps from mid (entry 0.06722)
  - BASECAT ask 0.01351 × 92 at about +2050 bps (entry 0.01340)
  - COMP ask 26.38 × 0.123 at about +780 bps over the 24.47 touch (entry 26.17)
- **Bids blocked by the last-sell anchor.** Each of these is above the 150 cap, and each slot is released every 10 minutes:

  | Market | Last sell | When (PT) | `dist_touch` (bps) | Mid move since |
  |---|---|---|---|---|
  | DASH | 50.51 | Oct 22 10:06 AM | ~900 | +3% since 3:46 PM |
  | IRYS | 0.01847 | Oct 21 | 2891–3416 | +32% (range 42%) |
  | GTC | 0.2528 | Oct 18 | 2152–2315 | +6% |
  | USELESS | 0.1443 | Oct 18 | 1175–1184 | +8% |
  | LIGHTER | 3.284 | Oct 20 | 537–540 | — |

- **FORT** is dropped by 4 bps: `GATE FORT buy max-dist need=110 dist_touch=154 cap=150 spread_med=59`, with a vol half of 200–250. It then flapped around the cap: `BUY FORT @ 0.026911 dist=151bp` at 11:16 PM PT, re-quoted at `dist=157bp` at 11:21 PM PT, and `CANCEL why=flat FORT` at 11:22 PM PT.
- **Scanner:** `SCAN best FORT exp_edge=45.5…62.8 need=78.0` printed, yet FORT, GTC, IRYS, USELESS, LIGHTER, ARB, VVV, DASH, WLD, INJ, AERO, QNT, ICP and FIL were all picked.
- **Park/release step-downs logged but never sent:**
  - `RELEASE step COMP k=2 floor=25.5` at 8:12 PM PT
  - `RELEASE step COMP k=3 floor=25.11 touch=24.41 qty=0.123000 maxLoss=$0.14` at 10:13 PM PT
  - Per-loop status `COMP q=1.75 half=bgate=slots/a415…a449bp`, which means the computed ask is about 25.5 against a mid of about 24.5
  - The COMP order is still 26.38, with **no** `CANCEL` or `SELL COMP` line in 30h
  - `PARK step BASECAT k=1 px=0.01325` at 9:03 PM PT; the BASECAT order is still 0.01351, with no re-quote
  - STRK *did* re-price (`PARK step STRK k=4 px=0.06347` at 10:53 PM PT, followed by `CANCEL why=requote` and `SELL STRK 67.51 @ 0.06347`), so the path works for some names
- **Deep-underwater parked positions:** STRK about −21% and BASECAT about −17% against entry. Their 800 bps loss bound (`AS_RELEASE_MAX_LOSS_BPS`) is about 0.0618 for STRK and 0.0123 for BASECAT, both above market, so they cannot exit. COMP's bound of 24.08 is reachable. The release day budget used is $0.00 of $0.19.

## Root causes

### R1 (P0): the last-sell anchor never expires, and it is applied after the band clamp

`state.lastFill[sym]` (index.js 566) is overwritten only by the next fill. No TTL, price-move test or flat test ever clears it. `oppBid` (2075–2076) is applied at 2089, after `clampToBand` (2052–2060), so it can pull the bid any distance below mid. `widenOpenDecision` keeps the lower price (quote.js 638), and line 651 then drops the quote. The buy `edgeGate` (2663) would reject any bid above the anchor in any case. In a market that rallies after a sell, the bot stops buying in that market for good. That is a permanent block, against design.

### R2 (P0): a quote just past the cap is dropped instead of clamped

quote.js 651 returns `px: 0` when `measured > cap`. For FORT the vol half (200–250 bps) sits just beyond the cap (150), so the quote disappears or flaps (151 → 157 → cancel). Clamping is always safe here: `cap ≥ spreadMed/2 + need`, so a price at `touch ∓ cap` still has `half ≥ need`.

### R3 (P0): coverage counts unreachable orders, and the buy budget ignores free cash

`tradableBookTarget` (quote.js 704–713) counts every resting ask and bid as cover, wherever it sits. It is called at index.js 3452 with `restingAsks = restingAskUsd(book.mine)`. Parked asks 780–2175 bps from mid make up $8.84 of the $10.33 "cover", so `bidRoom` is about 0 and `bidRoomShare` (quote.js 1403) caps the bids at 15% of tradable. That gives one slot and a $1.49 clip, with `budget-spent left=$0.17` while $3.58 of USDC sits idle. An order far from the touch cannot fill, so it is not book.

### R4 (P0): a never-cleared `dustArmed` flag re-raises the exit price after park/release has set it

This was verified in code and live state:
- `state.dustArmed[sym] = true` is set at index.js 2643–2644 when a dust top-up bid is quoted, and **nothing ever clears it** (`grep dustArmed`: only 2643, 2644 and 2647).
- index.js 2647–2649: `if (state.dustArmed[sym] && sellSz > 0 && pos.long > 0) askPx = max(askPx, roundTripFloorPx(entry))`. This runs *after* the release block (2172–2198) and the park block (2200–2225) have set `askPx`.
- The display half `askHalf` is computed at 2629, *before* that override. So the status line (`a425bp`) and the `RELEASE`/`PARK step` logs show the step price, while `sellJob.target` (2706) gets the round-trip floor.
- The floor is `entry × (1 + 78 bps)`:
  - COMP: 26.17 × 1.0078 = 26.374, which snaps to **26.38**
  - BASECAT: 0.01340 × 1.0078 = 0.013505, which snaps to **0.01351**

  Each matches its resting order exactly, so `syncSide`'s keep test (index.js 1716, within 0.15%) holds and nothing is re-quoted or logged.
- Live state (read-only): `dustArmed = {COMP: true, BASECAT: true, DOOD: true}`. STRK is not armed, which is why STRK re-priced and COMP and BASECAT did not. The last `DUST topup BASECAT` was at 2:52–3:03 PM PT Oct 22.

There are three secondary defects in the same path:
- (a) The park block (2200–2225) overwrites the release ask unconditionally, so a logged `RELEASE step … floor=25.11` is not what gets sent (park k=2 is about 25.50).
- (b) `RELEASE`/`PARK step` lines are logged once per k, *before* any send, so they are not evidence of an order.
- (c) There is only one `releasePick` at a time (`pickRelease`, index.js 1894, set at 3478), so release pricing for a name turns on and off from loop to loop as the pick changes.

### R5 (P1): deep-underwater parks cannot exit within the 800 bps loss cap

`releaseStep`/`parkStepPlan` (quote.js 1341–1349, 1453–1462) bound every step at `entry × (1 − AS_RELEASE_MAX_LOSS_BPS)`. When the mark is more than 8% under entry (STRK −21%, BASECAT −17%), that bound sits above the market and the position is stuck. This works as designed, but the cost is about $8 of equity that cannot be traded. Whether to change it is Blake's decision (see F5).

### R6 (P1): the scanner's printed "need" is not the threshold it applies, and the units differ

`expectedEdgeRow` (quote.js 846–862):
- `need = roundTripPadBps` = 78, a per-side half-spread pad that includes fees
- `expHalf = max(quotedHalf, k·horizon, need)`, so it is always ≥ need
- `expEdge = fillp × (2·expHalf − 2·fee)` is a round-trip figure, net of fees
- `tradeable = expEdge > 0 && expHalf ≥ need`, which reduces to `expEdge > 0`

The `SCAN best` line (index.js 1394) prints `exp_edge=45.5 need=78.0`, which reads as a failed check even though the real test is `> 0`. Comparing a net-of-fee edge with a fee-inclusive pad would count the fees twice.

## Fixes

### F1 (P0): buys follow mid, and the last-sell anchor expires

1. Add `anchorActive({ fill, mid, sigma, ageMin, posQty, minQty, ttlH, sigmaK, needBps, flatExpire })` in quote.js. The anchor is **inactive** if any of these holds:
   - **Age:** `ageH ≥ AS_ANCHOR_TTL_H` (env, default **4**).
   - **Move:** `|mid − fill| / fill ≥ max(needBps, AS_ANCHOR_SIGMA_K × σ1m × √ageMin)` (env `AS_ANCHOR_SIGMA_K`, default **3**). `σ1m` comes from `stats()`. While σ is warming up, use `needBps`.
   - **Flat:** with `AS_ANCHOR_FLAT_EXPIRE=1` (default), there is no inventory above the venue minimum on the side the anchor protects (`positionAboveMin`). A buy-back anchor protects nothing once the sold inventory is gone and nothing is short.
2. index.js 2072–2076: compute `oppBid`/`oppAsk` only when `anchorActive(...)` is true. When it expires, log `ANCHOR expire SYM side=sell px=… reason=ttl|move|flat age=…h move=…bp` once.
3. **The anchor never outranks the distance limit.** Move the 2084–2090 anchor `min`/`max` *before* the band clamp. After it, apply `bidPx = max(bidPx, touchBid × (1 − cap))`, where `cap` is the same as `widenOpenDecision`'s. An active anchor may widen a bid up to the cap. It may never push the bid off the book.
4. index.js 2663: the buy `edgeGate` uses the same effective (expired-aware, cap-bounded) `oppBid`, so the gate and the price agree. `costShort` keeps its current meaning: a real short's round-trip floor.
5. Make the same change for the sell side (`oppAsk`, 2073–2074, 2086/2088), so a stale last-buy cannot pin an opening ask either. Exits on a held long still use `costLong` (cost floor) and the park/release rules, unchanged.
6. These are env knobs only, with no per-coin values.

### F2 (P0): clamp a quote to the distance cap instead of dropping it

1. `widenOpenDecision` (quote.js 630–654): when `measured > cap`, set `next = snapOpen(buy ? touch × (1 − cap/1e4) : touch × (1 + cap/1e4))` toward mid, then recompute `half` and `distTouch`. Return `{ px: next, why: 'clamped', … }` if `half + 0.5 ≥ need`. Since `cap ≥ spreadMed/2 + need`, this holds whenever the touch spread is normal.
2. Return `max-dist` (`px: 0`) only if the clamped price would still break `need` or cross the book. Expect this to be rare; log it with the numbers.
3. index.js 2152: treat `why === 'clamped'` like `ok` (use `w.px`). Log `CLAMP SYM buy from=…bp to=…bp cap=…` with the same 10-minute dedupe as `logGate` (index.js 289).
4. Keep a 2 bps hysteresis. A resting order whose distance is within `[cap − 2, cap]` and within 0.15% of the new target is kept, so it does not flap between 151 and 157.
5. `AS_MAX_QUOTE_DIST_BPS` stays at 150.

### F3 (P0): count only reachable orders as coverage, and size the buy budget from free cash

1. `tradableBookTarget` (quote.js 704) takes `restingOrders: [{side, px, usd, touch}]`. An order counts toward `cover` only if `|px − sameSideTouch| / mid ≤ AS_MAX_QUOTE_DIST_BPS` (the same cap as F2). Unreachable orders are reported separately as `parkedUsd` and **do not reduce `bidRoom`**.
2. index.js 3449–3452: build that list from `book.mine` plus `getBook` touches (they are already fetched per quoted name, and are cached per loop). `countAskCover`'s half credit for parked asks (quote.js 1397) is replaced by this rule.
3. Buy budget = `min(target − reachableCover, free − reserve)`. Slots = `fundedSlots(budget, clip)` with the venue minimum clip. With today's numbers that is `free 3.58 − reserve 0.13 = 3.45`, which gives **at least 2 slots** of at least $1. The 15% `bidRoomShare` floor stays as a floor, not a cap.
4. The `BUDGET` line adds `reach=$X parked=$Y`, and `cover=` is the reachable figure.
5. A slot released for `max-dist` (v15 F2) is refilled from `scanPool` in the same loop. With F1 and F2 in place, `max-dist` releases should be rare.
6. **Goal:** reachable resting orders reach about 90% of tradable equity (equity − dust − reserve − parked inventory value), limited by free cash. Parked inventory is still shown in `book=` as its own term (`park=…%`).

### F4 (P0): park and release steps must reach the order

1. **Clear `dustArmed`.** Delete `state.dustArmed[sym]` when the position is no longer below the minimum (`positionAboveMin` true), when a sell fills, or after 24h. Migrate on load: drop any armed flag whose position is above the minimum (this clears COMP and BASECAT today).
2. **Order of precedence for the exit ask.** Compute one exit price in a single place, after every modifier:
   - `askPx = max(lossBound, touch, min(releasePx, parkPx))` when either plan applies, where `lossBound = entry × (1 − AS_RELEASE_MAX_LOSS_BPS)`
   - otherwise the cost floor and the dust floor as today

   The dust round-trip floor (2647–2649) must **not** apply when `parkPlan || releasePlan` is set.
3. Compute `askHalf`/`halfShown` (2628–2630) **after** the final `askPx`, so the status line shows the price actually sent.
4. Log the step when it is **sent**, not when it is planned. `RELEASE step`/`PARK step` move into `syncSide` (or are emitted with `sent=px`/`kept=px`). Use `extra.why` and `extra.releaseStep`, which are already passed (2706).
5. **Explain silent skips.** When `syncSide` keeps an order whose `extra.why` is `park` or `release`, or exits early, log `SYNC skip SYM sell why=keep|hold|quiet|focus target=… resting=…` once per (sym, k).
6. Let release be computed for every parked name that qualifies, not only `state.releasePick` (3478). The day cap (`AS_RELEASE_MAX_DAY_PCT`) is still shared and is charged in pick order.

### F5 (P1, open decision for Blake): deep-underwater parks

Leave the default alone: `AS_RELEASE_MAX_LOSS_BPS=800` and the day cap stay as they are. Make the behaviour explicit and visible:
1. Log `PARK stuck SYM loss=…bp bound=… touch=…` every 6h when the loss bound is above the market.
2. Add `AS_PARK_DEEP_MODE` (default `hold`, today's behaviour). The options below are for Blake to choose; none of them is enabled by default:
   - `hold`: keep the ask at the bound and wait.
   - `trail`: once a park has been stuck for more than `AS_PARK_DEEP_H` hours (default 72), widen the bound by `AS_RELEASE_STEP_BPS` every `AS_PARK_STEP_H` hours, still limited by the day cap and `releaseWorstLoss`.
   - `cap`: allow up to `AS_PARK_DEEP_MAX_LOSS_BPS` (unset means `hold`).
3. Every mode keeps post-only exits and the margin and lifetime rails.

### F6 (P1): the scanner threshold is the one printed

1. `expectedEdgeRow`: `tradeable = expEdge ≥ AS_SCAN_MIN_NET_BPS` (env, default `AS_MIN_EDGE_BPS` = 8). `expEdge` is already net of fees, so it is compared with a net figure. It is not compared with the fee-inclusive 78 pad, which would count fees twice.
2. The `SCAN best` line (index.js 1394) prints `exp_edge=… min_net=… pad=78 fillp=…`, so the logged threshold is the one in force.
3. `rankByExpectedEdge` (quote.js 864) drops rows that are not tradeable before slots are filled, and logs `SCAN skip SYM exp_edge=… min_net=…` (deduped hourly).

## Acceptance criteria

as-cb, within 2h of restart:
- **Buys follow mid.** For every quoted name with a bid, `|bidPx − mid×(1−half)|` is within one tick or within the clamp. No name has `GATE … max-dist` for more than one loop because of a last-fill anchor. Each anchor older than `AS_ANCHOR_TTL_H`, past the sigma move, or on a flat position logs `ANCHOR expire` within one loop. DASH, IRYS, GTC, USELESS and LIGHTER (whichever are still picked) get bids within the cap.
- **Clamp, not drop.** A name whose vol half is above the cap (FORT-like) rests a bid at `dist ≤ cap` with `CLAMP` logged, and it is not cancelled with `why=flat` while the inputs are unchanged. No order flaps more than once per 10 minutes because of the cap.
- **Reachable coverage.** `BUDGET` shows `reach=` and `parked=`. When free cash is more than 2 clips, `slots ≥ 2`, and free USDC drops below `reserve + 1 clip` within 2 loops. Reachable resting orders are at least 85% of `min(0.9 × tradable_ex_parked, free + reachable)`, averaged over any 6h window.
- **Re-price.** For every `PARK`/`RELEASE` step, the live order price equals the logged `sent=` price within one loop (≤ 2 min). COMP and BASECAT are re-priced to their step prices on the first loop after deploy. No `dustArmed` flag survives on a position above the minimum.
- **Deep parks.** `PARK stuck` lines appear for STRK and BASECAT while their bounds are above market. The defaults are unchanged (`AS_RELEASE_MAX_LOSS_BPS=800`, `AS_PARK_DEEP_MODE=hold`).
- **Scanner.** Every `SCAN best` line shows `exp_edge ≥ min_net`, and no name below `min_net` is picked.
- **Invariants.** Every order is post-only. No coin names appear in code or config. A diff of the rail env (`AS_LIFETIME_DD_PCT`, `AS_DAY_LOSS*`, `AS_SESSION_LOSS*`, the Kraken margin target) is empty. Transfers are still capital, and `unexplained` is still shown but never pauses trading.

## Unit tests (`scripts/test-as-v16.mjs`, added to `npm test`)

- `anchorActive`:
  - expires on TTL (age 4.01h)
  - expires on move (fill 0.01847, mid +32%, σ 30 bps, age 60 min)
  - expires on flat (posQty 0)
  - stays active when age 1h, move 20 bps and inventory is held
  - with σ warming up, uses `needBps`
- Bid build-up (a pure helper extracted from index.js 1964–2090):
  - with an expired anchor, `bidPx` equals the model bid
  - with an active anchor 900 bps under touch, `bidPx` equals `touch × (1 − cap)`, not `oppBid`
  - `edgeGate` with the effective anchor accepts that bid
- `widenOpenDecision`:
  - `distTouch` 154 against cap 150 returns `why: 'clamped'`, with a px 150 bps from touch and `half ≥ need`
  - a crossed or impossible case still returns `max-dist`
  - hysteresis keeps a 149 bps order
- `tradableBookTarget`: a $1.49 bid at −104 bps plus asks at +780, +2050 and +2175 bps gives `cover = 1.49` and `parked = 8.84`. With free 3.58 and reserve 0.13, the budget is 3.45 and `fundedSlots ≥ 2`.
- Exit price resolution:
  - `dustArmed` with a park plan: `askPx` is the park price, not the round-trip floor
  - release 25.11 and park 25.50 resolve to 25.11, bounded by the loss floor 24.08 and the touch
  - `askHalf` comes from the final price
  - the `dustArmed` migration clears flags on positions above the minimum
- `parkStepPlan` deep mode: `hold` returns `stuck: true` with the bound above touch, and `trail` widens one step after `AS_PARK_DEEP_H`.
- `expectedEdgeRow`: `expEdge` 45.5 with `min_net` 8 is tradeable, `expEdge` 5 is not, and the printed threshold equals the applied one.
