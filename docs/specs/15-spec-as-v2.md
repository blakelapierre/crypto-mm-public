# Spec AS v2: fee-aware spread, unwinding on the margin rail, as-cb leftovers

Status: **active**. Supersedes `14-spec-as-v1.md` (implemented in `414a1e3` and `f8deff8`). Line numbers refer to `src/bots/as/index.js` at `f8deff8`. Check them before editing.

Design constants (unchanged): no hardcoded coin names (the scanner picks markets); post-only only; deposits and withdrawals are capital, never P&L; open book ≈ 90% of equity when order criteria are met; venue max leverage on Kraken with the v1 rails.

## Post-mortem of v1 (observed Oct 12, 2026, ~2:41 AM to 5:54 AM PT)

- **as-kraken**: 10 maker fills right after the restart, then none since ~3:16 AM PT. Equity $12.28 → $11.99. `maker=$-0.02`, `fees=$0.24`: the bot pays more in fees than it captures. Every quote is logged at `19bp` half-spread while the maker fee is 16bp per side (~31-32bp round trip). Some round trips bought and sold at the same price.
- Margin level fell to ~204% (rail stop is 300%, cut is 200%). Every ~20s the loop logs `RAIL margin-stop`, then `SELL <sym> ... reduce` → `SELL CLAMP <pair> want=<n> free=0` → `REJECT <sym> sell free`, for both the RENDER long (~1.40 q, 5.757 units) and the AAVE long. An ALGO buy (opening) order stays on the book while the bot tries to reduce.
- Root cause of the reject: `src/shared/exchange.js:309` clamps a sell to the **spot free balance** of the base asset. A margin position has no spot balance, so a leveraged reduce sell is clamped to 0 and never sent.
- **as-cb**: no fills since restart. `eq=$5.65 free=$0.62`. The rest is ladder leftovers. At 10:39 AM BST (2:39 AM PT) every leftover sell (UP, SHDW, NEON, MNDE, LPT, MOODENG, ROSE, NMR, ...) was rejected with `PREVIEW_LIMIT_PRICE_TOO_FAR_FROM_MARKET`. Line 420 then marks the symbol as dust for 6h, and line 568 drops dusted symbols from the loop, so leftovers are abandoned instead of unwound. The scanner now only watches S/MON with zero size.
- **Logging**: the status line prints `fills=0` on both bots although as-kraken has 10 fills in `seenFills`. as-cb prints `RECON -0.07/-0.08` every loop (unexplained equity vs P&L split), likely leftovers' mark changes not counted in `inv`.

## P0-1: fee-aware minimum spread

`halfFor` (lines 105-110) uses `max(FEE_BPS*1.2, touch/2, 1)`; with 16bp that is ~19bp, below the round-trip cost.

- Minimum half-spread: `minHalf = MAKER_FEE_BPS + AS_PROFIT_BPS` per side (new env, default `AS_PROFIT_BPS=10`), so a full round trip clears 2×fee + 2×profit. For Kraken: ≥26bp. For Coinbase (40bp): ≥50bp. Read the fee from the venue fee tier at startup when available; env is the fallback.
- **Exit floor**: track average entry price per symbol and side from logged fills (VWAP of the open position). An exit on a long is never quoted below `entry × (1 + 2×fee + profit)`; an exit on a short never above `entry × (1 − 2×fee − profit)`. The AS reservation price may skew quotes, but must not cross this floor.
- Exception: the margin cut path (below 200%) and the kill switch may exit at the touch (still post-only) regardless of the floor. Log `EXIT LOSS <sym> <bp>` when that happens.
- Log the effective half-spread and floor on every quote line, e.g. `RENDER q=1.40 half=26bp floor=2.091`.

## P0-2: unwinding on the margin rail (Kraken)

When `ml < AS_MARGIN_LEVEL_STOP` (lines 469-497):

1. **Cancel every opening order first** (any order that would increase |position|, e.g. the open ALGO buy), on every symbol, before placing any exit. Wait for cancel confirmation, then re-read balance and margin.
2. **Reduce-only exits**: place a post-only limit with Kraken's `reduce_only=true` on the margin order (with the position's leverage), sized to the open position from `OpenPositions`, not to spot free balance. Fix `exchange.js:309`: skip the spot-free clamp when `leverage > 0` or `reduceOnly` is set; clamp instead to the open margin position size.
3. Price: at the touch on the exit side (best ask for a long, best bid for a short), post-only. If post-only rejects because it would cross, step one tick away and retry next loop.
4. **Backoff**: on repeated rejects for the same symbol and reason, back off 20s → 40s → 80s ... capped at 10 min, with one log line per backoff (`BACKOFF <sym> <reason> <n> <sec>`), not one per loop.
5. **Fallback path off the rail**: if after 3 backoff cycles the margin level is still below the stop and no exit is resting, (a) reduce the largest-notional position first, at 50% size; (b) if ml < 200% (cut), quote exits at the touch every loop until ml ≥ 300%; (c) if ml < 150% or the session/day kill switch trips, set `halted`, cancel all, and send a single `HALT` log/status flag for the operator. Never place a taker order automatically.
6. Resume opening quotes only when ml ≥ 350% (hysteresis), to stop flip-flopping at 300%.

## P0-3: as-cb trapped in leftover coins

- **Treat every held coin as inventory**, whether or not the scanner picked it. It stays in `state.symbols` until it is sold below the venue minimum. Do not apply the 6h dust mark (line 420) on `PREVIEW_LIMIT_PRICE_TOO_FAR_FROM_MARKET`; that reason means the price is wrong, not that the coin is dust.
- **Price inside the allowed band**: quote inventory exits at the best ask (post-only), or one tick above the best bid if the spread is wide, and never more than the venue's allowed distance from market. On a `TOO_FAR` reject, re-read the book and re-price toward the touch on the next loop, halving the distance each time.
- Leftovers have no fill-based entry price; use the mark at bot start as the cost basis, so the P0-1 exit floor does not block them. Allow the floor to decay to the touch over 24h for these legacy lots.
- Count leftovers in equity, in the 90% book target, and in sizing: the full-balance ask on each held coin counts toward the book.
- Coins below the venue min order value: keep them in equity, mark them `dust` in status, and retry when price changes. Do not hide them.

## P1: logging and reconciliation

- `fills=` in the status line must equal the count of logged fills (since start and last hour). It currently prints 0 while `seenFills` has entries.
- as-cb `RECON -0.07/-0.08` every loop: include the mark change on leftover inventory in `inv` (inventory P&L) and log the residual split by symbol once per hour, not every loop.
- Persist average entry price per symbol in `data/as-*.json` so the exit floor survives restarts.
- Log `RAIL` once per state change (enter/exit stop, cut, halt), not every loop.
- Transfers stay venue-record only (v1 rule); no transfer is inferred from a residual.
- as-cb: `INSUFFICIENT_FUND` on buys (S, OSMO) means the per-loop cash budget is still overcommitted. Subtract resting buy notional from the budget before placing new buys.

## Acceptance

- as-kraken: no quote with half-spread below `fee + profit`; no exit at or below entry after fees (except logged cut/halt exits). On the rail, opening orders cancel within one loop and a reduce-only exit rests on Kraken within two loops; no `SELL CLAMP free=0` on leveraged reduces.
- as-cb: no `TOO_FAR` repeat on the same coin more than 3 times; free cash rises as leftovers sell; book ≈ 90% of equity counting leftover asks.
- Status `fills=` matches the fills log; `RECON` lines only on a real, explained residual.
