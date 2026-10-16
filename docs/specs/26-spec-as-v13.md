# AS v13: as-kraken cannot place orders (`:BTNL` on every pair) and opening room is too small

Builds on v12, which is live in `7163d97`/`641e361`. Where they conflict, v13 wins. Line numbers refer to `src/bots/as/index.js` at `641e361`.

## Symptom

as-kraken has been idle for about 22 hours at $9.65, with 0 orders and 0 fills. Every status line shows `bgate=margin/agate=edge`.

## Root cause 1 (P0): every order goes to a pair that doesn't exist

- `orderPairOf()` (line 139) always returns `altname + ':BTNL'`.
- `:BTNL` is the ECP/margin variant. Kraken only lists it for pairs that are margin-eligible for this account (see the comment in `src/bots/margin/short.js` around line 336).
- The scanner (around line 1238) does not filter to those pairs. When a candidate clears every gate, the order still fails:
  - `LIMIT FAIL kraken CVXUSD:BTNL buy ... EQuery:Unknown asset pair`
  - The same failure hit TRAC, LUNA, ANIME, BLUR, ETHFI, LCX, NOS, NPC, POND, STBL and ZBCN: 12 failures since Oct 14 and 0 successes.
  - Each failure then triggers a `BACKOFF`, and the scanner moves on.
- The 77 historical fills were on names that do have a `:BTNL` pair (AVAX, ADA, ARB).
- This is why "max leverage" never shows up in practice: whatever the scanner picks is mostly not tradeable.

### Fix

1. When building the universe, mark each pair `marginOk` only if its `:BTNL` variant is valid for this account. Use AssetPairs `leverage_buy`/`leverage_sell` being non-empty for the account's region, or probe once with `validate=true` and cache the result for 24h in `data/as-kraken.pairs.json`.
2. The scanner ranks only `marginOk` pairs for two-sided quoting. If the configured list is empty, a non-margin pair may be quoted **long-only** on the plain spot pair (`altname`, no `:BTNL`, 1x). It gets a bid plus an exit ask on inventory only, and never opens a short.
3. `Unknown asset pair` must never repeat:
   - On the first one, add the pair to a 24h deny list.
   - Log `PAIR deny <sym> reason=unknown-pair`.
   - Re-rank in the same loop.
4. Use `orderPair` from the cached universe; do not rebuild it from the symbol.

## Root cause 2 (P1): the opening room is below most venue minimums

- `krakenNotionalRoom` (quote.js line 967) works out room = equity / (RESUME/100) × lev = 9.65 / 3.5 × 2 = **$5.51**.
- Any market whose minimum order is above $5.51 gets gated `margin`. Today that included Q ($12.17), ZK ($6.99), OSMO ($6.16) and ZEREBRO ($5.84).
- The leverage ramp (`leverageNotch`) only steps up after 2h of positive P&L, so with 0 fills it stays at 2x forever. That's a deadlock.

### Fix (keep the safety rails)

- Size the margin room from the **margin-level stop** (`AS_MARGIN_LEVEL_STOP`, 300%) plus a 20% buffer, not from `RESUME` (350%), which is meant for re-entry after a rail trips. The resulting room must still keep the margin level at or above `STOP × 1.2` after a fill.
- The scanner skips any pair whose `ordermin × price` is above the room, as a ranking filter, so the bot never parks on a market it can't afford. Log `SCAN reject <sym> reason=min-gt-room min=$x room=$y` once an hour per pair.
- Ramp deadlock: after 6h with 0 fills and no loss since the reset, allow **one** notch (2x → 3x), still capped by `AS_LEVERAGE`/venue max and the margin rails. A loss drops it back to 2x as today.

## Root cause 3 (P2): `edge` is a catch-all on the sell side

- Line 2004: when `sellSz` is 0 for any reason, the Kraken sell side falls back to `gate('sell','edge')`. Today the real reason is that the short side gets no room from `krakenOpeningPlan` (fit=0 with an empty reason).
- `krakenOpeningPlan` must always return a reason (`margin`, `min-size`, `loss-cap`, `room-used`). The fallback should log `unsized`, never `edge`.

## Also seen

- `lifetime` shows capital $12.28 against equity $9.65 (−21.4%, 3.6 pp from the 25% stop). Status prints `trading=$0.00 (+0.0%)` because the session reset zeroed the counters. Per v12, trading P&L must be measured against capital: it should read about −$2.63. Fix the label so the distance to the stop is visible.
- Pair backoff on `Unknown asset pair` is 20 s, which is pointless. It should use the deny list above.

## Acceptance

1. No order is ever sent to a pair that doesn't exist. At most one `Unknown asset pair` per pair per 24h, followed by a deny entry.
2. Within 15 minutes of starting with about $9.65, as-kraken has at least one post-only order resting on a valid pair, or it logs one specific reason per candidate (`min-gt-room`, `unknown-pair`, `margin`, `loss-cap`, `halt`).
3. The margin level after a fill on the planned room stays at or above `AS_MARGIN_LEVEL_STOP × 1.2`. There is a unit test for `krakenNotionalRoom`.
4. The sell side never shows `edge` unless the edge check actually failed.
5. Status shows trading P&L against capital, and distance to the lifetime stop, for Kraken.
6. As before: post-only only, fee-edge check on, loss rails on, no hardcoded coin names, smoke test before restart, no secrets.
