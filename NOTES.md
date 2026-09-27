# Runtime notes (2026-09-27)

## XRP held as zero
`normalizeAsset` used to strip a leading `X`, so **XRP became RP**. Rebalance thought the position was empty and bought more. Tickers that start with X are no longer stripped; Kraken prefixes (`XXRP`, `XXBT`) are mapped explicitly.

## Coinbase INVALID_LIMIT_PRICE_POST_ONLY
`quote_increment` like `0.01000000` was treated as 8 decimals. Prices are snapped to the real increment, and post-only buys/sells are clamped to bid/ask. Failed limits log `rawPrice`, `snappedPrice`, `quoteIncrement`, and the book.

## Comp bot: inventory but no ask
If a slide buy fails on cash, the bot now `ENSURE SELL` whenever coins are free and no ask is working, and `ENSURE BUY` when cash is free and no bid is working. Restart `gnot-sn64-kraken.js` after pull.

Standalone path: `src/bots/comp/gnot-sn64-kraken.js` (local copy is source of truth if GitHub blob is behind).
