# AS v14: as-cb stuck on parked inventory, as-kraken gated on a wrong fee and a wrong carry rate

Builds on v13, which is live in `90550b8`. Where they conflict, v14 wins. Line numbers refer to `src/bots/as/index.js` and `src/bots/as/quote.js` at `90550b8`.

## Symptom (Oct 17, 4:30 PM PT)

- **as-cb.** Equity is $14.48 against $14.89 capital (−$0.41 real). Maker capture is +$2.14 and fees are $0.64, but inventory mark is −$1.22. There have been 92 fills, with none since 10:31 AM PT Oct 16 (about 30h).
  - Book is 69% (84% ex-dust).
  - Five asks rest at cost floors well above mid:

    | Name | Floor | Mid | Above mid |
    |---|---|---|---|
    | STRK | 0.07967 | 0.0647 | +23% |
    | ZRO | 2.1931 | 1.861 | +18% |
    | USELESS | 0.17206 | 0.1534 | +12% |
    | WLD | 0.5421 | 0.4909 | +10% |
    | VVV | 24.42 | 22.29 | +10% |

  - Every bid is gated `budget`, even though `free=$3.17` and `b=$1.85`.
  - 5-minute markout averages **−40 bp** over 159 fills, so the bids were picked off on the way down.
- **as-kraken.** Equity is $9.73 against $12.28 capital (−20.8%, `stopDist=4.2pp`). The book is empty, with no fill since 7:01 AM PT Oct 16 (`idle=2900m+`).
  - The scanner does pick 12 names every hour, for example `SCAN picked=CRV:28,RENDER:27,ALGO:27,...`. The live pairs are then all gated:

    | Gate | Count in 25h |
    |---|---|
    | `CRV buy/sell carry` | 147 each |
    | `ALGO buy/sell carry` | 93 each |
    | `RENDER buy/sell carry` | 64 each |
    | `WLD buy edge` | 147 |
    | `WLD sell max-dist` | 122 |

## Diagnosis: as-kraken

### K1 (P0): the fee model is half the real fee

- Every hourly log says `maker fee 16.00bp source=default`.
- `loadMakerFee` (index.js ~395) calls `TradeVolume` with `{}`. Kraken returns `fees_maker` only when `pair=` is passed, so `bps` is 0 and the config default (`MAKER_FEE_BPS=16`) stays. The public `AssetPairs` `fees_maker` is now empty too.
- Here is what the fills actually paid (`logs/fills-as-kraken.jsonl`, 82 fills, $607 notional, all `liquidity=maker`):

  | Leverage | Fills | Fee paid |
  |---|---|---|
  | 2x | 1 | 32.0 bp |
  | 3x | 5 | 31.2 bp |
  | 5x | 22 | 31.0 bp |
  | 9x | 36 | 31.1 bp |
  | 10x | 18 | 31.5 bp |

  That is about **31 bp per side**, not 16.
- Lifetime totals are capture +$0.09, fees $1.89 and realized −$1.41. Markouts are flat (m5 ≈ −0.2 bp over 146), so the bot was not picked off. **The drawdown is fees.** Every quote was sized and priced against a 40 bp round-trip need (2×16+8) when the real need is about 70 bp (2×31+8).

### K2 (P0): the carry gate blocks every new pair

- `carryBpsPerHour` (index.js 1633) has no per-pair carry for CRV/RENDER/ALGO, so it falls back to `state.carryAccount`. That is `usd=$0.0489` accumulated since Oct 12 6:45 AM PT, divided by the **current** notional `$1.87` (the WLD residual) and 130h. The result is 2.0 bp/h.
- `carryAllows` (quote.js 312) then needs 4h × 2.0 = 8 bp < `PROFIT_BPS/2` = 5 bp, which fails. `notionalForCarry` shrinks the size below `ordermin` and returns 0, so `gate carry` fires on both sides.
- The numerator is carry paid on past, larger positions (up to 10x). The denominator is today's tiny position. Kraken rollover is about 0.02% per 4h (≈0.5 bp/h). `fundingBorrow` in state is $0.0032, an order of magnitude below `carryAccount.usd`, which also suggests double-counting.

### K3 (P1): the WLD residual short can never close

- The short is about 3.8 WLD (`inv=$1.87`, q=−0.37). Kraken `WLDUSD` has `ordermin=9`.
- The dust-short branch (index.js 1970–1983) allows a min-size buy only if `ordermin × mid ≤ 0.5% × equity`. That is $4.41 against $0.049, so it fails and `buySz=0`. The catch-all at index.js 2191 then logs `buy edge`. This is the same catch-all v13 fixed for the sell side only.
- `state.entry` says `shortQty=9.456 shortCost=6.50` (avg 0.687, floor 0.6846). The fills say the short is about 3.83 WLD opened at 0.53. The two reduce buys on Oct 16 (2.81 and 5.62 WLD) were not applied to the entry, so the floor shown is 40% off.
- WLD is now 0.49, so closing is **profitable** (about +$0.15 before fees).

### K4 (P1): the expected-edge ranking is degenerate

- `expectedEdgeRow` (quote.js 836) floors `expHalf` at `need`, so `expEdge = fillp × (2·need − 2·fee)` is positive by construction for every row.
- With the fake fill model (`fillp = exp(−1.5·extra/100)`), every tight-spread pair scores 27–29 bp. That is why the picks read `CRV:28,RENDER:27,ALGO:27,ENA:27,...`. The rank says nothing about which market can actually fill wide enough to cover fees.
- Hard rejects also drop candidates before ranking:
  - 26 on `vol` (`SCAN_MIN_VOL24_USD=250000`; APE $124k, GALA $109k, AXS $60k, CHZ $47k).
  - 16 on `tick` (a hardcoded `tickBps > 10` at quote.js 866; ENS 18 bp, FLOW 33 bp, LDO 26 bp).
  - Wide-tick and lower-volume names are exactly where a 70 bp round trip can exist.

### K5 (P1): the session loss cap is larger than the distance to the lifetime stop

`AS_MAX_SESSION_LOSS_PCT=8`, but `stopDist` is 4.2 pp (about $0.52). One bad session can blow through the 25% lifetime stop before the session rail fires.

## Diagnosis: as-cb

### C1 (P0): the bid budget is split across slots below the venue minimum

- The budget log reads `BUDGET free=3.17 held=0.00 reserve=0.14 → b=1.85`. `b` is `tradableBookTarget.bidRoom`: (14.48 − dust 2.62 − reserve 0.14) × 0.9 − askCover 8.69 ≈ 1.86. That is the right number.
- `slotClipUsd` (quote.js 954) divides it by `slots = quoteNames` (about 11: 5 held plus 6 scanned), so 1.85 × 0.9 / 11 = **$0.15 per slot**. That is below the $1 `quote_min_size`, so it returns 0 and every name gets `gate budget`.
- `tight` (index.js 1699: `cash < 25% of equity`, 3.17 < 3.62) separately blocks any bid unless the name is held **and** `hot` (index.js 2042).

### C2 (P0): cost floors never decay

- `unwindAsk` (index.js 1701) walks the ask toward the touch over `MAX_HOLD_MIN`. The cost-floor clamp (index.js 1723–1725, `askPx = max(askPx, longFloor)` when `!lossOk`) then undoes it.
- With `lossOk` false outside a rail, a name that drops more than the fee-plus-profit margin is parked forever. Its capital stays locked, which feeds C1.

### C3 (P2): status P&L

The status line `trading=$0.28 (+1.9%)` disagrees with real equity minus capital (−$0.41), because it adds back `pending=$-2.64`. Per v12, the line must show both, with the headline using real equity minus capital.

## Fix: as-cb

### 1. Stale-inventory release (bounded, post-only)

Per held name, track `lastFillAt[sym]` (any side). After `AS_RELEASE_IDLE_H` (default 12) with no fill on that name, the ask floor decays in steps:

```
floor_k = max( costFloor × (1 − k × AS_RELEASE_STEP_BPS/1e4),
               entryAvg × (1 − AS_RELEASE_MAX_LOSS_BPS/1e4),
               touchAsk )                    // never cross; still post-only
k += 1 every AS_RELEASE_STEP_H (default 2h) while no fill
```

**Defaults**

- `AS_RELEASE_STEP_BPS=150`.
- `AS_RELEASE_MAX_LOSS_BPS=800`. This is the per-name loss floor versus entry, after fees.
- `AS_RELEASE_MAX_DAY_PCT=1.5`. This is the daily realized-release-loss budget, as a share of equity ($0.22 today). It matches the existing `AS_MAX_EXIT_LOSS_PCT=1.5`.

**Rules**

- Release one name at a time: the one whose current floor is cheapest to reach, meaning the smallest `(floor_k − touch) × qty` loss. Other names keep their cost floors.
- Before posting a step, compute its worst-case realized loss, `(entryAvg×(1+fee) − floor_k) × qty`.
  - If that loss plus today's release loss would exceed the daily budget, **size the release ask down** to the qty that fits, still at or above `quote_min_size`.
  - If no such qty exists, hold at the current step and log `RELEASE hold reason=day-cap`.
- Release stops, and floors snap back to cost, if any of these is true:
  - The session loss is ≥ ½ `AS_MAX_SESSION_LOSS_PCT`.
  - The lifetime `stopDist` is < 10 pp.
  - Any rail is active.
- A fill on the name resets `k=0` and `lastFillAt`.
- Rails, `edgeGate` risk exemptions and the existing `lossOk` path are unchanged. Release is a separate, capped exemption. It must not set `lossOk`.

**Logging and P&L**

- Each step logs `RELEASE step <sym> k=<k> floor=<px> touch=<px> qty=<q> maxLoss=$<x> dayUsed=$<y>/<cap>`.
- A release fill gets `reason:"release"`, `releaseStep:k` and `releaseLoss` in `fills-as-cb.jsonl`. `pnl.js` keeps it in its own bucket, `releaseLoss`, separate from maker capture and inventory mark. Status shows `rel=$-x.xx (n)`.

### 2. Reserved bid share, so parked inventory can't zero the bids

- **Slots:** `slots = clamp(floor(b / venueMin), 1, quoteNames)`. Concentrate the budget into as many min-size clips as it can fund, ranked by expected edge, instead of spreading it into sub-minimum clips. With b=$1.85 that means one $1.00+ bid on the top-ranked name.
- **Reserved share:** at least `AS_MIN_BID_SHARE=0.15` of tradable equity stays reserved for bids, taken from the release proceeds first.
  - `bidRoom = max(bidRoom, min(free cash, AS_MIN_BID_SHARE × tradable))`.
  - The total book still caps at `BOOK_TARGET_FRAC` (0.9). The extra room comes from not counting parked asks above +5% of mid fully toward `askCover` (count them at 50%). The 90% target then pulls cash back into bids as release frees it.
- **`tight` gate:** applies only when `cash < max(venueMin, 0.05 × equity)`. Below that, the reserved-share clip still goes out if it fits in free cash. `tight` must log `budget-tight cash=$x need=$y` instead of a bare `budget`.
- **Logging:** `BUDGET ... → b=1.85 slots=1 clip=$1.66`. A `budget` gate that fires while `b ≥ venueMin` is a bug.

### 3. Status

Per v12, the headline is real equity minus capital. Change it to `trading=$-0.41 (−2.8%) pending=$-2.64 (excluded)`, add `rel=$..`, and add `parked=<n> $<usd> oldest=<h>h`.

## Fix: as-kraken

### 4. Real fee tier (P0)

- Call `TradeVolume` with `pair=<comma list of the picked orderPairs>` and read `fees_maker[pair].fee`. Also keep a rolling realized fee: `realizedMakerBps = Σfee / Σnotional` over the last 20 maker fills, with ≥5 required.
- `makerFeeBps = max(venue, realized, config)`. `feeSource` reports `venue|fills|default` and the 30-day `volume`.
- Log `FEE tier maker=<bp> taker=<bp> vol30=$<x> next=$<y>@<bp> src=<..>` hourly.
- Expect about 25 bp venue (tier 0) and about 31 bp realized, so the bot uses 31.
- Every downstream consumer uses this number: `roundTripPadBps`, `exitBound`, `edgeGate`, scanner `need`, and `MIN_HALF_BPS` (effective half = max(MIN_HALF, fee+profit)).
- If `realizedMakerBps` > `makerFeeBps` + 3 for 10 fills, log `FEE drift` and adopt the realized number.

### 5. Carry rate from time-weighted notional (P0)

- `state.carryAccount` keeps `notionalHours += notional × dtHours` every loop. The rate becomes `usd / notionalHours × 1e4` (bp/h). Never divide by current notional.
- With no per-pair data, fall back to the venue's published rollover (`AS_ROLLOVER_BPS_4H`, default 2 → 0.5 bp/h), not the account average.
- Dedupe carry against `fundingBorrow` by ledger refid, as v4 does for funding. Log `CARRY rate=<bp/h> src=pair|account|venue usd=$ nh=<notional-hours>`.

### 6. Expected net edge ranking, with no hard reject on vol or tick (P1)

- Replace `expectedEdgeRow`'s `max(..., need)` floor. For each candidate and a ladder of half-spreads h ∈ {touch, need, need+σ-steps}:

  ```
  fillp(h)  = empirical from our own fills (hits at distance h / quotes at h), with a prior from
              σ·√τ and 24h trade count: p0 = min(1, trades24/1440 × τ) × exp(−(h − touchHalf)/ (k·σ√τ))
  adverse   = −mean m5 markout for that pair (or the venue mean, if no pair data)
  netEdge(h)= fillp(h) × (2h − 2·fee − adverse) − carry(h, hold)
  ```

  Score = max over h of `netEdge(h)`, and remember the best h.
- **Ranking:**
  - Pick at most `MM_MAX_PAIRS` names with `score > AS_MIN_NET_EDGE_BPS` (default 1 bp per expected round trip).
  - Quote each at its best h, still clamped by `MAX_HALF_BPS`/`AS_MAX_QUOTE_DIST_BPS`. Allow up to 250 bp on wide-tick names, where `cap = max(150, 2×tickBps, spread_med)`.
  - If nothing scores positive, log `SCAN none-tradeable best=<sym> net=<bp> h=<bp> fee=<bp>`.
- **Soften the hard rejects:**
  - `tickBps > 10` and `vol24 < SCAN_MIN_VOL24_USD` become score penalties, not rejects.
    - Tick: a tick above the half just quantizes h.
    - Volume: lower volume lowers `p0`.
  - Keep a sanity floor of `vol24 ≥ $25k` and `trades24 ≥ 200`.
  - Lower `SCAN_MIN_VOL24_USD` to 25000 in `configs/as-kraken.env`. No coin names anywhere.
- **Candidate set:** keep v13's `marginOk` filter for two-sided quoting. Also rank the spot-only pairs (long-only, 1x) through the same score, so more volatile spot names can win on merit.
- **Logging:** `SCAN picked=<sym>:<net>bp:h<bp>:p<fillp>` and the top 5 rejects with their net edge. The log should show the margin each one missed by, not a reason word.

### 7. Lifetime-aware loss cap (P1)

- `sessionCap = min(AS_MAX_SESSION_LOSS_PCT, 0.5 × stopDist)`. Today that is 2.1% ≈ $0.20.
- Per-order worst case (`exitLossNotional`) ≤ `0.25 × stopDist × equity`.
- **Probation** while `stopDist < 10 pp`:
  - One pair, one clip at `ordermin`, and leverage ≤ `AS_RESET_LEV` (2).
  - Probation lifts after 10 round trips with realized net (after real fees) ≥ 0.
  - Another 25% of the remaining distance lost re-enters probation.
- Log `RISK probation stopDist=<pp> cap=$<x>`.
- These only tighten. Margin rails (`STOP 300 / CUT 200 / HALT 150`), `AS_LIFETIME_DD_PCT=25` and max-leverage-within-rails are unchanged outside probation.

### 8. Close the WLD residual (and any sub-min residual) with maker orders (P1)

- **Rebuild `state.entry` from venue `OpenPositions`** (`vol − vol_closed`, `cost`) at startup and hourly. The ledger of fills is only a fallback. Log `ENTRY resync <sym> qty <old>→<new> avg <old>→<new>` when they differ by more than 1%.
- **Sub-min short:** try a post-only `reduce_only` buy for exactly `pos.short` (`validate=true` first).
  - If Kraken rejects it on `ordermin`, place a post-only buy of `ordermin` instead. That closes the short and opens a small long (9 − 3.8 ≈ 5.2 WLD ≈ $2.55).
  - Allowed only when that long fits the reserved room, the margin level stays ≥ `STOP×1.2`, and the excess is ≤ 30% of equity.
  - The excess immediately gets a normal exit ask at its cost floor, with v14 §1-style decay capped by §7.
  - Replace the `0.5% × equity` affordability test with this.
- **Pricing:**
  - While the close is profitable versus the resynced entry (today it is: 0.53 → 0.49), price at the AS bid, but no worse than `entry × (1 − fee − profit)`.
  - After `MAX_HOLD_MIN`, use `gradualHoldExit` as today.
- **Gate reasons:** the buy-side catch-all (index.js 2191) must name the reason (`below-min`, `unsized`, `carry`, `margin`). `edge` only when `edgeGate` actually failed, matching v13 §3 for the sell side.

## Acceptance

1. **as-cb bids:** within 10 minutes of deploy, at least one post-only bid rests whenever `b ≥ venueMin`. No `budget` gate prints while `b ≥ venueMin`, and `slots` and `clip` show on the `BUDGET` line.
2. **as-cb release:**
   - `RELEASE step` lines appear for names idle ≥ `AS_RELEASE_IDLE_H`, one name at a time.
   - Realized release loss per day is ≤ `AS_RELEASE_MAX_DAY_PCT` × equity, with a unit test for the cap and step math.
   - Release stops at ½ the session cap or under 10 pp to the lifetime stop.
   - The book returns to ≥ 85% of equity ex-dust within 24h of a release fill.
3. **as-cb P&L:** release fills carry `reason:"release"`, and status shows `rel=` separately. The headline trading P&L equals real equity minus capital, with pending excluded and shown.
4. **as-kraken fee:**
   - The hourly log shows `FEE tier ... src=venue` or `src=fills` with maker ≥ 25 bp. `source=default` appears only if both venue and fills are unavailable, and then with a warning.
   - Scanner `need` and every floor use that fee.
5. **as-kraken carry:** for a pair with no carry history, `CARRY src=venue` ≈ 0.5 bp/h, and no `carry` gate fires at `MAX_HOLD_MIN=240` with `PROFIT_BPS=10`. There is a unit test that a small current notional cannot inflate the account rate.
6. **as-kraken scan:** picks show distinct net edges, not a flat 27 bp. Within 30 minutes either at least one post-only order rests with positive `net`, or `SCAN none-tradeable` names the best candidate and its shortfall in bp.
7. **as-kraken WLD:** within one loop after `ENTRY resync`, a post-only buy rests that closes the short (either exactly, or `ordermin` plus an exit ask on the excess). `GATE WLD buy edge` no longer prints.
8. **as-kraken risk:** `RISK probation` is active at the current `stopDist`, the session cap is ≤ ½ `stopDist`, and no single order's worst case exceeds ¼ `stopDist`.
9. **Dashboard and status fields** (both bots): `fee=<bp> src=`, `lastFill=<age>`, `parked=<n>/$`, `rel=$`, `bidShare=<%>`, `best=<sym>:<net>bp`, `stopDist=`, `probation=0|1`. Kraken also gets `carry=<bp/h> src=`.
10. **As before:** post-only only, fee-edge check on, margin rails unchanged, no hardcoded coin names, smoke test before restart, no secrets in the repo.
