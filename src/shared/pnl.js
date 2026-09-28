import { bankedTotalUsd } from './bank.js';

export function createPnl() {
  const books = new Map();
  let startEquity = null;
  let lastEquity = null;
  let feesPaid = 0;
  const inv = new Map();
  const lastMid = new Map();
  const priceBy = new Map();
  const makerBy = new Map();
  let priceAcc = 0;
  let makerAcc = 0;
  let primed = false;
  const key = (s) => String(s || '?').toUpperCase();
  const add = (map, sym, n) => map.set(sym, (map.get(sym) || 0) + n);
  function book(symbol) {
    const k = key(symbol);
    if (!books.has(k)) books.set(k, { boughtQty: 0, boughtCost: 0, soldQty: 0, soldProceeds: 0, realized: 0, fees: 0, fills: 0 });
    return books.get(k);
  }
  function symbolOf(rec) {
    if (rec.symbol) return key(rec.symbol);
    const p = String(rec.pair || '');
    if (p.includes('-')) return key(p.split('-')[0]);
    return key(p.replace(/USD[C]?$/i, ''));
  }
  function accruePrice(sym, mid) {
    if (!(mid > 0)) return;
    const prev = lastMid.get(sym);
    const q = inv.get(sym) || 0;
    if (prev > 0 && q) {
      const d = q * (mid - prev);
      priceAcc += d;
      add(priceBy, sym, d);
    }
    lastMid.set(sym, mid);
  }
  function recordFill(rec) {
    if (!rec) return;
    const qty = Number(rec.size);
    const px = Number(rec.price);
    const fee = Number(rec.fee || 0) || 0;
    if (!(qty > 0) || !(px > 0)) return;
    const sym = symbolOf(rec);
    const mid = Number(rec.mid || lastMid.get(sym) || 0);
    if (mid > 0) accruePrice(sym, mid);
    const buy = String(rec.side).toLowerCase() === 'buy';
    const edge = mid > 0 ? (buy ? (mid - px) * qty : (px - mid) * qty) : 0;
    makerAcc += edge;
    add(makerBy, sym, edge);
    feesPaid += fee;
    inv.set(sym, (inv.get(sym) || 0) + (buy ? qty : -qty));
    const b = book(sym);
    b.fills += 1;
    b.fees += fee;
    const notional = rec.filledValue > 0 ? Number(rec.filledValue) : qty * px;
    if (buy) { b.boughtQty += qty; b.boughtCost += notional + fee; }
    else {
      const proceeds = Math.max(0, notional - fee);
      const avg = b.boughtQty > 0 ? b.boughtCost / b.boughtQty : px;
      const used = Math.min(qty, b.boughtQty);
      if (used > 0) {
        b.realized += proceeds * (used / qty) - avg * used;
        const left = b.boughtQty - used;
        b.boughtCost = left > 0 ? b.boughtCost * (left / b.boughtQty) : 0;
        b.boughtQty = left;
      }
      b.soldQty += qty;
      b.soldProceeds += proceeds;
    }
  }
  function markWallet(equity) {
    const n = Number(equity);
    if (!Number.isFinite(n)) return;
    if (startEquity == null) startEquity = n;
    lastEquity = n;
  }
  function markHoldings(live) {
    if (!live) return;
    markWallet(live.totalEquity);
    for (const [raw, p] of Object.entries(live.positions || {})) {
      const sym = key(raw);
      const mid = Number(p.mid) || 0;
      const qty = Number(p.amount) || 0;
      if (!primed) {
        inv.set(sym, qty);
        if (mid > 0) lastMid.set(sym, mid);
      } else {
        accruePrice(sym, mid);
        inv.set(sym, qty);
      }
    }
    primed = true;
  }
  function fmt(n) {
    if (n == null || !Number.isFinite(n)) return 'n/a';
    const s = n.toFixed(4);
    return n >= 0 ? '+' + s : s;
  }
  function snapshot(mids = {}) {
    for (const [sym, mid] of Object.entries(mids)) accruePrice(key(sym), Number(mid));
    const wallet = startEquity != null && lastEquity != null ? lastEquity - startEquity : null;
    const symbols = new Set([...priceBy.keys(), ...makerBy.keys(), ...books.keys()]);
    const rows = [];
    for (const sym of symbols) {
      const b = books.get(sym) || { fills: 0, fees: 0 };
      rows.push({ symbol: sym, price: priceBy.get(sym) || 0, maker: makerBy.get(sym) || 0, fills: b.fills || 0, fees: b.fees || 0 });
    }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const other = wallet != null ? wallet + bankedTotalUsd() - priceAcc - makerAcc + feesPaid : null;
    return { startEquity, lastEquity, walletGain: wallet, pricePnl: priceAcc, makerPnl: makerAcc, fees: feesPaid, otherPnl: other, rows };
  }
  function print(mids = {}, tag = 'MM gain') {
    const s = snapshot(mids);
    console.log('\n-- ' + tag + ' --');
    if (s.walletGain != null) console.log('  WALLET ' + fmt(s.walletGain) + '   start=' + s.startEquity.toFixed(2) + ' now=' + s.lastEquity.toFixed(2));
    console.log('  PRICE  ' + fmt(s.pricePnl) + '   inventory x each mid tick');
    console.log('  MAKER  ' + fmt(s.makerPnl) + '   fill vs mid (no fees)');
    console.log('  FEES   ' + fmt(-s.fees) + '   venue commission (not in MAKER)');
    if (s.otherPnl != null) console.log('  TAKER  ' + fmt(s.otherPnl) + '   residual so WALLET+BANK=PRICE+MAKER-FEES+TAKER');
    const b = bankedTotalUsd();
    if (b > 0) console.log('  BANK   ' + fmt(b) + '   moved to trade-bot-bank  wallet+bank=' + ((s.walletGain || 0) + b).toFixed(4));
    for (const r of s.rows) {
      console.log('  ' + r.symbol.padEnd(6) + ' price=' + fmt(r.price) + '  maker=' + fmt(r.maker) + '  fills=' + r.fills + ' fees=' + r.fees.toFixed(4));
    }
    if (!s.rows.length) console.log('  no inventory/fills yet');
    return s;
  }
  function adjustFee(rec, fee) {
    const n = Number(fee);
    if (!(n > 0)) return;
    feesPaid += n;
    const b = books.get(symbolOf(rec));
    if (b) b.fees += n;
  }
  return { recordFill, markWallet, markHoldings, snapshot, print, adjustFee };
}
