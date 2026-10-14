# Spec AS v8: bounded risk while halted, no silent idle cash, exchange-confirmed open orders

Status: **active, addendum to `20-spec-as-v7.md`**. v7 (amended `0aba55a`) is **not yet deployed** (live server is on `c99d99d`). Implement v7 and v8 together; where they conflict, v8 wins. Line numbers are not given. Check `src/bots/as/index.js` at the implementation base.

Design constants (unchanged): original Avellaneda-Stoikov design; no hardcoded coin names (scanner picks markets); post-only maker only; deposits and withdrawals are capital, never P&L; **unknown money is flagged, never pauses trading** (v7 P0-2); open book ≈ 90% of ex-dust equity when order criteria are met; Kraken max leverage with the rails; kill switch 8% session / 12% day; no secrets in repo or logs.

## Observed (Oct 14, last good read 7:42 AM PT)

- **as-kraken**: halted (`session-loss`) since 2:37 PM PT Oct 13. Loss kept growing while halted: −10.4% → −11.6% → −12.6% ($10.72 vs start $12.28). It holds a 10x ADA long (~33 ADA) with only a reduce ask at/above the cost floor. The halt stops new risk but leaves the full leveraged position riding the market.
- **as-cb**: from ~5:36 AM PT every scan is `SCAN none-tradeable` with `rejected=0`. ~$21.81 cash idle, no orders at all, no log line saying why.
- **Dashboard/status**: the STRK ask that filled at 5:38 AM PT is still listed as open, which inflates book %.
- **as-cb bids**: `GATE STRK buy max-dist … dist_touch=152..196 cap=150` on a wide book. v7 P0-3 asked for a spread-relative cap; it is not live yet.
- **Deposit**: the ~$19.18–20.01 Coinbase deposit is still unbooked (v7 P0-1/P0-2 cover it; unchanged).

## P0-1: a halt must bound risk, not just stop opens (both bots, matters on Kraken)

A halt that holds full leveraged inventory with an ask parked above market is not a risk limit. While halted:

- **Record halt baseline:** at HALT persist `state.haltAt`, `state.haltEquity` (MTM, ex-pending/transfers per v7 P0-2) and `state.haltNotional`. Survives restarts (v7 P1).
- **De-lever on halt:** immediately on HALT, target exposure `notional ≤ AS_HALT_MAX_LEV (default 2) × equity`. Excess is reduced as **post-only maker** reduce orders at touch (best ask for longs / best bid for shorts, re-pegged each loop), tagged `risk=halt-delever`. The cost floor does not apply to this excess slice.
- **Additional-loss cap:** let `haltLoss = haltEquity − equityNow` (ex-transfers). If `haltLoss > AS_HALT_EXTRA_LOSS_PCT (default 2%) × haltEquity`, or the halt is older than `AS_HALT_MAX_HOLD_H (default 6)`, exit the rest stepwise as maker using v7's capped-loss stepping (¼ half per 15 min toward touch), tagged `risk=halt-cap`. The 1.5% below-cost cap from v7 P1 is lifted for this path: the cap is now on loss since halt, not distance from cost.
- **Never market orders.** If a post-only reduce is rejected for crossing, re-price one tick passive and retry next loop.
- **Log:** `HALT risk notional=$x lev=y haltLoss=$z (p%) action=<hold|delever|cap-exit>` once per change and at least hourly. Add `haltLoss=` to the status line.
- **Day kill (12%)** still applies; if hit while halted, same exit path, tag `risk=day-kill`.
- Re-entry rules (v6/v7 phase C, flat 60 min, control-file reset) unchanged.

Acceptance: after restart with the ADA position, within one loop notional ≤ 2× equity via a maker reduce at touch; a `HALT risk` line is logged; loss measured from halt time never exceeds 2% + one step's slippage before the position is flat or within the cap; no market orders; no order below venue minimum is sent.

## P0-2: never sit on idle cash silently (as-cb, applies to both)

Reinforces v7 P0-3 (products-API fallback when the scan is empty).

- **Empty candidates is an error state, not a quiet result.** If raw candidates = 0 or `rejected=0 && picked=0`, log `SCAN empty source=<file|api> n_raw=… after_products=… after_quote=… after_filters=…` and fall back to the products API in the **same loop**.
- **Per-candidate reject reasons:** for the top 20 candidates by volume, log one compact line each loop when nothing is picked: `SCAN reject <sym> reason=<fee-spread|vol|tick|min-size|status|stale|dist> val=… need=…`. One reason per candidate (the first failing check). Rate-limit to once per 10 min when unchanged.
- **Idle-cash watchdog:** if free cash > 50% of ex-dust equity for > 15 min, log `IDLE free=$x (p%) for=m min reason=<top reject reasons>` and include `idle=` in status. If idle > 60 min, relax scanner filters one step (`AS_MIN_EDGE_BPS` down to fee break-even + 2bp, volume floor halved) and log `SCAN relax step=n`; restore once the book ≥ 80% for 30 min. Never relax post-only or fee break-even.

Acceptance: no 15-minute window where free cash > 50% of ex-dust equity without an `IDLE` line naming reasons; `SCAN none-tradeable rejected=0` never appears without a `SCAN empty` diagnostic and a fallback attempt in the same loop; within 1h of the v7+v8 restart, as-cb has orders on ≥ 1 scanner-picked market or logged reject reasons for each top candidate.

## P0-3: open orders come from the exchange, not memory (both bots, dashboard)

- **Reconcile every loop:** fetch open orders from the exchange (Coinbase `orders/historical/batch?order_status=OPEN`, Kraken `OpenOrders`). Local orders not on the exchange are resolved by querying fills/status: filled → book fill (once, dedup by fill id), cancelled/expired → drop. Log `RECON order <id> local=open exch=<filled|cancelled|missing> → <action>`.
- **Status/dashboard:** `book %` and the open-order list are computed only from exchange-confirmed open orders, at the last reconcile. Show `orders_synced_at` in status/dashboard; if older than 2 loops, display `book=stale`.
- Write the reconciled snapshot to `data/<BOT>.json` so crypto-mm-web reads the same list.
- Exchange orders not tracked locally follow v7 ORPHAN handling (adopt or cancel, log once).

Acceptance: a filled order disappears from status and dashboard within one loop of the fill; the 5:38 AM-style stale STRK ask case cannot recur (unit test: local open + exchange filled → fill booked once, order removed, book % recomputed); book % equals Σ(exchange open order notional) / ex-dust equity ± 1%.

## P1-1: max-distance cap is spread-relative (confirm v7 covers it)

- Cap = `max(AS_MAX_QUOTE_DIST_BPS, ½ × observed touch spread + need_bps)`, where observed spread is the median over the last 10 min (not one tick). Applies to both sides, both bots.
- Log the cap actually used: `GATE <sym> <side> max-dist need=… dist_touch=… cap=… spread_med=…`.

Acceptance: on a book with 196bp touch spread and need=110, cap ≥ 208bp and the bid is placed; no `cap=150` line where `½ spread + need > 150`; unit test for 152bp and 196bp cases.

## P1-2: deposit (unchanged, v7 P0-1/P0-2)

Keep v7 as written. The ~$19.18–20.01 deposit is booked once as capital (ledger, or pending → inferred within 30 min), trading never pauses, `startEquity` unchanged.

Acceptance: as v7.

## Out of scope / unchanged
Post-only only; no coin lists; ledger-first transfers, unknown money never pauses trading; kill switch thresholds 8%/12%; margin rails 300/200/150, resume 350; no secrets in repo or logs.
