# AS bots spec v1 (`as-cb`, `as-kraken`)

Written Oct 11, 2026 (PT). Line numbers refer to commit `5cfaae4`. Check them before editing.

The ladder and the Kraken margin/short book (`12-kraken-short-book.md`) are retired. Both AS bots run from `src/bots/as/index.js`; `configs/as-coinbase.env` and `configs/as-kraken.env` pick the venue.

Baselines for this spec: as-kraken equity **$12.29**, as-cb equity **$5.72**. The owner made a withdrawal and ran a manual flatten at the same time. Those were real transfers, not P&L.

## State at 5cfaae4 (what the logs show)

- **as-kraken** has quoted RENDER all session. It keeps one bid and one ask of 2.5 RENDER resting at about 1.96/2.00, re-posting them every few minutes. Inventory has been `q=0.00` and equity a flat $12.29 for 6+ hours, so it has probably had no fills. There are no rejects.
- **as-cb** logs `AS $5.72 free=$0.61 no names` on every loop. Its last order attempts were at 7:28 PM PT, and two buys were rejected with `INSUFFICIENT_FUND`. Before `5cfaae4` it hit a long run of `REJECT BASECAT sell belowMin`.
- Neither bot logs fills or P&L.

---

## P0: Maximum leverage, with safety rails that ship in the same change

### as-kraken: use each pair's maximum leverage

Current code:
- `AS_LEVERAGE=2` is a fixed value (`index.js:28`). It is passed as `leverage: LEV` on every order (`index.js:229`).
- Room is `min(AS_MAX_NOTIONAL=10, cash × LEV × 0.4)` (`index.js:171-173`), and `syncSide` caps at a flat `AS_MAX_NOTIONAL` (`index.js:203`).

Kraken's public `AssetPairs` endpoint reports these maximums today (the largest value in `leverage_buy`/`leverage_sell`, USD pairs):

| Max | Pairs |
|---|---|
| 10× | BTC (XBT), ETH, ADA, AVAX, LINK, LTC, SOL, SUI, XRP |
| 5× | AAVE, ALGO, BCH, CRV, DOT, HBAR, NEAR, PEPE, RENDER, SHIB, UNI, XLM |
| 3× | PENGU |

- RENDER, the pair currently quoted, is 5× max, and the bot is using 2×.
- The old margin bot hard-coded `US_LEV` (`src/bots/margin/short.js:337`), with BTC and ETH at 20×. Commit `fe833f2` says Kraken accepted that. The public API currently lists 10× for both, so treat 20× as unverified and probe for it (see below) instead of hard-coding it.

Required:
1. **Max leverage per pair.**
   - In `getProducts('kraken')` (`src/shared/exchange.js:~87`), store `maxLevBuy = max(leverage_buy)` and `maxLevSell = max(leverage_sell)` on each product record. Refresh them hourly.
   - The account's real limit can be lower. Confirm it once per pair per session with a `validate: true` post-only AddOrder at that leverage, reusing the pattern at `short.js:179`. If Kraken rejects it, step down through the listed values and cache what it accepts.
   - Pass `leverage = maxLevBuy` for buys and `maxLevSell` for sells.
   - `AS_LEVERAGE` becomes `max` (default) or a number that is used as a ceiling. Delete the fixed-2 behaviour. Reuse `levFor()` from `short.js:364-368`.
2. **Sizing from equity × leverage.**
   - Total room becomes `equity × lev × AS_LEV_UTIL`, with `AS_LEV_UTIL` defaulting to 0.8.
   - Change `AS_MAX_NOTIONAL` to `max` (default), meaning `equity × lev`, or a number used as a ceiling. Apply it at both `index.js:172` and `index.js:203`.
   - The clip scales the same way: `clip = max(venue min, room / (MM_MAX_PAIRS × AS_CLIPS_PER_SIDE))`.
   - `q` must be measured in that clip (`index.js:246`). Otherwise the AS skew is wrong.
3. **Shorts are allowed and intended.** With `q=0` the ask opens a margin short (`index.js:267`). Keep that behaviour, but every rail below applies to it.

### as-cb: Coinbase spot has no leverage

The bot trades Coinbase Advanced Trade **spot**, and spot has no leverage. You can't pass a leverage value to Coinbase here (`index.js:229` sends `0`).

- Coinbase Financial Markets offers US perpetual-style futures through the Advanced Trade API, but only on accounts that have been approved for futures. Whether Blake's account is approved is **unverified**, and it needs his application and approval. This spec does not build it. It may become `as-cb-fut` later.
- The spot equivalent of max leverage is to **put the whole wallet to work**. as-cb must keep its open book at or above 90% of tradable equity, the way the ladder's `BOOK_TARGET_FRAC` did. Spread bids across the eligible pairs, and post asks for the full sellable balance.

### Safety rails (required, all config knobs, Kraken unless noted)

| Knob | Default | Behaviour |
|---|---|---|
| `AS_LIQ_MIN_PCT` | 15 | Before every order, compute the estimated liquidation price after the fill, from `TradeBalance` and `OpenPositions docalcs`. If it would be closer than this % to mid, shrink the order until it isn't. If it still is, skip the order and log `RAIL liq`. |
| `AS_MARGIN_LEVEL_STOP` | 300 | If the Kraken margin level (`ml` in TradeBalance, %) falls below this, stop adding and post only reduce-only orders. |
| `AS_MARGIN_LEVEL_CUT` | 200 | Below this, post post-only reduce-only orders at the touch to cut exposure by 50% per loop until `ml` is back above `AS_MARGIN_LEVEL_STOP`. |
| `AS_MAX_SESSION_LOSS_PCT` | 8 | Applies to both bots. Session loss is measured as transfer-adjusted equity against the persisted start equity. Past this, cancel all of the bot's orders, go reduce-only, and set `halted: 'session-loss'` in status. It stays halted until restarted with `AS_RESUME=1`. |
| `AS_MAX_DAY_LOSS_PCT` | 12 | Applies to both bots. The same check over a rolling 24h. |
| `POST_ONLY` | 1, forced | Applies to both bots. No market orders and no IOC orders. Any order without post-only is a bug and must throw. Reduce-only flattening also stays post-only, priced at the touch. |
| `AS_LEV_UTIL` | 0.8 | The fraction of equity × leverage the bot may use. |

Also required:
- `/api/status` reports `rails: { ml, liqDistPct, sessionLossPct, dayLossPct, halted, levBySymbol }`.
- A rail trip logs one line, prefixed `RAIL`.

---

## P1: Fill and P&L logging

### Why there's none today

1. **There is no fill source.**
   - Both configs set `USE_USER_WEBSOCKET=0`, and `index.js` never opens a user websocket. The ladder used `startKrakenUserWs` in `ladder/index.js:101`.
   - Nothing polls Kraken `TradesHistory`/`Ledgers` or Coinbase `orders/historical/fills`.
   - `syncSide` (`index.js:190-239`) only places and cancels orders. When an order id disappears, the bot never asks whether it was filled.
2. **P&L is hard-coded.** `postStatus` sends `netMaker: 0, fees: 0, pricePnl: 0` (`index.js:324`).
3. **Start equity is lost on every restart.** `startEquity` is an in-memory `let` (`index.js:291`) set from the first loop, so every restart resets the baseline.
4. **The per-loop line only prints equity and free cash** (`index.js:328`).

### Required

- **Fills from venue records.**
  - Kraken: poll `TradesHistory`, filtered by the bot's orders (`userref=AS_USERREF`), every loop.
  - Coinbase: poll `orders/historical/fills` for the bot's order ids.
  - Store a high-water cursor so no fill is double-counted.
  - Write each fill with `logFill` (`src/shared/fill-log.js:216`) to `logs/fills-as-<venue>.jsonl` and send it with `postFill` (`status-client.js:24`). Fields: `venueFillId, time (ISO), symbol, side, price, size, fee, feeCcy, liquidity (maker|taker), orderId, leverage, posEffect (open|close)`.
- **Session P&L**, persisted in `data/as-<venue>.json` so it survives restarts:
  - `startEquity` and `startTime`: set once per session and only reset with `AS_NEW_SESSION=1`.
  - `makerCapture`: the spread captured against mid at fill time.
  - `fees`.
  - `inventoryPnl`: mark-to-market of the position.
  - `fundingBorrow`: Kraken margin rollover and opening fees, taken from `Ledgers` entries of type `rollover` and `margin`.
  - `transfers`: deposits and withdrawals, **only** from venue records (Kraken `Ledgers` type `deposit`/`withdrawal`, Coinbase transactions). **Never infer a transfer from a cash residual** (the v13 lesson).
  - `equityAdj = equity − startEquity − transfers`.
  - `recon = equityAdj − (makerCapture − fees + inventoryPnl − fundingBorrow)`. Log `RECON` if `|recon|` is more than 1% of equity.
- **`/api/status`** for each bot: `pnl: { startEquity, startTime, lastEquity, transfers, equityAdj, makerCapture, fees, inventoryPnl, fundingBorrow, recon, fills, fillsHour }`, plus per-market `openOrders`.
- **Per-loop log line**: `AS eq=$ free=$ adj=$ maker=$ fees=$ inv=$ fund=$ fills=N lev=X ml=% | SYM q= half=bp ...`

---

## P2: Other fixes

1. **as-cb is stuck on `no names` with $0.61 free.**
   - `main()` drops every pair that isn't already held when `cash < CLIP` (`index.js:301`).
   - `select()` skips held coins that are flagged foreign, and `coinbaseBook` marks a coin foreign if it is worth under $0.9 and isn't in `state.symbols` (`index.js:117`). It also marks any coin with an order whose id isn't in state as foreign (`index.js:104-108`). After a state wipe (`index.js:316-318`), its own old orders therefore look foreign.
   - The wallet is worth $5.72 but only $0.61 is cash. Equity is in coins nobody is quoting, so the bot sits idle.
   - Fix:
     - Every held coin at or above the venue minimum gets a full-balance post-only ask.
     - Track the bot's own order ids in persisted state, and never drop an id until the venue reports it done.
     - Treat a coin as foreign only if it carries an order from a different client-order-id prefix. Tag every order with a client-order-id prefix `as-cb-`.
2. **Insufficient-funds buy rejects.**
   - `canBuy` checks `cash >= CLIP` (`index.js:266`), but `syncSide` raises the notional to `max(CLIP, minNotional)` (`index.js:208`). That can exceed free cash, and bids on two pairs both spend the same cash.
   - Fix: keep one cash budget per loop and charge each bid against it. Skip a bid whose notional exceeds what's left. Never cancel and replace a bid with a larger one while the old one is still pending.
3. **BASECAT `belowMin` loop.**
   - A dust sell was retried every 22s for hours. `5cfaae4` raises the ask to reach the minimum.
   - Also required: after 3 `belowMin` rejects on a symbol, mark it `dust` for 6h and stop trying, and report dust in status. Dust still counts in equity, but it doesn't count toward the book target or recon alerts.
4. **No hard-coded coin lists.**
   - The 23-name `US` set (`index.js:32`, used at `index.js:161`) goes.
   - Both bots pick markets from the venue scanner. Coinbase already uses `pullVenueScan` (`index.js:167`). Kraken must use `pullVenueScan('kraken')`, or a Kraken scan using the same code (`src/shared/vol-scan.js`).
   - Filters, all config knobs:
     - `SCAN_MIN_VOL24_USD`, default 250k.
     - `SCAN_MAX_SPREAD_BPS`, default 40.
     - Realised 15m range ≥ `VOL_ENTER_PCT`.
     - The venue minimum must fit the clip.
     - Kraken only: the pair must have `leverage_sell` (shortable) when shorts are enabled.
   - Rank by expected capture, `range × fill-rate proxy`, not alphabetically (`index.js:165`).
5. **as-kraken quotes too wide to fill.**
   - Kraken's tick is hard-coded to `0.01` (`index.js:252`). On RENDER near $1.98, one tick is about 50 bp, so `snap` pushes each side 1 tick or more from the model price. The 1.96/2.00 quotes are about ±100 bp around mid on a large coin, while `MIN_HALF_BPS=60`.
   - Coinbase sigma is a constant `0.0015` (`index.js:137`), not measured.
   - Fix:
     - Use the pair's real tick (`10^-pair_decimals`, or `tick_size` when present).
     - Measure Coinbase sigma from candles, as Kraken does.
     - Scan-select pairs where one tick is under 10 bp.
     - Let `MIN_HALF_BPS` adapt per pair: `max(fee×1.2, 0.5 × the pair's 30-minute median touch spread)`.
   - Acceptance: at least 1 fill per hour per quoted pair on average.
6. **Restarts.**
   - as-cb was restarted at 5:44 and 5:45 PM PT. Both units run with `Restart=always`. Each restart resets `startEquity` (fixed in P1).
   - Add a single-instance lock per bot, as the ladder v13 spec did. Log `restart reason` at startup.
   - On startup, rebuild the bot's resting orders from the venue using the client-order-id prefix or userref, instead of trusting the state file.

---

## Acceptance (from `/api/status` and logs)

1. Kraken status shows `levBySymbol` matching the pair's accepted max leverage, for example RENDER 5. Orders carry that leverage. `rails.liqDistPct ≥ AS_LIQ_MIN_PCT` at all times.
2. Tripping a rail in dry-run (simulated ml=150) produces `RAIL` lines and reduce-only orders only, all post-only. Zero market or IOC orders over 24h. Every fill shows `liquidity=maker`, except fills from post-only orders that Kraken's own rules re-marked.
3. Fills appear in `logs/fills-as-*.jsonl` and in `pnl.fills`, with venue fill ids. A restart doesn't change `startEquity`. `|recon|` stays at or under 1% of equity over an hour.
4. Transfers are counted only with a venue record id. None are inferred from cash.
5. as-cb: the open book is at or above 90% of tradable equity, averaged over each hour (spot equivalent of max leverage). No `no names` while held coins sit above the minimum. Fewer than 3 `INSUFFICIENT_FUND` rejects per hour, and none repeated on the same order.
6. as-kraken: the pair comes from the scanner (no hard-coded list), with at least 1 fill per hour on average.
7. Kill switch: a loss of `AS_MAX_SESSION_LOSS_PCT` sets `halted` and cancels the bot's orders. The bot does not resume on its own.

## Non-goals

- Coinbase futures or perps. They are not built here and need Blake's account approval first.
- Market orders or taker exits of any kind.
- Restarting the ladder or the margin bot.
- Cross-venue hedging.
- Changing the AS model math in `quote.js`, beyond the tick and sigma inputs above.
