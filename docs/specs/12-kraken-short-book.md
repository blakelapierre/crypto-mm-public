# Kraken short book

The Coinbase ladder can only hold long inventory. On a down tape the spread still pays and the inventory gives it back. This is the same two-sided post-only book with the inventory sign flipped, on Kraken spot margin.

## What it does
- Universe is whatever Kraken marks `leverage_sell` on the quote (USD). No coin list. Microcaps the ladder trades are not in that set, so this does not hedge BLAST, SWELL, HONEY, and the rest.
- Rank active names by the session range, then keep a name only when its current 15-minute bar is down (`ret < SHORT_OPEN_RET`, default 0) and the bar's range is at least `VOL_ENTER_PCT`.
- Ask, post-only, `half = maker fee + min edge` above mid, opens or adds a short. Size is one clip, and the short on a name stops at `INV_NAME_MAX_FRAC` of equity.
- Bid, post-only, the same distance below mid, only exists to cover. Its size is floored so it cannot exceed the open short. A buy never opens a long.
- If the 15-minute bar is no longer down, asks are pulled. The cover bid stays until the short is flat.
- Leverage is 2. That is the borrow, not a bigger clip. `CLIP_MAX_USD` stays 1.5.
- Orders are tagged `userref=20261007`. The bot cancels only those.
- `ALLOW_MARKET_EXIT` stays 0. Nothing crosses the spread.

## What it does not do
- It loses on an up tape the same way the ladder loses on a down tape. Running both does not make a flat result unless the two books are the same assets. They are not.
- It does not short a pair Kraken's margin pool will not lend. Some margin pairs have a short limit of 0 and are skipped.
- Rollover is charged on the borrowed coin about every 4 hours. A short held across that window pays it on top of the maker fee.

## Run
Dry by default. From the repo, with Kraken keys in the environment:

```
node src/bots/margin/index.js
```

Live sends only when both `DRY_RUN=0` and `SHORT_LIVE=1`. The web UI does not start this bot. `SHORT_BOOK=0` falls back to the old leveraged long ladder.
