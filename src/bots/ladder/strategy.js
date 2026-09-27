import { setTimeout as sleep } from 'timers/promises';
import { formatPrice, calculateVolume, formatVolume } from '../../shared/sizing.js';

export function generateLadder(cfg, mid, sizeUsd, pairDecimals, lotDecimals, ordermin, book = null) {
  const step = cfg.mmSpreadBps / 10000;
  const tick = Number((10 ** -pairDecimals).toFixed(pairDecimals));
  const useBook = cfg.joinTouch && book && book.bid && book.ask;
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
  console.log(`\n[${new Date().toLocaleTimeString()}] ${symbol} ${pair} mid=${book.mid.toFixed(6)}`);
  for (const o of ladder.buys) console.log(`  BUY  L${o.level} ${o.size} @ ${o.price}  [${o.status}]`);
  for (const o of ladder.sells) console.log(`  SELL L${o.level} ${o.size} @ ${o.price}  [${o.status}]`);
}

function resizeLeg(cfg, a, o, live) {
  if (!live) return o.size;
  const hair = cfg.orderSizeHaircut || 0.9;
  const minV = (a.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
  if (o.side === 'buy') {
    const pairs = Math.max(1, cfg.mmMaxPairs || cfg.symbols?.length || 1);
    const cashShare = (live.freeQuote * (cfg.capitalSafetyMargin || 0.92) * hair) / pairs;
    const useUsd = Math.min(o.price * o.size, cashShare);
    if (o.price <= 0 || useUsd <= 0) return 0;
    let size = useUsd / o.price;
    if (size + 1e-12 < minV) return minV * o.price <= live.freeQuote * hair ? formatVolume(minV, a.lotDecimals) : 0;
    return formatVolume(size, a.lotDecimals);
  }
  const held = live.positions?.[a.symbol]?.amount || 0;
  let size = Math.min(o.size, held * hair);
  if (size + 1e-12 < minV) return held >= minV ? formatVolume(Math.min(held * hair, o.size), a.lotDecimals) : 0;
  return formatVolume(size, a.lotDecimals);
}

async function cancelSide(ex, legs) {
  for (const o of legs) {
    if (o.orderId && (o.status === 'open' || o.status === 'pending')) {
      await ex.cancelOrder(o.orderId);
      o.status = 'cancelled';
    }
  }
}

async function ensureBothSides(cfg, ex, a, ladder, book) {
  const openS = ladder.sells.some((o) => o.status === 'open');
  const pendS = ladder.sells.some((o) => o.status === 'pending');
  const openB = ladder.buys.some((o) => o.status === 'open');
  const pendB = ladder.buys.some((o) => o.status === 'pending');
  const size = [...ladder.sells, ...ladder.buys].find((o) => o.size > 0)?.size || 0;
  if (!size) return;
  if (!openS && !pendS) {
    const price = formatPrice(book.ask || book.mid, a.pairDecimals);
    console.log(`  ENSURE SELL ${a.symbol} ${size} @ ${price}`);
    const r = await ex.limitOrder(a.pair, 'sell', price, size, { level: 1 });
    ladder.sells.push({ level: 1, side: 'sell', price, size, orderId: r?.order_id || null, status: r?.order_id ? 'open' : 'pending' });
    await sleep(cfg.rateLimitMs);
  }
  if (!openB && !pendB) {
    const price = formatPrice(book.bid || book.mid, a.pairDecimals);
    console.log(`  ENSURE BUY ${a.symbol} ${size} @ ${price}`);
    const r = await ex.limitOrder(a.pair, 'buy', price, size, { level: 1 });
    ladder.buys.push({ level: 1, side: 'buy', price, size, orderId: r?.order_id || null, status: r?.order_id ? 'open' : 'pending' });
    await sleep(cfg.rateLimitMs);
  }
}

export async function placeLadder(cfg, ex, pair, ladder, a = null, getLive = null) {
  for (const o of [...ladder.sells, ...ladder.buys]) {
    if (getLive && a) {
      const live = await getLive();
      const resized = resizeLeg(cfg, a, o, live);
      if (!resized) { o.status = 'pending'; console.log(`  ${o.side} L${o.level} ${a.symbol} skip`); continue; }
      if (resized !== o.size) { console.log(`  ${o.side} L${o.level} ${a.symbol} size ${o.size} -> ${resized}`); o.size = resized; }
    }
    const r = await ex.limitOrder(pair, o.side, o.price, o.size, { level: o.level });
    if (r?.order_id) { o.orderId = r.order_id; o.status = 'open'; }
    else o.status = 'pending';
    await sleep(cfg.rateLimitMs);
  }
}

function nextSlidePrice(cfg, filledLeg, pairDecimals) {
  const step = cfg.mmSpreadBps / 10000;
  if (filledLeg.side === 'buy') return formatPrice(filledLeg.price * (1 - step), pairDecimals);
  return formatPrice(filledLeg.price * (1 + step), pairDecimals);
}

async function slideSameSide(cfg, ex, a, ladder, filledLeg) {
  const sideLegs = filledLeg.side === 'buy' ? ladder.buys : ladder.sells;
  const working = sideLegs.filter((o) => o.status === 'open' || o.status === 'pending');
  if (working.length >= cfg.slideMaxLegsPerSide) return;
  const price = nextSlidePrice(cfg, filledLeg, a.pairDecimals);
  const maxLevel = sideLegs.reduce((m, o) => Math.max(m, o.level || 0), 0);
  const neu = { level: maxLevel + 1, side: filledLeg.side, price, size: filledLeg.size, orderId: null, status: 'pending' };
  console.log(`  SLIDE ${neu.side.toUpperCase()} ${a.symbol} ${neu.size} @ ${neu.price}`);
  const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
  if (r?.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'pending';
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
    if (r?.order_id) { neu.orderId = r.order_id; neu.status = 'open'; }
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
  others.push({ level: best.level, side: otherSide, price: newPx, size: best.size, orderId: r?.order_id || null, status: r?.order_id ? 'open' : 'cancelled' });
}

export async function processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd, getLive = null) {
  const book = await ex.getBook(a.pair);
  if (!book) return;
  if (!pairState.has(a.pair)) {
    const ladder = generateLadder(cfg, book.mid, orderSizeUsd, a.pairDecimals, a.lotDecimals, a.ordermin, book);
    pairState.set(a.pair, { ladder, symbol: a.symbol, lastMid: book.mid });
    console.log(`\nInitial ladder ${a.symbol} mid=${book.mid.toFixed(6)} joinTouch=${!!cfg.joinTouch}`);
    await placeLadder(cfg, ex, a.pair, ladder, a, getLive);
    printLadder(a.symbol, a.pair, ladder, book);
    return;
  }
  const state = pairState.get(a.pair);
  const ladder = state.ladder;
  const before = new Map([...ladder.buys, ...ladder.sells].filter((o) => o.orderId).map((o) => [o.orderId, o.status]));
  const filledNow = syncLadderFromRegistry(ladder, orderRegistry);
  await ensureBothSides(cfg, ex, a, ladder, book);
  const lastMid = state.lastMid || book.mid;
  const move = Math.abs(book.mid - lastMid) / (lastMid || book.mid);
  const anyOpen = [...ladder.buys, ...ladder.sells].some((o) => o.status === 'open');
  const needRequote = move >= (cfg.requoteMoveBps || 8) / 10000 || !anyOpen;
  if (!filledNow && anyOpen && !needRequote) return;
  if (needRequote && !filledNow) {
    console.log(`  REQUOTE ${a.symbol} mid ${lastMid.toFixed(6)} -> ${book.mid.toFixed(6)} (${(move * 10000).toFixed(1)}bps) open=${anyOpen}`);
    await cancelSide(ex, ladder.buys);
    await sleep(cfg.rateLimitMs);
    await cancelSide(ex, ladder.sells);
    await sleep(cfg.rateLimitMs);
    const next = generateLadder(cfg, book.mid, orderSizeUsd, a.pairDecimals, a.lotDecimals, a.ordermin, book);
    state.ladder = next; state.lastMid = book.mid;
    await placeLadder(cfg, ex, a.pair, next, a, getLive);
    printLadder(a.symbol, a.pair, next, book);
    return;
  }
  state.lastMid = book.mid;
  const newlyFilled = [...ladder.buys, ...ladder.sells].filter((o) => o.status === 'filled' && before.get(o.orderId) !== 'filled');
  if (cfg.rebalanceOnFill) {
    await cancelSide(ex, ladder.buys);
    await cancelSide(ex, ladder.sells);
    const next = generateLadder(cfg, book.mid, orderSizeUsd, a.pairDecimals, a.lotDecimals, a.ordermin, book);
    state.ladder = next; state.lastMid = book.mid;
    await placeLadder(cfg, ex, a.pair, next, a, getLive);
    return;
  }
  for (const leg of newlyFilled) {
    await slideSameSide(cfg, ex, a, ladder, leg);
    await skewOtherSide(cfg, ex, a, ladder, leg);
  }
  printLadder(a.symbol, a.pair, ladder, book);
}
