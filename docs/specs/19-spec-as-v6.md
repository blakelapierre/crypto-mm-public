# Spec AS v6: tradeable pairs, a halt that can't deadlock, honest gate reasons, Coinbase deposits as capital

Status: **active**. Supersedes `18-spec-as-v5.md` (implemented in `52da3cb`, follow-up `8e6d550`, restarted Oct 13 9:13 PM PT). Line numbers refer to `src/bots/as/index.js` at `8e6d550`. Check them before editing.

Design constants (unchanged): no hardcoded coin names (the scanner picks markets; coins named below are only examples from the logs); post-only only; deposits and withdrawals are capital, never P&L; open book ≈ 90% of equity when order criteria are met; Kraken venue max leverage with the v1-v5 rails; kill switch 8% session / 12% day.

## Post-mortem of v5 (Oct 13, 9:13-9:40 PM PT)

v5 landed: marked equity works (`eq` now moves between fills, `resid=$0.00`), `tracked=` and `ex-dust` book are logged, fee gates fire. What is left (journal, last 15 min, ~40 loops):

- **as-kraken has nothing it may trade.** Every opening candidate is gated: `GATE AAVE|ALGO|ARB|ASTER|BCH both fee-spread` ×40 each. Only the held AVAX/ADA get `halt` gates. Cause: lines 769-792 take `candidates.slice(0, 8)` in venue-scan rank order, then drop each whose median spread < 2 × 16bp. The scan (`SCAN_MAX_SPREAD_BPS=40`, `SCAN_MIN_VOL24_USD=250000`) ranks *tight-spread, high-volume* pairs first, exactly the ones a 16bp maker can't earn on, and nothing below rank 8 is ever looked at.
- **as-kraken halted, may never reset.** `eq=$11.04-11.08` vs session start $12.28 (−10.1% MTM). The v5 reset needs 60 min **flat** (line 1577). It holds an ADA long (~$7.85) whose cost-floor ask is 0.240624, ~1.9% above market; session-loss halt only allows exits at/above the cost floor; so it is flat only if price comes back. No time bound → possible permanent deadlock.
- **as-cb misleading gate.** `GATE STRK buy fee-edge half=200 need=110` ×35. A 200bp half obviously exceeds the 110bp need. `widenOpen` (lines 145-158) returns 0 when the widened price is > `AS_MAX_QUOTE_DIST_BPS` (150) from the touch, and line 1106 maps any 0 to `blockOpenBuy`, then line 1198 prints `fee-edge` with the half of the *pre-widen* price. The real reason is `max-dist`: STRK's touch is wide and the bid must sit ≥ need from mid, which is > 150bp from the touch on the other side of a very wide book.
- **as-cb sell budget gates on dust**: `GATE BASECAT sell budget`, `GATE DRB sell budget` ×20. A sell never needs quote cash; this is the dust top-up path mislabelled (or a real bug).
- **as-cb budget** `BUDGET free=0.58 held=0.00 reserve=0.10 → b=0.48`, `dust=$2.86 (28)`, book 22%.
- **Coinbase deposits are not detected at all.** `pollTransfers` (line 425-426) returns immediately `if (VENUE !== 'kraken')`. A ~$20 Coinbase deposit would show as +$20 P&L, give `adj ≈ +$20`, mask the session loss, and break RECON. Must be fixed before the deposit is credited.

## P0-1: the scanner picks pairs a maker can earn on (as-kraken, both bots)

Fix:
- Rank candidates by **net edge**, not by raw tightness: `edge_bps = median_touch_spread_1h − 2 × makerFee` (current tier). Score = `edge_bps × min(1, vol24 / SCAN_TARGET_VOL24_USD)`, tie-break by lower sigma noise / tick size. Drop pairs with `edge_bps < AS_MIN_EDGE_BPS` (v5 default 8) or `vol24 < SCAN_MIN_VOL24_USD`.
- Evaluate the **whole** venue scan list (or at least the top `SCAN_EVAL_N`, default 40, by volume), not `slice(0, 8)` before filtering. Filter first, then take the best `MM_MAX_PAIRS`.
- `SCAN_MAX_SPREAD_BPS` is an upper sanity bound (default raise to 250 on Kraken) so wide-but-liquid pairs are eligible; add `SCAN_MIN_SPREAD_BPS = 2 × makerFee + AS_MIN_EDGE_BPS` derived at runtime, not hardcoded.
- Spread history (`state.spreads`) is collected for every evaluated pair each loop, so medians exist before selection; warm start from `crypto-mm-feed` px/book data if available.
- Log hourly `SCAN picked=<sym:edge:vol,...> rejected=<n> (fee-spread a, vol b, tick c)`; at most one `fee-spread` line per pair per hour (not per loop).
- If no pair passes, log `SCAN none-tradeable best=<sym> edge=<x>bp` hourly and quote nothing new; do not fall back to a losing pair.

Acceptance: within 1h of restart (when not halted) as-kraken has `MM_MAX_PAIRS` pairs selected with `edge_bps ≥ AS_MIN_EDGE_BPS` and opening quotes on them, or an hourly `SCAN none-tradeable` line; no pair is selected whose median spread < 2 × makerFee; no coin names in code or config.

## P0-2: a bounded way out of a session-loss halt

Fix (stays inside the original design: maker-only, cost-aware exits, deposits not P&L):
- **Phase A (0 to `AS_HALT_HOLD_H`, default 6h after HALT):** as v5: no new risk, exits at or above the cost floor, step from floor toward breakeven per v4.
- **Phase B (after `AS_HALT_HOLD_H`):** exit price may go below the cost floor in steps of ¼ half per 15 min, floored at `cost × (1 − AS_HALT_MAX_EXIT_LOSS_PCT)` (default 1.5% of position notional, and never more than 1% of equity in total for the halt). Post-only, never crossing the spread. Order lines tag `risk=halt-timeout`.
- **Phase C (if still not flat after `AS_HALT_MAX_H`, default 24h, or flat is impossible because the remaining position is under venue min):** **re-baseline while holding**: `startEquity = marked equity`, carry the remaining inventory with its tracked fee-inclusive cost and cost floor (exits keep obeying P0-2 of v5), log `SESSION reset baseline=$X reason=hold-timeout inv=<sym:qty@cost>`. Counts toward `AS_MAX_SESSION_RESETS_PER_DAY`.
- Positions below venue min no longer block "flat": flat = no position ≥ venue min and no opening orders.
- Day-loss and margin halts keep v5 rules (margin halt may use `risk=margin` exits immediately).
- Status shows `halt=session-loss phase=A|B|C age=<h>`.
- `data/<BOT>.control.json` `reset-session` still works at any time.

Acceptance: from a HALT with a position stuck above market, the bot reaches either flat or a `SESSION reset … reason=hold-timeout` within `AS_HALT_MAX_H` without a deploy; no exit below `cost × (1 − AS_HALT_MAX_EXIT_LOSS_PCT)`; total halt-exit loss ≤ 1% of equity.

## P0-3: Coinbase deposits and withdrawals are capital

Fix:
- Implement Coinbase transfer detection (remove the `VENUE !== 'kraken'` early return): poll the Coinbase transactions/ledger for each quote-currency account (USD, USDC) and for coin accounts, for `deposit`, `withdrawal`, `send`, `receive`, `fiat_deposit`, `fiat_withdrawal` types, dedup by transaction id, persist the cursor. Only venue ledger records count, never inferred equity jumps.
- Each detected transfer: `state.transfers += amount_usd` (coin transfers at mid at the transfer time), append to `logs/transfers-<BOT>.jsonl` (id, type, ccy, amount, usd, time; no keys), log `TRANSFER deposit $20.00 USD id=…`.
- Safety net: if marked equity jumps by > max(5% of equity, $1) in one loop with no fill and no recorded transfer, log `EQUITY jump unexplained $X` and **pause new risk for that loop** (do not count it as P&L, do not re-baseline) until the ledger confirms or 15 min pass.
- Kill-switch math, `adj`, RECON keep using `transfers`; a deposit never "recovers" a session loss and never trips or resets a halt.
- Budget must react the same loop: `free` includes the new cash; the `BUDGET` line shows it.

Acceptance: after Blake's ~$20 deposit, a `TRANSFER deposit` line appears within 2 loops, `adj` changes by < $0.05, `resid ≤ $0.02`, `startEquity` unchanged, no halt state change.

## P0-4: as-cb scales the book with new cash and uses it on dust

Fix:
- Book target = `BOOK_TARGET_FRAC (0.9) × (equity − dust − reserve)` across resting asks (inventory) + bids. After a deposit, spread the budget over selected pairs (P0-1 applies on Coinbase too, with Coinbase's own fee tier) using clip = `min(budget / slots, max(CLIP_MAX_USD, venue min × 1.2))`; raise `MM_MAX_PAIRS` effectively by budget: slots = `min(MM_MAX_PAIRS, floor(budget / (venue min × 1.2)))`.
- **Dust top-up uses new cash:** up to `AS_DUST_COMBINE_MAX` (2) dust names at a time, ≤ 25% of budget, still on scanner and passing the fee-edge rule: post-only bid of `venue_min − dust_value` (rounded up to lot/min), then exit the combined holding above fee-inclusive cost (legacy dust basis = mark at bot start). Log `DUST topup <sym> bid=$x` / `DUST exit <sym>`.
- Dust that fails (`dust-stuck`) is left; hourly list only.
- Fix the `sell budget` gate on dust names: a sell needs no quote budget. If it's the top-up bid, label it `buy dust-budget`; if the sell itself is blocked by min notional, label `sell below-min`.

Acceptance: within 1h of the deposit, ex-dust book ≥ 80% of equity, bids on ≥ 2 pairs (or `GATE` reasons per side), ≥ 1 dust top-up placed if any dust name passes the filters, no `sell budget` gate lines.

## P1: gate reasons that say what happened (both bots)

Fix:
- `widenOpen` returns `{px, why}` with `why ∈ ok|max-dist|below-need|no-mid`; `blockOpenBuy/Sell` carry the reason; gate text becomes e.g. `GATE STRK buy max-dist need=110 dist_touch=212 cap=150` or `fee-edge half=<sent> need=<n>` only when the sent half is actually < need.
- The half printed in a gate line is the half of the price that would have been sent, not the pre-widen price.
- Review `max-dist`: the cap exists to avoid stale far quotes, not to block wide books. Measure distance from **mid** for the opening side when the touch spread itself is > 2 × need (wide book), i.e. cap = `max(AS_MAX_QUOTE_DIST_BPS, half_touch_spread + need)`; otherwise keep the touch cap.
- Deduplicate: one line per symbol/side/reason per 10 min, plus an hourly `GATES` count summary.

Acceptance: no gate line where the printed half ≥ printed need with reason `fee-edge`; STRK-like wide books either quote at `≥ need` from mid or log `max-dist` with the numbers; GATE line volume per bot ≤ ~1/10 of current.

## Out of scope / unchanged
Post-only only; no coin lists; transfers only from venue ledger records; kill switch thresholds 8%/12%; margin rails 300/200/150, resume 350; no secrets in repo or logs.
