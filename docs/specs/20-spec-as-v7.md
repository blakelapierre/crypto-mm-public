# Spec AS v7: the Coinbase deposit is capital, as-cb spends it, as-kraken halt clock and AVAX dust

Status: **active**. Supersedes `19-spec-as-v6.md` (implemented in `ef1314d`, follow-up `c99d99d` "Page Coinbase quote ledgers", restarted Oct 13 10:34 PM PT). Line numbers refer to `src/bots/as/index.js` at `c99d99d`. Check them before editing.

Design constants (unchanged): no hardcoded coin names; post-only only; deposits and withdrawals are capital, never P&L; open book ≈ 90% of (ex-dust) equity when order criteria are met; Kraken max leverage with the rails; kill switch 8% session / 12% day; no secrets in repo or logs.

## Observed (Oct 13, 10:34-10:45 PM PT)

- **as-cb**: `eq=$25.49 free=$14.49 adj=$19.77 maker=$0.20 fees=$0.15 inv=$6.16 (1) dust=$2.84 (28) fund=$0.00 resid=$20.01 fills=34/1 book=29% (ex-dust 32%)`. Blake's ~$20.01 USDC deposit sits in `resid` and `adj`. No `TRANSFER` line and no `EQUITY jump unexplained` line in the journal since v6 started (05:12 BST = 9:12 PM PT). `data/as-coinbase.json`: `transfers=0`, `cbTransferBooted=true`, `seenLedgers` has **0 entries** (not one transaction of any type has ever been booked or seen), `startTime=2026-10-12T09:39Z`, `startEquity=5.717`.
- **as-cb scanner**: `SCAN picked=- rejected=0 (fee-spread 0, vol 0, tick 0)` then `SCAN none-tradeable best=- edge=-bp`. The only quotes are STRK (one ask, plus one 118bp bid that filled and turned into inventory). `GATE ESP|CTSI|00|S both fee-spread`, `GATE STRK buy max-dist need=110 dist_touch=196 cap=150`, `GATE BASECAT sell budget` (still there; v6 asked to remove it). `BUDGET … b=13.99` unused.
- **as-kraken**: `eq=$11.02 adj=$-1.26 (−10.3%) halt=session-loss phase=A age=0.1h`. Reduce ask `SELL ADA 33.18 @ 0.239472 10x reduce half=a166bp risk=hold dist=176bp floor=0.240624`. `HOLD AVAX` (dust short, q=−0.01) with `GATE AVAX buy halt` and no exit order. `ORPHAN OJSW2K-…` logged. The halt began at 2:37 PM PT, but `age=0.1h`.

## Root cause: why the deposit was missed (`pollCoinbaseTransfers`, lines 531-581)

Several defects stack. Together they mean the function can't book this deposit, and the failure is silent:

1. **Errors are swallowed.** Each `/v2/accounts/<id>/transactions` call is `catch { break; }` (line ~551) with no log. `seenLedgers` is empty even for old buys and sells that a working call would at least return (they are skipped *after* parsing, so the empty map only shows nothing qualified). The most likely failure is auth: v2 wallet endpoints need the `wallet:transactions:read` / view scope, or a JWT whose `uri` claim matches the exact path. The `?limit=…` query, or a `next_uri` path, may not be signed the way `coinbaseRequest` signs v3 brokerage paths. Any 401/403/404 vanishes.
2. **Account discovery is one page.** `/v2/accounts?limit=100` is not paged (`pagination.next_uri` ignored). Coinbase returns one wallet per supported asset (300+), so the USDC (or USD) wallet holding the deposit may simply not be in the first 100.
3. **The deep scan never runs.** `cbTransferBooted` is persisted in state and was set `true` by the v6 run (ef1314d) on its first loop. So the c99d99d deep paging (`deep = quoteCcy && !cbTransferBooted`) is skipped on every later restart, and only the newest 25 rows per account are read.
4. **Incoming crypto is booked as negative.** An on-chain USDC deposit appears in v2 as `type:"send"` with a **positive** amount (a `send` *to* this account). Line ~566 marks every `send` as negative (`neg = /withdraw|send/`), so even a successful read would book −$20.01.
5. **The safety net was never armed.** `unexplainedJump` compares `prevEquity` with the current equity within one process. The deposit landed while the bot was restarting, so no single loop saw the jump. The `resid=$20.01` that RECON computes every loop is never used as a trigger.

## P0-1: book Coinbase transfers reliably

Fix:
- **Source of truth, in order:**
  - (a) Primary: v2 `GET /v2/accounts/{id}/transactions` for every quote account (USD and USDC) and every held-coin account, fixed as below.
  - (b) Fallback if v2 is not permitted for the key: v3 `GET /api/v3/brokerage/accounts` (paged with `cursor`/`has_next`) to find every quote account by `currency`, then compare available + hold balances with the persisted balances. Treat balance changes not explained by fills as transfers, via the P0-2 pending path.
  - Use whichever the key's scopes allow. Log `TRANSFER source=<v2|v3> accounts=<n>` once at start.
- **Sign exactly what is requested:** the JWT `uri` must include the path that is sent, with the query string per the CDP rules. Same for `next_uri`. Add a unit test that signs `/v2/accounts/x/transactions?limit=25`.
- **Never swallow errors:** log `TRANSFER error <acct ccy> <status> <msg>` (no headers or keys) at most once per 10 min per account. If 3 polls in a row fail, set `state.transferBlind = true` and show `xfer=blind` in status.
- **Page the account list** until `next_uri` / `has_next` is empty. Always include the USD and USDC accounts even with a zero balance.
- **Deep scan by cursor, not a boolean:** persist `state.cbTxCursor[acctId] = newest created_at/id seen`. On every start, page back until it reaches the cursor or `startTime`, up to 10 pages. Drop `cbTransferBooted`, or reset it on migration so the next start does a full replay from `startTime`.
- **Sign from the amount, not the type:** `usd = sign(amount) × |amount| × px` (px = 1 for USD/USDC, mid otherwise). Types accepted: `send, receive, fiat_deposit, fiat_withdrawal, deposit, withdrawal, transfer, exchange_deposit, exchange_withdrawal, pro_deposit, pro_withdrawal, intx_deposit, intx_withdrawal`. Excluded: `buy, sell, trade, advanced_trade_fill, retail_simple_dust, interest, staking_reward` (rewards stay P&L). Dedup by tx id. For `status != completed`, book only once completed.
- Write each one to `logs/transfers-as-cb.jsonl` and log `TRANSFER deposit $20.01 USDC id=…`.
- **Migration:** on first start of v7, replay from `startTime` (Oct 12 09:39Z). The ~$20.01 deposit must be booked once.

## P0-2: fallback when transfers can't be read (both bots): flag, never pause

**This supersedes v6 P0-3's "pause new risk for that loop / 15 min on an unexplained equity jump" (`state.equityPauseUntil`).** Unknown money never pauses trading. Remove `equityPauseUntil` and its use in `addOk`.

- **Trigger:** `resid` (RECON) exceeds `max($1, 3% of equity)` with no fill explaining it (|Δ from fills| < $0.05 over the window), or one loop's equity jumps the same way. Also checked at startup: compare the persisted `lastEquity` with the first marked equity.
- **On trigger:**
  - set `state.transferPending = {usd: resid, since}`;
  - log `TRANSFER pending $X (resid, no fills)` once, and add `xfer=pending $X` to the status line for the monitor;
  - **keep trading normally.** Opening orders, exits and the scanner are not paused.
- **Provisional capital:**
  - the pending amount counts in equity for sizing, budget and the book target (≈90% of ex-dust equity);
  - it is excluded from P&L (`adj`, maker/inventory P&L) and from halt math: session/day loss is computed as `equity − pending − transfers` vs baseline;
  - it never trips, clears or resets a halt, and never moves `startEquity`.
- **Resolution:**
  - (a) A matching ledger transfer arrives (within ±2%): replace the pending entry with it and clear `xfer=pending`.
  - (b) After `AS_XFER_PENDING_MAX_MIN` (default 30) with no ledger record: book it in `transfers-<BOT>.jsonl` with `inferred:true` and log `TRANSFER inferred $X`. When the real record arrives later, it replaces the inferred row rather than being added on top.
  - (c) `data/<BOT>.control.json {"cmd":"book-transfer","usd":X}` books it manually at any time.

Acceptance: after the v7 restart, as-cb logs `TRANSFER deposit $20.01`, or `pending` and then `inferred` within 30 min, with no gap in opening orders at any point. Then `transfers ≈ 20.01`, `adj ≈ −$0.24 ± 0.05`, `|resid| ≤ $0.02`, `startEquity` unchanged and no halt state change. No code path pauses opens because of an unexplained equity change. Any transfer API error is logged, not silent.

## P0-3: as-cb spends the new cash across scanner-chosen markets

Observed: `SCAN picked=- rejected=0` (zero candidates evaluated), `b=13.99` unused, book 29%.

Fix:
- **Diagnose the empty scan.** `rejected=0` with 0 picked means the candidate list was empty before filtering: `pullVenueScan('coinbase')` returned nothing, or it was intersected with products/`state.symbols` (dust names) and came out empty. Log `SCAN source=<file|api> n=<raw> after_products=<n> after_quote=<n>`. If the venue scan file is stale (> 2h) or empty, build candidates from the Coinbase products API (`/api/v3/brokerage/products`, quote USD/USDC, `status=online`, not `trading_disabled`, not `limit_only=false` requirements violated). Rank them by v6 net edge (`median_spread − 2 × makerFee` at the current Coinbase tier from `transaction_summary`) × volume.
- **Slots scale with budget:** `slots = clamp(floor(budget / (venue_min × 1.2)), 1, AS_CB_MAX_PAIRS default 6)`. With ~$14 that is several markets. Clip = `budget × 0.9 / slots`, at least the venue minimum.
- **Book target:** resting bids + inventory asks ≥ 0.9 × (equity − dust − reserve). Re-plan within one loop of a budget change ≥ $1 (`BOOK replan budget=$x slots=n`).
- **Wide books (STRK-like):** the v6 `max-dist` cap must use `max(AS_MAX_QUOTE_DIST_BPS, ½ touch spread + need)`. The log still shows `cap=150` on a 196bp case, so it isn't applied. Fix that, and give each line exactly one reason (no `fee-edge half=158 need=110`).
- Opening orders are never paused by `transferPending` (P0-2). Pending money counts as provisional capital for sizing.
- Remove the `sell budget` gate (still logged for BASECAT). A sell never consumes budget; dust top-up bids use `buy dust-budget`.
- Dust top-up (v6 P0-4) uses up to 25% of the new budget, at most 2 names, once a deposit is booked.

Acceptance: within 1h of the deposit being booked, as-cb has bids on ≥ 3 scanner-picked markets (or one `GATE` reason per missing side), ex-dust book ≥ 80%, `SCAN picked=` is non-empty with net edge ≥ `AS_MIN_EDGE_BPS`, and there are no `sell budget` lines. No coin names in code or config.

## P1: as-kraken halt clock, ADA exit, AVAX dust

- **The halt age survives restarts.** Persist `state.haltAt` (first HALT time, here Oct 13 22:37:44 BST = 2:37 PM PT) and compute phase A/B/C from it, not from process start. Today `age=0.1h` after each deploy resets the 6h/24h clocks, so every restart postpones the bounded exit.
- **ADA long (~33 at 10x, ask 175bp above mid):** this is the correct phase-A behavior (cost floor 0.240624). Once the persisted clock is right, phase B (after 6h, so already due) steps the ask below the floor by ¼ half per 15 min, down to `cost × (1 − 1.5%)`, tagged `risk=halt-timeout`. Phase C at 24h re-baselines while holding. Confirm the order line shows `phase=B` after restart.
- **AVAX dust short (q≈−0.01, below venue min):**
  - Positions below the venue min are not "open" for the flat check (v6).
  - Give them one handling path. If `|q| < ordermin`, do not send reduce orders. Instead, either (a) on the next opening trade in that pair in the same direction as the close (a buy), raise its size by |q| so the fill closes the dust, or (b) if the pair is not selected, mark it `dust-stuck` and list it hourly.
  - Kraken margin: a short below ordermin can still be closed by a min-size buy, which then leaves a long of `ordermin − |q|`. Allow that only when `ordermin × px ≤ 0.5% of equity`, then exit the remainder through normal cost-floor exits.
  - Stop `REJECT AVAX buy belowMin` / `HOLD AVAX` every loop: at most one log line per hour.
- **ORPHAN orders:** after logging `ORPHAN <id>`, adopt the order if it matches a tracked symbol/side, otherwise cancel it. Don't log the same id again.

Acceptance: after restart, `halt … age=` continues from 2:37 PM PT (≈8h+), `phase=B` is shown, and the ADA ask steps toward market within the 1.5% cap. The AVAX dust is either closed or listed as `dust-stuck`, with no per-loop reject or hold lines. Each orphan id is logged once and then resolved.

## Out of scope / unchanged
Post-only only; no coin lists; ledger-first transfers (inferred only through P0-2; unknown money never pauses trading); kill switch thresholds 8%/12%; margin rails 300/200/150, resume 350; no secrets in repo or logs.
