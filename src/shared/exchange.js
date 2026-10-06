import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { STABLECOINS, KEEP_ASSETS } from './env.js';
import { safeQuoteSize, normalizeAsset, incrementDecimals, snapToIncrement, formatVolume } from './sizing.js';
import { coinbaseRequest, coinbasePublic, loadCoinbaseSigningKey, coinbaseWsBook, rememberCoinbaseBook } from './coinbase.js';
import { reserveSell, coolSide, sellable } from './free-qty.js';
import { noteLimitFail } from './exit-book.js';
import { krakenPrivate, krakenPublic } from './kraken.js';
import { invalidateLiveCache } from './portfolio.js';

function money(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'object') return money(v.value ?? v.amount ?? v.total_commission ?? v.commission);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function coinbaseFee(o, fills = []) {
  let fee = money(o && o.total_fees) || money(o && o.total_fee) || money(o && o.commission) || money(o && o.fee);
  const det = (o && o.commission_detail_total) || {};
  if (!fee) fee = money(det.total_commission) || money(det.client_commission);
  if (!fee) {
    for (const f of fills) {
      fee += money(f.commission) || money(f.fee) || money((f.commission_detail_total || {}).total_commission);
    }
  }
  return fee;
}

export function createExchange(cfg, orderRegistry) {
  const name = cfg.exchange;
  const pairMeta = new Map();
  const bookCache = new Map();
  function bookTtl() { return Number(process.env.BOOK_CACHE_MS || 1000); }
  async function cachedBook(pair, venue, loader) {
    const key = String(venue) + ':' + String(pair);
    const hit = bookCache.get(key);
    const ttl = bookTtl();
    if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.book;
    const book = await loader();
    if (book) bookCache.set(key, { at: Date.now(), book });
    return book;
  }
  return {
    name,
    loadKeyInfo() {
      if (name === 'coinbase') return loadCoinbaseSigningKey(cfg).alg;
      return null;
    },
    async getProducts(venue = name) {
      if (venue === 'coinbase') {
        let data;
        try { data = await coinbasePublic('/api/v3/brokerage/market/products'); }
        catch { data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/products?product_type=SPOT'); }
        const map = {};
        const q = cfg.quote.toUpperCase();
        for (const p of data.products || []) {
          if (p.is_disabled || p.trading_disabled || p.cancel_only || p.view_only || p.auction_mode) continue;
          if (p.status && String(p.status).toLowerCase() !== 'online') continue;
          const quoteId = (p.quote_currency_id || p.quote_currency || '').toUpperCase();
          if (quoteId !== q) continue;
          const base = (p.base_currency_id || p.base_currency || '').toUpperCase();
          if (!base || STABLECOINS.has(base)) continue;
          const bi = p.base_increment || '0.00000001';
          const qi = p.price_increment || p.quote_increment || '0.01';
          const rec = { venue: 'coinbase', pair: p.product_id || (base + '-' + q), quoteIncrement: parseFloat(qi) || 0.01, pairDecimals: incrementDecimals(qi), lotDecimals: incrementDecimals(bi), ordermin: parseFloat(p.base_min_size || '0') || 0 };
          map[base] = rec; pairMeta.set(rec.pair, rec);
        }
        return map;
      }
      if (venue === 'print') return {};
      const pairs = await krakenPublic('AssetPairs');
      const map = {};
      const q = cfg.quote.toUpperCase();
      for (const [k, v] of Object.entries(pairs)) {
        const b = normalizeAsset(v.base || '');
        const qq = normalizeAsset(v.quote || '');
        if (qq !== q) continue;
        if (STABLECOINS.has(b) || KEEP_ASSETS.has(b)) continue;
        const base = b === 'XBT' ? 'BTC' : b;
        if (map[base]) continue;
        const rec = { venue: 'kraken', pair: k, wsname: v.wsname || null, pairDecimals: v.pair_decimals ?? 5, lotDecimals: v.lot_decimals ?? 8, quoteIncrement: 10 ** -(v.pair_decimals ?? 5), ordermin: parseFloat(v.ordermin || '0') || 0 };
        map[base] = rec; pairMeta.set(k, rec); if (v.altname) pairMeta.set(v.altname, rec);
      }
      return map;
    },
    async getBook(pair, venue = name) {
      if (venue === 'coinbase') {
        const ws = coinbaseWsBook(pair);
        if (ws && ws.mid > 0) return { mid: ws.mid, bid: ws.bid, ask: ws.ask, pair, venue, src: 'ws' };
      }
      return cachedBook(pair, venue, async () => {
        if (venue === 'coinbase') {
          try {
            const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/best_bid_ask?product_ids=' + encodeURIComponent(pair));
            const book = (data.pricebooks || [])[0];
            if (book && book.bids && book.bids[0] && book.asks && book.asks[0]) {
              const bid = parseFloat(book.bids[0].price); const ask = parseFloat(book.asks[0].price);
              rememberCoinbaseBook(pair, bid, ask);
              return { mid: (bid + ask) / 2, bid, ask, pair, venue };
            }
          } catch { /* fallback */ }
          return null;
        }
        const ticker = await krakenPublic('Ticker', { pair });
        const t = ticker[Object.keys(ticker)[0]];
        return { mid: (parseFloat(t.b[0]) + parseFloat(t.a[0])) / 2, bid: parseFloat(t.b[0]), ask: parseFloat(t.a[0]), pair, venue };
      });
    },
    async getBooks(pairs, venue = name) {
      const out = new Map();
      const list = [...new Set((pairs || []).filter(Boolean))];
      if (!list.length) return out;
      if (venue === 'kraken') {
        try {
          const ticker = await krakenPublic('Ticker', { pair: list.join(',') });
          for (const [k, t] of Object.entries(ticker || {})) {
            const bid = parseFloat(t.b[0]); const ask = parseFloat(t.a[0]);
            const rec = { mid: (bid + ask) / 2, bid, ask, pair: k, venue };
            out.set(k, rec);
            for (const p of list) if (p === k || k.includes(p) || p.includes(k)) out.set(p, rec);
          }
        } catch (e) { console.warn('batch ticker', e.message); }
        return out;
      }
      if (venue === 'coinbase') {
        const missing = [];
        for (const p of list) {
          const ws = coinbaseWsBook(p);
          if (ws && ws.mid > 0) out.set(p, { mid: ws.mid, bid: ws.bid, ask: ws.ask, pair: p, venue, src: 'ws' });
          else missing.push(p);
        }
        const chunk = Number(process.env.BOOK_BATCH || 25);
        for (let i = 0; i < missing.length; i += chunk) {
          const part = missing.slice(i, i + chunk);
          const qs = part.map((id) => 'product_ids=' + encodeURIComponent(id)).join('&');
          try {
            const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/best_bid_ask?' + qs);
            for (const book of data.pricebooks || []) {
              if (!(book.bids && book.bids[0] && book.asks && book.asks[0])) continue;
              const bid = parseFloat(book.bids[0].price);
              const ask = parseFloat(book.asks[0].price);
              rememberCoinbaseBook(book.product_id, bid, ask);
              const rec = { mid: (bid + ask) / 2, bid, ask, pair: book.product_id, venue, src: 'rest-batch' };
              out.set(book.product_id, rec);
              for (const p0 of part) {
                if (p0 === book.product_id || p0.replace('-USDC','-USD') === String(book.product_id).replace('-USDC','-USD')) out.set(p0, rec);
              }
            }
          } catch (e) { console.warn('book batch', e.message); }
        }
        return out;
      }
      for (const p of list) {
        try { const b = await this.getBook(p, venue); if (b) out.set(p, b); } catch { /* ignore */ }
        await sleep(cfg.rateLimitMs || 200);
      }
      return out;
    },
    async _touchThenMarket(pair, side, volume, quoteAmount, venue) {
      if (this.disableTouch) return { remainVol: volume, remainQuote: quoteAmount, filled: 0 };
      if (venue === 'kraken' && process.env.MARKET_TOUCH_KRAKEN !== '1') {
        return { remainVol: volume, remainQuote: quoteAmount, filled: 0 };
      }
      const waitMs = Number(process.env.MARKET_TOUCH_WAIT_MS || 0);
      if (!['1', 'true', 'yes'].includes(String(process.env.ALLOW_MARKET_EXIT || '0').toLowerCase())) {
        return { remainVol: volume, remainQuote: quoteAmount, filled: 0 };
      }
      if (!(waitMs > 0) || cfg.dryRun) return { remainVol: volume, remainQuote: quoteAmount, filled: 0 };
      let book;
      try { book = await this.getBook(pair, venue); } catch { book = null; }
      if (!book) return { remainVol: volume, remainQuote: quoteAmount, filled: 0 };
      const px = side === 'buy' ? book.bid : book.ask;
      if (!(px > 0)) return { remainVol: volume, remainQuote: quoteAmount, filled: 0 };
      let vol = Number(volume);
      if (!(vol > 0) && quoteAmount > 0) vol = Number(quoteAmount) / px;
      if (!(vol > 0)) return { remainVol: 0, remainQuote: 0, filled: 0 };
      console.log('  TOUCH ' + side + ' ' + pair + ' ' + vol + ' @ ' + px + ' wait ' + waitMs + 'ms');
      const r = await this.limitOrder(pair, side, px, vol, { level: 0 }, venue);
      const id = r && r.order_id;
      if (!id) return { remainVol: vol, remainQuote: quoteAmount, filled: 0 };
      const t0 = Date.now();
      let st = null;
      while (Date.now() - t0 < waitMs) {
        await sleep(1000);
        st = await this.getOrderStatus(id, venue);
        const s = String((st && st.status) || '').toUpperCase();
        if (s === 'FILLED' || s === 'CANCELLED' || s === 'EXPIRED' || s === 'FAILED') break;
      }
      try { await this.cancelOrder(id, venue); } catch { /* done */ }
      st = (await this.getOrderStatus(id, venue)) || st;
      const filled = Number((st && st.filledSize) || 0);
      const filledVal = Number((st && st.filledValue) || filled * px);
      const remainVol = Math.max(0, vol - filled);
      let remainQuote = quoteAmount;
      if (quoteAmount != null) remainQuote = Math.max(0, Number(quoteAmount) - filledVal);
      console.log('  TOUCH filled ' + filled + ' remain ' + remainVol);
      return { remainVol, remainQuote, filled };
    },
    async marketBuy(pair, volume, quoteAmount = null, venue = name) {
      if (!['1', 'true', 'yes'].includes(String(process.env.ALLOW_MARKET_EXIT || '0').toLowerCase())) {
        console.log('  skip MARKET BUY ' + pair + ' ALLOW_MARKET_EXIT=0');
        return null;
      }
      const sq = quoteAmount != null ? safeQuoteSize(cfg, quoteAmount) : null;
      if (cfg.dryRun) { console.log('[DRY] MARKET BUY', venue, pair); return { ok: true }; }
      const touch = await this._touchThenMarket(pair, 'buy', volume, sq, venue);
      if (!(touch.remainVol > 0) && !(touch.remainQuote > 0)) return { ok: true, touched: true };
      volume = touch.remainVol;
      const useQ = touch.remainQuote != null ? touch.remainQuote : sq;
      if (venue === 'coinbase') {
        const order_configuration = useQ != null ? { market_market_ioc: { quote_size: String(useQ) } } : { market_market_ioc: { base_size: String(volume) } };
        try {
          const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', { client_order_id: randomUUID(), product_id: pair, side: 'BUY', order_configuration });
          if (res.success === false || res.error_response) { console.error('MARKET BUY FAIL', res.error_response || res); return null; }
          return res;
        } catch (e) { console.error(e.message); return null; }
      }
      return krakenPrivate(cfg, 'AddOrder', { pair, type: 'buy', ordertype: 'market', volume: String(volume) });
    },
    async marketSell(pair, volume, venueOrOpts = name) {
      let venue = name;
      let reason = '';
      if (venueOrOpts && typeof venueOrOpts === 'object') {
        venue = venueOrOpts.venue || name;
        reason = String(venueOrOpts.reason || '');
      } else if (typeof venueOrOpts === 'string') venue = venueOrOpts;
      const stranded = reason === 'stranded' && ['1', 'true', 'yes'].includes(String(process.env.STRANDED_TAKER || '0').toLowerCase());
      if (!stranded && !['1', 'true', 'yes'].includes(String(process.env.ALLOW_MARKET_EXIT || '0').toLowerCase())) {
        console.log('  skip MARKET SELL ' + pair + ' ALLOW_MARKET_EXIT=0');
        return null;
      }
      if (cfg.dryRun) { console.log('[DRY] MARKET SELL', venue, pair, volume, reason); return { ok: true }; }
      if (!stranded) {
        const touch = await this._touchThenMarket(pair, 'sell', volume, null, venue);
        if (!(touch.remainVol > 0)) return { ok: true, touched: true };
        volume = touch.remainVol;
      }
      if (venue === 'coinbase') {
        try {
          const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', { client_order_id: randomUUID(), product_id: pair, side: 'SELL', order_configuration: { market_market_ioc: { base_size: String(volume) } } });
          if (res.success === false || res.error_response) { console.error('MARKET SELL FAIL', res.error_response || res); return null; }
          return res;
        } catch (e) { console.error(e.message); return null; }
      }
      return krakenPrivate(cfg, 'AddOrder', { pair, type: 'sell', ordertype: 'market', volume: String(volume) });
    },
    async limitOrder(pair, side, price, volume, meta = {}, venue = name) {
      const info = pairMeta.get(pair);
      if (String(side).toLowerCase() === 'sell') {
        const base = String(pair).split(/[-/]/)[0].toUpperCase();
        const free = sellable(base);
        if (Number.isFinite(free) && Number(volume) > free + 1e-12) {
          const next = formatVolume(free, info && info.lotDecimals);
          const minUsd = Number(process.env.MIN_ORDER_USD || 1);
          const minV = (info && info.ordermin) || 0;
          if (!(Number(next) > 0) || Number(next) + 1e-12 < minV || Number(next) * Number(price) < minUsd) {
            const k = pair;
            const now = Date.now();
            if (now - (this._clampAt && this._clampAt[k] || 0) > 20000) {
              this._clampAt = this._clampAt || {};
              this._clampAt[k] = now;
              console.log('  SELL CLAMP ' + base + ' want=' + volume + ' free=' + (Number.isFinite(free) ? free : 'na'));
            }
            return { skipped: 'free' };
          }
          volume = next;
        }
      }
      const inc = (info && info.quoteIncrement) || (info && info.pairDecimals != null ? 10 ** -info.pairDecimals : 0.01);
      let px = snapToIncrement(price, inc);
      let bookSnap = null;
      if (cfg.postOnly) {
        try {
          bookSnap = await this.getBook(pair, venue);
          if (bookSnap) {
            if (side.toLowerCase() === 'buy' && px >= bookSnap.ask) px = snapToIncrement(bookSnap.bid, inc);
            if (side.toLowerCase() === 'sell' && px <= bookSnap.bid) px = snapToIncrement(bookSnap.ask, inc);
          }
        } catch { /* keep */ }
      }
      price = px;
      const failCtx = (err) => {
        const msg = String(err && err.message || err || '');
        const k = venue + ':' + pair + ':' + side;
        const now = Date.now();
        if (now - (failCtx._at && failCtx._at[k] || 0) < 15000) return;
        failCtx._at = failCtx._at || {};
        failCtx._at[k] = now;
        console.error('LIMIT FAIL id=none', venue, pair, side, 'L' + (meta.level || ''), volume, '@', price, msg);
        noteLimitFail(msg);
        if (/insufficient/i.test(msg)) {
          coolSide(pair, side);
          invalidateLiveCache();
        }
      };
      if (cfg.dryRun) {
        const id = 'dry-' + randomUUID().slice(0, 8);
        orderRegistry.set(id, { pair, side, level: meta.level, status: 'open', price, size: volume, venue });
        return { order_id: id };
      }
      if (venue === 'coinbase') {
        try {
          const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', {
            client_order_id: randomUUID(), product_id: pair, side: side.toUpperCase(),
            order_configuration: { limit_limit_gtc: { base_size: String(volume), limit_price: String(price), post_only: cfg.postOnly } },
          });
          if (res.success === false || res.error_response) {
            failCtx(res.error_response || res);
            const msg = JSON.stringify(res.error_response || res);
            if (cfg.postOnly && !meta._retried && /POST_ONLY|INVALID_LIMIT_PRICE/i.test(msg) && bookSnap) {
              const retryPx = side.toLowerCase() === 'buy' ? snapToIncrement(bookSnap.bid - inc, inc) : snapToIncrement(bookSnap.ask + inc, inc);
              console.log('  post-only retry ' + side + ' ' + pair + ' ' + price + ' -> ' + retryPx);
              return this.limitOrder(pair, side, retryPx, volume, Object.assign({}, meta, { _retried: true }), venue);
            }
            return null;
          }
          const oid = (res.success_response && res.success_response.order_id) || res.order_id;
          if (oid) {
            const base = String(pair).split(/[-/]/)[0];
            orderRegistry.set(oid, { pair, symbol: base, side, level: meta.level, status: 'open', price, size: volume, venue, placedAt: Date.now() });
            if (String(side).toLowerCase() === 'sell') {
              reserveSell(base, volume, oid);
              invalidateLiveCache();
            }
          }
          return { order_id: oid };
        } catch (e) { failCtx(e.message); return null; }
      }
      try {
        const params = { pair, type: side.toLowerCase(), ordertype: 'limit', price: String(price), volume: String(volume) };
        if (cfg.postOnly) params.oflags = 'post';
        const lev = Number(cfg.marginLeverage || process.env.MARGIN_LEVERAGE || 0);
        if (lev >= 2) params.leverage = String(lev);
        const r = await krakenPrivate(cfg, 'AddOrder', params);
        const oid = r.txid && r.txid[0];
        if (oid) orderRegistry.set(oid, { pair, side, level: meta.level, status: 'open', price, size: volume, venue });
        return { order_id: oid };
      } catch (e) { failCtx(e.message); return null; }
    },
    async getOrderStatus(orderId, venue = name) {
      if (!orderId) return null;
      if (String(orderId).startsWith('dry-')) return { status: (orderRegistry.get(orderId) || {}).status || 'open' };
      if (cfg.useUserWebsocket && process.env.COINBASE_REST_STATUS !== '1' && process.env.KRAKEN_REST_STATUS !== '1') {
        const rec = orderRegistry.get(orderId);
        if (rec && !rec.needFee) {
          return {
            status: String(rec.status || 'open').toUpperCase(),
            filledSize: rec.filledSize || 0,
            filledValue: rec.filledValue || 0,
            fee: rec.fee || 0,
            avgPrice: rec.avgPrice || rec.price || 0,
          };
        }
      }
      if (venue === 'coinbase') {
        try {
          const res = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/' + orderId);
          const o = res.order || res;
          const st0 = String(o.status || '').toUpperCase();
          let fills = [];
          if (st0.indexOf('FILL') >= 0 || (orderRegistry.get(orderId) || {}).needFee) {
            try {
              const fl = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/fills?order_ids=' + encodeURIComponent(orderId) + '&limit=100');
              fills = fl.fills || [];
            } catch { fills = []; }
          }
          const taker = fills.some((f) => String(f.liquidity_indicator || '').toUpperCase() === 'TAKER');
          const fee = coinbaseFee(o, fills);
          if (!(fee > 0) && st0.indexOf('FILL') >= 0 && !getOrderStatus._feeWarned) {
            getOrderStatus._feeWarned = true;
            console.warn('fills lookup empty fee', orderId, 'n=' + fills.length);
          }
          return { status: st0, raw: o, filledSize: money(o.filled_size), filledValue: money(o.filled_value), fee, avgPrice: money(o.average_filled_price), taker };
        } catch { return null; }
      }
      try {
        const r = await krakenPrivate(cfg, 'QueryOrders', { txid: orderId });
        const o = r[orderId];
        if (!o) return null;
        const map = { closed: 'FILLED', open: 'OPEN', canceled: 'CANCELLED', expired: 'EXPIRED' };
        return { status: map[o.status] || String(o.status).toUpperCase(), raw: o, filledSize: parseFloat(o.vol_exec || 0) || 0, filledValue: parseFloat(o.cost || 0) || 0, fee: parseFloat(o.fee || 0) || 0, avgPrice: parseFloat(o.price || 0) || 0 };
      } catch { return null; }
    },
    async listOpen(venue = name) {
      if (venue !== 'coinbase') return [];
      try {
        const open = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=100');
        return open.orders || [];
      } catch (e) { console.warn('list open', e.message); return []; }
    },
    async cancelAll(venue = name) {
      if (cfg.dryRun) return;
      if (venue === 'coinbase') {
        try {
          const open = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=100');
          const ids = (open.orders || []).map((o) => o.order_id).filter(Boolean);
          if (ids.length) await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: ids });
        } catch (e) { console.warn(e.message); }
        return;
      }
      try { await krakenPrivate(cfg, 'CancelAll'); } catch (e) { console.warn(e.message); }
    },
    async cancelOrder(orderId, venue = name) {
      if (!orderId || String(orderId).startsWith('dry-') || cfg.dryRun) return;
      if (venue === 'coinbase') { try { await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: [orderId] }); } catch { /* ignore */ } return; }
      try { await krakenPrivate(cfg, 'CancelOrder', { txid: orderId }); } catch { /* ignore */ }
    },
    async cancelPair(pair, venue = name) {
      if (venue === 'coinbase') {
        try {
          const open = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/batch?product_ids=' + encodeURIComponent(pair) + '&order_status=OPEN&limit=50');
          const ids = (open.orders || []).filter((o) => o.product_id === pair).map((o) => o.order_id).filter(Boolean);
          if (ids.length) await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: ids });
        } catch (e) { console.warn(e.message); }
        return;
      }
      const open = await krakenPrivate(cfg, 'OpenOrders');
      for (const [txid, order] of Object.entries(open.open || {})) {
        if ((order.descr && order.descr.pair === pair) || String((order.descr && order.descr.order) || '').includes(pair)) {
          try { await krakenPrivate(cfg, 'CancelOrder', { txid }); } catch { /* ignore */ }
          await sleep(cfg.rateLimitMs);
        }
      }
    },
  };
}
