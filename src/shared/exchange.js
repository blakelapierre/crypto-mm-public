import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { STABLECOINS, KEEP_ASSETS } from './env.js';
import { safeQuoteSize } from './sizing.js';
import { coinbaseRequest, coinbasePublic, loadCoinbaseSigningKey } from './coinbase.js';
import { krakenPrivate, krakenPublic } from './kraken.js';

export function createExchange(cfg, orderRegistry) {
  const name = cfg.exchange;
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
          if (p.is_disabled) continue;
          const quoteId = (p.quote_currency_id || p.quote_currency || '').toUpperCase();
          if (quoteId !== q) continue;
          const base = (p.base_currency_id || p.base_currency || '').toUpperCase();
          if (!base || STABLECOINS.has(base)) continue;
          const bi = p.base_increment || '0.00000001';
          const qi = p.quote_increment || '0.01';
          map[base] = {
            venue: 'coinbase',
            pair: p.product_id || `${base}-${q}`,
            pairDecimals: Math.max(0, (String(qi).split('.')[1] || '').length),
            lotDecimals: Math.max(0, (String(bi).split('.')[1] || '').length),
            ordermin: parseFloat(p.base_min_size || '0') || 0,
          };
        }
        return map;
      }
      if (venue === 'print') return {};
      const pairs = await krakenPublic('AssetPairs');
      const map = {};
      const q = cfg.quote.toUpperCase();
      for (const [k, v] of Object.entries(pairs)) {
        const b = (v.base || '').replace(/^X/, '').replace(/^Z/, '');
        const qq = (v.quote || '').replace(/^X/, '').replace(/^Z/, '');
        if (qq !== q) continue;
        if (STABLECOINS.has(b) || KEEP_ASSETS.has(b)) continue;
        const base = b === 'XBT' ? 'BTC' : b;
        if (map[base]) continue;
        map[base] = { venue: 'kraken', pair: k, pairDecimals: v.pair_decimals ?? 5, lotDecimals: v.lot_decimals ?? 8, ordermin: parseFloat(v.ordermin || '0') || 0 };
      }
      return map;
    },
    async getBook(pair, venue = name) {
      if (venue === 'coinbase') {
        try {
          const data = await coinbaseRequest(cfg, 'GET', `/api/v3/brokerage/best_bid_ask?product_ids=${encodeURIComponent(pair)}`);
          const book = (data.pricebooks || [])[0];
          if (book?.bids?.[0] && book?.asks?.[0]) {
            const bid = parseFloat(book.bids[0].price);
            const ask = parseFloat(book.asks[0].price);
            return { mid: (bid + ask) / 2, bid, ask, pair, venue };
          }
        } catch { /* fallback */ }
        try {
          const t = await coinbasePublic(`/api/v3/brokerage/market/products/${encodeURIComponent(pair)}`);
          const px = parseFloat(t.price || 0);
          if (px) return { mid: px, bid: px, ask: px, pair, venue };
        } catch { /* ignore */ }
        return null;
      }
      const ticker = await krakenPublic('Ticker', { pair });
      const key = Object.keys(ticker)[0];
      const t = ticker[key];
      return { mid: (parseFloat(t.b[0]) + parseFloat(t.a[0])) / 2, bid: parseFloat(t.b[0]), ask: parseFloat(t.a[0]), pair: key, venue };
    },
    async marketBuy(pair, volume, quoteAmount = null, venue = name) {
      const sq = quoteAmount != null ? safeQuoteSize(cfg, quoteAmount) : null;
      if (cfg.dryRun) { console.log(`[DRY] MARKET BUY ${venue} ${pair}`); return { ok: true }; }
      if (venue === 'coinbase') {
        if (sq != null && sq < cfg.minOrderUsd) return null;
        const order_configuration = sq != null
          ? { market_market_ioc: { quote_size: String(sq) } }
          : { market_market_ioc: { base_size: String(volume) } };
        try {
          const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', {
            client_order_id: randomUUID(), product_id: pair, side: 'BUY', order_configuration,
          });
          if (res.success === false || res.error_response) { console.error('MARKET BUY FAIL', res.error_response || res); return null; }
          return res;
        } catch (e) { console.error(e.message); return null; }
      }
      return krakenPrivate(cfg, 'AddOrder', { pair, type: 'buy', ordertype: 'market', volume: String(volume) });
    },
    async marketSell(pair, volume, venue = name) {
      if (cfg.dryRun) { console.log(`[DRY] MARKET SELL ${venue} ${pair} ${volume}`); return { ok: true }; }
      if (venue === 'coinbase') {
        try {
          const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', {
            client_order_id: randomUUID(), product_id: pair, side: 'SELL',
            order_configuration: { market_market_ioc: { base_size: String(volume) } },
          });
          if (res.success === false || res.error_response) { console.error('MARKET SELL FAIL', res.error_response || res); return null; }
          return res;
        } catch (e) { console.error(e.message); return null; }
      }
      return krakenPrivate(cfg, 'AddOrder', { pair, type: 'sell', ordertype: 'market', volume: String(volume) });
    },
    async limitOrder(pair, side, price, volume, meta = {}, venue = name) {
      if (cfg.dryRun) {
        const id = 'dry-' + randomUUID().slice(0, 8);
        console.log(`[DRY] LIMIT ${venue} ${side} ${volume} @ ${price} ${pair}`);
        orderRegistry.set(id, { pair, side, level: meta.level, status: 'open', price, size: volume, venue });
        return { order_id: id };
      }
      if (venue === 'coinbase') {
        try {
          const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', {
            client_order_id: randomUUID(), product_id: pair, side: side.toUpperCase(),
            order_configuration: { limit_limit_gtc: { base_size: String(volume), limit_price: String(price), post_only: cfg.postOnly } },
          });
          if (res.success === false || res.error_response) { console.error('LIMIT FAIL', res.error_response || res); return null; }
          const oid = res.success_response?.order_id || res.order_id;
          if (oid) orderRegistry.set(oid, { pair, side, level: meta.level, status: 'open', price, size: volume, venue });
          return { order_id: oid };
        } catch (e) { console.error(e.message); return null; }
      }
      const params = { pair, type: side.toLowerCase(), ordertype: 'limit', price: String(price), volume: String(volume) };
      if (cfg.postOnly) params.oflags = 'post';
      const r = await krakenPrivate(cfg, 'AddOrder', params);
      const oid = r.txid?.[0];
      if (oid) orderRegistry.set(oid, { pair, side, level: meta.level, status: 'open', price, size: volume, venue });
      return { order_id: oid };
    },
    async getOrderStatus(orderId, venue = name) {
      if (!orderId) return null;
      if (String(orderId).startsWith('dry-')) return { status: orderRegistry.get(orderId)?.status || 'open' };
      if (venue === 'coinbase') {
        try {
          const res = await coinbaseRequest(cfg, 'GET', `/api/v3/brokerage/orders/historical/${orderId}`);
          const o = res.order || res;
          return { status: (o.status || '').toUpperCase(), raw: o };
        } catch { return null; }
      }
      try {
        const r = await krakenPrivate(cfg, 'QueryOrders', { txid: orderId });
        const o = r[orderId];
        if (!o) return null;
        const map = { closed: 'FILLED', open: 'OPEN', canceled: 'CANCELLED', expired: 'EXPIRED' };
        return { status: map[o.status] || o.status.toUpperCase(), raw: o };
      } catch { return null; }
    },
    async cancelAll(venue = name) {
      console.log(`\n── Cancel all (${venue}) ──`);
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
      if (venue === 'coinbase') {
        try { await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: [orderId] }); } catch { /* ignore */ }
        return;
      }
      try { await krakenPrivate(cfg, 'CancelOrder', { txid: orderId }); } catch { /* ignore */ }
    },
    async cancelPair(pair, venue = name) {
      if (cfg.dryRun) {
        for (const [, rec] of orderRegistry) if (rec.pair === pair && rec.status === 'open') rec.status = 'cancelled';
        return;
      }
      if (venue === 'coinbase') {
        try {
          const path = `/api/v3/brokerage/orders/historical/batch?product_id=${encodeURIComponent(pair)}&order_status=OPEN&limit=50`;
          const open = await coinbaseRequest(cfg, 'GET', path);
          const ids = (open.orders || []).map((o) => o.order_id).filter(Boolean);
          if (ids.length) {
            await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: ids });
            ids.forEach((id) => { const r = orderRegistry.get(id); if (r) r.status = 'cancelled'; });
          }
        } catch (e) { console.warn(e.message); }
        return;
      }
      const open = await krakenPrivate(cfg, 'OpenOrders');
      for (const [txid, order] of Object.entries(open.open || {})) {
        if (order.descr?.pair === pair || (order.descr?.order || '').includes(pair)) {
          try { await krakenPrivate(cfg, 'CancelOrder', { txid }); } catch { /* ignore */ }
          const r = orderRegistry.get(txid);
          if (r) r.status = 'cancelled';
          await sleep(cfg.rateLimitMs);
        }
      }
    },
  };
}
