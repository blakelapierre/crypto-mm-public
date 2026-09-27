# Runtime notes (2026-09-27)

## XRP held as zero
`normalizeAsset` no longer strips a leading `X` (XRP was becoming RP).

## Coinbase INVALID_LIMIT_PRICE_POST_ONLY
Prices snap to `quote_increment`. Post-only buys clamp to bid, sells to ask. Failed limits log `rawPrice`, `snappedPrice`, increment, and book (`src/shared/exchange.js`).

## Comp bot idle inventory
Standalone `src/bots/comp/gnot-sn64-kraken.js` (run from your tree) calls `ENSURE SELL` / `ENSURE BUY` when one side is empty. Keep using that file locally until the full blob is on GitHub.

`git pull` then restart ladder for the exchange.js snap/fail-log.
