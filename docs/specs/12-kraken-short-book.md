# Kraken directional book

Same post-only ladder as Coinbase, on Kraken spot margin at 2x. One name is never long and short at once. It does not flip until the open position is flat. A position uses about half its size as collateral, which is why the test deposit can be smaller than a spot book.

## Direction
- 15-minute bar **flat or up** (`ret >= SHORT_OPEN_RET`, default 0), and range at least `VOL_ENTER_PCT`: **margin long**. A bid below mid opens or adds it. An ask above mid only closes it, and is never larger than the open long.
- 15-minute bar **down**: **margin short**. An ask above mid opens or adds it. A bid below mid only covers it, and is never larger than the short.
- While a long is open and the bar flips down, only the closing ask stays. No short until the long is flat. The mirror applies to an open short.
- New orders are skipped when free margin cannot cover `notional / 2`.

Clip stays $1.50. Per-name cap stays 25% of equity, measured on the position notional, not the margin. `ALLOW_MARKET_EXIT` stays 0 for the book. Orders use `userref=20261007`.

## Funding
This account is for trading only. Any non-cash spot balance, including an XLM deposit, is sold at market for USD. That conversion is the one market order. The book itself stays post-only. XLM/USD cannot sell less than 30 XLM (about $6 at $0.20).

## Run
Sends orders when `DRY_RUN=0` and `SHORT_LIVE=1`.

```
node src/bots/margin/index.js
```

The web UI does not start it. Margin trading has to be enabled on the Kraken account or the orders are rejected.

## Cross-venue
A locked arb is `bid` on one venue minus `ask` on the other, after both fees. Measured 2026-10-07 across 20 overlapping USD books: mids differed by about 1–23 bps. The best locked cross was ADA at 18 bps. This account pays about 35 bps maker on Coinbase and, at Kraken Pro tier 1, 40 bps maker. Nothing cleared a round trip. `src/bots/xex` is not in the web UI and is not run.
