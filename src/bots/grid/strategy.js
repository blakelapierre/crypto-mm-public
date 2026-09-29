import { formatPrice, formatVolume } from '../../shared/sizing.js';
import { logEvent } from '../../shared/fill-log.js';
import { postOrders } from '../../shared/status-client.js';
import { realizedFeeBps } from '../../shared/fee-spread.js';

function halfFrac(cfg, pair) {
  const fee = realizedFeeBps(pair);
  const feeBps = fee != null ? fee : Number(cfg.makerFeeBps || process.env.MAKER_FEE_BPS || 35);
  const edge = Number(cfg.minEdgeBps || process.env.MIN_EDGE_BPS || 20);
  return Math.max(feeBps + edge, Number(process.env.GRID_HALF_BPS || process.env.MIN_HALF_SPREAD_BPS || 55)) / 10000;
}

function stepFrac(cfg, pair) {
  const step = Number(process.env.GRID_BPS || 0);
  if (step > 0) return step / 10000;
  return halfFrac(cfg, pair);
}

function snapDown(px, step, decimals) {
  if (!(px > 0) || !(step > 0)) return formatPrice(px, decimals);
  const n = Math.floor(Math.log(px) / Math.log(1 + step));
  return formatPrice(Math.pow(1 + step, n), decimals);
}
function snapUp(px, step, decimals) {
  if (!(px > 0) || !(step > 0)) return formatPrice(px, decimals);
  const n = Math.ceil(Math.log(px) / Math.log(1 + step));
  return formatPrice(Math.pow(1 + step, n), decimals);
}

function clipSize(cfg, a, px, live, side) {
  const usd = Number(process.env.GRID_CLIP_USD || cfg.minOrderUsd || 5);
  const minV = (a.ordermin || 0) * (cfg.volumeSafetyMargin || 1.05);
  let size = usd / px;
  if (side === 'buy') {
    const cash = (live && live.freeQuote || 0) * (cfg.orderSizeHaircut || 0.9);
    size = Math.min(size, cash / px);
  } else {
    const held = (live && live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount) || 0;
    size = Math.min(size, held * (cfg.orderSizeHaircut || 0.9));
  }
  if (size + 1e-12 < minV) return heldOrCashOk(side, live, a, minV, px) ? formatVolume(minV, a.lotDecimals) : 0;
  return formatVolume(size, a.lotDecimals);
}

function heldOrCashOk(side, live, a, minV, px) {
  if (side === 'sell') {
    const held = (live && live.positions && live.positions[a.symbol] && live.positions[a.symbol].amount) || 0;
    return held >= minV;
  }
  return (live && live.freeQuote || 0) >= minV * px;
}

function publish(a, st, mid) {
  const orders = [];
  if (st.bid && st.bid.status === 'open') orders.push({ ...st.bid, usd: Number(st.bid.size) * Number(st.bid.price) });
  if (st.ask && st.ask.status === 'open') orders.push({ ...st.ask, usd: Number(st.ask.size) * Number(st.ask.price) });
  postOrders(a.symbol, orders, { pair: a.pair, mid });
}

export function createGridState() {
  return { bid: null, ask: null, lots: [], shorts: [], lastMid: 0 };
}

export async function processGrid(cfg, ex, a, st, book, getLive, orderRegistry) {
  const mid = Number(book && book.mid);
  if (!(mid > 0)) return;
  st.lastMid = mid;
  const half = halfFrac(cfg, a.pair);
  const step = stepFrac(cfg, a.pair);
  const bidPx = snapDown(mid * (1 - half), step, a.pairDecimals);
  const askPx = snapUp(mid * (1 + half), step, a.pairDecimals);

  for (const o of [st.bid, st.ask]) {
    if (!o || !o.orderId || o.status !== 'open') continue;
    const rec = orderRegistry.get(o.orderId);
    if (rec && /FILL/i.test(String(rec.status || '')) && !/PARTIAL/i.test(String(rec.status || ''))) {
      o.status = 'filled';
      logEvent('fill', { orderId: o.orderId, pair: a.pair, symbol: a.symbol, side: o.side, price: o.price, size: o.size, mid });
      if (o.side === 'buy') st.lots.push({ px: Number(o.price), size: Number(o.size) });
      else st.shorts.push({ px: Number(o.price), size: Number(o.size) });
    }
  }

  const live = getLive ? await getLive() : null;
  async function ensure(side, target, lotHint) {
    const cur = side === 'buy' ? st.bid : st.ask;
    if (cur && cur.status === 'open' && cur.orderId && formatPrice(Number(cur.price), a.pairDecimals) === String(target)) return;
    if (cur && cur.status === 'open' && cur.orderId) {
      try { await ex.cancelOrder(cur.orderId); } catch { /* ignore */ }
      cur.status = 'cancelled';
      logEvent('cancel', { orderId: cur.orderId, side, price: cur.price, why: 'grid-move', mid });
    }
    const size = lotHint && lotHint.size ? formatVolume(lotHint.size, a.lotDecimals) : clipSize(cfg, a, Number(target), live, side);
    if (!size) return;
    const r = await ex.limitOrder(a.pair, side, target, size, { level: 1 });
    if (!(r && r.order_id)) return;
    logEvent('place', { pair: a.pair, symbol: a.symbol, side, level: 1, price: target, size, orderId: r.order_id, mid });
    const row = { side, price: target, size, orderId: r.order_id, status: 'open', level: 1 };
    if (side === 'buy') st.bid = row; else st.ask = row;
  }

  const pairSell = st.lots[0];
  const pairBuy = st.shorts[0];
  const sellTarget = pairSell ? snapUp(pairSell.px * (1 + 2 * half), step, a.pairDecimals) : askPx;
  const buyTarget = pairBuy ? snapDown(pairBuy.px * (1 - 2 * half), step, a.pairDecimals) : bidPx;

  await ensure('sell', sellTarget, pairSell);
  await ensure('buy', buyTarget, pairBuy);

  if (st.ask && st.ask.status === 'filled' && pairSell) st.lots.shift();
  if (st.bid && st.bid.status === 'filled' && pairBuy) st.shorts.shift();

  publish(a, st, mid);
  const bidN = st.bid && st.bid.status === 'open' ? 1 : 0;
  const askN = st.ask && st.ask.status === 'open' ? 1 : 0;
  if (bidN + askN) {
    console.log('[grid] ' + a.symbol + ' mid=' + mid + ' bid ' + (st.bid && st.bid.status === 'open' ? st.bid.price : '-') +
      ' ask ' + (st.ask && st.ask.status === 'open' ? st.ask.price : '-') +
      ' lots=' + st.lots.length + ' shorts=' + st.shorts.length);
  }
}
