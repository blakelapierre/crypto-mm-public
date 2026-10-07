# Ladder bot specs

Change specs for the `ladder` bot, written from live logs and status data (Oct 4–7, 2026).

- `13-spec-v13.md` is the current, active work list. Start here. Lead priority: no transfer is ever inferred from a cash residual (venue records only, with a reversal path); fills come from cumulative quantity so partials survive cancels; open book ≥ 90% of tradable equity (`BOOK_TARGET_FRAC`); a full-balance ask on every sellable position; truthful `running` status.
- `12-kraken-short-book.md` is separate Kraken short-book work, not part of the ladder spec series.
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
