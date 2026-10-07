# Kraken directional book

Same post-only ladder as Coinbase, with a side for each tape. One name is never long and short at once. It does not flip until the open inventory is flat.

## Direction
- 15-minute bar **flat or up** (`ret >= SHORT_OPEN_RET`, default 0), and range at least `VOL_ENTER_PCT`: **spot long**, the Coinbase shape. A bid below mid buys. An ask above mid sells, and is never larger than the spot this bot itself bought.
- 15-minute bar **down**: **margin short** at 2x. An ask above mid opens or adds the short. A bid below mid only covers, and is never larger than the short.
- While a long is still open and the bar flips down, only the ask stays. No short until the spot is sold. The mirror applies to an open short when the bar flips up.
- Existing balances are baselined in `logs/margin-book-base.json` on first start. Coins already on the account are not sold. Delete that file only if you mean to re-base.

Clip stays $1.50. Per-name cap stays 25% of equity. Leverage 2 is the borrow on shorts, not a bigger order. Longs are spot, leverage 0. `ALLOW_MARKET_EXIT` stays 0. Orders use `userref=20261007`.

Universe is Kraken pairs that have `leverage_sell`, so the same name can be long on an up bar and short on a down bar. That set is majors and larger alts, not the Coinbase microcaps.

## Run
Dry by default.

```
node src/bots/margin/index.js
```

Sends orders only when `DRY_RUN=0` and `SHORT_LIVE=1`. The web UI does not start it.

## Cross-venue
A locked arb is `bid` on one venue minus `ask` on the other, after both fees. Measured 2026-10-07 15:35Z across 20 overlapping USD books (BTC, ETH, SOL, and the liquid alts): mids differed by about 1–23 bps. The best locked cross was ADA at 18 bps, BTC at 2 bps. This account pays about 35 bps maker on Coinbase and 16 bps on Kraken, so the bar is about 51 bps before any buffer. Nothing cleared it. Taking both legs is worse, because the taker fee is higher than 35.

`src/bots/xex` already does this check and then sends two market orders. It is not in the web UI. Its Coinbase fee was 6 bps, which would have traded a gap this account still loses on. That default is now 35. Do not run it until a locked cross is larger than both fees, both legs can rest as maker, and the coin and the quote are already sitting on both venues. Transferring after the fill is too slow to be the hedge. Two ladders quoting the same name are not an arb. They are two books.
