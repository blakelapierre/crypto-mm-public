import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, envBool, envNum } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { krakenPrivate, krakenPublic } from '../../shared/kraken.js';
import { noteMid } from '../../shared/mid-ring.js';
import { formatPrice, normalizeAsset } from '../../shared/sizing.js';

// Kraken directional book. Both sides use max margin, so a position ties up notional/leverage.
// Up or flat over the trailing 15 minutes: a bid opens or adds a long, an ask only
// closes it. Down: an ask opens or adds a short, a bid only covers it.
// A name cannot flip until that position is flat. Spot coins are not inventory.
// They are sold for USD, which is how an XLM deposit becomes collateral.
const USERREF = 20261007;
const blocked = new Set();
let forceRank = false;

function blockedFile() {
  return path.join(process.cwd(), 'logs', 'margin-reduce-only.json');
}

function loadBlocked() {
  try {
    for (const s of JSON.parse(fs.readFileSync(blockedFile(), 'utf8'))) blocked.add(s);
  } catch { /* none yet */ }
}

function blockSymbol(symbol) {
  if (!symbol || blocked.has(symbol)) return;
  blocked.add(symbol);
  forceRank = true;
  try {
    fs.mkdirSync(path.dirname(blockedFile()), { recursive: true });
    fs.writeFileSync(blockedFile(), JSON.stringify([...blocked]));
  } catch { /* keep it in memory */ }
  console.log('  block ' + symbol + ' reduce-only');
}

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

function targetUsd(clip, venueMin, room, freeMargin, lev) {
  const ceiling = Math.min(room, freeMargin * lev * 0.9);
  const want = Math.max(clip, venueMin);
  if (want <= ceiling + 1e-9) return want;
  return ceiling + 1e-9 >= venueMin ? ceiling : 0;
}

function okSize(sz, px, ordermin, minUsd, qtyCap) {
  if (!(sz > 0) || !(px > 0)) return false;
  if (sz + 1e-12 < ordermin) return false;
  if (sz * px + 1e-12 < minUsd) return false;
  if (qtyCap != null && sz > qtyCap + 1e-12) return false;
  return true;
}

// signal is 'long', 'short', or null. null only works an exit.
// Both opens use leverage 2. A closing order is never larger than the position.
export function decideBook(x) {
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
  const lev = Number(x.leverage) || 2;
  const longLev = x.longLeverage == null ? lev : Number(x.longLeverage);
  const canShort = x.canShort !== false;
  const freeQuote = x.freeQuote == null ? Infinity : Math.max(0, Number(x.freeQuote) || 0);
  const canLong = x.canLong !== false;
  const freeMargin = x.freeMargin == null ? Infinity : Math.max(0, Number(x.freeMargin) || 0);
  const signal = x.signal === 'long' || x.signal === 'short' ? x.signal : null;
  if (!(mid > 0) || !(half > 0)) return { bid: null, ask: null, why: 'no-mid' };
  // The US book rounds to the nearest cent. A buy that rounds up crosses and is canceled.
  const tick = 0.01;
  const bidPx = formatPrice(Math.floor((mid * (1 - half)) / tick + 1e-8) * tick, 8);
  const askPx = formatPrice(Math.ceil((mid * (1 + half)) / tick - 1e-8) * tick, 8);
  const why = [];
  let bid = null;
  let ask = null;
  if (shortQty > 0 && longQty > 0) why.push('both');
  if (shortQty > 0) {
    const sz = clipSize(clip, bidPx, shortQty, lot, null);
    if (okSize(sz, bidPx, ordermin, minUsd, shortQty)) bid = { price: bidPx, size: sz, leverage: lev, marginShort: false, role: 'cover' };
    else why.push('cover-below-min');
  }
  if (longQty > 0 && shortQty <= 0) {
    const exitLev = longLev >= 2 ? lev : 0;
    const need = Math.max(clip, ordermin * askPx);
    const sz = clipSize(Math.min(need, longQty * askPx), askPx, longQty, lot, null);
    if (okSize(sz, askPx, ordermin, minUsd, longQty)) ask = { price: askPx, size: sz, leverage: exitLev, marginClose: exitLev >= 2, role: 'close' };
    else why.push('close-below-min');
  }
  const shortRoom = cap - shortQty * mid;
  const longRoom = cap - longQty * mid;
  const affordable = (usd) => usd / lev <= freeMargin * 0.9 + 1e-9;
  const openAskMin = Math.max(minUsd, ordermin * askPx);
  const openBidMin = Math.max(minUsd, ordermin * bidPx);
  if (canShort && longQty <= 0 && signal === 'short' && shortRoom >= openAskMin) {
    const use = targetUsd(clip, openAskMin, shortRoom, freeMargin, lev);
    const sz = clipSize(use, askPx, null, lot, null);
    if (use >= openAskMin && affordable(sz * askPx) && okSize(sz, askPx, ordermin, minUsd, null)) ask = { price: askPx, size: sz, leverage: lev, marginShort: true, role: 'short' };
    else why.push(use > 0 ? (shortQty > 0 ? 'add-below-min' : 'open-below-min') : 'min-over-cap');
  } else if (canShort && longQty <= 0 && signal === 'short') why.push('min-over-cap');
  else if (!canShort && signal === 'short' && shortQty <= 0 && longQty <= 0) why.push('no-margin');
  if (shortQty <= 0 && canLong && signal === 'long' && longRoom >= openBidMin) {
    const cash = longLev >= 2 ? freeMargin * lev * 0.9 : freeQuote * 0.98;
    const use = targetUsd(clip, openBidMin, longRoom, cash, longLev >= 2 ? lev : 1);
    const sz = clipSize(use, bidPx, null, lot, null);
    const fitsCash = longLev >= 2 || sz * bidPx <= freeQuote * 0.98 + 1e-9;
    if (use >= openBidMin && fitsCash && okSize(sz, bidPx, ordermin, minUsd, null)) bid = { price: bidPx, size: sz, leverage: longLev, marginShort: false, role: 'long' };
    else why.push(use > 0 ? 'bid-below-min' : 'min-over-cap');
  } else if (shortQty <= 0 && canLong && signal === 'long') why.push('min-over-cap');
  if (shortQty > 0 && signal !== 'short') why.push('flatten-short');
  if (longQty > 0 && signal === 'short') why.push('flatten-long');
  if (!canLong && signal === 'long' && longQty <= 0) why.push('no-long-margin');
  if (!signal) why.push('no-signal');
  return { bid, ask, why: why.filter(Boolean).join(',') || 'ok' };
}

function rolling15(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const start = Math.floor(Date.now() / 1000) - 15 * 60;
  const window = rows.filter((c) => Number(c[0]) >= start);
  if (window.length < 2) return null;
  const open = Number(window[0][1]);
  const close = Number(window[window.length - 1][4]);
  let high = 0;
  let low = Infinity;
  for (const c of window) {
    high = Math.max(high, Number(c[2]));
    const lo = Number(c[3]);
    if (lo > 0) low = Math.min(low, lo);
  }
  if (!(open > 0) || !(close > 0) || !(high >= low) || !Number.isFinite(low)) return null;
  return { ret: (close - open) / open, range: (high - low) / close, mid: close };
}

async function marginAllowed(cfg, row) {
  if (blocked.has(row.symbol)) return false;
  const px = Number(row.last || row.mid || 0);
  const vol = Math.max(Number(row.ordermin) || 0, px > 0 ? 1 / px : 0);
  if (!(px > 0) || !(vol > 0)) return true;
  try {
    await krakenPrivate(cfg, 'AddOrder', {
      pair: row.orderPair || row.pair, type: 'buy', ordertype: 'limit', leverage: String(row.maxLev || 2), oflags: 'post', validate: true,
      price: String(formatPrice(px * 0.5, row.pairDecimals)), volume: String(vol),
    });
    return true;
  } catch (e) {
    if (/reduce only/i.test(e.message)) { blockSymbol(row.symbol); return false; }
    return true;
  }
}

async function ohlc15(pair) {
  const data = await krakenPublic('OHLC', { pair, interval: 1 });
  const key = Object.keys(data || {}).find((k) => k !== 'last');
  return rolling15(key ? data[key] : null);
}

async function spotBalances(cfg) {
  const r = await krakenPrivate(cfg, 'Balance');
  const out = {};
  for (const [k, v] of Object.entries(r || {})) out[normalizeAsset(k)] = Number(v) || 0;
  return out;
}

const CASH = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF']);

async function tradeState(cfg) {
  const r = await krakenPrivate(cfg, 'TradeBalance', { asset: 'ZUSD' });
  return {
    equity: Number((r && (r.eb || r.e)) || 0),
    freeMargin: Number((r && r.mf) || 0),
  };
}

async function sweepSpot(cfg, products, bals, live) {
  const held = Object.entries(bals).filter(([s, q]) => q > 0 && s === 'XLM' && products[s]);
  if (!held.length) return;
  let tick = {};
  try { tick = await krakenPublic('Ticker', { pair: held.map(([s]) => products[s].pair).join(',') }); }
  catch (e) { console.warn('sweep ticker', e.message); return; }
  for (const [symbol, qty] of held) {
    const row = products[symbol];
    const t = tick[row.pair] || tick[row.altname];
    const bid = t && t.b ? Number(t.b[0]) : 0;
    if (!(bid > 0)) continue;
    const sz = floorVol(qty, row.lotDecimals);
    if (!okSize(sz, bid, row.ordermin, 0.5, qty)) {
      if (sz * bid >= 0.5) console.log('  SWEEP skip ' + symbol + ' ' + sz + ' below min');
      continue;
    }
    console.log((live ? '  SWEEP ' : '  DRY SWEEP ') + symbol + ' ' + sz + ' ~$' + (sz * bid).toFixed(2));
    if (!live) continue;
    try {
      const r = await krakenPrivate(cfg, 'AddOrder', { pair: row.pair, type: 'sell', ordertype: 'market', volume: String(sz), userref: String(USERREF) });
      console.log('  SWEEP ok ' + symbol + ' ' + ((r && r.txid && r.txid[0]) || ''));
    } catch (e) { console.log('  SWEEP reject ' + symbol + ' ' + e.message); }
  }
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
      leverage: Number(String(d.leverage || '').split(':')[0]) || 0,
    });
  }
  return out;
}

function posFor(pos, rec) {
  const btnl = rec.orderPair || (rec.altname ? rec.altname + ':BTNL' : null);
  return pos.get(rec.pair) || pos.get(rec.altname) || (btnl && pos.get(btnl)) || pos.get(rec.wsname) || { short: 0, long: 0 };
}

function ordersFor(orders, rec) {
  const btnl = rec.orderPair || (rec.altname ? rec.altname + ':BTNL' : null);
  const keys = new Set([rec.pair, rec.altname, rec.wsname, rec.symbol, btnl, rec.wsname && String(rec.wsname).replace('/', '')].filter(Boolean));
  return orders.filter((o) => keys.has(o.pair));
}

const seenCancels = new Set();
let cancelSince = Math.floor(Date.now() / 1000) - 24 * 3600;

function cancelLogPath() {
  return path.join(process.cwd(), 'logs', 'kraken-cancels.jsonl');
}

function loadSeenCancels() {
  try {
    for (const line of fs.readFileSync(cancelLogPath(), 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.id) seenCancels.add(row.id);
    }
  } catch { /* none yet */ }
}

function noteCancel(row) {
  if (!row || !row.id || seenCancels.has(row.id)) return;
  seenCancels.add(row.id);
  try {
    fs.mkdirSync(path.dirname(cancelLogPath()), { recursive: true });
    fs.appendFileSync(cancelLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
  } catch (e) { console.warn('cancel log', e.message); }
  console.log('  CANCELLED ' + (row.why || row.reason || '') + ' ' + row.side + ' ' + (row.symbol || row.pair) + ' @ ' + row.price);
}

async function ingestClosed(cfg, pages) {
  let ofs = 0;
  let newest = cancelSince;
  for (let page = 0; page < pages; page++) {
    const r = await krakenPrivate(cfg, 'ClosedOrders', { start: cancelSince, ofs });
    const rows = Object.entries((r && r.closed) || {});
    if (!rows.length) break;
    for (const [id, o] of rows) {
      const tm = Number(o.closetm || o.opentm || 0);
      if (tm > newest) newest = tm;
      const st = String(o.status || '');
      if (st !== 'canceled' && st !== 'cancelled' && st !== 'expired') continue;
      const d = o.descr || {};
      const reason = o.reason || '';
      const why = /post only/i.test(reason) ? 'post-only' : (/user requested/i.test(reason) ? 'user' : (reason || st));
      noteCancel({
        id, pair: d.pair, side: String(d.type || '').toLowerCase(), price: Number(d.price || 0),
        size: Number(o.vol || 0), leverage: Number(String(d.leverage || '').split(':')[0]) || 0,
        status: st, reason, why, userref: o.userref || '', opentm: o.opentm || null, closetm: o.closetm || null,
      });
    }
    if (rows.length < 50) break;
    ofs += rows.length;
  }
  cancelSince = Math.max(cancelSince, Math.floor(newest) - 120);
}

// US retail margin is a different book from the international pairs. The order
// pair is the altname plus :BTNL. The plain pair returns Reduce only:Non-ECP.
const US_LEV = {
  BTC: 20, ETH: 20,
  ADA: 10, AVAX: 10, DOGE: 10, LINK: 10, LTC: 10, SOL: 10, SUI: 10, XRP: 10,
  AAVE: 5, ALGO: 5, BCH: 5, CRV: 5, DOT: 5, HBAR: 5, HYPE: 5, NEAR: 5, PEPE: 5, PAXG: 5, RENDER: 5, SHIB: 5, TRX: 5, UNI: 5, XLM: 5, ZEC: 5,
  PENGU: 3,
};

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
  // A resting order stays until the signal flips or the mid leaves it behind.
  // Chasing the target by a few bps was cancelling bids that the mid then traded.
  const hold = envNum('HOLD_BPS', 200) / 10000;
  const longRaw = String(process.env.MARGIN_LONG ?? 'max').trim().toLowerCase();
  const useMaxLev = longRaw === 'max';
  const longLev = useMaxLev ? 2 : envNum('MARGIN_LONG', 0);
  const marginLongs = useMaxLev || longLev >= 2;
  const canShort = envBool('MARGIN_SHORT', false);
  const useMargin = canShort || marginLongs;
  const levFor = (row) => {
    const max = Number(row.maxLev) || 2;
    if (useMaxLev) return max;
    return longLev >= 2 ? Math.min(longLev, max) : max;
  };
  loadBlocked();
  const ex = createExchange(cfg, new Map());
  if (!cfg.krakenApiKey || !cfg.krakenApiSecret) throw new Error('Missing Kraken keys');
  const products = await ex.getProducts('kraken');
  let handsOff = new Set();
  try {
    const existing = await marginPos(cfg);
    for (const [pair, p] of existing) {
      if ((p.long > 0 || p.short > 0) && String(pair).startsWith('XBT')) handsOff.add('BTC');
    }
  } catch (e) { console.warn('positions', e.message); }
  const book = Object.entries(products)
    .filter(([symbol]) => US_LEV[symbol] && !handsOff.has(symbol))
    .map(([symbol, r]) => ({ ...r, symbol, maxLev: US_LEV[symbol], orderPair: (r.altname || symbol + 'USD') + ':BTNL' }));
  console.log('kraken book pairs=' + book.length + ' live=' + live + ' clip=$' + clip + ' long=' + (useMaxLev ? 'max' : (marginLongs ? longLev + 'x' : 'spot')) + ' short=' + (canShort ? 'max' : 'off'));
  if (handsOff.has('BTC')) console.log('  leaving the open BTC long alone');
  if (!useMargin) console.log('  margin opens are refused on this account (Non-ECP). longs are spot');
  if (!live) console.log('  dry run. set DRY_RUN=0 and SHORT_LIVE=1 to send orders');
  loadSeenCancels();
  let ranked = [];
  let rankedAt = 0;
  let cancelBoot = true;
  while (true) {
    try {
      const pos = await marginPos(cfg);
      const orders = await ourOrders(cfg);
      await ingestClosed(cfg, cancelBoot ? 20 : 2);
      cancelBoot = false;
      const acct = await tradeState(cfg);
      const equity = acct.equity;
      const freeMargin = acct.freeMargin;
      const bals = await spotBalances(cfg);
      let reservedBids = 0;
      for (const o of orders) if (o.side === 'buy') reservedBids += Number(o.price) * Number(o.size);
      const freeQuote = Math.max(0, Number(bals.USD || 0) - reservedBids);
      await sweepSpot(cfg, products, bals, live);
      const heldSyms = new Set();
      for (const r of book) {
        const p = posFor(pos, r);
        const mark = Number((ranked.find((x) => x.symbol === r.symbol) || {}).mid || 0);
        const spotUsd = marginLongs ? 0 : Number(bals[r.symbol] || 0) * mark;
        if (p.short > 0 || p.long > 0 || spotUsd >= minUsd) heldSyms.add(r.symbol);
      }
      if (forceRank || Date.now() - rankedAt > 60000 || !ranked.length) {
        forceRank = false;
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
        const capUsd = equity * capFrac;
        const fit = (r) => {
          const need = Math.max(minUsd, (Number(r.ordermin) || 0) * r.last);
          const budget = useMargin ? freeMargin * (Number(r.maxLev) || 2) * 0.9 : freeQuote;
          return need <= capUsd + 1e-9 && need <= budget + 1e-9;
        };
        const affordable = scored.filter((r) => r.dayRange > 0 && fit(r) && !(useMargin && blocked.has(r.symbol)));
        const top = affordable.slice(0, Math.max(maxPairs * 4, 12));
        console.log('  universe affordable=' + affordable.length + ' cap=$' + capUsd.toFixed(2));
        for (const r of book) if (heldSyms.has(r.symbol) && !top.some((t) => t.symbol === r.symbol)) top.push(r);
        ranked = [];
        for (const r of top) {
          let bar = null;
          try { bar = await ohlc15(r.pair); } catch (e) { console.warn('ohlc', r.symbol, e.message); }
          await sleep(200);
          if (!bar) continue;
          if (useMargin && !(await marginAllowed(cfg, { ...r, last: bar.mid }))) continue;
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
      const tradable = ranked.filter((r) => {
        if (useMargin && blocked.has(r.symbol)) return false;
        if (!(r.range >= enter) || r.ret15 == null) return false;
        if (!canShort && !(r.ret15 >= openRet)) return false;
        return true;
      }).sort((a, b) => b.range - a.range);
      for (const r of tradable) {
        if (active.length >= maxPairs) break;
        active.push(r);
      }
      for (const r of book) {
        if (heldSyms.has(r.symbol) && !active.some((a) => a.symbol === r.symbol)) {
          active.push(ranked.find((x) => x.symbol === r.symbol) || r);
        }
      }
      const activeSyms = new Set(active.map((r) => r.symbol));
      for (const r of book) {
        if (activeSyms.has(r.symbol) || heldSyms.has(r.symbol)) continue;
        for (const o of ordersFor(orders, r)) {
          if (live) {
            try {
              await ex.cancelOrder(o.id, 'kraken');
              noteCancel({ id: o.id, pair: o.pair, symbol: r.symbol, side: o.side, price: o.price, size: o.size, leverage: o.leverage, why: 'stale' });
            } catch { /* ignore */ }
          }
        }
      }
      const knownIds = new Set(book.flatMap((r) => ordersFor(orders, r).map((o) => o.id)));
      for (const o of orders) {
        if (knownIds.has(o.id)) continue;
        if (live) {
          try {
            await ex.cancelOrder(o.id, 'kraken');
            noteCancel({ id: o.id, pair: o.pair, side: o.side, price: o.price, size: o.size, leverage: o.leverage, why: 'leftover' });
          } catch { /* ignore */ }
        }
      }
      let marginLeft = freeMargin;
      let shortUsd = 0;
      let longUsd = 0;
      for (const r of active) {
        const snap = ranked.find((x) => x.symbol === r.symbol) || r;
        const mid = Number(snap.mid || snap.last || 0);
        if (!(mid > 0)) continue;
        const p = posFor(pos, r);
        const spotQty = Number(bals[r.symbol] || 0);
        const lev = levFor(r);
        const longQty = marginLongs ? p.long : spotQty;
        const signal = snap.ret15 == null ? null : (snap.ret15 < openRet ? 'short' : 'long');
        const mine = ordersFor(orders, r);
        let bidOpen = mine.some((o) => o.side === 'buy');
        let askOpen = mine.some((o) => o.side === 'sell');
        const q = decideBook({
          mid, half, clipUsd: clip, equity, capFrac, freeMargin: marginLeft, freeQuote, leverage: lev, longLeverage: lev, canShort,
          canLong: marginLongs ? r.longable !== false : true,
          shortQty: p.short, longQty,
          signal, bidOpen, askOpen, minUsd, ordermin: r.ordermin, lotDecimals: r.lotDecimals, pairDecimals: r.pairDecimals,
        });
        shortUsd += p.short * mid;
        longUsd += longQty * mid;
        const sameLev = (o) => !o.leverage || o.leverage === lev;
        const near = (o) => mid > 0 && Math.abs(o.price - mid) / mid <= hold;
        for (const o of mine) {
          const keepBid = o.side === 'buy' && q.bid && sameLev(o) && o.price < mid && near(o);
          const keepAsk = o.side === 'sell' && q.ask && sameLev(o) && o.price > mid && near(o);
          if (keepBid || keepAsk) continue;
          const target = o.side === 'buy' ? (q.bid && q.bid.price) : (q.ask && q.ask.price);
          const why = !target ? 'flat' : (!sameLev(o) ? 'leverage' : ((o.side === 'buy' ? o.price >= mid : o.price <= mid) ? 'crossed' : 'far'));
          const offBps = mid > 0 ? Math.round((o.price - mid) / mid * 10000) : null;
          if (live) {
            try {
              await ex.cancelOrder(o.id, 'kraken');
              noteCancel({ id: o.id, pair: o.pair, symbol: r.symbol, side: o.side, price: o.price, size: o.size, leverage: o.leverage, why, offBps });
            } catch { /* ignore */ }
          }
          if (o.side === 'buy') bidOpen = false;
          else askOpen = false;
        }
        if (!q.bid && !q.ask) console.log('  skip ' + r.symbol + ' ' + (q.why || 'no-quote'));
        if (q.ask && !askOpen) {
          await send(ex, r, 'sell', q.ask, live);
          marginLeft -= (q.ask.size * q.ask.price) / Math.max(lev, 1);
        }
        if (q.bid && !bidOpen) {
          await send(ex, r, 'buy', q.bid, live);
          marginLeft -= (q.bid.size * q.bid.price) / Math.max(lev, 1);
        }
      }
      const names = active.map((r) => {
        const snap = ranked.find((x) => x.symbol === r.symbol);
        const dir = snap && snap.ret15 != null ? (snap.ret15 < openRet ? 'S' : 'L') : '?';
        return r.symbol + ':' + dir;
      });
      console.log('  BOOK equity=$' + equity.toFixed(2) + ' freeMargin=$' + freeMargin.toFixed(2) + ' long=$' + longUsd.toFixed(2) + ' short=$' + shortUsd.toFixed(2) + ' ' + (names.join(',') || '-') + (live ? '' : ' dry'));
    } catch (e) {
      console.warn('short loop', e.message);
    }
    await sleep(envNum('SHORT_LOOP_MS', 15000));
  }
}

async function send(ex, row, side, order, live) {
  const tag = (live ? '  ' : '  DRY ') + side.toUpperCase() + ' ' + row.symbol + ' ' + order.size + ' @ ' + order.price + ' ' + (order.leverage || 1) + 'x ' + (order.role || '');
  console.log(tag);
  if (!live) return;
  const r = await ex.limitOrder((order.leverage >= 2 && row.orderPair) ? row.orderPair : row.pair, side, order.price, order.size, {
    level: 1, userref: USERREF, marginShort: !!order.marginShort, marginClose: !!order.marginClose, leverage: order.leverage || 0,
  }, 'kraken');
  if (!r || !r.order_id) {
    const msg = String((r && (r.error || r.skipped)) || 'no id');
    console.log('  REJECT ' + row.symbol + ' ' + side + ' ' + msg);
    if (/reduce only/i.test(msg)) blockSymbol(row.symbol);
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
