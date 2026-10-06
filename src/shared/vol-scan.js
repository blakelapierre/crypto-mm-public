import { trendMult, midReturn, midRangePct } from './mid-ring.js';
import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { krakenPublic } from './kraken.js';
import { coinbaseRequest, coinbaseWsBook } from './coinbase.js';
import { nnSizeMult } from '../ml/infer.js';

function pairToSym(productMap) {
  const m = new Map();
  for (const [sym, info] of Object.entries(productMap)) m.set(info.pair, sym);
  return m;
}

const quarantine = new Map();
const scanStats = {
  universe: 0, scanned: 0, wsMids: 0, restMids: 0, missing: 0,
  batchErrors1h: [], bisectCalls1h: [], productsAt: null, lastScanAt: null,
};
function pruneHour(arr) {
  const cut = Date.now() - 3600000;
  while (arr.length && arr[0] < cut) arr.shift();
  return arr.length;
}
export function scannerSnap() {
  return {
    universe: scanStats.universe,
    scanned: scanStats.scanned,
    wsMids: scanStats.wsMids,
    restMids: scanStats.restMids,
    missing: scanStats.missing,
    batchErrors1h: pruneHour(scanStats.batchErrors1h),
    bisectCalls1h: pruneHour(scanStats.bisectCalls1h),
    quarantined: [...quarantine.entries()].map(([id, q]) => ({
      id, status: q.status, untilPT: new Date(q.until).toISOString(),
    })),
    productsAt: scanStats.productsAt,
    lastScanAt: scanStats.lastScanAt,
  };
}
export function noteProductsAt(ts) { scanStats.productsAt = ts || new Date().toISOString(); }

async function bidAskBatch(cfg, ids) {
  return coinbaseRequest(
    cfg, 'GET',
    '/api/v3/brokerage/best_bid_ask?' + ids.map((id) => 'product_ids=' + encodeURIComponent(id)).join('&'),
  );
}
function statusOf(err) {
  const m = String(err && err.message || '').match(/Coinbase (\d+)/);
  return m ? Number(m[1]) : 0;
}
async function fetchBooks(cfg, ids) {
  const books = [];
  const now = Date.now();
  const live = [];
  for (const id of ids) {
    const q = quarantine.get(id);
    if (q && now < q.until) continue;
    if (q) {
      try {
        const data = await bidAskBatch(cfg, [id]);
        quarantine.delete(id);
        console.log('SCAN RELEASE ' + id);
        for (const b of data.pricebooks || []) books.push(b);
      } catch (e) {
        const base = Number(process.env.VOL_QUARANTINE_MS || 21600000);
        const ttl = Math.min(24 * 3600000, (q.ttl || base) * 2);
        quarantine.set(id, { ...q, status: statusOf(e) || q.status, until: Date.now() + ttl, ttl });
      }
      continue;
    }
    live.push(id);
  }
  async function take(batch) {
    if (!batch.length) return;
    try {
      const data = await bidAskBatch(cfg, batch);
      for (const b of data.pricebooks || []) books.push(b);
    } catch (e) {
      const status = statusOf(e);
      scanStats.batchErrors1h.push(Date.now());
      if (!(status >= 400 && status < 500)) {
        await sleep(200);
        try {
          const data = await bidAskBatch(cfg, batch);
          for (const b of data.pricebooks || []) books.push(b);
        } catch {
          console.warn('vol scan batch skip', batch.join(','));
        }
        return;
      }
      if (batch.length === 1) {
        const id = batch[0];
        if (!quarantine.has(id)) console.log('SCAN QUARANTINE ' + id + ' ' + status);
        const ttl = Number(process.env.VOL_QUARANTINE_MS || 21600000);
        quarantine.set(id, { reason: '4xx', status, firstAt: Date.now(), until: Date.now() + ttl, ttl });
        return;
      }
      scanStats.bisectCalls1h.push(Date.now());
      const mid = Math.ceil(batch.length / 2);
      await sleep(120);
      await take(batch.slice(0, mid));
      await sleep(120);
      await take(batch.slice(mid));
    }
  }
  const chunk = Number(process.env.VOL_SCAN_REST_CHUNK || 25);
  for (let i = 0; i < live.length; i += chunk) {
    await take(live.slice(i, i + chunk));
    if (i + chunk < live.length) await sleep(120);
  }
  return books;
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
  if (!missing.length) {
    scanStats.universe = pairs.length;
    scanStats.scanned = Object.keys(mids).length;
    scanStats.wsMids = Object.keys(mids).length;
    scanStats.restMids = 0;
    scanStats.missing = 0;
    scanStats.lastScanAt = new Date().toISOString();
    return mids;
  }
  if (process.env.VOL_SCAN_REST === '0') {
    if (missing.length) console.log('vol scan ws-only missing=' + missing.length);
    return mids;
  }
  const wsN = Object.keys(mids).length;
  const books = await fetchBooks(cfg, missing);
  for (const book of books) {
    const bid = parseFloat((book.bids && book.bids[0] && book.bids[0].price) || 0);
    const ask = parseFloat((book.asks && book.asks[0] && book.asks[0].price) || 0);
    const sym = rev.get(book.product_id);
    if (sym && bid && ask) mids[sym] = (bid + ask) / 2;
  }
  const still = pairs.filter((pair) => {
    const q = quarantine.get(pair);
    if (q && Date.now() < q.until) return false;
    const sym = rev.get(pair);
    return sym && !(mids[sym] > 0);
  });
  scanStats.universe = pairs.length;
  scanStats.scanned = Object.keys(mids).length;
  scanStats.wsMids = wsN;
  scanStats.restMids = Math.max(0, Object.keys(mids).length - wsN);
  scanStats.missing = still.length;
  scanStats.lastScanAt = new Date().toISOString();
  return mids;
}

function volFile() {
  const raw = process.env.VOL_SCAN_FILE;
  if (raw === 'off' || raw === '0' || raw === 'false') return null;
  if (raw && raw.trim()) return path.resolve(process.cwd(), raw.trim());
  const bot = String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
  return path.resolve(process.cwd(), 'logs/vol-scan-' + bot + '.json');
}

export function ensureVolLoaded() {
  if (lastMeta.size || lastHistory.size) return;
  loadVolInto(lastHistory);
}
export function savedRangePct(sym) {
  ensureVolLoaded();
  const key = String(sym || '').toUpperCase();
  const m = lastMeta.get(key);
  if (m && m.rangePct != null) return Number(m.rangePct) || 0;
  const arr = lastHistory.get(key);
  if (arr && arr.length >= 2) {
    const mids = arr.map((x) => Number(x.mid)).filter((x) => x > 0);
    if (mids.length >= 2) {
      const lo = Math.min(...mids), hi = Math.max(...mids), last = mids[mids.length - 1];
      return last > 0 ? ((hi - lo) / last) * 100 : 0;
    }
  }
  return 0;
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
  const key = String(sym || '').toUpperCase();
  const win = Number(process.env.LIVE_WEIGHT_MS || 60000);
  const names = universe.length ? universe : [...lastScore.keys()];
  const list = names.length ? names : [key];
  const kTrend = Number(process.env.LIVE_TREND_GAIN || 40);
  function score(s) {
    const rng = midRangePct(s, win);
    const ret = midReturn(s, win);
    if (!(rng >= 0.08) && !(ret > 0.002)) return 0.04;
    const rise = Math.max(0.25, 1 + Math.max(0, ret) * kTrend);
    return Math.max(0.04, rng * rise);
  }
  const scores = list.map(score);
  const sum = scores.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return 1;
  const mine = score(key);
  const n = Math.max(1, list.length);
  const base = Math.min(2.2, Math.max(0.15, (mine / sum) * n));
  const ret = midReturn(key, win);
  return base * nnSizeMult({ buy: ret >= 0 ? 1 : 0, offMid: 0, feeBps: Number(process.env.MAKER_FEE_BPS || 35), invSign: ret >= 0 ? 1 : -1 });
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
      const first = arr[0].mid;
      const range = last > 0 ? (hi - lo) / last : 0;
      const ret = first > 0 ? (last - first) / first : 0;
      rows.push({ symbol: sym, ...productMap[sym], volScore: sigma * Math.sqrt(rets.length) + range, rangePct: range * 100, samples: arr.length, last, ret });
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
