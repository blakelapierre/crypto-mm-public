import fs from 'fs';
import path from 'path';
import { coinbasePublic, startCoinbaseTickerWs } from '../shared/coinbase.js';

const WINDOW = 15 * 60 * 1000;
const SAMPLE = Number(process.env.FEED_SAMPLE_MS || 1000);
const FLUSH = Number(process.env.FEED_FLUSH_MS || 250);
const outFile = path.resolve(process.cwd(), 'data', 'feed', 'coinbase.json');
const series = new Map();
const last = new Map();
const bids = new Map();
const asks = new Map();

function note(symbol, mid, bid, ask) {
  const px = Number(mid);
  if (!(px > 0)) return;
  const now = Date.now();
  const arr = series.get(symbol) || [];
  const prev = arr[arr.length - 1];
  if (!prev || now - prev.t >= SAMPLE) arr.push({ t: now, p: px });
  else prev.p = px;
  while (arr.length && now - arr[0].t > WINDOW) arr.shift();
  series.set(symbol, arr);
  last.set(symbol, px);
  if (Number(bid) > 0) bids.set(symbol, Number(bid));
  if (Number(ask) > 0) asks.set(symbol, Number(ask));
}

function stats(symbol) {
  const arr = series.get(symbol) || [];
  if (arr.length < 2) return null;
  const a = arr[0].p;
  const b = arr[arr.length - 1].p;
  const ps = arr.map((x) => x.p);
  const hi = Math.max(...ps);
  const lo = Math.min(...ps);
  const mid = (hi + lo) / 2;
  return { symbol, mid: b, bid: bids.get(symbol) || b, ask: asks.get(symbol) || b, ret: a > 0 ? (b - a) / a : 0, rangePct: mid > 0 ? ((hi - lo) / mid) * 100 : 0 };
}

function flush() {
  const ranked = [...series.keys()].map(stats).filter(Boolean).sort((a, b) => b.ret - a.ret).slice(0, 40);
  const keep = new Set(['BTC', 'ETH', ...ranked.map((r) => r.symbol)]);
  const sparks = {};
  for (const sym of keep) sparks[sym] = (series.get(sym) || []).slice(-90);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ updated: Date.now(), ranked, sparks, mids: Object.fromEntries(last) }));
}

async function universe() {
  const data = await coinbasePublic('/api/v3/brokerage/market/products?product_type=SPOT');
  const rows = (data.products || [])
    .filter((p) => p.quote_currency_id === 'USDC' && p.status === 'online' && !p.trading_disabled)
    .sort((a, b) => Number(b.volume_percentage_change_24h || b.approximate_quote_24h_volume || 0) - Number(a.volume_percentage_change_24h || a.approximate_quote_24h_volume || 0))
    .slice(0, 80);
  const ids = new Set(rows.map((p) => p.product_id));
  ids.add('BTC-USDC');
  ids.add('ETH-USDC');
  try {
    const held = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data', 'ape-positions.json'), 'utf8'));
    for (const row of held) if (row && row.symbol) ids.add(String(row.symbol).toUpperCase() + '-USDC');
  } catch { /* no positions yet */ }
  return [...ids];
}

const pairs = await universe();
console.log('feed universe', pairs.length);
startCoinbaseTickerWs(pairs, (rec) => {
  const sym = String(rec.pair || '').split('-')[0];
  note(sym, rec.last || rec.mid || rec.bid, rec.bid, rec.ask);
});
setInterval(flush, FLUSH);
flush();
console.log('feed writing', outFile);
