import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { coinbaseRequest, coinbasePublic } from '../../shared/coinbase.js';
import { planBook, reconcileSide, sessionWindow, tradableNow, wholeShares } from './quote.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/stocks.env');
const cfg = baseConfig();
const self = fileURLToPath(import.meta.url);
const BOT = 'stocks';
const statePath = path.resolve(process.cwd(), process.env.STATE_FILE || 'data/stocks.json');
const CID = 'st-';

function envNum(k, d) {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && process.env[k] !== '' ? n : d;
}
function hasOwnKey() {
  return !!(process.env.STOCKS_COINBASE_API_KEY && (process.env.STOCKS_COINBASE_API_SECRET || process.env.STOCKS_COINBASE_API_SECRET_FILE));
}
function useOwnKey() {
  cfg.coinbaseApiKey = process.env.STOCKS_COINBASE_API_KEY || '';
  cfg.coinbaseApiSecret = process.env.STOCKS_COINBASE_API_SECRET || '';
  cfg.coinbaseSecretFile = process.env.STOCKS_COINBASE_API_SECRET_FILE || '';
  cfg.exchange = 'coinbase';
  cfg.postOnly = true;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

const SUBTYPE = {
  COMMON_STOCK: 'EQUITY_PRODUCT_SUBTYPE_COMMON_STOCK',
  ADR: 'EQUITY_PRODUCT_SUBTYPE_ADR',
  ETF: 'EQUITY_PRODUCT_SUBTYPE_ETF',
};

function allowedSubtypes() {
  const raw = String(process.env.STOCK_SUBTYPES || 'COMMON_STOCK,ADR,ETF');
  const out = new Set();
  for (const part of raw.split(',')) {
    const s = part.trim().toUpperCase();
    if (!s) continue;
    out.add(SUBTYPE[s] || (s.startsWith('EQUITY_') ? s : ''));
  }
  out.delete('');
  return out;
}

function tickerOf(p) {
  const d = (p && p.equity_product_details) || {};
  return String(d.ticker || p.base_display_symbol || p.base_currency_id || '').toUpperCase();
}

async function listEquities(quote) {
  const rows = [];
  let cursor = '';
  for (let page = 0; page < 40; page++) {
    let pathQ = '/api/v3/brokerage/market/products?product_type=EQUITY&limit=250';
    if (cursor) pathQ += '&cursor=' + encodeURIComponent(cursor);
    const data = await coinbasePublic(pathQ);
    for (const p of data.products || []) {
      if (String(p.product_type || '').toUpperCase() !== 'EQUITY') continue;
      if (String(p.quote_currency_id || '').toUpperCase() !== quote) continue;
      rows.push(p);
    }
    if (!data.pagination || !data.pagination.has_next || !data.pagination.next_cursor) break;
    cursor = data.pagination.next_cursor;
  }
  return rows;
}

async function accounts() {
  const rows = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    let p = '/api/v3/brokerage/accounts?limit=250';
    if (cursor) p += '&cursor=' + encodeURIComponent(cursor);
    const data = await coinbaseRequest(cfg, 'GET', p);
    rows.push(...(data.accounts || []));
    cursor = data.has_next ? data.cursor : '';
    if (!cursor) break;
  }
  return rows;
}

async function listOpenEquities() {
  const rows = [];
  let cursor = '';
  let useType = true;
  for (let page = 0; page < 10; page++) {
    let p = '/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=100';
    if (useType) p += '&product_type=EQUITY';
    if (cursor) p += '&cursor=' + encodeURIComponent(cursor);
    let data;
    try { data = await coinbaseRequest(cfg, 'GET', p); }
    catch (e) {
      if (useType && page === 0) { useType = false; page -= 1; continue; }
      throw e;
    }
    rows.push(...(data.orders || []));
    cursor = data.has_next ? (data.cursor || '') : '';
    if (!cursor) break;
  }
  return rows;
}

function ours(o) {
  return String((o && o.client_order_id) || '').startsWith(CID);
}

function legOf(o) {
  const limit = ((o.order_configuration || {}).limit_limit_gtc) || {};
  return {
    id: o.order_id,
    productId: o.product_id,
    side: String(o.side || '').toLowerCase(),
    price: Number(limit.limit_price || 0),
    size: Number(limit.base_size || 0),
    clientId: o.client_order_id || '',
  };
}

async function books(ids) {
  const out = new Map();
  const chunk = 25;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const qs = part.map((id) => 'product_ids=' + encodeURIComponent(id)).join('&');
    try {
      const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/best_bid_ask?' + qs);
      for (const book of data.pricebooks || []) {
        const bid = Number(book.bids && book.bids[0] && book.bids[0].price);
        const ask = Number(book.asks && book.asks[0] && book.asks[0].price);
        if (!(bid > 0) || !(ask > 0)) continue;
        out.set(book.product_id, { bid, ask, mid: (bid + ask) / 2 });
      }
    } catch (e) { console.warn('book', e.message); }
  }
  return out;
}

async function cancel(id, why, label) {
  console.log('CANCEL why=' + why + ' ' + label + ' ' + id);
  if (cfg.dryRun || !id) return;
  try {
    await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: [id] });
  } catch (e) { console.warn('cancel', e.message); }
}

async function place(product, side, price, size, session) {
  const whole = Number.isInteger(size);
  const base = whole ? String(size) : String(size);
  const tick = Number(product.price_increment || product.quote_increment) || 0.01;
  const px = Number(price).toFixed(Math.min(8, (String(tick).split('.')[1] || '00').length));
  const label = tickerOf(product);
  console.log('  ' + side.toUpperCase() + ' ' + label + ' ' + base + ' @ ' + px + ' session=' + (session || '-'));
  if (cfg.dryRun) return 'dry-' + randomUUID().slice(0, 8);
  const body = {
    client_order_id: CID + randomUUID(),
    product_id: product.product_id,
    side: side.toUpperCase(),
    order_configuration: { limit_limit_gtc: { base_size: base, limit_price: px, post_only: true } },
    equity_order_metadata: {
      equity_trading_session: session || 'EQUITY_TRADING_SESSION_NORMAL',
      displayed_order_config: 'LIMIT_GTC',
    },
  };
  try {
    const res = await coinbaseRequest(cfg, 'POST', '/api/v3/brokerage/orders', body);
    if (res.success === false || res.error_response) {
      console.log('  REJECT ' + label + ' ' + side + ' ' + JSON.stringify(res.error_response || res));
      return '';
    }
    return (res.success_response && res.success_response.order_id) || res.order_id || '';
  } catch (e) {
    console.log('  REJECT ' + label + ' ' + side + ' ' + (e.message || e));
    return '';
  }
}

function rank(p) {
  const sub = ((p.equity_product_details || {}).equity_subtype) || '';
  const pri = sub.endsWith('COMMON_STOCK') ? 0 : sub.endsWith('ADR') ? 1 : 2;
  return pri + ':' + tickerOf(p);
}

async function choose(products, heldIds, bookFor, now) {
  const allow = allowedSubtypes();
  const want = new Set(String(process.env.SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const max = Math.max(1, envNum('MM_MAX_PAIRS', 4));
  const clip = envNum('CLIP_MAX_USD', 100);
  const cap = envNum('MAX_SHARE_USD', clip);
  const chosen = [];
  const seen = new Set();
  for (const id of heldIds) {
    const p = products.find((x) => x.product_id === id);
    if (p) { chosen.push(p); seen.add(p.product_id); }
  }
  let pool = products.filter((p) => {
    if (seen.has(p.product_id)) return false;
    const d = p.equity_product_details || {};
    if (allow.size && !allow.has(d.equity_subtype)) return false;
    if (d.liquidate_only || d.trading_halted || p.trading_disabled || p.view_only) return false;
    const flags = d.equity_trading_flags || {};
    if (flags.buy_enabled === false || flags.tradable === false) return false;
    if (!tradableNow({ ...p, equity: d }, now)) return false;
    if (want.size && !want.has(tickerOf(p))) return false;
    return true;
  });
  pool.sort((a, b) => rank(a).localeCompare(rank(b)));
  const probe = pool.slice(0, Math.max(max, envNum('STOCK_PROBE', 80)));
  const bk = await bookFor(probe.map((p) => p.product_id));
  const tight = [];
  for (const p of probe) {
    const book = bk.get(p.product_id);
    if (!book) continue;
    const px = book.ask > 0 ? book.ask : book.mid;
    if (!(px > 0) || px > cap + 1e-9) continue;
    const spread = book.mid > 0 && book.ask > book.bid ? (book.ask - book.bid) / book.mid * 10000 : 1e9;
    tight.push({ p, spread });
  }
  tight.sort((a, b) => a.spread - b.spread);
  for (const row of tight) {
    if (chosen.length >= max) break;
    chosen.push(row.p);
  }
  return { chosen, probed: probe.length, pool: pool.length };
}

async function main() {
  useOwnKey();
  if (!hasOwnKey()) {
    console.log('stocks idle: set STOCKS_COINBASE_API_KEY and STOCKS_COINBASE_API_SECRET in data/keys.env (this bot does not use the crypto key)');
    while (true) await sleep(60000);
  }
  const quote = String(process.env.QUOTE || 'USD').toUpperCase();
  const state = loadState();
  state.orders = state.orders || {};
  console.log('stocks venue=coinbase quote=' + quote + ' dry=' + cfg.dryRun + ' post_only=1 levels=' + envNum('MM_LEVELS', 1));
  let products = [];
  let productsAt = 0;
  while (true) {
    const now = Date.now();
    try {
      if (now - productsAt > envNum('PRODUCTS_REFRESH_MS', 1800000) || !products.length) {
        products = await listEquities(quote);
        productsAt = now;
        console.log('products equities quote=' + quote + ' n=' + products.length);
      }
      const accts = await accounts();
      let cash = 0;
      let cashHold = 0;
      const pos = {};
      for (const a of accts) {
        const cur = String(a.currency || '').toUpperCase();
        const avail = Number((a.available_balance && a.available_balance.value) || 0);
        const hold = Number((a.hold && a.hold.value) || 0);
        if (cur === quote) { cash += avail; cashHold += hold; continue; }
        if (avail + hold > 0) pos[cur] = { avail, hold, total: avail + hold };
      }
      let open = null;
      try { open = await listOpenEquities(); } catch (e) { console.warn('list open', e.message); open = null; }
      if (open == null) {
        console.log('BOOK fetch miss');
        saveState(state);
        await sleep(envNum('LOOP_MS', 5000));
        continue;
      }
      const mine = open.filter(ours).map(legOf).filter((o) => o.id && o.productId);
      const byProduct = new Map();
      for (const o of mine) {
        if (!byProduct.has(o.productId)) byProduct.set(o.productId, []);
        byProduct.get(o.productId).push(o);
      }
      const heldIds = [];
      for (const p of products) {
        const t = tickerOf(p);
        const row = pos[t] || pos[String(p.base_currency_id || '').toUpperCase()];
        if (row && row.total > 0) heldIds.push(p.product_id);
      }
      const { chosen, probed, pool } = await choose(products, heldIds, books, now);
      const bk = await books(chosen.map((p) => p.product_id));
      const levels = Math.max(1, envNum('MM_LEVELS', 1));
      const half = envNum('MIN_HALF_SPREAD_BPS', 10);
      const requote = envNum('REQUOTE_MOVE_BPS', 15);
      const clip = envNum('CLIP_MAX_USD', 100);
      const join = !['0', 'false', 'no'].includes(String(process.env.JOIN_TOUCH || '1').toLowerCase());
      const liveIds = new Set();
      let notion = 0;
      for (const p of chosen) {
        const d = p.equity_product_details || {};
        const window = sessionWindow(d, now);
        const session = (window && window.session_type) || d.current_session || '';
        const book = bk.get(p.product_id);
        const t = tickerOf(p);
        const row = pos[t] || pos[String(p.base_currency_id || '').toUpperCase()] || { avail: 0, hold: 0, total: 0 };
        const resting = byProduct.get(p.product_id) || [];
        const halted = !!(d.trading_halted || !tradableNow({ ...p, equity: d }, now));
        if (!book || halted) {
          for (const o of resting) await cancel(o.id, halted ? 'halt' : 'nobook', t + ' ' + o.side);
          continue;
        }
        const bidRest = resting.filter((o) => o.side === 'buy').reduce((s, o) => s + o.price * o.size, 0);
        const askRest = resting.filter((o) => o.side === 'sell').reduce((s, o) => s + o.size, 0);
        const flags = d.equity_trading_flags || {};
        const plan = planBook({
          mid: book.mid, bid: book.bid, ask: book.ask, halfBps: half, levels, tick: Number(p.price_increment || p.quote_increment) || 0.01,
          join, cash: cash + bidRest, inventory: row.avail + askRest, clipUsd: clip,
          wholeBid: wholeShares(d, 'buy', now), wholeAsk: wholeShares(d, 'sell', now),
          minSize: Number(p.base_min_size) || 0,
          buyEnabled: flags.buy_enabled !== false,
          sellEnabled: flags.sell_enabled !== false,
          liquidateOnly: !!d.liquidate_only,
        });
        const buyOpen = resting.filter((o) => o.side === 'buy');
        const askOpen = resting.filter((o) => o.side === 'sell');
        const buyCost = plan.bids.reduce((s, w) => s + w.price * w.size, 0);
        const buyPlan = reconcileSide({
          open: buyOpen, want: plan.bids, requoteBps: requote,
          pull: !!d.liquidate_only || halted, replace: buyCost <= cash + 1e-6,
        });
        const askPlan = reconcileSide({
          open: askOpen, want: plan.asks, requoteBps: requote, pull: halted, replace: true,
        });
        for (const o of buyPlan.cancel) await cancel(o.id, plan.bids.length ? 'requote' : 'flat', t + ' buy');
        for (const o of askPlan.cancel) await cancel(o.id, plan.asks.length ? 'requote' : 'flat', t + ' sell');
        for (const o of buyPlan.keep.concat(askPlan.keep)) { liveIds.add(o.id); notion += Number(o.price) * Number(o.size); }
        for (const w of buyPlan.place) {
          const id = await place(p, 'buy', w.price, w.size, session);
          if (id) { liveIds.add(id); notion += w.price * w.size; cash = Math.max(0, cash - w.price * w.size); }
        }
        for (const w of askPlan.place) {
          const id = await place(p, 'sell', w.price, w.size, session);
          if (id) { liveIds.add(id); notion += w.price * w.size; }
        }
      }
      const chosenIds = new Set(chosen.map((p) => p.product_id));
      for (const [id, xs] of byProduct) {
        if (chosenIds.has(id)) continue;
        for (const o of xs) await cancel(o.id, 'dropped', (o.productId || id) + ' ' + o.side);
      }
      state.orders = {};
      for (const id of liveIds) state.orders[id] = true;
      state.chosen = chosen.map((p) => ({ productId: p.product_id, ticker: tickerOf(p) }));
      saveState(state);
      const names = chosen.map((p) => tickerOf(p)).join(',') || '-';
      console.log('STOCKS cash=$' + cash.toFixed(2) + ' hold=$' + cashHold.toFixed(2) + ' book=$' + notion.toFixed(2) + ' tracked=' + liveIds.size + ' names=' + names + ' pool=' + pool + ' probed=' + probed + (cfg.dryRun ? ' dry' : ''));
    } catch (e) {
      console.warn('loop', e.message || e);
    }
    await sleep(envNum('LOOP_MS', 5000));
  }
}

if (process.env.SMOKE === '1') {
  console.log('smoke import ok');
} else if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
