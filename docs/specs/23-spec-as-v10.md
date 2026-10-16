# Spec AS v10: quotes that survive the scanner, a full Coinbase book, an honest pending line

Status: **active, addendum to `22-spec-as-v9.md`**. v9 is deployed (`ac2fbb3` on the box, both units active). Implement this on top of v9. Where they conflict, **v10 wins**. Line numbers are from `ac2fbb3`; check `src/bots/as/index.js`, `src/bots/as/quote.js` and `src/shared/coinbase.js` before editing.

Design constants (unchanged): no hardcoded coin names; post-only maker only, never market orders; deposits and withdrawals are capital, never P&L; **unknown money is flagged, never pauses trading**; open book ≈ 90% of ex-dust equity when order criteria are met; Kraken max leverage with the rails, opening leverage still the v9 ramp (2× until it earns a notch); kill switch 8% session / 12% day; no secrets in repo or logs.

## Observed (Oct 15 PT, after the v9 restart)

- **as-kraken is flat with names and no orders.** `life=$9.65 vs $12.28 (−21.5%)`, not halted, `lev=2`. The scanner holds POND (`sig≈200bp`, half source `vol`) and ZK (`sig≈11bp`, half source `floor`). Both print `half=b-/a-`. Book 0%. No resting bid or ask.
- **as-cb booked one small bid.** Equity $25.48, about $19 free after the order. One post-only AERGO bid (~$2.8, half 200bp). Ex-dust book ~12%, not ~90%. No second name. No `SCAN reject` lines, because one name was picked.
- **The deposit is still not a ledger row.** `GET /v2/accounts` is `401` every loop (this key cannot read wallet v2). v3 accounts work (`TRANSFER source=v3`, maker fee refreshed to 35bp). The $19.18 residual is `xfer=pending`. The status line prints `life=$6.30 vs $5.72 (+10.2%)`, which is equity minus that pending, not the account.
- **A pending residual halted the bot.** First loop after pending was set: `HALT day-loss` with `haltLoss=$0.00`, then `action=cap-exit`, because day marks still held the cash that pending had just subtracted. Cleared only after a follow-up (`HALT day-loss cleared pending-gap`).
- **The first v9 process could not read Coinbase at all.** Signing `/api/v3/brokerage/accounts?limit=250` with the query in the JWT returned 401 on every loop, so the book never loaded. Path-only v3 signing fixed it. Wallet v2 still needs the query.

## P0-1: a Kraken name the scanner keeps must get a resting quote, or a reason

The vol size gate (`model.half > 2 ×` the last 15-minute range, `quoteSymbol`) deletes the opening size. The round-trip half on Kraken is 40bp (2×16bp + 8bp). A quiet range under 20bp fails that test, and a vol-widened half (POND, ~200bp) fails it too. v9 P0-3 said quoting wider than the touch is allowed. This gate undoes that after the scanner has already accepted the name.

- Delete that size-zeroing use. An opening order the expected-edge scanner marked tradeable is not dropped for being wider than the recent range.
- When the quote is wider than the touch, scale the opening notional by the same `fillp` the scanner already computed (`expectedEdgeRow`). A low fill probability makes a smaller order, not a missing one. Still respect the exit-loss notional cap, the 2× ramp, margin room and the venue minimum. Below the venue minimum, skip and log `GATE <sym> <side> min-size`, do not round up into a new position.
- `half=b-/a-` on a selected name is not a quiet success. The status token for a side with no order is `gate=<reason>` (the same reason `logGate` would print: `vol` is no longer valid for this case; `max-dist`, `carry`, `budget`, `edge`, `cooldown`, `min-size` remain). Log that `GATE` line on the first loop after start, then keep the 10-minute throttle.
- Round-trip floor, cooldown, churn and the spread-relative distance cap are unchanged. Never inside 2×fee + `AS_MIN_EDGE_BPS`.

Acceptance: a fixture with a 40bp required half and a 10bp 15-minute range still places the bid (sized by fillp, not deleted); a 200bp vol half is placed or logged `min-size` / `budget`, not silently `b-/a-`; live, within 15 minutes, each Kraken name on the status line has a resting post-only order or a `gate=` reason on that line.

## P0-2: Coinbase uses the cash on the names that passed, and says why the others did not

Two separate cuts leave the book at ~12%.

1. **Slot math divides by the cap, not by the names in hand.** `bookSlotsScaled` returns up to `AS_CB_MAX_PAIRS` (6) from the cash alone. `slotClipUsd` then does `budget × 0.9 / slots`. One passing name is bid at ~1/6 of the bid room (~$3 on ~$20) and the other five slots are never filled.
2. **Coinbase still ranks on the touch.** `rankByNetEdge` requires the quoted spread itself to clear 2×fee + edge (~78bp at the live 35bp tier). Names inside that are dropped. `logScan` prints `SCAN reject` only when `picked` is empty, so a one-name book produces no reject lines at all.

- Set the slot count for the clip to the number of names actually selected this loop (dust top-ups do not consume a slot). Minimum 1. Do not reserve budget for names that were not picked.
- Per-name opening notional is still capped at `AS_CB_NAME_CAP_FRAC` (default 0.5) of ex-dust equity. A single qualifier may take the bid room up to that cap, not up to 90% of the account. Log `BOOK concentrate <sym> cap=$x` when the cap binds. The rest of the 90% target stays cash until a second name qualifies; that state is `IDLE`, not a silent 12% book.
- Rank Coinbase with `rankByExpectedEdge`, same rules as Kraken: expected half is `max(touch half, k×σ√τ, round-trip pad)`, fill probability scales size, quoting wider than the touch is allowed, a name inside the pad is not tradeable. Do not relax the pad. v8's idle relax may lower the volume floor; it may not lower the half below the pad.
- Log `SCAN reject` for the top 20 measured names that were not picked, even when some names were picked. One reason each, 10-minute dedup. `best_bid_ask` stays repeated `product_ids=` parameters. A thrown book read logs `SCAN books <status>` at most every 10 minutes and counts as `SCAN empty` when `after_quote=0` and products > 0.

Acceptance: with one qualifier and ~$20 of bid room, that bid is about half of ex-dust equity (the cap), not ~$3, and `BOOK concentrate` is logged; a second qualifier splits the room; a unit fixture of a 20bp Coinbase book at a 35bp fee is tradeable by quoting wider than the touch and is not tradeable if the quote would sit inside the pad; the top rejected names produce `SCAN reject` lines while AERGO (or whichever name) is still picked.

## P0-3: a v2 401 is a missing scope, and the life line shows the cash

`GET /v2/accounts` returns 401. The key can read Advanced Trade (`/api/v3/brokerage/accounts`, fee tier). Retrying v2 every loop cannot succeed, and it must not be counted as `xfer=blind` when v3 returned balances.

- On 401 or 403 from `/v2/`, log `TRANSFER scope v2=denied` once and do not call v2 again until process start. Keep the v3 balance fallback.
- `xfer=blind` only after the v3 fallback itself fails three times in a row. A successful v3 read clears it.
- The historical deposit is still not invented from an equity jump. It stays `TRANSFER pending` until a real ledger row or the existing pending timer (`AS_XFER_PENDING_MAX_MIN`, 30) books `TRANSFER inferred`, which adds the usd to `lifetimeTransfers` and `capitalBaseline`. Unknown money still does not pause and does not move session `startEquity`.
- The life line uses **gross** equity on the left. Pending is a separate field, not a substitute equity. Format: `life=$25.48 vs $5.72 (+p% ex-pending) pending=$19.18`. `p` is `(gross − pending − capitalBaseline) / capitalBaseline`. When pending is 0, omit `pending=` and the `ex-pending` tag. The status API and the dashboard equity line use the same gross figure plus `pending`. The `+$10%` on `$6.30` must not appear.

Acceptance: a 401 from v2 logs `TRANSFER scope v2=denied` once and does not set `xfer=blind` if v3 returned accounts; the life line shows ~$25.48 vs ~$5.72 with `pending=$19.18` until inferred, then pending disappears and the baseline includes the inferred usd; no `equityPause` and no session reset from this path.

## P0-4: keep the two deploy fixes (auth and the false day-loss)

These are already in `4bac663` and `ac2fbb3`. They stay. Do not revert them while doing P0-1..P0-3.

- **JWT.** `/api/v3/` uri claim is `METHOD api.coinbase.com` + path, query stripped. `/v2/` keeps the query (`next_uri` included). A test that the v3 claim for `/api/v3/brokerage/accounts?limit=250` contains no `?`, and the existing v2 `?limit=25` test, both stay green. Putting the query back on v3 401s the book and the loop never quotes.
- **Pending vs the day rail.** Before session-loss and day-loss, marks recorded near gross equity while the pending cash was already in the account are shifted by that pending (`marksForPending`). A mark far from gross (a real earlier peak) is not shifted. A `day-loss` whose day window is back under 12% only because of that shift, and whose loss since `haltEquity` is ~0, is cleared with `HALT day-loss cleared pending-gap`. That clear must not call `beginSession`: no new `startEquity`, no `resetTimes` push, no change to `capitalBaseline`. A real day-loss whose peak mark was not shifted stays halted. Pending still does not count as profit and does not auto-clear a real halt.

Acceptance: the two JWT fixtures pass; a fixture with marks at $25.48, gross $25.48 and pending $19.18 does not trip a 12% day-loss, and a peak mark at $100 against a post-deposit gross of $110 is not shifted; clearing the false halt does not change `startEquity`.

## Out of scope / unchanged

- Lifetime baseline for Kraken stays the seeded $12.28. Do not re-seed from the current session.
- Leverage ramp, round-trip floor, churn cooldown, halt de-lever / cap-exit, 8% / 12% / 25% rails.
- No market orders. No hardcoded names. No secrets in logs.
