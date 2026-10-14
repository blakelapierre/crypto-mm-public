# Spec AS v5: as-kraken stops paying fees to trade, halts that reset themselves, as-cb dust out of the budget

Status: **active**. Supersedes `17-spec-as-v4.md` (implemented in `5ad9f3f`). Line numbers refer to `src/bots/as/index.js` at `5ad9f3f`. Check them before editing.

Design constants (unchanged): no hardcoded coin names (the scanner picks markets; any coin named below is only an example of what was held or traded); post-only only; deposits and withdrawals are capital, never P&L; open book ≈ 90% of equity (`BOOK_TARGET_FRAC`) when order criteria are met; venue max leverage on Kraken with the v1-v4 rails (margin 300/200/150, resume 350; kill switch 8% session / 12% day).

## Post-mortem of v4 (observed Oct 13, ~1:00 AM PT restart to ~9:00 PM PT)

v4 landed cleanly: funding now steps on rollovers only (`fund=$0.03`), `BUDGET` and `half_src` are logged, markout and ledger logs exist, no market orders, no `INSUFFICIENT`. What is left:

- **as-kraken halted.** `HALT session-loss` at 2:37 PM PT Oct 13 (22:37:44 server BST) at eq $11.23 vs start $12.28 (−8.5%). Now `eq=$11.18 (−8.95%) maker=$-0.02 fees=$1.02 fund=$0.03 resid=$-0.14 fills=41/0`. It only places reduce orders and will never open again without a code change or `AS_RESUME`.
- **Fees are the loss.** 41 fills, all maker, fees $1.02, net maker −$1.04. Fees ≈ 31bp per round trip (≈ $0.025 per ~$8 fill), while the half actually sent is often **below the floor**: the live status shows `AVAX half=15bp/floor` with `MIN_HALF_BPS=26`, and the log shows `BUY AVAX … reduce half=15bp half_src=floor`. The v4 "one function decides the sent half" did not cover reduce/exit quotes.
- **Selling below cost.** The order that tripped the halt was an AVAX sell at 10.29 (21:37:38 BST) against an entry/floor ≈ 10.40, fill row `posEffect:"open"`.
- **Equity frozen between fills.** From 2:00 to 3:02 PM PT every status line reads `eq=$11.31 adj=$-0.97` while `inv=` moved $20.47 → $20.57 with three open positions. Cause (line 443): `equity: Number(tb.eb || tb.e || 0)`. Kraken `TradeBalance.eb` is the *equivalent balance* (cash only, excludes unrealized P&L on open margin positions); `e = eb + n` (unrealized) is the marked equity. The kill switch, book %, sizing and RECON all run on a number that ignores open P&L.
- **Spread capture is always zero.** Every Kraken fill row has `capture:0` and `mid` equal to `price` (e.g. `AAVE sell 159.21 mid 159.21`). Lines 231/233: `mid = mids[sym] || px` is taken at *poll* time; the map has no entry for the fill's symbol (or it holds the fill price), so the fallback makes capture exactly 0. Coinbase path (line 255) has the same fallback. `posEffect` is hard-coded `'open'` for every fill (lines 240/262) even for closes.
- **Mostly exits, no bids with free cash.** All afternoon `free=$8.5` of `eq=$11.3` while quotes were mostly reduce-side; `REJECT AVAX buy belowMin` on a 0.0043 reduce bid (a dust remainder of a position).
- **as-cb starved by dust.** `eq=$5.58 free=$0.58 inv=$1.14 (1) dust=$2.86 (28) book=22%`. Last hour of GATE lines: 296 `buy budget`, 94 `buy vol-warmup`, 79 `both vol`. No new fills for ~8h. 28 dust names (half of equity) earn nothing and count against nothing, so the budget is just `$0.58 − $0.10`.
- **Reconciliation** `resid` drifts $0.10-0.36 on Kraken (now −$0.14); mostly explained by the `eb` vs `e` equity above.

## P0-1: never quote a spread that does not pay the fees (as-kraken, both bots)

Fix:
- One function, `sentHalf(sym, side, purpose)` with `purpose ∈ open|exit|reduce|unwind|halt`, decides **every** price sent. All paths (bids, asks, reduce, hold-cap exit, unwind, halt sweep) go through it; `halfFor`, `adaptiveHalf`, `gradualHoldExit`, `unwindAsk`, `touchExit` return a *candidate* that `sentHalf` clamps.
- **Opening quotes:** require `half ≥ makerFee + AS_FEE_BUFFER_BPS (default 6) + AS_PROFIT_BPS` **and** `2 × half − 2 × makerFee ≥ AS_MIN_EDGE_BPS (default 8)` (round trip must net positive). Use the *current* fee tier from `loadMakerFee`, in bp of the order notional. If the touch spread plus the adaptive term can't reach that without being far from the touch (> `AS_MAX_QUOTE_DIST_BPS`, default 150), **don't quote that side**: log `GATE <sym> <side> fee-edge half=<x> need=<y>`.
- **Exit quotes** (closing an open position) are bounded by the cost floor in P0-2, not by the opening rule.
- Scanner: rank pairs by `touch spread − 2 × makerFee` and sigma; a pair whose median touch spread over the last hour is < 2 × makerFee gets no opening quotes (`GATE <sym> both fee-spread`). No coin list; this is a filter on measured data.
- Status prints the half actually sent per side (`half=b26/a31bp`) and its source.

Acceptance: no order line with `half < makerFee + buffer` on an opening order; after 24h, `maker capture − fees ≥ 0` on round trips that closed through the normal (non-risk) exit; status never shows a half below `MIN_HALF_BPS` on an opening quote.

## P0-2: don't unwind below cost unless a defined risk rule says so (as-kraken)

Fix:
- Each position carries `entryAvg` (fee-inclusive) and a **cost floor** = `entryAvg × (1 ± (makerFee + AS_PROFIT_BPS))` (long: above, short: below). Persist it with the position; recompute from the fills log at startup.
- Exit/unwind/hold-cap prices are clamped to the cost floor. Crossing it is allowed **only** when one of these fires, and the order line must say which: `risk=margin` (ml below the 200 cut rail), `risk=stop` (adverse move ≥ `AS_STOP_SIGMA` × sigma_15m × √(hold/15m), default 3, or ≥ `AS_STOP_PCT` of position notional, default 3%), `risk=hold` (age ≥ 2 × `AS_MAX_HOLD_MIN`), `risk=halt` (only for day-loss or margin halt, not session-loss, see P0-4). Then step at most ¼ half per 15 min (v4 gradual exit), never crossing the spread (post-only).
- Sizing of the opening order already caps a forced exit at `AS_MAX_EXIT_LOSS_PCT` (v4); keep it.
- Remainders below the venue min (e.g. the `REJECT AVAX buy belowMin` 0.0043 reduce bid) are not re-sent every loop: round the reduce size **up** to the venue minimum when that does not flip the position by more than the min, otherwise mark it `dust` and stop sending.

Acceptance: no exit fill below cost floor unless its log line carries a `risk=` tag; zero repeated `REJECT … belowMin` lines for the same symbol within an hour.

## P0-3: mark equity to market every loop (as-kraken, both bots)

Fix:
- Kraken `equity = Number(tb.e)` (balance + unrealized). Keep `eb` as `cashEq` for logging only. If `e` is missing, compute `eb + Σ position unrealized at mid`.
- Coinbase: equity = cash + holds + Σ holdings × current mid (incl. dust) every loop.
- Kill switch, book %, sizing, `exitLossNotional` and RECON all use the marked equity.
- RECON identity becomes `maker + inv_realized + inv_unrealized − fees − fund = Δequity − transfers`, `|resid| ≤ $0.02`; log each part hourly.

Acceptance: with open positions, `eq` changes between fills when mids move; the 2-3 PM PT style flat-`eq` hour cannot recur; Kraken `|resid| ≤ $0.02` for 24h.

## P0-4: halts that reset without a code change

Today `state.halted` is set once (line 1306) and only cleared by `AS_RESUME` env at startup (line 1265), so recovery needs a deploy.

Fix:
- **Session-loss halt:** stop opening, close positions with exits bounded by cost floor (P0-2 rules apply, no forced loss). When **flat** (no positions above venue min, no open orders) for `AS_HALT_COOLDOWN_MIN` (default 60), start a **new session**: `startEquity = current marked equity`, log `SESSION reset baseline=$X prev=$Y reason=flat-cooldown`. Allow at most `AS_MAX_SESSION_RESETS_PER_DAY` (default 2); after that the halt holds until the day rolls.
- **Day-loss halt** (12% vs 24h-ago mark): holds until the 24h window no longer shows ≥12% loss, then resets as above.
- **Margin halt:** as v1-v4 (exit to resume 350).
- **Manual reset without code:** the bot watches `data/<BOT>.control.json` (non-secret, created by the operator) each loop. `{"cmd":"reset-session"}` sets a new baseline; `{"cmd":"halt"}` halts; the file is renamed to `.done` with a timestamp after handling and logged `CONTROL <cmd>`. `AS_RESUME` stays for startup.
- Session baseline and resets are written to the status JSON (`sessionStart`, `sessionResets`).
- Deposits/withdrawals still adjust via `transfers`; a deposit never counts as recovering a loss.

Acceptance: a session-loss halt leads, without a deploy, to flat → cooldown → `SESSION reset` → opening quotes again; `CONTROL reset-session` works within one loop; resets are capped per day.

## P0-5: spread capture and position effect that mean something

Fix:
- Record the **quote-time mid** for every order at placement (`state.orderMid[orderId] = {mid, t}`), persisted. On a fill, `capture = (buy ? mid_q − px : px − mid_q) × size` using that mid; if missing, use the last mid seen *before* the fill time from the px history, never the fill price. Log `CAPTURE missing <orderId>` when neither exists.
- `posEffect` derived from the position before the fill: `open`, `add`, `reduce`, `close`, `flip`. Realized P&L per close written into the row (`realized`, fee-inclusive).
- Both venues (Kraken lines 231-240, Coinbase lines 255-263).

Acceptance: after restart, no fill row with `capture` exactly 0 and `mid == price` unless the quote really sat at mid; closes are tagged `reduce`/`close` with `realized`; status `maker=` matches the sum of fill `capture`.

## P0-6: bids when cash is free (as-kraken)

With `free=$8.5` of `$11.3` the bot rested mostly exits. Fix:
- After exits are placed, the remaining book target (`BOOK_TARGET_FRAC × equity − exit notional`) is spent on opening quotes on scanner pairs that pass P0-1, both sides allowed (long and short at venue max leverage, capped by v4 exit-loss sizing and the margin rails).
- Holding inventory in a pair does **not** block quoting the other pairs, nor the same-side add in the same pair if `|q|` < `AS_MAX_Q` (skewed per AS).
- Every side not quoted logs exactly one `GATE` reason per loop (`fee-edge`, `fee-spread`, `exit-loss`, `margin`, `halt`, `budget`, `vol-warmup`).

Acceptance: when not halted and free margin allows, `book ≥ 80%` within 1h and at least 2 pairs have opening quotes, or a `GATE` reason explains each missing side.

## P1: as-cb dust out of the budget and into the book

Fix:
- **Dust stays equity** (already counted) but is excluded from any budget or "book starved" logic: book % = (resting orders + inventory asks) / (equity − dust). Log `book=22%` as `book=…% (ex-dust …%)`.
- **Combine when possible:** for each dust name that is still a scanner market, if `dust + one min clip` ≥ venue min and budget allows, place a post-only bid of the min size at fee-paying width; on fill the combined holding becomes inventory and gets an ask (v4 unwind) above fee-inclusive cost. Cap this to `AS_DUST_COMBINE_MAX` names at a time (default 2) and ≤ 25% of budget.
- **Quote exits when possible:** any dust whose `qty × mid` rises above min (or whose base size meets the lot) is reclassified to inventory immediately and gets an ask.
- Dust that cannot be combined (not on scanner, delisted, or min > 10× dust value) is listed in hourly RECON as `dust-stuck <sym> $x` and left alone; no orders, no GATE spam.
- Budget: `BUDGET` must not stay at < venue min for > 1h while dust ≥ 30% of equity: log `BUDGET starved dust=$X` once per hour so the operator knows a manual sweep or deposit is needed (no auto-convert; Coinbase Convert is not post-only).
- `vol-warmup` gates: warmup uses existing px history from `crypto-mm-feed` if available so restarts don't idle names for N samples.

Acceptance: within 2h, ex-dust book ≥ 80%; ≥ 1 dust name combined and exited when budget allows; no more than one `buy budget` GATE per name per loop and an hourly `BUDGET starved` line when applicable.

## P2

- **Dropped markets:** when the scanner drops a pair, cancel its opening orders that loop (`CANCEL dropped <sym> <orderId>`) and keep tracking exits for held positions (cost-floor exits, P0-2) until flat. Orders still resting on a dropped pair are listed in status as `tracked=<n>`; no untracked order may exist (reconcile open orders vs `state.knownIds` each loop, log `ORPHAN <orderId>` and adopt or cancel).
- **Reconciliation drift** ($0.10-0.36): after P0-3, log per-part disagreement when `|resid| > $0.02` (`RECON drift parts=…`), and include ledger rows not matched to fills (`LEDGER orphan`). Target `|resid| ≤ $0.02` both bots.
- Hourly report per pair: fills, capture, fees, realized, markout5, half sent vs required.

## Out of scope / unchanged
Post-only only; no coin lists; transfers only from venue ledger records; kill switch thresholds 8% session / 12% day (only the reset rules change); margin rails 300/200/150, resume 350; no secrets in repo or logs.
