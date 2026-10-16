import fs from 'fs';
import { planBook, reconcileSide, rungPrices, sessionWindow, shareSize, tradableNow, wholeShares } from '../src/bots/stocks/quote.js';

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('ok ' + msg); return; }
  failed += 1;
  console.error('FAIL ' + msg);
}

const now = Date.parse('2026-10-16T14:00:00Z');
const day = {
  trading_day_info: {
    trading_sessions: [
      { session_type: 'EQUITY_TRADING_SESSION_PRE_MARKET', session_start_time: '2026-10-16T08:00:00Z', session_end_time: '2026-10-16T13:30:00Z', support_fractional: false, limit_only: true },
      { session_type: 'EQUITY_TRADING_SESSION_NORMAL', session_start_time: '2026-10-16T13:30:00Z', session_end_time: '2026-10-16T20:00:00Z', support_fractional: true, limit_only: false },
    ],
  },
  current_session: 'EQUITY_TRADING_SESSION_NORMAL',
  equity_trading_flags: { tradable: true, buy_enabled: true, buy_fractional_shares: false, sell_fractional_shares: false },
};

check(sessionWindow(day, now).session_type === 'EQUITY_TRADING_SESSION_NORMAL', 'normal session is the window that contains now');
check(sessionWindow(day, Date.parse('2026-10-16T21:00:00Z')) == null, 'after the last window the market is closed');
check(tradableNow({ equity: day }, now), 'a tradable equity inside a session can be quoted');
check(!tradableNow({ equity: { ...day, trading_halted: true } }, now), 'a halt is not tradable');
check(!tradableNow({ trading_disabled: true, equity: day }, now), 'a disabled product is not tradable');
check(wholeShares(day, 'buy', now), 'fractional buys stay off when the flag says so');
check(wholeShares({ ...day, current_session: 'EQUITY_TRADING_SESSION_PRE_MARKET', equity_trading_flags: {} }, Date.parse('2026-10-16T12:00:00Z')), 'pre-market is whole shares');

check(shareSize({ price: 40, budgetUsd: 100, whole: true }) === 2, 'a $40 share fits twice in $100');
check(shareSize({ price: 150, budgetUsd: 100, whole: true }) === 0, 'one share over the budget is not a fraction');
check(shareSize({ price: 40.5, budgetUsd: 50, whole: false, minSize: 0.00001 }) > 1, 'a fractional venue can size under one share');

const touch = rungPrices({ mid: 100, bid: 99.9, ask: 100.1, halfBps: 10, levels: 1, tick: 0.01, join: true });
check(touch.bids[0] < 100.1 && touch.asks[0] > 99.9, 'a joined quote does not cross the touch');
const far = rungPrices({ mid: 100, bid: 99, ask: 101, halfBps: 50, levels: 2, tick: 0.01, join: false });
check(far.bids.length === 2 && far.bids[1] < far.bids[0] && far.asks[1] > far.asks[0], 'extra rungs step away from the mid');

const book = planBook({
  mid: 100, bid: 99.5, ask: 100.5, halfBps: 20, levels: 1, tick: 0.01, join: false,
  cash: 250, inventory: 3, clipUsd: 100, wholeBid: true, wholeAsk: true, buyEnabled: true, sellEnabled: true,
});
check(book.bids.length === 1 && book.bids[0].size === 1 && book.bids[0].price * book.bids[0].size <= 100 + 1e-6, 'the bid is one share inside the clip');
check(book.asks.length === 1 && book.asks[0].size === 1 && book.asks[0].price > 100, 'the ask is one share above the mid');
const liq = planBook({ mid: 100, bid: 99, ask: 101, cash: 500, inventory: 2, clipUsd: 200, liquidateOnly: true, sellEnabled: true, buyEnabled: true });
check(liq.bids.length === 0 && liq.asks.length === 1, 'liquidate-only has an ask and no bid');

const kept = reconcileSide({ open: [{ id: 'a', price: 99, size: 1 }], want: [], pull: false });
check(kept.cancel.length === 0 && kept.keep.length === 1, 'a zero budget keeps the resting bid');
const pulled = reconcileSide({ open: [{ id: 'a', price: 99, size: 1 }], want: [], pull: true });
check(pulled.cancel.length === 1 && pulled.keep.length === 0, 'a halt pulls the resting bid');
const dear = reconcileSide({
  open: [{ id: 'a', price: 99, size: 1 }],
  want: [{ price: 90, size: 1 }],
  requoteBps: 15,
  replace: false,
});
check(dear.cancel.length === 0 && dear.place.length === 0 && dear.keep.length === 1, 'a requote waits when the new order is not funded');
const same = reconcileSide({
  open: [{ id: 'a', price: 99, size: 1 }],
  want: [{ price: 99.05, size: 1 }],
  requoteBps: 15,
  replace: true,
});
check(same.keep.length === 1 && same.cancel.length === 0 && same.place.length === 0, 'a small price move is not a cancel');

const src = fs.readFileSync(new URL('../src/bots/stocks/index.js', import.meta.url), 'utf8');
check(src.includes('post_only: true'), 'equity orders are post-only');
check(src.includes('equity_order_metadata'), 'equity orders name their session');
check(src.includes('limit_limit_gtc'), 'equity orders are limits');
check(!src.includes('market_market'), 'there is no market order');
check(!src.includes('STOCKS_COINBASE_API_KEY') || src.includes('does not use the crypto key'), 'the stock key is not the crypto key');
check(!/\b(AAPL|NVDA|TSLA|MSFT)\b/.test(src), 'tickers come from the venue, not the source');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('stocks checks passed');
