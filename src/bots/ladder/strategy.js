import { setTimeout as sleep } from 'timers/promises';
import { formatPrice, calculateVolume, formatVolume } from '../../shared/sizing.js';
import { applySpreadFromFees, joinTouchForPair } from '../../shared/fee-spread.js';
import { sizeWeightForSymbol } from '../../shared/vol-scan.js';

export function generateLadder(cfg, mid, sizeUsd, pairDecimals, lotDecimals, ordermin, book = null, pair = null) {
  const bps = applySpreadFromFees(cfg, pair);
  const step = bps / 10000;
  const tick = Number((10 ** -pairDecimals).toFixed(pairDecimals));
  const useBook = joinTouchForPair(cfg, pair) && book && book.bid && book.ask;
  let bid1 = useBook ? book.bid : mid * (1 - step);
  let ask1 = useBook ? book.ask : mid * (1 + step);
  if (bid1 >= ask1) { bid1 = mid - tick; ask1 = mid + tick; }
  const buys = []; const sells = [];
  for (let i = 1; i <= cfg.mmLevels; i++) {
    const size = calculateVolume(cfg, mid, sizeUsd, ordermin, lotDecimals);
    const buyPx = i === 1 ? bid1 : bid1 * (1 - (i - 1) * step);
    const sellPx = i === 1 ? ask1 : ask1 * (1 + (i - 1) * step);
    buys.push({ level: i, side: 'buy', price: formatPrice(buyPx, pairDecimals), size, orderId: null, status: 'pending' });
    sells.push({ level: i, side: 'sell', price: formatPrice(sellPx, pairDecimals), size, orderId: null, status: 'pending' });
  }
  return { buys, sells, mid };
}

export function syncLadderFromRegistry(ladder, orderRegistry) {
  let anyFilled = false;
  for (const leg of [...ladder.buys, ...ladder.sells]) {
    if (!leg.orderId) continue;
    const rec = orderRegistry.get(leg.orderId); if (!rec) continue;
    if (rec.status === 'filled' && leg.status !== 'filled') { leg.status = 'filled'; anyFilled = true; }
    else if (rec.status === 'cancelled') leg.status = 'cancelled';
    else if (rec.status === 'open') leg.status = 'open';
  }
  return anyFilled;
}

export function printLadder(symbol, pair, ladder, book) {
  const live = (o) => o.status === 'open';
  const buys = ladder.buys.filter(live);
  const sells = ladder.sells.filter(live);
  if (!buys.length && !sells.length) return;
  console.log(`\n[${new Date().toLocaleTimeString()}] ${symbol} ${pair} mid=${book.mid.toFixed(6)}`);
  for (const o of buys) console.log('  BUY  L' + o.level + ' ' + o.size + ' @ ' + o.price + '  ~$' + (Number(o.size) * Number(o.price)).toFixed(2) + '  [' + o.status + ']');
  for (const o of sells) console.log('  SELL L' + o.level + ' ' + o.size + ' @ ' + o.price + '  ~$' + (Number(o.size) * Number(o.price)).toFixed(2) + '  [' + o.status + ']');
}

function pruneDone(ladder) {
  ladder.buys = ladder.buys.filter((o) => o.status === 'open');
  ladder.sells = ladder.sells.filter((o) => o.status === 'open');
}

function resizeLeg(cfg, a, o, live) {
  if (!live) return o.size;
  const hair = cfg.orderSizeHaircut || 0.9;
  const minV = (a.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
  if (o.side === 'buy') {
    const pairs = Math.max(1, cfg.mmMaxPairs || (cfg.symbols && cfg.symbols.length) || 1);
    const w = sizeWeightForSymbol(a.symbol);
    const cashShare = (live.freeQuote * (cfg.capitalSafetyMargin || 0.92) * hair * w) / pairs;
    const useUsd = Math.min(o.price * o.size, cashShare);
    if (o.price <= 0 || useUsd <= 0) return 0;
    let size = useUsd / o.price;
    if (size + 1e-12 < minV) return minV * o.price <= live.freeQuote * hair ? formatVolume(minV, a.lotDecimals) : 0;
    return formatVolume(size, a.lotDecimals);
  }
  const held = (live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount) || 0;
  let size = Math.min(o.size, held * hair);
  if (size + 1e-12 < minV) return held >= minV ? formatVolume(Math.min(held * hair, o.size), a.lotDecimals) : 0;
  return formatVolume(size, a.lotDecimals);
}

async function cancelSide(ex, legs) {
  for (const o of legs) {
    if (o.orderId && o.status === 'open') {
      await ex.cancelOrder(o.orderId);
      o.status = 'cancelled';
    }
  }
}

async function ensureBothSides(cfg, ex, a, ladder, book, getLive = null, state = null) {
  const now = Date.now();
  if (state && now - (state.lastEnsureAt || 0) < 20000) return;
  const isOpen = (o) => o.status === 'open' && o.orderId;
  const openS = ladder.sells.some(isOpen);
  const openB = ladder.buys.some(isOpen);
  if (openS && openB) return;
  const live = getLive ? await getLive() : null;
  const template = [...ladder.sells, ...ladder.buys].find((o) => o.size > 0);
  if (!template) return;
  async function place(side, px) {
    const size = live ? resizeLeg(cfg, a, { side, price: px, size: template.size }, live) : template.size;
    if (!size) { if (state) state.lastEnsureAt = now; return; }
    console.log('  ENSURE ' + side.toUpperCase() + ' ' + a.symbol + ' ' + size + ' @ ' + px);
    const r = await ex.limitOrder(a.pair, side, px, size, { level: 1 });
    const row = { level: 1, side, price: px, size, orderId: r && r.order_id || null, status: r && r.order_id ? 'open' : 'failed' };
    if (side === 'sell') ladder.sells.push(row); else ladder.buys.push(row);
    if (!(r && r.order_id) && state) state.lastEnsureAt = Date.now();
    await sleep(cfg.rateLimitMs);
  }
  if (!openS) await place('sell', formatPrice(book.ask || book.mid, a.pairDecimals));
  if (!openB) await place('buy', formatPrice(book.bid || book.mid, a.pairDecimals));
}

export async function placeLadder(cfg, ex, pair, ladder, a = null, getLive = null) {
  for (const o of [...ladder.sells, ...ladder.buys]) {
    if (getLive && a) {
      const live = await getLive();
      const resized = resizeLeg(cfg, a, o, live);
      if (!resized) { o.status = 'failed'; console.log('  ' + o.side + ' L' + o.level + ' ' + a.symbol + ' skip'); continue; }
      if (resized !== o.size) { console.log('  ' + o.side + ' L' + o.level + ' ' + a.symbol + ' size ' + o.size + ' -> ' + resized); o.size = resized; }
    }
    const r = await ex.limitOrder(pair, o.side, o.price, o.size, { level: o.level });
    if (r && r.order_id) { o.orderId = r.order_id; o.status = 'open'; }
    else o.status = 'failed';
    await sleep(cfg.rateLimitMs);
  }
}

function nextSlidePrice(cfg, filledLeg, pairDecimals, pair) {
  const step = applySpreadFromFees(cfg, pair) / 10000;
  if (filledLeg.side === 'buy') return formatPrice(filledLeg.price * (1 - step), pairDecimals);
  return formatPrice(filledLeg.price * (1 + step), pairDecimals);
}

async function slideSameSide(cfg, ex, a, ladder, filledLeg) {
  const sideLegs = filledLeg.side === 'buy' ? ladder.buys : ladder.sells;
  const working = sideLegs.filter((o) => o.status === 'open');
  if (working.length >= cfg.slideMaxLegsPerSide) return;
  const price = nextSlidePrice(cfg, filledLeg, a.pairDecimals, a.pair);
  const maxLevel = sideLegs.reduce((m, o) => Math.max(m, o.level || 0), 0);
  const neu = { level: maxLevel + 1, side: filledLeg.side, price, size: filledLeg.size, orderId: null, status: 'pending' };
  console.log('  SLIDE ' + neu.side.toUpperCase() + ' ' + a.symbol + ' ' + neu.size + ' @ ' + neu.price);
  const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
  if (r && r.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'failed';
  sideLegs.push(neu);
  await sleep(cfg.rateLimitMs);
}

async function skewOtherSide(cfg, ex, a, ladder, filledLeg) {
  if (!cfg.skewOtherSide) return;
  const otherSide = filledLeg.side === 'buy' ? 'sell' : 'buy';
  const others = otherSide === 'sell' ? ladder.sells : ladder.buys;
  const open = others.filter((o) => o.status === 'open' && o.orderId);
  const tighten = cfg.skewTightenBps / 10000;
  if (!open.length) {
    const price = filledLeg.side === 'buy'
      ? formatPrice(filledLeg.price * (1 + tighten), a.pairDecimals)
      : formatPrice(filledLeg.price * (1 - tighten), a.pairDecimals);
    const neu = { level: 1, side: otherSide, price, size: filledLeg.size, orderId: null, status: 'pending' };
    const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
    if (r && r.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'failed';
    others.push(neu);
    return;
  }
  const best = otherSide === 'sell'
    ? open.reduce((b, o) => (o.price < b.price ? o : b))
    : open.reduce((b, o) => (o.price > b.price ? o : b));
  const newPx = otherSide === 'sell'
    ? formatPrice(best.price * (1 - tighten), a.pairDecimals)
    : formatPrice(best.price * (1 + tighten), a.pairDecimals);
  if (newPx === best.price) return;
  await ex.cancelOrder(best.orderId);
  best.status = 'cancelled';
  const r = await ex.limitOrder(a.pair, otherSide, newPx, best.size, { level: best.level });
  others.push({ level: best.level, side: otherSide, price: newPx, size: best.size, orderId: r && r.order_id || null, status: r && r.order_id ? 'open' : 'failed' });
}

export async function processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive = null) {
  const book = await ex.getBook(a.pair);
  if (!book) return;
  const sized = orderSizeUsd * sizeWeightForSymbol(a.symbol);
  if (!pairState.has(a.pair)) {
    const ladder = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair);
    pairState.set(a.pair, { ladder, symbol: a.symbol, lastMid: book.mid });
    console.log('\nInitial ladder ' + a.symbol + ' mid=' + book.mid.toFixed(6));
    await placeLadder(cfg, ex, a.pair, ladder, a, getLive);
    printLadder(a.symbol, a.pair, ladder, book);
    return;
  }
  const state = pairState.get(a.pair);
  const ladder = state.ladder;
  const before = new Map([...ladder.buys, ...ladder.sells].filter((o) => o.orderId).map((o) => [o.orderId, o.status]));
  let filledNow = syncLadderFromRegistry(ladder, orderRegistry);
  for (const o of [...ladder.buys, ...ladder.sells]) {
    if (!o.orderId || o.status !== 'open') continue;
    try {
      const st = await ex.getOrderStatus(o.orderId);
      const s = String((st && st.status) || '').toUpperCase();
      if (s.indexOf('FILL') >= 0 && s.indexOf('PARTIAL') < 0) {
        o.status = 'filled';
        filledNow = true;
        const rec = orderRegistry.get(o.orderId);
        if (rec) rec.status = 'filled';
      } else if (s === 'CANCELLED' || s === 'EXPIRED' || s === 'FAILED') {
        o.status = 'cancelled';
      }
    } catch { /* ignore */ }
  }
  if (filledNow) state.lastEnsureAt = 0;
  await ensureBothSides(cfg, ex, a, ladder, book, getLive, state);
  const lastMid = state.lastMid || book.mid;
  const move = Math.abs(book.mid - lastMid) / (lastMid || book.mid);
  const openBuy = ladder.buys.some((o) => o.status === 'open');
  const openSell = ladder.sells.some((o) => o.status === 'open');
  const anyOpen = openBuy || openSell;
  const staleEmpty = !anyOpen && Date.now() - (state.lastRequoteAt || 0) > 15000;
  const needRequote = move >= (cfg.requoteMoveBps || 8) / 10000 || staleEmpty;
  if (!filledNow && openBuy && openSell && !needRequote) return;
  if (needRequote && !filledNow) {
    console.log('  REQUOTE ' + a.symbol + ' mid ' + lastMid.toFixed(6) + ' -> ' + book.mid.toFixed(6));
    await cancelSide(ex, ladder.buys);
    await sleep(cfg.rateLimitMs);
    await cancelSide(ex, ladder.sells);
    await sleep(cfg.rateLimitMs);
    const next = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair);
    state.ladder = next; state.lastMid = book.mid; state.lastRequoteAt = Date.now();
    await placeLadder(cfg, ex, a.pair, next, a, getLive);
    printLadder(a.symbol, a.pair, next, book);
    return;
  }
  state.lastMid = book.mid;
  const newlyFilled = [...ladder.buys, ...ladder.sells].filter((o) => o.status === 'filled' && before.get(o.orderId) !== 'filled');
  if (cfg.rebalanceOnFill) {
    await cancelSide(ex, ladder.buys);
    await cancelSide(ex, ladder.sells);
    const next = generateLadder(cfg, book.mid, sized, a.pairDecimals, a.lotDecimals, a.ordermin, book, a.pair);
    state.ladder = next; state.lastMid = book.mid;
    await placeLadder(cfg, ex, a.pair, next, a, getLive);
    return;
  }
  for (const leg of newlyFilled) {
    await slideSameSide(cfg, ex, a, ladder, leg);
    await skewOtherSide(cfg, ex, a, ladder, leg);
  }
  pruneDone(ladder);
  state.lastEnsureAt = 0;
  await ensureBothSides(cfg, ex, a, ladder, book, getLive, state);
  if (newlyFilled.length) printLadder(a.symbol, a.pair, ladder, book);
}
