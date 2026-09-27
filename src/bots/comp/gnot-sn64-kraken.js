/**
 * node src/bots/comp/gnot-sn64-kraken.js
 * loads .env then configs/comp.env (override)
 */
import crypto from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import qs from 'querystring';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

function loadEnv(file, { override = false } = {}) {
  const envPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(envPath)) { console.warn('env missing', envPath); return; }
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (override || process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
  console.log('loaded', envPath, override ? '(override)' : '');
}
loadEnv('.env', { override: false });
loadEnv('configs/comp.env', { override: true });

const envStr = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && process.env[k] !== '' && process.env[k] != null ? n : d; };
const envBool = (k, d) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const CONFIG = {
  dryRun: envBool('DRY_RUN', true),
  krakenApiKey: envStr('KRAKEN_API_KEY', ''),
  krakenApiSecret: envStr('KRAKEN_API_SECRET', ''),
  quote: envStr('QUOTE', 'USD'),
  symbols: envStr('SYMBOLS', 'GNOT,SN64').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  perSymbolFraction: envNum('PER_SYMBOL_FRACTION', 0.5),
  perSymbolMargin: envNum('PER_SYMBOL_MARGIN', 0.01),
  invFractionOfCap: envNum('INV_FRACTION', 0.5),
  mmLevels: envNum('MM_LEVELS', 1),
  mmSpreadBps: envNum('MM_SPREAD_BPS', 8),
  joinTouch: envBool('JOIN_TOUCH', true),
  requoteMoveBps: envNum('REQUOTE_MOVE_BPS', 8),
  postOnly: envBool('POST_ONLY', true),
  cancelAllOrdersOnStartup: envBool('CANCEL_ALL_ORDERS_ON_STARTUP', true),
  orderPollMs: envNum('ORDER_POLL_MS', 2500),
  updateIntervalMs: envNum('UPDATE_INTERVAL_MS', 2000),
  minOrderUsd: envNum('MIN_ORDER_USD', 1),
  volumeSafetyMargin: envNum('VOLUME_SAFETY_MARGIN', 1.05),
  rateLimitMs: envNum('RATE_LIMIT_MS', 400),
  capitalSafetyMargin: envNum('CAPITAL_SAFETY_MARGIN', 0.92),
  orderSizeHaircut: envNum('ORDER_SIZE_HAIRCUT', 0.9),
  feeBufferPct: envNum('FEE_BUFFER_PCT', 0.0026),
  settleWaitMs: envNum('SETTLE_WAIT_MS', 2500),
  cashReservePct: envNum('CASH_RESERVE_PCT', 0.12),
};

const KRAKEN_BASE = 'https://api.kraken.com';
const orderRegistry = new Map();
const pairState = new Map();
const fmtP = (p, d) => Number(Number(p).toFixed(d));
const fmtV = (v, d) => Number(Number(v).toFixed(d));
const capOf = (eq) => eq * CONFIG.perSymbolFraction * (1 - CONFIG.perSymbolMargin);
function normalizeAsset(code) {
  const a = String(code || '').toUpperCase();
  if (a === 'XXBT' || a === 'XBT') return 'BTC';
  if (a === 'ZUSD' || a === 'USD') return 'USD';
  if (a === 'XXRP') return 'XRP';
  return a;
}
function krakenSign(reqPath, postData, secret) {
  const message = qs.stringify(postData);
  const hash = crypto.createHash('sha256').update(postData.nonce + message).digest();
  const hmac = crypto.createHmac('sha512', Buffer.from(secret, 'base64'));
  hmac.update(reqPath); hmac.update(hash);
  return hmac.digest('base64');
}
async function krakenPrivate(endpoint, params = {}) {
  const reqPath = `/0/private/${endpoint}`;
  const nonce = Date.now() * 1000;
  const body = { nonce, ...params };
  const res = await fetch(KRAKEN_BASE + reqPath, {
    method: 'POST',
    headers: {
      'API-Key': CONFIG.krakenApiKey,
      'API-Sign': krakenSign(reqPath, body, CONFIG.krakenApiSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: qs.stringify(body),
  });
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(' | '));
  return data.result;
}
async function krakenPublic(endpoint, params = {}) {
  const q = qs.stringify(params);
  const res = await fetch(`${KRAKEN_BASE}/0/public/${endpoint}${q ? '?' + q : ''}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(' | '));
  return data.result;
}
async function getBook(pair) {
  const ticker = await krakenPublic('Ticker', { pair });
  const t = ticker[Object.keys(ticker)[0]];
  const bid = parseFloat(t.b[0]); const ask = parseFloat(t.a[0]);
  return { mid: (bid + ask) / 2, bid, ask, pair };
}
async function limitOrder(pair, side, price, volume, meta = {}) {
  if (CONFIG.dryRun) {
    const id = 'dry-' + randomUUID().slice(0, 8);
    console.log(`[DRY] LIMIT ${side} ${volume} @ ${price} ${pair}`);
    orderRegistry.set(id, { pair, side, level: meta.level, status: 'open', price, size: volume });
    return { order_id: id };
  }
  try {
    const params = { pair, type: side.toLowerCase(), ordertype: 'limit', price: String(price), volume: String(volume) };
    if (CONFIG.postOnly) params.oflags = 'post';
    const r = await krakenPrivate('AddOrder', params);
    const oid = r.txid?.[0];
    if (oid) orderRegistry.set(oid, { pair, side, level: meta.level, status: 'open', price, size: volume });
    console.log(`  → LIMIT ${side} @ ${price} id=${oid || '?'}`);
    return { order_id: oid };
  } catch (e) {
    console.error('LIMIT FAIL', { pair, side, price, volume, error: e.message });
    return null;
  }
}
async function marketBuy(pair, volume) {
  if (CONFIG.dryRun) { console.log('[DRY] MARKET BUY', pair, volume); return { ok: true }; }
  return krakenPrivate('AddOrder', { pair, type: 'buy', ordertype: 'market', volume: String(volume) });
}
async function marketSell(pair, volume) {
  if (CONFIG.dryRun) { console.log('[DRY] MARKET SELL', pair, volume); return { ok: true }; }
  return krakenPrivate('AddOrder', { pair, type: 'sell', ordertype: 'market', volume: String(volume) });
}
async function cancelAll() {
  console.log('Cancel all');
  if (!CONFIG.dryRun) {
    try { console.log('Cancelled', (await krakenPrivate('CancelAll')).count ?? 0); } catch (e) { console.warn(e.message); }
  }
}
async function cancelPair(pair) {
  if (CONFIG.dryRun) {
    for (const rec of orderRegistry.values()) if (rec.pair === pair && rec.status === 'open') rec.status = 'cancelled';
    return;
  }
  const open = await krakenPrivate('OpenOrders');
  for (const [txid, order] of Object.entries(open.open || {})) {
    if (order.descr?.pair === pair || (order.descr?.order || '').includes(pair)) {
      try { await krakenPrivate('CancelOrder', { txid }); } catch { /* ignore */ }
      const rec = orderRegistry.get(txid); if (rec) rec.status = 'cancelled';
      await sleep(CONFIG.rateLimitMs);
    }
  }
}
async function getOrderStatus(orderId) {
  if (!orderId) return null;
  if (String(orderId).startsWith('dry-')) return { status: orderRegistry.get(orderId)?.status || 'open' };
  try {
    const r = await krakenPrivate('QueryOrders', { txid: orderId });
    const o = r[orderId]; if (!o) return null;
    const map = { closed: 'FILLED', open: 'OPEN', canceled: 'CANCELLED', expired: 'EXPIRED' };
    return { status: map[o.status] || String(o.status).toUpperCase() };
  } catch { return null; }
}
function markOrder(id, statusRaw) {
  const rec = orderRegistry.get(id); if (!rec) return;
  const st = String(statusRaw || '').toUpperCase();
  if (st === 'FILLED' || st === 'CLOSED') {
    if (rec.status !== 'filled') { rec.status = 'filled'; console.log('  FILL', String(id).slice(0, 8), rec.side, rec.pair); }
  } else if (['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED'].includes(st)) rec.status = 'cancelled';
}
async function pollOpenOrders() {
  for (const [id, rec] of orderRegistry) {
    if (rec.status !== 'open') continue;
    const st = await getOrderStatus(id);
    if (st?.status) markOrder(id, st.status);
    await sleep(80);
  }
}
async function resolvePairs() {
  const pairs = await krakenPublic('AssetPairs');
  const out = [];
  for (const sym of CONFIG.symbols) {
    let found = null;
    for (const [k, v] of Object.entries(pairs)) {
      const b = normalizeAsset(v.base || '');
      const q = normalizeAsset(v.quote || '');
      const alt = String(v.altname || '').toUpperCase();
      if ((b === sym && q === CONFIG.quote) || alt === `${sym}${CONFIG.quote}` || alt === `${sym}/${CONFIG.quote}`) {
        found = { symbol: sym, pair: k, pairDecimals: v.pair_decimals ?? 5, lotDecimals: v.lot_decimals ?? 8, ordermin: parseFloat(v.ordermin || '0') || 0 };
        break;
      }
    }
    if (found) { console.log('Resolved', sym, found.pair); out.push(found); }
    else console.warn('No pair', sym, CONFIG.quote);
  }
  if (!out.length) throw new Error('No competition pairs');
  return out;
}
async function snapshot(markets) {
  const bal = await krakenPrivate('Balance');
  let freeQuote = 0; const raw = {};
  for (const [asset, s] of Object.entries(bal || {})) {
    const amt = parseFloat(s) || 0; if (amt <= 0) continue;
    const n = normalizeAsset(asset);
    if (n === CONFIG.quote || asset === 'Z' + CONFIG.quote) { freeQuote += amt; continue; }
    raw[n] = (raw[n] || 0) + amt;
  }
  const positions = {}; let positionsValue = 0;
  for (const m of markets) {
    const amt = raw[m.symbol] || 0;
    const book = await getBook(m.pair); if (!book) continue;
    const value = amt * book.mid;
    positions[m.symbol] = { amount: amt, mid: book.mid, valueQuote: value };
    positionsValue += value;
  }
  return { freeQuote, positions, positionsValue, totalEquity: freeQuote + positionsValue };
}
function workingIds(pair, side) {
  const st = pairState.get(pair); const ids = new Set();
  if (!st?.ladder) return ids;
  for (const o of side === 'sell' ? st.ladder.sells : st.ladder.buys) {
    if (o.status === 'open' && o.orderId) ids.add(o.orderId);
  }
  return ids;
}
function workingSellSize(pair) {
  const ids = workingIds(pair, 'sell'); let n = 0;
  for (const [id, rec] of orderRegistry) {
    if (rec.pair !== pair || rec.side !== 'sell' || rec.status !== 'open') continue;
    if (ids.size && !ids.has(id)) continue;
    n += Number(rec.size) || 0;
  }
  return n;
}
function workingBuyNotional(pair) {
  const ids = workingIds(pair, 'buy'); let n = 0;
  for (const [id, rec] of orderRegistry) {
    if (rec.pair !== pair || rec.side !== 'buy' || rec.status !== 'open') continue;
    if (ids.size && !ids.has(id)) continue;
    n += Number(rec.price) * Number(rec.size);
  }
  return n;
}
function spendableCash(q) { return Math.max(0, q * (1 - CONFIG.cashReservePct)); }
function resizeBuy(m, price, wantSize, live) {
  const cap = capOf(live.totalEquity);
  const held = live.positions[m.symbol]?.valueQuote || 0;
  const cashRoom = Math.min(spendableCash(live.freeQuote), live.freeQuote);
  const capRoom = Math.max(0, cap - held - workingBuyNotional(m.pair));
  const useUsd = Math.min(price * wantSize, Math.min(capRoom, cashRoom) * CONFIG.orderSizeHaircut);
  if (useUsd <= 0 || price <= 0) return 0;
  let size = fmtV(useUsd / price, m.lotDecimals);
  const minV = (m.ordermin || 0) * CONFIG.volumeSafetyMargin;
  if (size + 1e-12 < minV) return minV * price <= cashRoom && minV * price <= capRoom ? fmtV(minV, m.lotDecimals) : 0;
  return size;
}
function resizeSell(m, wantSize, live) {
  const heldAmt = live.positions[m.symbol]?.amount || 0;
  const freeBase = Math.max(0, heldAmt - workingSellSize(m.pair));
  const minV = (m.ordermin || 0) * CONFIG.volumeSafetyMargin;
  const size = fmtV(Math.min(wantSize, freeBase), m.lotDecimals);
  if (size + 1e-12 < minV) return freeBase + 1e-12 >= minV ? fmtV(Math.min(freeBase, wantSize), m.lotDecimals) : 0;
  return size;
}
function generateLadder(book, sizeUsd, pairDecimals, lotDecimals, ordermin) {
  const mid = book.mid; const step = CONFIG.mmSpreadBps / 10000;
  const tick = Number((10 ** -pairDecimals).toFixed(pairDecimals));
  let bid1 = CONFIG.joinTouch && book.bid ? book.bid : mid * (1 - step);
  let ask1 = CONFIG.joinTouch && book.ask ? book.ask : mid * (1 + step);
  if (bid1 >= ask1) { bid1 = mid - tick; ask1 = mid + tick; }
  const buys = []; const sells = [];
  const per = Math.max(sizeUsd, 0.01);
  for (let i = 1; i <= CONFIG.mmLevels; i++) {
    let v = per / mid; const minV = (ordermin || 0) * CONFIG.volumeSafetyMargin; if (v < minV) v = minV;
    const size = fmtV(v, lotDecimals);
    buys.push({ level: i, side: 'buy', price: fmtP(i === 1 ? bid1 : bid1 * (1 - (i - 1) * step), pairDecimals), size, orderId: null, status: 'pending' });
    sells.push({ level: i, side: 'sell', price: fmtP(i === 1 ? ask1 : ask1 * (1 + (i - 1) * step), pairDecimals), size, orderId: null, status: 'pending' });
  }
  return { buys, sells, mid };
}
function syncLadder(ladder) {
  let any = false;
  for (const leg of [...ladder.buys, ...ladder.sells]) {
    if (!leg.orderId) continue;
    const rec = orderRegistry.get(leg.orderId); if (!rec) continue;
    if (rec.status === 'filled' && leg.status !== 'filled') { leg.status = 'filled'; any = true; }
    else if (rec.status === 'cancelled') leg.status = 'cancelled';
    else if (rec.status === 'open') leg.status = 'open';
  }
  return any;
}
function printLadder(symbol, pair, ladder, book) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${symbol} ${pair} mid=${book.mid.toFixed(6)}`);
  for (const o of ladder.buys) console.log(`  BUY  L${o.level} ${o.size} @ ${o.price} [${o.status}]`);
  for (const o of ladder.sells) console.log(`  SELL L${o.level} ${o.size} @ ${o.price} [${o.status}]`);
}
async function placeLadder(m, ladder, markets) {
  for (const o of [...ladder.buys, ...ladder.sells]) {
    const live = await snapshot(markets);
    const resized = o.side === 'buy' ? resizeBuy(m, o.price, o.size, live) : resizeSell(m, o.size, live);
    if (!resized) { o.status = 'pending'; console.log(`  ${o.side} L${o.level} pending resize`); continue; }
    o.size = resized;
    const r = await limitOrder(m.pair, o.side, o.price, o.size, { level: o.level });
    o.orderId = r?.order_id || null; o.status = r?.order_id ? 'open' : 'pending';
    await sleep(CONFIG.rateLimitMs);
  }
}
async function ensureBothSides(m, ladder, book, markets) {
  const live = await snapshot(markets);
  const openS = ladder.sells.some((o) => o.status === 'open');
  const pendS = ladder.sells.some((o) => o.status === 'pending');
  const openB = ladder.buys.some((o) => o.status === 'open');
  const pendB = ladder.buys.some((o) => o.status === 'pending');
  if (!openS && !pendS) {
    const size = resizeSell(m, 1e12, live);
    if (size) {
      const price = fmtP(book.ask || book.mid * 1.0008, m.pairDecimals);
      console.log('  ENSURE SELL', m.symbol, size, '@', price);
      const r = await limitOrder(m.pair, 'sell', price, size, { level: 1 });
      ladder.sells.push({ level: 1, side: 'sell', price, size, orderId: r?.order_id || null, status: r?.order_id ? 'open' : 'pending' });
    } else console.log('  ENSURE SELL skip', m.symbol, 'held', live.positions[m.symbol]?.amount || 0);
  }
  if (!openB && !pendB) {
    const price = fmtP(book.bid || book.mid * 0.9992, m.pairDecimals);
    const size = resizeBuy(m, price, 1e12, live);
    if (size) {
      console.log('  ENSURE BUY', m.symbol, size, '@', price);
      const r = await limitOrder(m.pair, 'buy', price, size, { level: 1 });
      ladder.buys.push({ level: 1, side: 'buy', price, size, orderId: r?.order_id || null, status: r?.order_id ? 'open' : 'pending' });
    }
  }
}
async function retryPending(m, ladder, markets) {
  let placed = false;
  for (const o of [...ladder.buys, ...ladder.sells]) {
    if (o.status === 'cancelled') o.status = 'pending';
    if (o.status !== 'pending') continue;
    const live = await snapshot(markets);
    const resized = o.side === 'buy' ? resizeBuy(m, o.price, o.size || 1, live) : resizeSell(m, o.size, live);
    if (!resized) continue;
    o.size = resized;
    const r = await limitOrder(m.pair, o.side, o.price, o.size, { level: o.level });
    if (r?.order_id) { o.orderId = r.order_id; o.status = 'open'; placed = true; }
    await sleep(CONFIG.rateLimitMs);
  }
  return placed;
}
function levelSize(live, markets) {
  const cap = capOf(live.totalEquity);
  const fromCap = ((cap * (1 - CONFIG.invFractionOfCap)) / CONFIG.mmLevels) * CONFIG.orderSizeHaircut;
  const fromCash = (spendableCash(live.freeQuote) / Math.max(1, markets.length * CONFIG.mmLevels)) * CONFIG.orderSizeHaircut;
  return Math.min(fromCap, fromCash);
}
async function seedInventory(markets) {
  console.log('\nSeed inventory');
  for (const m of markets) {
    const live = await snapshot(markets);
    const invTarget = capOf(live.totalEquity) * CONFIG.invFractionOfCap;
    const held = live.positions[m.symbol]?.valueQuote || 0;
    const heldAmt = live.positions[m.symbol]?.amount || 0;
    const book = await getBook(m.pair); if (!book) continue;
    console.log(m.symbol, 'held', held.toFixed(2), 'targetInv', invTarget.toFixed(2), 'cash', live.freeQuote.toFixed(4));
    if (held > invTarget + 0.5 && heldAmt > 0) {
      const sellAmt = fmtV(heldAmt * ((held - invTarget) / held), m.lotDecimals);
      if (sellAmt >= (m.ordermin || 0) * CONFIG.volumeSafetyMargin) {
        console.log('  MARKET SELL', sellAmt); await marketSell(m.pair, sellAmt); await sleep(CONFIG.settleWaitMs);
      }
      continue;
    }
    const gap = invTarget - held;
    if (gap < 0.5) continue;
    const spend = Math.min(gap, capOf(live.totalEquity) - held, spendableCash(live.freeQuote) / markets.length * CONFIG.capitalSafetyMargin);
    if (spend < 0.5) continue;
    let vol = spend / book.ask; const minV = (m.ordermin || 0) * CONFIG.volumeSafetyMargin; if (vol < minV) vol = minV;
    vol = fmtV(vol, m.lotDecimals);
    console.log('  MARKET BUY', vol); await marketBuy(m.pair, vol); await sleep(CONFIG.settleWaitMs);
  }
}
async function processPair(m, sizeUsd, markets) {
  const book = await getBook(m.pair); if (!book) return;
  if (!pairState.has(m.pair)) {
    const live = await snapshot(markets);
    const use = levelSize(live, markets) || sizeUsd;
    const ladder = generateLadder(book, use, m.pairDecimals, m.lotDecimals, m.ordermin);
    pairState.set(m.pair, { ladder, lastMid: book.mid });
    console.log('\nInitial ladder', m.symbol, 'mid', book.mid, 'joinTouch', CONFIG.joinTouch);
    await placeLadder(m, ladder, markets);
    printLadder(m.symbol, m.pair, ladder, book);
    return;
  }
  const st = pairState.get(m.pair);
  const ladder = st.ladder;
  syncLadder(ladder);
  await retryPending(m, ladder, markets);
  await ensureBothSides(m, ladder, book, markets);
  const lastMid = st.lastMid || book.mid;
  const move = Math.abs(book.mid - lastMid) / (lastMid || book.mid);
  if (move >= CONFIG.requoteMoveBps / 10000) {
    console.log('  REQUOTE', m.symbol, lastMid, '->', book.mid);
    await cancelPair(m.pair);
    const live = await snapshot(markets);
    const next = generateLadder(book, levelSize(live, markets) || sizeUsd, m.pairDecimals, m.lotDecimals, m.ordermin);
    st.ladder = next; st.lastMid = book.mid;
    await placeLadder(m, next, markets);
    printLadder(m.symbol, m.pair, next, book);
  } else st.lastMid = book.mid;
}
async function main() {
  console.log('comp GNOT+SN64', 'QUOTE=' + CONFIG.quote, 'spread=' + CONFIG.mmSpreadBps, 'joinTouch=' + CONFIG.joinTouch, 'dryRun=' + CONFIG.dryRun);
  if (CONFIG.quote.toUpperCase() !== 'USD') throw new Error('quote must be USD');
  if (!CONFIG.krakenApiKey || !CONFIG.krakenApiSecret) throw new Error('set KRAKEN keys');
  const markets = await resolvePairs();
  if (CONFIG.cancelAllOrdersOnStartup) await cancelAll();
  let live = await snapshot(markets);
  console.log('startup cash', live.freeQuote.toFixed(4), 'pos', live.positionsValue.toFixed(2), 'eq', live.totalEquity.toFixed(2));
  await seedInventory(markets);
  live = await snapshot(markets);
  console.log('after seed cash', live.freeQuote.toFixed(4), 'pos', live.positionsValue.toFixed(2), 'eq', live.totalEquity.toFixed(2));
  const sizeUsd = levelSize(live, markets);
  (async () => { while (true) { try { await pollOpenOrders(); } catch (e) { console.warn(e.message); } await sleep(CONFIG.orderPollMs); } })();
  process.on('SIGINT', () => process.exit(0));
  while (true) {
    for (const m of markets) {
      try { await processPair(m, sizeUsd, markets); } catch (e) { console.error(m.symbol, e.message); }
      await sleep(CONFIG.rateLimitMs);
    }
    await sleep(CONFIG.updateIntervalMs);
  }
}
main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
