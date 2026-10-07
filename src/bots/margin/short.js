import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envBool, envNum } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { noteMid } from '../../shared/mid-ring.js';
import { formatPrice } from '../../shared/sizing.js';

// Kraken spot-margin short book. Mirror of the ladder: post-only asks open a short,
// post-only bids only cover it. A buy is never larger than the open short, so this
// cannot flip into a long. New shorts are placed only while the 15m bar is down.
const USERREF = 20261007;

export function floorVol(v, d) {
  const f = 10 ** (Number(d) || 0);
  return Math.floor((Number(v) + 1e-12) * f) / f;
}

export function decideQuote(x) {
  const mid = Number(x.mid);
  const half = Number(x.half);
  const clip = Number(x.clipUsd) || 1.5;
  const cap = Number(x.equity) * Number(x.capFrac || 0.25);
  const shortQty = Math.max(0, Number(x.shortQty) || 0);
  const longQty = Math.max(0, Number(x.longQty) || 0);
  const minUsd = Number(x.minUsd) || 1;
  const ordermin = Number(x.ordermin) || 0;
  const lot = x.lotDecimals ?? 8;
  const pxd = x.pairDecimals ?? 5;
  const openRet = Number(x.openRet ?? 0);
  if (!(mid > 0) || !(half > 0)) return { bid: null, ask: null, why: 'no-mid' };
  if (longQty > 0) return { bid: null, ask: null, why: 'long' };
  const askPx = formatPrice(mid * (1 + half), pxd);
  const bidPx = formatPrice(mid * (1 - half), pxd);
  const shortUsd = shortQty * mid;
  const room = cap - shortUsd;
  const why = [];
  let bid = null;
  let ask = null;
  if (shortQty > 0 && !x.bidOpen) {
    let sz = floorVol(Math.min(shortQty, clip / bidPx), lot);
    if (sz > shortQty) sz = floorVol(shortQty, lot);
    if (sz + 1e-12 >= ordermin && sz * bidPx + 1e-12 >= minUsd && sz <= shortQty + 1e-12) bid = { price: bidPx, size: sz };
    else why.push('cover-below-min');
  }
  const down = x.ret15 != null && Number.isFinite(Number(x.ret15)) && Number(x.ret15) < openRet;
  if (!down) why.push(x.ret15 == null ? 'tape' : 'not-down');
  else if (!x.askOpen && room >= minUsd) {
    const use = Math.min(clip, room);
    let sz = floorVol(use / askPx, lot);
    if (sz * askPx > room) sz = floorVol((room / askPx) * 0.98, lot);
    if (sz + 1e-12 >= ordermin && sz * askPx + 1e-12 >= minUsd) ask = { price: askPx, size: sz };
    else why.push('open-below-min');
  }
  return { bid, ask, why: why.join(',') || 'ok', shortUsd, room };
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
  console.log('kraken short book pairs=' + book.length + ' live=' + live + ' lev=' + (process.env.MARGIN_LEVERAGE || 2) + ' clip=$' + clip);
  if (!live) console.log('  dry run. set DRY_RUN=0 and SHORT_LIVE=1 to send orders');
  let ranked = [];
  let rankedAt = 0;
  while (true) {
    try {
      const pos = await marginPos(cfg);
      const orders = await ourOrders(cfg);
      const equity = await tradeEquity(cfg);
      const heldSyms = new Set();
      for (const r of book) {
        const p = posFor(pos, r);
        if (p.short > 0 || p.long > 0) heldSyms.add(r.symbol);
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
        const preview = ranked.filter((r) => r.ret15 < openRet && r.range >= enter).slice(0, maxPairs);
        console.log('  scan down ' + (preview.map((r) => r.symbol + ' ' + (r.ret15 * 100).toFixed(2) + '%').join(', ') || '-'));
      }
      const active = [];
      for (const r of ranked) {
        if (!(r.ret15 < openRet && r.range >= enter)) continue;
        if (active.length >= maxPairs) break;
        active.push(r);
      }
      for (const r of book) {
        if (heldSyms.has(r.symbol) && !active.some((a) => a.symbol === r.symbol)) {
          active.push(ranked.find((x) => x.symbol === r.symbol) || r);
        }
      }
      let shortUsd = 0;
      const downSyms = new Set(active.filter((r) => r.ret15 < openRet && r.range >= enter).map((r) => r.symbol));
      for (const r of active) {
        const snap = ranked.find((x) => x.symbol === r.symbol) || r;
        const mid = Number(snap.mid || snap.last || 0);
        if (!(mid > 0)) continue;
        const p = posFor(pos, r);
        const mine = ordersFor(orders, r);
        const bidOpen = mine.some((o) => o.side === 'buy');
        const askOpen = mine.some((o) => o.side === 'sell');
        const q = decideQuote({
          mid, half, clipUsd: clip, equity, capFrac, shortQty: p.short, longQty: p.long,
          ret15: downSyms.has(r.symbol) ? snap.ret15 : null,
          bidOpen, askOpen, minUsd, ordermin: r.ordermin, lotDecimals: r.lotDecimals, pairDecimals: r.pairDecimals, openRet,
        });
        shortUsd += p.short * mid;
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
      console.log('  SHORT equity=$' + equity.toFixed(2) + ' short=$' + shortUsd.toFixed(2) + ' names=' + (active.map((r) => r.symbol).join(',') || '-') + (live ? '' : ' dry'));
    } catch (e) {
      console.warn('short loop', e.message);
    }
    await sleep(envNum('SHORT_LOOP_MS', 15000));
  }
}

async function send(ex, row, side, order, live) {
  const tag = (live ? '  ' : '  DRY ') + side.toUpperCase() + ' ' + row.symbol + ' ' + order.size + ' @ ' + order.price;
  console.log(tag);
  if (!live) return;
  const r = await ex.limitOrder(row.pair, side, order.price, order.size, {
    level: 1, userref: USERREF, marginShort: side === 'sell',
  }, 'kraken');
  if (!r || !r.order_id) console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + (r && (r.error || r.skipped) || 'no id'));
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
