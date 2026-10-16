# AS v12: withdrawal detection, no halts on unknown money, first-class control

Builds on v10/v11 (live at `27406f8`). Where they conflict, v12 wins. Line numbers refer to `src/bots/as/index.js` at `27406f8`.

## Incident (Oct 16, 2026)

1. 2:43 AM PT: as-cb was stopped and all 8 open Coinbase orders cancelled at the owner's request.
2. The owner withdrew $10 from Coinbase. as-cb was restarted at 2:46 AM PT.
3. `TRANSFER source=v3 accounts=2` found nothing. The bot logged `EQUITY jump unexplained $-10.01`, and the residual went from about −$2 to −$8.03. Capital stayed at $24.90.
4. The bot then tripped `HALT lifetime-dd`, because $15.74 against $24.90 reads as a 37% drawdown, and it sat with 0 orders. **This breaks the rule: unknown money is flagged and kept out of P&L, and it never pauses trading.**
5. Manual recovery, which this spec makes first-class:
   - `data/as-cb.control.json` = `{"cmd":"book-transfer","usd":-10.01}` booked the withdrawal: capital went to $14.89 and resid to +$1.98.
   - The `lifetime-dd` halt only clears with `AS_RESUME=1` at startup (line 2273), so it took a restart through a runtime systemd drop-in.
   - After that restart the bot tripped `HALT day-loss`, because `state.equityMarks` (the 24h day baseline, line 2328) was never shifted by the booked transfer. Recovery needed a stop, a backed-up hand edit to shift 1,361 marks down by $10.01 and clear `halted`, and a start. Nobody should have to do that again.

## P0. Detect Coinbase withdrawals and deposits

- The v3 accounts source does not see withdrawals. Add a transfer source that does:
  1. v2 `/v2/accounts/:id/transactions` (types `send`, `fiat_withdrawal`, `fiat_deposit`, `exchange_deposit`, `exchange_withdrawal`) for the quote currency and USD, **when the key has the scope**. A 401 or 403 logs `TRANSFER v2 scope-missing` once an hour and falls through. Do not crash or loop.
  2. If no endpoint can see transfers, use an equity-jump heuristic. A drop or rise in **free quote cash** of at least $1 within one loop, with no fill, order or fee to explain it, becomes `transferPending {usd, at, source:'jump'}`. It is excluded from P&L and from every risk calculation right away. If a venue record matching within 2% or $0.02 arrives later, replace the pending entry with it (the `bookTransfer` replace path at line 243 already does this for `inferredOpen`). Otherwise it stays pending and shows in status.
- Never infer a transfer from a **mark** move (positions repricing). Use cash only.
- Log one `TRANSFER detect src=<v2|jump|control> usd=… id=…` line for each one.

## P0. No halt may trip on unexplained or pending money

- Drawdown for **every** halt (`session-loss`, `day-loss`, `lifetime-dd`, halt-risk exits) = **trading P&L** / capital:
  - Trading P&L = maker capture − fees − funding + inventory mark.
  - Capital = baseline + booked transfers.
  - Residual and pending transfers are **excluded** from the numerator and the denominator.
- When any transfer is booked or marked pending, shift **all** stored baselines by the same amount, in the same tick:
  - `startEquity`
  - the lifetime baseline
  - every entry in `equityMarks`
  - `haltEquity`
  - the reset baselines
  Add one helper, `applyCapitalShift(state, usd, why)`, and call it from `bookTransfer`, from pending creation and from pending reversal.
- If a loop sees an unexplained equity jump of at least $1, it must not evaluate halts in that loop. Mark it pending first.
- Test: replay the Oct 16 sequence (equity marks around $25.7, then the cash balance drops $10.01 with no fills). Expected: no halt of any kind, `pending=-10.01`, quoting continues, and life % is unchanged.

## P1. First-class control commands

`data/<BOT>.control.json` already supports `reset-session`, `halt` and `book-transfer`. Add the following and document them in the README:
- `{"cmd":"resume"}` clears **any** halt, including `lifetime-dd`, and sets `haltSwept=false`. No restart and no `AS_RESUME` env is needed. Log `CONTROL resume prev=<halt>`.
- `{"cmd":"book-transfer","usd":-10.01,"note":"..."}` calls `applyCapitalShift`, which includes `equityMarks`. If it matches an open pending entry, it replaces it. If the bot is halted only because of the transfer, it auto-clears the halt.
- `{"cmd":"clear-pending","id":"..."}` drops a pending entry after a human confirms it.
- Every command writes `{cmd, at, result}` to `logs/control-<BOT>.jsonl`, and the status line shows the last command.
- Keep `AS_RESUME` for backward compatibility, but log it as deprecated.

## P1. Status shows residual separately

- The status line and dashboard show `eq`, `capital`, `trading=$x (y%)`, `resid=$r`, `pending=$p` as separate fields. Life % and every halt use `trading` only.
- `resid` sitting above $1 for more than 30 minutes logs `RESID flag $r` once an hour. That is a flag, never a pause.

## P1. Smoke test before every restart (the formatPrice lesson)

- `27406f8` followed a crash loop (about 50 s and 11 restarts) caused by a missing `formatPrice` export.
- Add `npm run smoke`, which does all of the following:
  - `node --check` on every file in `src/`
  - an import of `src/bots/as/index.js` with a `SMOKE=1` early exit after the module graph resolves
  - `node scripts/test-as-v*.mjs`
- Deploys run smoke first, then restart. If smoke fails, do not restart.
- Add `StartLimitIntervalSec=60` and `StartLimitBurst=5` to the AS units so a crash loop stops fast and is visible.

## P2. Seen in logs

- **Book oscillation.** The book swings between 0% and 72–87% every loop, all placed, then all gone (`book=72%` then `book=0% tracked=0` 25 s later). Find out whether orders are being cancelled each loop or the open-order fetch is missing them. Orders must persist across loops unless a requote is needed. Log `CANCEL why=<reason>` for each cancel.
- **STRK `agate=below-min`.** The ask is blocked because the position is under the venue minimum, which is expected for dust. Fold this into the hourly stuck list, not the per-loop line.
- **Unit stays enabled after a manual stop.** Document that `systemctl stop` holds until the next reboot. A `halt` control command is the preferred soft stop.

## Acceptance

1. Replaying the Oct 16 withdrawal causes no halt and leaves `pending=-10.01`. Capital goes to −10.01 when the venue record or a `book-transfer` arrives, and `equityMarks` shift.
2. `{"cmd":"resume"}` clears `lifetime-dd` and `day-loss` without a restart.
3. Day, session and lifetime drawdowns never include resid or pending money. There is a unit test for each.
4. Status shows trading, resid and pending separately.
5. `npm run smoke` exists and runs before restarts, and the units have start limits.
6. As before: post-only only, no market orders, no hardcoded coin names, and no secrets in the repo.
