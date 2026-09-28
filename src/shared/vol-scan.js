import { setTimeout as sleep } from 'timers/promises';
import { krakenPublic } from './kraken.js';
import { coinbaseRequest } from './coinbase.js';

function pairToSym(productMap) {
  const m = new Map();
  for (const [sym, info] of Object.entries(productMap)) m.set(info.pair, sym);
  return m;
}

export async function fetchAllMids(cfg, productMap) {
  const mids = {};
  const rev = pairToSym(productMap);
  if (cfg.exchange === 'kraken') {
    const tick = await krakenPublic('Ticker');
    for (const [sym, info] of Object.entries(productMap)) {
      const t = tick[info.pair];
      if (!t) continue;
      const bid = parseFloat((t.b && t.b[0]) || 0);
      const ask = parseFloat((t.a && t.a[0]) || 0);
      if (bid && ask) mids[sym] = (bid + ask) / 2;
    }
    return mids;
  }
  if (cfg.exchange !== 'coinbase') return mids;
  const pairs = [...new Set(Object.values(productMap).map((p) => p.pair))];
  const chunk = 10;
  for (let i = 0; i < pairs.length; i += chunk) {
    const ids = pairs.slice(i, i + chunk);
    try {
      const data = await coinbaseRequest(
        cfg,
        'GET',
        '/api/v3/brokerage/best_bid_ask?' + ids.map((id) => 'product_ids=' + encodeURIComponent(id)).join('&')
      );
      for (const book of data.pricebooks || []) {
        const bid = parseFloat((book.bids && book.bids[0] && book.bids[0].price) || 0);
        const ask = parseFloat((book.asks && book.asks[0] && book.asks[0].price) || 0);
        const sym = rev.get(book.product_id);
        if (sym && bid && ask) mids[sym] = (bid + ask) / 2;
      }
    } catch (e) {
      for (const id of ids) {
        try {
          const one = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/best_bid_ask?product_ids=' + encodeURIComponent(id));
          const book = (one.pricebooks || [])[0];
          if (!book) continue;
          const bid = parseFloat((book.bids && book.bids[0] && book.bids[0].price) || 0);
          const ask = parseFloat((book.asks && book.asks[0] && book.asks[0].price) || 0);
          const sym = rev.get(book.product_id || id);
          if (sym && bid && ask) mids[sym] = (bid + ask) / 2;
        } catch { /* skip invalid product_id */ }
      }
    }
    if (i + chunk < pairs.length) await sleep(120);
  }
  return mids;
}

const lastScore = new Map();
let universe = [];

export function setSizeUniverse(symbols) {
  universe = (symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean);
}

export function sizeWeightForSymbol(sym) {
  if (!lastScore.size) return 1;
  const key = String(sym || '').toUpperCase();
  const names = universe.length ? universe : [...lastScore.keys()];
  const scores = names.map((s) => Math.max(1e-9, lastScore.get(s) || 0));
  const sum = scores.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return 1;
  const mine = Math.max(1e-9, lastScore.get(key) || sum / names.length);
  const n = Math.max(1, names.length);
  return Math.min(3, Math.max(0.35, (mine / sum) * n));
}

export function createVolScan(cfg, productMap) {
  const windowMs = (cfg.volWindowMin || 15) * 60 * 1000;
  const history = new Map();
  function push(sym, mid, now) {
    if (!(mid > 0)) return;
    if (!history.has(sym)) history.set(sym, []);
    const arr = history.get(sym);
    arr.push({ t: now, mid });
    while (arr.length && now - arr[0].t > windowMs) arr.shift();
  }
  async function tick() {
    const now = Date.now();
    const mids = await fetchAllMids(cfg, productMap);
    for (const [sym, mid] of Object.entries(mids)) push(sym, mid, now);
    return Object.keys(mids).length;
  }
  function ranking() {
    const rows = [];
    for (const [sym, arr] of history) {
      if (arr.length < 3 || !productMap[sym]) continue;
      const rets = [];
      for (let i = 1; i < arr.length; i++) {
        if (arr[i - 1].mid > 0) rets.push(Math.log(arr[i].mid / arr[i - 1].mid));
      }
      if (!rets.length) continue;
      const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
      const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
      const sigma = Math.sqrt(variance);
      const hi = Math.max(...arr.map((a) => a.mid));
      const lo = Math.min(...arr.map((a) => a.mid));
      const last = arr[arr.length - 1].mid;
      const range = last > 0 ? (hi - lo) / last : 0;
      rows.push({ symbol: sym, ...productMap[sym], volScore: sigma * Math.sqrt(rets.length) + range, rangePct: range * 100, samples: arr.length, last });
    }
    rows.sort((a, b) => b.volScore - a.volScore);
    lastScore.clear();
    for (const r of rows) lastScore.set(r.symbol, r.volScore);
    return rows;
  }
  return { tick, ranking, history };
}
