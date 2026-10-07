import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envBool, envNum } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { noteMid } from '../../shared/mid-ring.js';
import { formatPrice, normalizeAsset } from '../../shared/sizing.js';

// Kraken directional book. Up or flat 15m bar: spot bids and asks, same shape as the
// Coinbase ladder (a buy builds inventory, a sell never exceeds it). Down bar: a
// margin ask opens a short and a buy only covers it. A name cannot flip until flat.
const USERREF = 20261007;

export function floorVol(v, d) {
  const f = 10 ** (Number(d) || 0);
  return Math.floor((Number(v) + 1e-12) * f) / f;
}

function clipSize(usd, px, qtyCap, lot, room) {
  let sz = floorVol(Math.min(usd, qtyCap == null ? usd : qtyCap * px) / px, lot);
  if (qtyCap != null && sz > qtyCap) sz = floorVol(qtyCap, lot);
  if (room != null && sz * px > room) sz = floorVol((room / px) * 0.98, lot);
  return sz;
}

function okSize(sz, px, ordermin, minUsd, qtyCap) {
  if (!(sz > 0) || !(px > 0)) return false;
  if (sz + 1e-12 < ordermin) return false;
  if (sz * px + 1e-12 < minUsd) return false;
  if (qtyCap != null && sz > qtyCap + 1e-12) return false;
  return true;
}

// signal is 'long', 'short', or null. null only works an exit.
export function decideBook(x) {
  const mid = Number(x.mid);
  const half = Number(x.half);
  const clip = Number(x.clipUsd) || 1.5;
  const cap = Number(x.equity) * Number(x.capFrac || 0.25);
  const shortQty = Math.max(0, Number(x.shortQty) || 0);
  const spotQty = Math.max(0, Number(x.spotQty) || 0);
  const minUsd = Number(x.minUsd) || 1;
  const ordermin = Number(x.ordermin) || 0;
  const lot = x.lotDecimals ?? 8;
  const pxd = x.pairDecimals ?? 5;
  const freeQuote = Math.max(0, Number(x.freeQuote == null ? cap : x.freeQuote) || 0);
  const signal = x.signal === 'long' || x.signal === 'short' ? x.signal : null;
  if (!(mid > 0) || !(half > 0)) return { bid: null, ask: null, why: 'no-mid' };
  const askPx = formatPrice(mid * (1 + half), pxd);
  const bidPx = formatPrice(mid * (1 - half), pxd);
  const why = [];
  let bid = null;
  let ask = null;
  const spotUsd = spotQty * mid;
  const holdSpot = spotUsd + 1e-9 >= minUsd;
  if (shortQty > 0 && holdSpot) why.push('both');
  if (shortQty > 0 && !x.bidOpen) {
    const sz = clipSize(clip, bidPx, shortQty, lot, null);
    if (okSize(sz, bidPx, ordermin, minUsd, shortQty)) bid = { price: bidPx, size: sz, leverage: 2, marginShort: false };
    else why.push('cover-below-min');
  } else if (shortQty > 0) {
    why.push('cover-resting');
  }
  if (shortQty <= 0 && holdSpot && !x.askOpen) {
    const sz = clipSize(clip, askPx, spotQty, lot, null);
    if (okSize(sz, askPx, ordermin, minUsd, spotQty)) ask = { price: askPx, size: sz, leverage: 0, marginShort: false };
    else why.push('exit-below-min');
  }
  const shortRoom = cap - shortQty * mid;
  const longRoom = cap - spotUsd;
  if (shortQty > 0 && signal === 'short' && !holdSpot && !x.askOpen && shortRoom >= minUsd) {
    const sz = clipSize(Math.min(clip, shortRoom), askPx, null, lot, shortRoom);
    if (okSize(sz, askPx, ordermin, minUsd, null)) ask = { price: askPx, size: sz, leverage: 2, marginShort: true };
    else why.push('add-below-min');
  }
  if (shortQty <= 0 && !holdSpot && signal === 'short' && !x.askOpen && shortRoom >= minUsd) {
    const sz = clipSize(Math.min(clip, shortRoom), askPx, null, lot, shortRoom);
    if (okSize(sz, askPx, ordermin, minUsd, null)) ask = { price: askPx, size: sz, leverage: 2, marginShort: true };
    else why.push('open-below-min');
  }
  if (shortQty <= 0 && signal === 'long' && !x.bidOpen && longRoom >= minUsd && freeQuote >= minUsd) {
    const budget = Math.min(clip, longRoom, freeQuote * 0.98);
    const sz = clipSize(budget, bidPx, null, lot, longRoom);
    if (okSize(sz, bidPx, ordermin, minUsd, null) && sz * bidPx <= freeQuote + 1e-9) bid = { price: bidPx, size: sz, leverage: 0, marginShort: false };
    else why.push('bid-below-min');
  }
  if (shortQty > 0 && signal !== 'short') why.push('flatten-short');
  if (holdSpot && signal === 'short') why.push('flatten-long');
  if (!signal) why.push('no-signal');
  return { bid, ask, why: why.filter(Boolean).join(',') || 'ok' };
}

function candleNow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const c = rows[rows.length - 1];
  const open = Number(c[1]);
  const high = Number(c[2]);
  const low = Number(c[3]);
  const close = Number(c[4]);
  if (!(open > 0) || !(close > 0)) return null;
  return { ret: (close - open) / open, range: (high - low) / close, mid: close };
}

async function ohlc15(pair) {
  const data = await krakenPublic('OHLC', { pair, interval: 15 });
  const key = Object.keys(data || {}).find((k) => k !== 'last');
  return candleNow(key ? data[key] : null);
}

async function spotBalances(cfg) {
  const r = await krakenPrivate(cfg, 'Balance');
  const out = {};
  for (const [k, v] of Object.entries(r || {})) out[normalizeAsset(k)] = Number(v) || 0;
  return out;
}

function baselineFile() {
  return path.join(process.cwd(), 'logs', 'margin-book-base.json');
}

function loadBaseline(bals, pos, book) {
  const file = baselineFile();
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* rewrite */ }
  const base = { spot: {}, short: {}, at: new Date().toISOString() };
  for (const r of book) {
    base.spot[r.symbol] = Number(bals[r.symbol] || 0);
    base.short[r.symbol] = posFor(pos, r).short || 0;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(base, null, 2));
  console.log('  baselined existing balances. only inventory opened after this is traded');
  return base;
}

async function tradeEquity(cfg) {
  const r = await krakenPrivate(cfg, 'TradeBalance', { asset: 'ZUSD' });
  return Number((r && (r.eb || r.e)) || 0);
}

async function marginPos(cfg) {
  const r = await krakenPrivate(cfg, 'OpenPositions', { docalcs: true });
  const by = new Map();
  for (const p of Object.values(r || {})) {
    const vol = Number(p.vol || 0) - Number(p.vol_closed || 0);
    if (!(vol > 0) || !p.pair) continue;
    const row = by.get(p.pair) || { short: 0, long: 0 };
    if (String(p.type).toLowerCase() === 'sell') row.short += vol;
    else row.long += vol;
    by.set(p.pair, row);
  }
  return by;
}

async function ourOrders(cfg) {
  const r = await krakenPrivate(cfg, 'OpenOrders');
  const out = [];
  for (const [id, o] of Object.entries((r && r.open) || {})) {
    if (String(o.userref || '') !== String(USERREF)) continue;
    const d = o.descr || {};
    out.push({
      id,
      pair: d.pair,
      side: String(d.type || '').toLowerCase(),
      price: Number(d.price || 0),
      size: Number(o.vol || 0) - Number(o.vol_exec || 0),
    });
  }
  return out;
}

function posFor(pos, rec) {
  return pos.get(rec.pair) || pos.get(rec.altname) || pos.get(rec.wsname) || { short: 0, long: 0 };
}

function ordersFor(orders, rec) {
  const keys = new Set([rec.pair, rec.altname, rec.wsname, rec.symbol, rec.wsname && String(rec.wsname).replace('/', '')].filter(Boolean));
  return orders.filter((o) => keys.has(o.pair));
}

export async function main() {
  loadProjectEnv(process.env.BOT_CONFIG || 'configs/margin.env');
  const cfg = baseConfig();
  const live = envBool('SHORT_LIVE', false) && !cfg.dryRun;
  const clip = envNum('CLIP_MAX_USD', 1.5);
  const capFrac = envNum('INV_NAME_MAX_FRAC', 0.25);
  const maxPairs = Math.max(1, envNum('MM_MAX_PAIRS', 4));
  const enter = envNum('VOL_ENTER_PCT', 2) / 100;
  const openRet = envNum('SHORT_OPEN_RET', 0);
  const half = (envNum('MAKER_FEE_BPS', 16) + envNum('MIN_EDGE_BPS', 20)) / 10000;
  const minUsd = envNum('MIN_ORDER_USD', 1);
  const reprice = envNum('REQUOTE_BPS', 8) / 10000;
  const ex = createExchange(cfg, new Map());
  if (!cfg.krakenApiKey || !cfg.krakenApiSecret) throw new Error('Missing Kraken keys');
  const products = await ex.getProducts('kraken');
  const book = Object.entries(products).filter(([, r]) => r.shortable).map(([symbol, r]) => ({ ...r, symbol }));
  console.log('kraken book pairs=' + book.length + ' live=' + live + ' clip=$' + clip + ' long=spot short=2x');
  if (!live) console.log('  dry run. set DRY_RUN=0 and SHORT_LIVE=1 to send orders');
  let ranked = [];
  let rankedAt = 0;
  let base = null;
  while (true) {
    try {
      const pos = await marginPos(cfg);
      const orders = await ourOrders(cfg);
      const equity = await tradeEquity(cfg);
      const bals = await spotBalances(cfg);
      if (!base) base = loadBaseline(bals, pos, book);
      let reservedBids = 0;
      for (const o of orders) if (o.side === 'buy') reservedBids += Number(o.price) * Number(o.size);
      const freeQuote = Math.max(0, Number(bals.USD || 0) - reservedBids);
      const heldSyms = new Set();
      for (const r of book) {
        const p = posFor(pos, r);
        const spotQty = Math.max(0, Number(bals[r.symbol] || 0) - Number(base.spot[r.symbol] || 0));
        const shortQty = Math.max(0, p.short - Number(base.short[r.symbol] || 0));
        const spotUsd = spotQty * Number((ranked.find((x) => x.symbol === r.symbol) || {}).mid || 0);
        if (shortQty > 0 || spotUsd >= minUsd) heldSyms.add(r.symbol);
      }
      if (Date.now() - rankedAt > 60000 || !ranked.length) {
        const scored = [];
        for (let i = 0; i < book.length; i += 20) {
          const part = book.slice(i, i + 20);
          let tick = {};
          try { tick = await krakenPublic('Ticker', { pair: part.map((r) => r.pair).join(',') }); } catch (e) { console.warn('ticker', e.message); }
          for (const r of part) {
            const t = tick[r.pair] || tick[r.altname];
            if (!t || !t.c) continue;
            const last = Number(t.c[0]);
            const hi = Number((t.h && (t.h[1] || t.h[0])) || 0);
            const lo = Number((t.l && (t.l[1] || t.l[0])) || 0);
            if (last > 0) noteMid(r.symbol, last);
            scored.push({ ...r, last, dayRange: last > 0 && hi > lo ? (hi - lo) / last : 0 });
          }
        }
        scored.sort((a, b) => b.dayRange - a.dayRange);
        const top = scored.filter((r) => r.dayRange > 0).slice(0, Math.max(maxPairs * 4, 12));
        for (const r of book) if (heldSyms.has(r.symbol) && !top.some((t) => t.symbol === r.symbol)) top.push(r);
        ranked = [];
        for (const r of top) {
          let bar = null;
          try { bar = await ohlc15(r.pair); } catch (e) { console.warn('ohlc', r.symbol, e.message); }
          await sleep(200);
          if (!bar) continue;
          noteMid(r.symbol, bar.mid);
          ranked.push({ ...r, ret15: bar.ret, range: bar.range, mid: bar.mid });
        }
        rankedAt = Date.now();
        const previewUp = ranked.filter((r) => r.ret15 >= openRet && r.range >= enter).slice(0, maxPairs);
        const previewDn = ranked.filter((r) => r.ret15 < openRet && r.range >= enter).slice(0, maxPairs);
        console.log('  scan up ' + (previewUp.map((r) => r.symbol + ' ' + (r.ret15 * 100).toFixed(2) + '%').join(', ') || '-'));
        console.log('  scan down ' + (previewDn.map((r) => r.symbol + ' ' + (r.ret15 * 100).toFixed(2) + '%').join(', ') || '-'));
      }
      const active = [];
      const tradable = ranked.filter((r) => r.range >= enter && r.ret15 != null).sort((a, b) => b.range - a.range);
      for (const r of tradable) {
        if (active.length >= maxPairs) break;
        active.push(r);
      }
      for (const r of book) {
        if (heldSyms.has(r.symbol) && !active.some((a) => a.symbol === r.symbol)) {
          active.push(ranked.find((x) => x.symbol === r.symbol) || r);
        }
      }
      let shortUsd = 0;
      let longUsd = 0;
      for (const r of active) {
        const snap = ranked.find((x) => x.symbol === r.symbol) || r;
        const mid = Number(snap.mid || snap.last || 0);
        if (!(mid > 0)) continue;
        const p = posFor(pos, r);
        const spotQty = Math.max(0, Number(bals[r.symbol] || 0) - Number(base.spot[r.symbol] || 0));
        const shortQty = Math.max(0, p.short - Number(base.short[r.symbol] || 0));
        const signal = snap.ret15 == null ? null : (snap.ret15 < openRet ? 'short' : 'long');
        const mine = ordersFor(orders, r);
        const bidOpen = mine.some((o) => o.side === 'buy');
        const askOpen = mine.some((o) => o.side === 'sell');
        const q = decideBook({
          mid, half, clipUsd: clip, equity, capFrac, freeQuote,
          shortQty, spotQty,
          signal, bidOpen, askOpen, minUsd, ordermin: r.ordermin, lotDecimals: r.lotDecimals, pairDecimals: r.pairDecimals,
        });
        shortUsd += shortQty * mid;
        longUsd += spotQty * mid;
        const drifted = (o, px) => !(px > 0) || Math.abs(o.price - px) / px >= reprice;
        let cancelled = false;
        for (const o of mine) {
          const keepBid = o.side === 'buy' && q.bid && !drifted(o, q.bid.price);
          const keepAsk = o.side === 'sell' && q.ask && !drifted(o, q.ask.price);
          if (keepBid || keepAsk) continue;
          if (live) { try { await ex.cancelOrder(o.id, 'kraken'); } catch { /* ignore */ } }
          console.log('  CANCEL ' + o.side + ' ' + r.symbol + ' @ ' + o.price);
          cancelled = true;
        }
        if (cancelled) continue;
        if (q.ask && !askOpen) await send(ex, r, 'sell', q.ask, live);
        if (q.bid && !bidOpen) await send(ex, r, 'buy', q.bid, live);
      }
      const names = active.map((r) => {
        const snap = ranked.find((x) => x.symbol === r.symbol);
        const dir = snap && snap.ret15 != null ? (snap.ret15 < openRet ? 'S' : 'L') : '?';
        return r.symbol + ':' + dir;
      });
      console.log('  BOOK equity=$' + equity.toFixed(2) + ' long=$' + longUsd.toFixed(2) + ' short=$' + shortUsd.toFixed(2) + ' free=$' + freeQuote.toFixed(2) + ' ' + (names.join(',') || '-') + (live ? '' : ' dry'));
    } catch (e) {
      console.warn('short loop', e.message);
    }
    await sleep(envNum('SHORT_LOOP_MS', 15000));
  }
}

async function send(ex, row, side, order, live) {
  const kind = order.marginShort ? 'short' : (order.leverage >= 2 ? 'cover' : 'spot');
  const tag = (live ? '  ' : '  DRY ') + side.toUpperCase() + ' ' + row.symbol + ' ' + order.size + ' @ ' + order.price + ' ' + kind;
  console.log(tag);
  if (!live) return;
  const r = await ex.limitOrder(row.pair, side, order.price, order.size, {
    level: 1, userref: USERREF, marginShort: !!order.marginShort, leverage: order.leverage || 0,
  }, 'kraken');
  if (!r || !r.order_id) console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + (r && (r.error || r.skipped) || 'no id'));
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
