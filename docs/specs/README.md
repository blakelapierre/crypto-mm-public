# Bot specs

- **`17-spec-as-v4.md` is the current, active work list. Start here.** Lead priority: funding counts only Kraken rollover rows (margin-row fees deduped by refid, realized P&L moved to price P&L, raw ledger persisted and recomputed at start); as-cb treats every above-minimum holding as inventory to unwind and fixes its double-counted cash budget to reach the 80-90% book; as-kraken losses addressed through fill markouts, a volatility-adaptive half-spread, exit-loss-capped sizing (max leverage available, not always used) and a gradual hold-cap exit. Line numbers refer to `7b3547d`.
- `16-spec-as-v3.md` was the spec for commit `7b3547d`. Its post-mortem is in AS v4. Lead priority: as-cb cash budget (no buy above free cash, zero insufficient-funds rejects, leftovers unwound near the touch); as-kraken sizing so one fill cannot push margin level below 300%, logged quote gating and a fill-rate fix; carry cost and max hold time in decisions; a P&L identity that reconciles with a logged residual. Line numbers refer to `b6637c7`.
- `15-spec-as-v2.md` was the spec for commits `f90f550` and `b6637c7`. Its post-mortem is in AS v3. Lead priority for the AS bots `as-cb` (Coinbase) and `as-kraken` (Kraken): a fee-aware minimum half-spread with an exit floor above entry after fees; unwinding on the margin rail (cancel opening orders first, Kraken `reduce_only` post-only exits sized to the margin position, backoff and a defined fallback); as-cb ladder leftovers priced near the touch and treated as inventory. Line numbers refer to `f8deff8`.
- `14-spec-as-v1.md` was the spec for commits `414a1e3` and `f8deff8` (max leverage plus rails, fill and P&L logging, scanner-driven selection). Its post-mortem is in AS v2. Line numbers refer to `5cfaae4`.

## Retired / archived

The `ladder` bot and the Kraken margin/short book were retired on Oct 11, 2026. The specs below are kept for history only.

- `13-spec-v13.md` (archived) was the last ladder spec. Lead priority: no transfer is ever inferred from a cash residual (venue records only, with a reversal path); fills come from cumulative quantity so partials survive cancels; open book ≥ 90% of tradable equity (`BOOK_TARGET_FRAC`); a full-balance ask on every sellable position; truthful `running` status.
- `12-kraken-short-book.md` (archived) covered the Kraken short book (margin bot), now retired.
- `11-spec-v12.md` was the spec for commits `08d1b98`, `5abcc9e` and `b78ff91` (followed by `b85218e` and `af81074`). Its post-mortem is in v13.
- `10-spec-v11.md` was the spec for commits `587e29c` and `19caf70`. Its post-mortem is in v12.
- `09-spec-v10.md` was the spec for commits `ef47ed6` and `3bdfea8`. Its post-mortem is in v11.
- `08-spec-v9.md` was the spec for commit `0b0e093` (implemented in `77fde73`). Its status is in v10.
- `07-spec-v8.md` was the spec for commits `63caf2c` and `50ecf81`. Its status is in v9.
- `06-spec-v7.md` was the spec for commit `f426b9c`. Its status is in v8.
- `05-spec-v6.md` was the spec for commits `3399b33` and `ebea1f5`. Its status is in v7.
- `04-spec-v5.md` was the spec for commit `1b555ea`. Its status is in v6.
- `03-spec-v4.md` was the spec for commits `de867b7` and `d845396`. Its status is in v5.
- `02-fixes-v3.md` was the follow-up to commit `3d70e6f`. Items done in `666efc6` are noted in v4.
- `01-profitability-brief.md` is the original diagnosis and full priority list, P1 through P9.

Line numbers in v13 refer to the code at commit `af81074`; v12 used `19caf70`; v11 used `3bdfea8`; v10 used `77fde73`; v9 used `50ecf81`; v8 used `f426b9c`; v7 used `558ed14`; v6 used `1b555ea`; v5 used `d845396`; earlier specs use `666efc6`. Check them before editing.
