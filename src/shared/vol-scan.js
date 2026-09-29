import { trendMult } from './mid-ring.js';
import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { krakenPublic } from './kraken.js';
import { coinbaseRequest, coinbaseWsBook } from './coinbase.js';

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
  for (const pair of pairs) {
    const ws = coinbaseWsBook(pair);
    const sym = rev.get(pair);
    if (sym && ws && ws.mid > 0) mids[sym] = ws.mid;
  }
  const missing = pairs.filter((pair) => {
    const sym = rev.get(pair);
    return sym && !(mids[sym] > 0);
  });
  if (!missing.length) return mids;
  if (process.env.VOL_SCAN_REST === '0') {
    if (missing.length) console.log('vol scan ws-only missing=' + missing.length);
    return mids;
  }
  const chunk = Number(process.env.VOL_SCAN_REST_CHUNK || 25);
  for (let i = 0; i < missing.length; i += chunk) {
    const ids = missing.slice(i, i + chunk);
    try {
      const data = await coinbaseRequest(
        cfg, 'GET',
        '/api/v3/brokerage/best_bid_ask?' + ids.map((id) => 'product_ids=' + encodeURIComponent(id)).join('&')
      );
      for (const book of data.pricebooks || []) {
        const bid = parseFloat((book.bids && book.bids[0] && book.bids[0].price) || 0);
        const ask = parseFloat((book.asks && book.asks[0] && book.asks[0].price) || 0);
        const sym = rev.get(book.product_id);
        if (sym && bid && ask) mids[sym] = (bid + ask) / 2;
      }
    } catch (e) {
      console.warn('vol scan batch skip', ids.length, (e && e.message || '').slice(0, 80));
    }
    if (i + chunk < missing.length) await sleep(120);
  }
  return mids;
}

function volFile() {
  const raw = process.env.VOL_SCAN_FILE;
  if (raw === 'off' || raw === '0' || raw === 'false') return null;
  if (raw && raw.trim()) return path.resolve(process.cwd(), raw.trim());
  const bot = String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
  return path.resolve(process.cwd(), 'logs/vol-scan-' + bot + '.json');
}

export function saveVolScan(scan) {
  const dest = volFile();
  if (!dest || !scan || !scan.history) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const hist = {};
    for (const [sym, arr] of scan.history) hist[sym] = arr;
    const scores = {};
    for (const [k, v] of lastScore) scores[k] = v;
    const meta = {};
    for (const [k, v] of lastMeta) meta[k] = v;
    fs.writeFileSync(dest, JSON.stringify({ ts: new Date().toISOString(), hist, scores, meta }));
  } catch (e) { console.warn('vol-scan save', e.message); }
}

function loadVolInto(history) {
  const dest = volFile();
  if (!dest || !fs.existsSync(dest)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(dest, 'utf8'));
    let n = 0;
    for (const [sym, arr] of Object.entries(j.hist || {})) {
      if (!Array.isArray(arr)) continue;
      const cut = Date.now() - 15 * 60 * 1000;
      const kept = arr.filter((x) => x && x.mid > 0 && x.t && x.t >= cut);
      if (!kept.length) continue;
      history.set(sym, kept);
      n += kept.length;
    }
    for (const [k, v] of Object.entries(j.scores || {})) lastScore.set(k, Number(v) || 0);
    for (const [k, v] of Object.entries(j.meta || {})) lastMeta.set(k, v);
    if (n) console.log('restored vol-scan samples=' + n + ' symbols=' + history.size);
    return n;
  } catch (e) {
    console.warn('vol-scan load', e.message);
    return 0;
  }
}

const lastScore = new Map();
const lastMeta = new Map();
let lastHistory = new Map();
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
  const raw = Math.min(3, Math.max(0.35, (mine / sum) * n));
  return raw * trendMult(key);
}

export function volStatsForSymbol(sym) {
  return lastMeta.get(String(sym || '').toUpperCase()) || null;
}
function scanRows() {
  const rows = [];
  for (const [symbol, m] of lastMeta) {
    const hist = lastHistory.get(symbol) || [];
    const a = hist.length ? Number(hist[0].mid) : 0;
    const b = hist.length ? Number(hist[hist.length - 1].mid) : Number(m.last || 0);
    const ret = a > 0 ? (b - a) / a : 0;
    rows.push({ symbol, rangePct: Number(m.rangePct || 0), last: b, ret });
  }
  return rows;
}
export function topMovers(n = 8) {
  return scanRows().sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret) || b.rangePct - a.rangePct).slice(0, n);
}
export function topVolatiles(n = 8) {
  return scanRows().sort((a, b) => b.rangePct - a.rangePct).slice(0, n);
}
export function midHistory(sym) {
  return lastHistory.get(String(sym || '').toUpperCase()) || [];
}

export function createVolScan(cfg, productMap) {
  const windowMs = (cfg.volWindowMin || 15) * 60 * 1000;
  const history = new Map();
  loadVolInto(history);
  lastHistory = history;
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
    for (const [sym, arr] of history) {
      while (arr.length && now - arr[0].t > windowMs) arr.shift();
      if (!arr.length) history.delete(sym);
    }
    saveVolScan({ history });
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
    lastMeta.clear();
    for (const r of rows) {
      lastScore.set(r.symbol, r.volScore);
      lastMeta.set(r.symbol, { volScore: r.volScore, rangePct: r.rangePct, samples: r.samples, last: r.last });
    }
    return rows;
  }
  return { tick, ranking, history };
}
