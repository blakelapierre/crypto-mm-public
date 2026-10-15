# Spec AS v9: no fee churn, honest loss baseline across resets, wider Kraken scanner

Status: **active, addendum to `20-spec-as-v7.md` (amended `0aba55a`) and `21-spec-as-v8.md` (`bc4ee7f`)**. Neither v7 nor v8 is deployed yet (live server is on `c99d99d`, units up since 10:34 PM PT Oct 13). Implement **v7 + v8 + v9 together**; where they conflict, **v9 wins**. Line numbers are approximate (from `c99d99d`); check `src/bots/as/index.js` and `src/bots/as/quote.js` at the implementation base.

Design constants (unchanged): original Avellaneda-Stoikov design; no hardcoded coin names (scanner picks markets); post-only maker only, never market orders; deposits and withdrawals are capital, never P&L; **unknown money is flagged, never pauses trading**; open book ≈ 90% of ex-dust equity when order criteria are met; Kraken max leverage with the rails; no secrets in repo or logs.

## Observed (Oct 14–15, PT)

- **as-kraken churn.** After the 24h-halt auto-reset at 10:35 PM PT Oct 14 (session baseline $12.28 → $10.50, full 10x again), it made ~76 maker fills mostly buying/selling the same ~33 ADA at ~0.22 and AVAX between ~9.59 and ~9.63. Fees $0.78 vs spread capture $0.08: **net maker −$0.70**. Re-halted 2:42 AM PT at session −8%.
- **Resets hide losses.** Three auto-resets (10:35 PM, 6:32 AM, 7:30 AM PT) moved the session baseline $12.28 → $10.50 → $9.65. Status shows small session %, but real equity is **−21.5% vs the Oct 11 start ($12.29)**.
- **Kraken scanner finds nothing.** It now rejects all 40 scanned markets on fee-spread (best candidates ~15–19bp short of the requirement at the 16bp maker fee) and sits flat at ~$9.65.
- **Stale Kraken order.** Status API lists an ADA bid at 0.2194 that the logs and venue say does not exist.
- **as-cb idle ~33h.** 0 open orders, scanner picks nothing, 29 dust positions, ~$19.18 deposit still unbooked (v7).

## Root cause of the churn (from code at `c99d99d`)

1. **Every edge gate only applies to orders that open risk.** The fee/vol/carry/size gates in `quoteSymbol` are all wrapped in `opensRisk(netQty, side)`. An order that reduces or closes a position (the opposite side of the last fill) never passes a round-trip edge check.
2. **The Kraken close floor counts only one fee.** For Kraken, the ask/bid on an open position is clamped with `costFloorPx({ entry, feeBps: makerFeeBps, profitBps: PROFIT_BPS })` (`quote.js`), whose pad is `feeBps + profitBps`: **one leg**. The entry leg's fee is already paid, so a close at entry × (1 + 16bp + profit) barely breaks even, and with small `PROFIT_BPS` and price rounding to the pair tick it rounds to the same 0.22 / ~same AVAX price. `exitBound` correctly uses `2 × feeBps`, but it's only applied when `!lossOk && !legacy`, so it is bypassed after a reset or in the halt step-down path.
3. **Entry average resets/moves with each churn cycle.** After a close and re-open at the same price, the new entry is the same price, so the loop repeats: open at touch → close one fee-width away (rounded to tick) → reopen. The capture logged per fill (vs mid) is tiny and fees dominate.
4. **No memory of losing round trips.** Nothing slows quoting on a pair after a round trip that lost money.

## P0-1: round-trip edge on every order (both bots, Kraken first)

- Replace the Kraken close clamp with a **round-trip floor**: long close ask ≥ `entryAvg × (1 + (2×makerFeeBps + AS_MIN_EDGE_BPS)/10000)`, short close bid ≤ `entryAvg × (1 − (same)/10000)`, rounded **away** from entry to the pair tick (never toward). Use one shared helper; delete the one-fee `costFloorPx` use for closes.
- **Opposite-side requote rule:** after any fill, the opposite-side order on that pair may never be placed tighter than fill price ± (round-trip fees + min edge). This holds even when the order is reduce-only.
- The edge check runs for **every** order, opening or closing. The only exemptions are defined risk exits, each tagged and logged: `risk=halt-delever`, `risk=halt-cap`, `risk=day-kill`, `risk=lifetime-rail`, `risk=liq`. A below-floor order without one of these tags must not be sent; log `GATE <sym> <side> edge need=<px> have=<px>`.
- **Per-pair cooldown:** after a round trip that is net negative after fees, no new opening orders on that pair for `AS_PAIR_COOLDOWN_MIN` (default 60). Two losing round trips in 24h → cooldown 6h.
- **Churn alert:** if on any pair, over a rolling 60 min, fills ≥ 6 and (fees − capture) > 0, log `CHURN <sym> fills=n fees=$x capture=$y` once and put that pair in cooldown.
- Capture accounting: per round trip, also log realized `(exit − entry) × qty − both fees`, so the `PAIR` line shows true net per pair, not only vs-mid capture.

Acceptance: replaying the Oct 14 10:35 PM–2:42 AM PT fill sequence (unit test with fixture prices 0.22 ADA tick, 16bp fee) produces no close order within 2×fee+edge of entry; no non-risk-tagged order is sent below the round-trip floor; a losing round trip triggers cooldown; live, net maker (capture − fees) on Kraken is ≥ 0 over any 6h window with ≥ 10 fills, or a `CHURN` line has fired.

## P0-2: lifetime baseline; resets cannot hide losses or snap back to full leverage

- Persist `state.capitalBaseline` = starting equity + net transfers (deposits − withdrawals per v7). It is **never** changed by a session reset. Show `life=$eq vs $base (p%)` next to session % in the status line, status API and dashboard.
- **Lifetime drawdown rail:** if `(equity − capitalBaseline) / capitalBaseline ≤ −AS_LIFETIME_DD_PCT` (default 25%), halt, exit stepwise via v8's halt path (`risk=lifetime-rail`), and **do not auto-reset**. Resume only via the control-file reset (v5), which logs who/when.
- **Reset cap:** at most `AS_MAX_RESETS_PER_DAY` (default 1) automatic resets per rolling 24h; further halts wait for the control file.
- **Leverage ramp after reset:** the new session starts at `AS_RESET_LEV` (default 2x). Leverage steps up one notch (2→3→5→max) after each 2h without a new loss halt **and** with net-positive realized round trips in that window. Any losing round trip resets the ramp to the current step's floor. Max leverage is still the ceiling.
- Session baseline semantics stay as-is for the 8% session kill.

Acceptance: after restart, status shows both session and lifetime %; lifetime for as-kraken reads ≈ −21.5% vs $12.29 (transfers-adjusted); a simulated second reset in 24h does not fire automatically; post-reset order leverage is 2x; a lifetime −25% fixture halts with no auto-reset.

## P0-3: Kraken scanner that can find tradeable markets

- Candidate universe: **all** Kraken USD (and USD-stable quoted) spot/margin pairs with 24h volume ≥ the current volume floor. Not a fixed top-N by tightness.
- Score by **expected edge**, not only quoted top-of-book spread: `expected half = max(quoted half, k × realized σ over the hold horizon)`. A pair is tradeable if quoting at `max(touch, mid ± required half)` has positive expected edge after round-trip fees under the fill-probability model already in AS (`κ`, arrival intensity estimated from trades). Quoting wider than touch is allowed when the model says fill probability × edge > 0.
- Max-distance cap stays spread/σ-relative (v8 P1-1).
- Log hourly `SCAN best <sym> exp_edge=<bp> need=<bp> fillp=<p>` for the best 5 candidates, tradeable or not.
- If none are tradeable for > `AS_SCAN_ALERT_H` (default 6) hours, log `SCAN alert none-tradeable for=<h>h` **once** (until one becomes tradeable again).
- Never relax round-trip fee break-even (P0-1). Never hardcode coins.

Acceptance: within one hour of start, the scan logs ≥ 30 candidates with scores and 5 `SCAN best` lines; either ≥ 1 pair is quoted with exp_edge > 0 or the alert fires after the threshold; no quoted pair has a required half below round-trip fee + min edge.

## P0-4: Kraken open orders are exchange-confirmed (reiterates v8 P0-3)

- Status API / dashboard open orders come from Kraken `OpenOrders` each loop (and the WS order feed). Internal `state.orders` slots without a matching venue order id are dropped after one loop and logged `ORDER stale <sym> <side> <px> dropped`.
- Acceptance: the phantom ADA bid 0.2194 does not appear; status open-order count equals Kraken's count for the account at every sample.

## P1-1: as-cb must be quoting with free cash (reinforces v7 P0-3, v8 P0-2)

- v7 products-API fallback and v8 `SCAN empty` / per-candidate reject reasons / idle watchdog stay as specified.
- Dust (29 positions) is excluded from budget and book math (v5/v6) and never blocks scanning.
- The ~$19.18 deposit is booked as capital per v7; unknown money never pauses.
- Acceptance: **within 15 min of start, with > $10 free cash, as-cb has post-only bids on ≥ 2 markets, or logs a specific reject reason for each of the top 20 candidates**; ex-dust book reaches ≥ 80% of target within 1h or an `IDLE` line names why.

## Out of scope / unchanged

- v7 deposit replay and pending-transfer rules, v8 halt de-lever/cap path, kill switch thresholds (8% session / 12% day), post-only only, no market orders.
- No secrets in repo, logs or the status API.
