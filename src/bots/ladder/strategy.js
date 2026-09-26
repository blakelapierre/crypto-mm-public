import { setTimeout as sleep } from 'timers/promises';
import { formatPrice, calculateVolume } from '../../shared/sizing.js';

export function generateLadder(cfg, mid, sizeUsd, pairDecimals, lotDecimals, ordermin) {
  const step = cfg.mmSpreadBps / 10000;
  const buys = [];
  const sells = [];
  for (let i = 1; i <= cfg.mmLevels; i++) {
    const size = calculateVolume(cfg, mid, sizeUsd, ordermin, lotDecimals);
    buys.push({ level: i, side: 'buy', price: formatPrice(mid * (1 - i * step), pairDecimals), size, orderId: null, status: 'pending' });
    sells.push({ level: i, side: 'sell', price: formatPrice(mid * (1 + i * step), pairDecimals), size, orderId: null, status: 'pending' });
  }
  return { buys, sells, mid };
}

export function syncLadderFromRegistry(ladder, orderRegistry) {
  let anyFilled = false;
  for (const leg of [...ladder.buys, ...ladder.sells]) {
    if (!leg.orderId) continue;
    const rec = orderRegistry.get(leg.orderId);
    if (!rec) continue;
    if (rec.status === 'filled' && leg.status !== 'filled') { leg.status = 'filled'; anyFilled = true; }
    else if (rec.status === 'cancelled') leg.status = 'cancelled';
    else if (rec.status === 'open') leg.status = 'open';
  }
  return anyFilled;
}

export function printLadder(symbol, pair, ladder, book) {
  const now = new Date().toLocaleTimeString();
  console.log(`\n[${now}] ${symbol} ${pair} mid=${book.mid.toFixed(6)}`);
  for (const o of ladder.buys) {
    console.log(`  BUY  L${o.level} ${o.size} @ ${o.price}  [${o.status}] ${o.orderId ? String(o.orderId).slice(0, 10) + '…' : ''}`);
  }
  for (const o of ladder.sells) {
    console.log(`  SELL L${o.level} ${o.size} @ ${o.price}  [${o.status}] ${o.orderId ? String(o.orderId).slice(0, 10) + '…' : ''}`);
  }
}

export async function placeLadder(cfg, ex, pair, ladder) {
  for (const o of [...ladder.buys, ...ladder.sells]) {
    const r = await ex.limitOrder(pair, o.side, o.price, o.size, { level: o.level });
    if (r?.order_id) { o.orderId = r.order_id; o.status = 'open'; }
    else o.status = 'cancelled';
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
  if (working.length >= cfg.slideMaxLegsPerSide) {
    console.log(`  skip slide ${filledLeg.side}: ${working.length} working ${a.symbol}`);
    return;
  }
  const price = nextSlidePrice(cfg, filledLeg, a.pairDecimals);
  const maxLevel = sideLegs.reduce((m, o) => Math.max(m, o.level || 0), 0);
  const neu = { level: maxLevel + 1, side: filledLeg.side, price, size: filledLeg.size, orderId: null, status: 'pending' };
  console.log(`  SLIDE ${neu.side.toUpperCase()} ${a.symbol} ${neu.size} @ ${neu.price} (fill @ ${filledLeg.price})`);
  const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
  if (r?.order_id) { neu.orderId = r.order_id; neu.status = 'open'; } else neu.status = 'cancelled';
  sideLegs.push(neu);
  await sleep(cfg.rateLimitMs);
}

async function skewOtherSide(cfg, ex, a, ladder, filledLeg) {
  if (!cfg.skewOtherSide) return;
  const otherSide = filledLeg.side === 'buy' ? 'sell' : 'buy';
  const others = otherSide === 'sell' ? ladder.sells : ladder.buys;
  const open = others.filter((o) => o.status === 'open' && o.orderId);
  if (!open.length) {
    const tighten = cfg.skewTightenBps / 10000;
    const price = filledLeg.side === 'buy'
      ? formatPrice(filledLeg.price * (1 + tighten), a.pairDecimals)
      : formatPrice(filledLeg.price * (1 - tighten), a.pairDecimals);
    const neu = { level: 1, side: otherSide, price, size: filledLeg.size, orderId: null, status: 'pending' };
    console.log(`  SKEW new ${otherSide.toUpperCase()} ${a.symbol} @ ${price}`);
    const r = await ex.limitOrder(a.pair, neu.side, neu.price, neu.size, { level: neu.level });
    if (r?.order_id) { neu.orderId = r.order_id; neu.status = 'open'; }
    others.push(neu);
    await sleep(cfg.rateLimitMs);
    return;
  }
  const best = otherSide === 'sell'
    ? open.reduce((b, o) => (o.price < b.price ? o : b))
    : open.reduce((b, o) => (o.price > b.price ? o : b));
  const tighten = cfg.skewTightenBps / 10000;
  const newPx = otherSide === 'sell'
    ? formatPrice(best.price * (1 - tighten), a.pairDecimals)
    : formatPrice(best.price * (1 + tighten), a.pairDecimals);
  if (newPx === best.price) return;
  console.log(`  SKEW replace ${otherSide.toUpperCase()} ${best.price} → ${newPx}`);
  await ex.cancelOrder(best.orderId);
  best.status = 'cancelled';
  const r = await ex.limitOrder(a.pair, otherSide, newPx, best.size, { level: best.level });
  others.push({ level: best.level, side: otherSide, price: newPx, size: best.size, orderId: r?.order_id || null, status: r?.order_id ? 'open' : 'cancelled' });
  await sleep(cfg.rateLimitMs);
}

export async function processPair(cfg, ex, orderRegistry, pairState, a, orderSizeUsd) {
  const book = await ex.getBook(a.pair);
  if (!book) return;
  if (!pairState.has(a.pair)) {
    const ladder = generateLadder(cfg, book.mid, orderSizeUsd, a.pairDecimals, a.lotDecimals, a.ordermin);
    pairState.set(a.pair, { ladder, symbol: a.symbol });
    console.log(`\nInitial ladder ${a.symbol} mid=${book.mid.toFixed(6)}`);
    await placeLadder(cfg, ex, a.pair, ladder);
    printLadder(a.symbol, a.pair, ladder, book);
    return;
  }
  const state = pairState.get(a.pair);
  const ladder = state.ladder;
  const before = new Map([...ladder.buys, ...ladder.sells].filter((o) => o.orderId).map((o) => [o.orderId, o.status]));
  const filledNow = syncLadderFromRegistry(ladder, orderRegistry);
  if (!filledNow) return;
  const newlyFilled = [...ladder.buys, ...ladder.sells].filter((o) => o.status === 'filled' && before.get(o.orderId) !== 'filled');
  console.log(`\nFill(s) via order id for ${a.symbol}`);
  printLadder(a.symbol, a.pair, ladder, book);
  if (cfg.rebalanceOnFill) {
    await ex.cancelPair(a.pair);
    const next = generateLadder(cfg, book.mid, orderSizeUsd, a.pairDecimals, a.lotDecimals, a.ordermin);
    state.ladder = next;
    await placeLadder(cfg, ex, a.pair, next);
    printLadder(a.symbol, a.pair, next, book);
    return;
  }
  for (const leg of newlyFilled) {
    await slideSameSide(cfg, ex, a, ladder, leg);
    await skewOtherSide(cfg, ex, a, ladder, leg);
  }
  printLadder(a.symbol, a.pair, ladder, book);
}
