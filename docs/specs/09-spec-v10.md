# crypto-mm ladder: spec v10 (Oct 6, 2026, 8:20 PM PT)

## Design intent (read first)
- **What the bot is:** a **post-only, two-sided spread capturer**. It keeps one bid and one ask per coin outside the fee. After a fill it places another order on the same side and skews the other side (README; `261bc7d`/`00e2c60`, Sep 26).
- **Momentum tilt (rise-hold):** while a coin's 1-minute price is rising, it holds back part of the coin from sells and widens the ask. When the rise stops, it sells that held part at the best ask (`639058b`/`838ace3`, Sep 29).
- **Markets:** the **scanner picks them** (15-minute volatility rank over every online USDC product). No coin names are hardcoded as logic; names below are **examples only** of observed failure modes.
- **Blake's lead priority for v10:** when order criteria are met, keep the **open order book (bids + asks)** as close as possible to **total wallet equity**. Capital should be working on the scanner-selected set as post-only quotes — not sitting idle in USDC while the set churns.
- **What v10 does:**
  - Makes **book ≈ equity** an explicit deploy/sizing goal (P0).
  - Fixes sticky/focus **park** so in-set pairs that meet bid criteria actually quote instead of parking forever with idle cash (P0).
  - Recognizes **deposits as capital transfers**, not P&L / not unexplained recon (P1).
  - Stops **insufficient-funds** rejects when free cash (or free coin) is available (P2).
  - Keeps **leftover inventory** on the original exit path when value is still meaningful (P3; carry if still broken).
- Everything stays post-only. `ALLOW_MARKET_EXIT=0` stays. Do **not** hardcode coin names as markets to trade. Do **not** fight rise-hold / scanner / max-pairs with successive band-aids.

**Status (live at ~8:15–8:20 PM PT Oct 6, code at `77fde73`):**
- Equity ≈ **$16.84**, free cash ≈ **$15.90**, **0 open bids / 0 open asks** while 4/4 active pairs (examples at that snapshot: FORT / LRDS / KAIO / LCX).
- Every in-set pair showed `bidWhy=park`; asks mostly `noInv` / `dust`. `WORKING bids=$0.00 asks=$0.00`.
- Idle release (`IDLE_RELEASE_MS=15m`) is rotating the set (97 `ROTATE idle` since the v9 restart) instead of deploying capital.
- ~5:54 PM PT Oct 6 Blake added ≈$10 USDC: log shows `EQUITY STEP 10.00 unattributed cash 10.00`; `recon.transfers=[]`, `unattributed≈9.996`, `walletGain≈+$10.03`, recon `alert:true` (false positive).
- `limitFails.insufficient1h` still non-zero (3 at snapshot; 32 `Insufficient balance` session lines) despite free USDC / free dust leftovers.
- Scanner v9 item looks healthy: `universe=402 scanned=402 missing=0 quarantined=[]`.

Line numbers are at `77fde73`. Check them before editing.

## v9 status (from code and live since the v9 implement commit)
| v9 item | Status | Evidence |
|---|---|---|
| 1a Scanner bisect / quarantine | **Done** | `scanner.universe=scanned=402`, `batchErrors1h=0`, `quarantined=[]`. |
| 1b bidGate + quote state + idle release | **Partial, harmful** | `BID BLOCK` and `quote.bidWhy` exist, but `park` sticks (see P0). Idle release churns the set with $0 book. |
| 2a–2d Inventory / skew / soft stop | **In code** | Caps, skew, soft stop present. Not the failure mode tonight — capital never deploys. |
| 3 Sell sizer choke | **Partial** | Still seeing sell `Insufficient balance` (e.g. MNDE L1, NMR L4, BLAST L2/L3). See P2. |
| 4 Fee labels | **Likely done** | Venue fee rows advancing; not the v10 focus. |
| 5 Remaining v8 leftovers | **Partial** | Dust list present; exit queue empty while ORCA/HNT/META/NMR leftovers sit in dust (P3). |

## P0 — Book near equity + park/focus (lead priority)

### Observed failure
At ~8:15 PM PT Oct 6: equity ~$16.84, cash ~$15.90 idle, **0 open orders** on 4/4 active pairs. All bids blocked by `park` (`LIVE_FOCUS_N=3` focus gates); asks mostly `noInv`/`dust`. Idle release churns the set instead of quoting. Result: **book ≈ $0 vs equity** — fails Blake's "keep open orders near total wallet equity when criteria met."

### Root causes (code at `77fde73`)
1. **Sticky `parked` flag (smoking gun).** `processPair` sets `st.parked = true` in the park branch (`strategy.js` ~L828–852) and **never clears it** when the pair later becomes focused or rising. `bidGate` (~L127) returns `park` whenever `st.parked` is true. Live proof: pairs with `rising:true` still show `bidWhy=park` and 0 orders.
2. **Focus parks most of the set.** `LIVE_FOCUS_N=3` + `isTopWeight` (`strategy.js` ~L631–642, `FOCUS_LOCK_MS` default 120s) means with `MM_MAX_PAIRS=4`, at least one in-set pair is always in the park branch. Park **pulls all bids** and returns early — so that slot never quotes.
3. **Idle release fights empty books instead of fixing them.** `index.js` ~L204–212 marks pairs idle when no open bids and inventory < `MIN_ORDER_USD`; `rotate.js` ~L40–45 rotates them after `IDLE_RELEASE_MS` (15m). With sticky park, every pair eventually looks idle → churn, still $0 book.
4. **Sizing caps leave most cash unposted even when bids are allowed.** `INV_BOOK_MAX_FRAC=0.45` (`resizeLeg` ~L312–313) and `CASH_FLOOR_FRAC=0.35` (`bidGate` ~L137, `resizeLeg` ~L314) structurally keep a large cash buffer. Combined with `CLIP_MAX_USD=1.5`, open-book notional cannot approach equity. There is **no** explicit "deploy open bids+asks toward equity" goal.

### Design intent (do not fight the bot)
- Scanner still picks markets. Max-pairs still caps how many. Rise-hold still holds inventory on rises.
- Park/focus exists to concentrate **depth** on the hottest 1m names — not to leave the account flat with idle USDC.
- When an in-set pair passes `bidGate` (trend/peak/cap/cash/rip/sibling/tape all clear) and has free quote, it should **post**. Capital works on the selected set.

### Change

#### P0a. Explicit book≈equity deploy goal
1. Define `bookNotional = Σ open bid notional + Σ open ask notional` (use existing `working.bids` / `working.asks` / per-market `bidUsd`/`askUsd`).
2. Define target: `BOOK_TARGET_FRAC` (default **0.90**) × `totalEquity`. When criteria are met across the in-set, aim for `bookNotional` to approach that target with **post-only** orders only.
3. Expose in `/api/status.working`: `{ bookNotional, bookTarget, bookGap, bookTargetFrac }` and log on the WORKING line: `book=$X / target=$Y`.
4. **Sizing implication:** distribute deployable cash across in-set pairs that pass `bidGate`, still respecting per-coin `capFor` / `costHeld` and min order. Raise the effective ceiling so the book can grow:
   - Set `INV_BOOK_MAX_FRAC` default to **≥ `BOOK_TARGET_FRAC`** (recommend **0.95**), or treat book-target as the binding book cap when it is higher.
   - Set `CASH_FLOOR_FRAC` default lower at this equity (recommend **0.10**), or skip the cash-floor block when `bookNotional < bookTarget` and free cash exceeds one clip — idle cash is the failure mode tonight.
   - Keep `CLIP_MAX_USD` / `INV_NAME_MAX_FRAC` as per-coin risk controls; do **not** remove inventory caps. The goal is many working quotes totaling near equity, not one oversized coin.
5. **Asks count toward the book.** Inventory already held should stay covered by open asks (existing cover / ladder). Book≈equity is bids+asks, not bids alone.

#### P0b. Fix sticky park (required)
1. In `processPair`, when the pair is focused **or** rising (i.e. not taking the park early-return), set `st.parked = false` before quoting.
2. `bidGate` `park` reason must mean "**parked on this tick**", not "was parked earlier this session". Prefer: pass a live `parkedNow` into the gate, or clear the flag as above and only set it inside the park branch.
3. After clearing park, run the normal ladder / `pinL1` / `ensureBothSides` path so a previously parked pair actually posts.

#### P0c. Refine focus / park so the selected set works capital
Pick **one** of these (prefer A; B is acceptable if A is too aggressive on deeper levels):

**A (preferred at ~$17 equity):** Make focus cover the live set.
- `effectiveFocusN = max(LIVE_FOCUS_N, mmAlloc.length)` when `totalEquity < FOCUS_ALL_EQ_USD` (default **25**), **or** simply default `LIVE_FOCUS_N` to match `MM_MAX_PAIRS` (4) at this size.
- Goal: every in-set pair can bid when `bidGate` is otherwise ok. Focus then only limits **level count** (deep books on top weights via `generateLadder` ~L202–205), not "zero bids."

**B (milder):** Park may cancel **L2+** bids on non-focus names, but **must keep / restore an L1 bid** when:
- pair is in `mmAlloc`,
- `bidGate` would otherwise be ok (ignoring park),
- and `bookNotional < bookTarget` (idle cash to deploy).
- Log `PARK depth <sym>` vs `PARK flat <sym>` so we can tell depth-trim from flat-book.

Do **not** remove rise-hold. Do **not** bypass trend/peak/cap/rip when those gates are real. Do **not** hardcode symbols into focus.

#### P0d. Idle release interaction
1. Idle release stays for pairs that are truly unable to quote (e.g. stuck on `tape` / `trend` / `rip` for `IDLE_RELEASE_MS` with no inventory).
2. A pair blocked **only** by sticky/wrong `park` must **not** count as idle — fix P0b/P0c first.
3. When `bookGap > 0` and free cash ≥ `MIN_ORDER_USD`, prefer **deploying** on the current set over rotating. Optionally suppress idle-rotate while `bookNotional < bookTarget * 0.5` unless `bidWhy` has been a non-park blocker for the full idle window.
4. Log `ROTATE idle <sym> <bidWhy> <min>m` must include the real `bidWhy` (already intended in v9); verify park is not the only reason after P0b.

#### P0e. Clarify sibling / trend / cap with deploy goal
- `sibling` (`siblingHasBareBids`): must not leave the whole set with 0 bids. If sibling blocking would zero every bid while cash is idle, allow at least one L1 bid on the top-weight ready pair.
- `trend` / `peak` / `rip` / `cap`: keep as risk gates. They reduce size or pause a name; they must not be an excuse for account-wide flat books when other in-set names are clear.
- Document in code comments near `bidGate` / `processPair`: **deploy goal vs risk gates** (deploy is account-level; gates are per-name).

### Acceptance (P0)
- With equity ~$15–20 and free cash ≥ ~70% of equity, when ≥1 in-set pair has a clear non-park `bidGate`, **within 2 minutes** `bookNotional ≥ min(bookTarget * 0.7, freeCash * 0.7)` (post-only; subject to venue rejects counted separately).
- 0 in-set pairs show `bidWhy=park` while `rising:true` or while in the focus lock set.
- Samples with `WORKING bids=$0` while cash ≥ $10 fall sharply (target: under 15% of status ticks over 6 h, vs near-continuous $0 tonight).
- Idle rotates per hour drop vs the post-v9 churn; rotations that remain show a non-park `bidWhy`.
- `/api/status.working` exposes book target / gap; dashboard/WORKING log shows it.
- No hardcoded coin lists. No market exits. Rise-hold behavior unchanged for held inventory.

## P1 — Deposit detection (capital, not P&L)

### Observed failure
~5:53 PM PT Oct 6 (`2026-10-07T00:53:07Z`): `EQUITY STEP 10.00 unattributed cash 10.00 …`. No `TRANSFER` line. `pnl.transfers=[]`, `netDeposits=0`, `unattributed≈9.996`, dashboard `walletGain≈+$10.04`, `recon.alert=true`. Blake's ~$10 USDC deposit was treated as unexplained residual, not capital.

### Where
- `src/shared/venue-recon.js` ~L103–128: polls Coinbase v2 account transactions; filters `deposit|withdraw|transfer|send|receive`. Live `state.transfers=[]` all session — venue path never booked this deposit.
- `src/shared/pnl.js` `markHoldings` ~L109–141: large residual → `unattributed` + `EQUITY STEP`, **does not** call `noteTransfer`.
- `noteTransfer` (~L89–99) correctly bumps `startEquity` when called; it simply was not called.

### Change
1. **Heuristic deposit/withdraw in `markHoldings` (required).** When, in one mark:
   - `|Δcash|` and `|Δequity|` agree within tolerance (e.g. $0.05 or 1%),
   - no fill in the last ~60s,
   - position qty map is unchanged (or changes are dust-only),
   - `|Δequity| ≥ DEPOSIT_DETECT_USD` (default **1.0**),
   → call `noteTransfer(Δequity, 'equity-step', id)` with a stable id (`equity-step:<tsBucket>` or hash of amount+minute) so it dedupes.
   - Do **not** add to `unattributed`.
   - Log `TRANSFER +N.NN equity-step …` like venue transfers.
2. **Venue path:** keep polling, but:
   - Log once per session if the transactions endpoint errors or returns 0 rows while cash moved (`transfer history` already warns once — also log empty-but-cash-moved).
   - Broaden type match if Coinbase labels Advanced Trade funding differently (inspect a real tx once on the box; include common types such as `fiat_deposit`, `pro_deposit`, `internal_deposit`, `advanced_trade_fill` **excluded**, etc.). Never commit secrets; only type strings.
   - Prefer brokerage/Advanced funding endpoints if v2 retail transactions omit Advanced USDC tops-ups.
3. **Recon:** after a booked transfer, `unattributed` must not retain that amount; `recon.alert` must not fire solely because of a just-booked deposit. `gapUsd` should ignore transferred capital (startEquity already adjusts).
4. API: `pnl.transfers` / `recon.transfers` show the deposit; `netDeposits` ≈ +10 for this event; `walletGain` reflects trading, not the top-up (or document clearly: walletGain ex-deposit).

### Acceptance (P1)
- Replaying a +$10 USDC top-up with no fills: exactly one `TRANSFER +10.00 …`, `unattributed` does not rise by ~10, `recon.alert` false for that step, `netDeposits` includes it.
- Withdrawals get the negative transfer symmetrically.
- No double-count if venue recon later sees the same tx (id dedupe).

## P2 — Insufficient-funds rejects with free cash / free coin

### Observed failure
Session log: 32 `Insufficient balance` lines after v9 restart (examples: MNDE sell L1, NMR sell L4, BLAST sell L2/L3) while free USDC was often $5–16. Live snapshot still showed `insufficient1h: 3` with ~$15.90 free cash and 0 open bids (so tonight's rejects are mostly **sell** sizing, not buy cash — but buy path must stay honest when bids resume under P0).

### Where
- Sell choke intended in v9 (`exchange.js` `limitOrder` sell clamp / `sellable` / `free-qty.js`) — still leaking on ladder L2+ and cover/slide paths.
- Buy path: `resizeLeg` uses `freeQuote - reserved` with haircuts (`capitalSafetyMargin` × `orderSizeHaircut`); stacked haircuts + stale cache can still oversize when bids are live.

### Change
1. **Audit every sell placement** (cover, slide, skew, soft-stop, exit, ladder L2+): final size must be `min(want, sellable(base))` at the `limitOrder` choke. On skip, `SELL CLAMP` (not venue insufficient).
2. **Invalidate / refresh** free-qty after every successful sell placement and reject; drop the reservation on insufficient (v9 item 3.6) — verify it is wired for multi-level sells.
3. **Buys:** size from `freeQuote +` accurate view of holds. Do not count the same USDC twice across pairs in one tick (`pendingBidUsd` already helps — ensure park-clear bursts under P0 cannot stampede past cash). If `cashLeft < minUsd`, return 0 with `bidWhy`/`resize` reason rather than posting.
4. Keep rolling `limitFails.insufficient1h`; target remains **&lt; 5/h** all pairs (v9 acceptance). After P0 redeploy, watch buy-side insufficients especially.

### Acceptance (P2)
- &lt; 5 `Insufficient balance` / hour over 6 h after fix.
- 0 insufficients immediately after a successful same-symbol sell placement.
- With free USDC ≥ $10 and clear bid gates, buy posts succeed or soft-skip locally — not venue insufficient.

## P3 — Leftover inventory without exits (carry if still broken)

### Observed failure
Dust includes meaningful leftovers under `MIN_ORDER_USD` (examples: ORCA ~$0.27, HNT ~$0.25, META ~$0.12, NMR ~$0.12) with **`exits: []`**. `sweepStranded` (`exit-book.js` ~L59–74) only queues exits when `value ≥ MIN_ORDER_USD` (1); the rest sit forever.

### Change (aligned with original exit design)
1. Add `DUST_EXIT_USD` (default **0.15**, or `min(MIN_ORDER_USD, max(venue min notional, 0.15))`): stranded coins **not in `mmAlloc`** with value ≥ that floor get a **post-only** exit row, same step-down behavior as v8/v9 exits.
2. If venue `ordermin` / notional prevents a legal post, keep in `dust` with `lastErr:'below venue min'` — no market dump.
3. `ALLOW_MARKET_EXIT=0` stays. Stranded taker (v8) remains the only market path, still capped.
4. Do not hardcode leftover symbol lists; sweep all non-set positions each tick as today.

### Acceptance (P3)
- A non-set leftover ≥ `DUST_EXIT_USD` and venue-legal shows an `EXIT` row within one sweep.
- 0 new market sells from this path.
- Dust list only contains truly unpostable crumbs.

## Non-goals
- No hardcoded coin names as markets to trade (scanner only; names in this spec are examples).
- No `ALLOW_MARKET_EXIT=1` / rotation dumps / startup flattening.
- No weakening rise-hold's hold-back on rising inventory.
- No removal of per-coin inventory caps (`INV_NAME_MAX_FRAC` / cost basis).
- No secrets, API keys, wallet addresses, or SSH details in commits (repo is public).
- No production bot edits from this spec commit — SuperGrok implements from the spec file.

## Config deltas (starting point; Blake can tune live)
```
BOOK_TARGET_FRAC=0.90          # new (P0a): open bids+asks / equity target
INV_BOOK_MAX_FRAC=0.95         # was 0.45 — was capping book far below equity
CASH_FLOOR_FRAC=0.10           # was 0.35 — was forcing large idle cash
LIVE_FOCUS_N=4                 # was 3 — cover full MM_MAX_PAIRS at this size
# or FOCUS_ALL_EQ_USD=25 with effectiveFocusN = max(LIVE_FOCUS_N, mmAlloc.length)
IDLE_RELEASE_MS=900000         # keep; but idle must not fire on sticky park alone
DEPOSIT_DETECT_USD=1.0         # new (P1)
DUST_EXIT_USD=0.15             # new (P3)
ALLOW_MARKET_EXIT=0            # unchanged
STRANDED_TAKER=1               # unchanged
MIN_ORDER_USD=1                # unchanged for new entries; dust exits use DUST_EXIT_USD
CLIP_MAX_USD=1.5               # keep per-clip; deploy via more working quotes, not giant clips
INV_NAME_MAX_FRAC=0.25         # keep
```

## Implement order
1. P0b sticky park clear (smallest, unblocks quoting).
2. P0c focus/park refine + P0a book target / config ceilings.
3. P0d idle-release guard once books can deploy.
4. P1 deposit heuristic + venue broaden.
5. P2 sell/buy insufficient audit.
6. P3 dust-exit floor.

## Done means
SuperGrok implements against this file on the live tree, commits the code changes separately, and Blake can verify: WORKING book near equity when gates clear, deposits as `TRANSFER`, insufficients rare, leftovers on exits when venue-legal.
