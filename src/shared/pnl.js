import { bankedTotalUsd, bankedRunUsd } from './bank.js';
import { holdRealizedUsd } from './hold-pnl.js';

export function createPnl() {
  const startedAt = Date.now();
  const books = new Map();
  let startEquity = null;
  let lastEquity = null;
  let feesPaid = 0;
  let takerFees = 0;
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
    if (!books.has(k)) books.set(k, { boughtQty: 0, boughtCost: 0, soldQty: 0, soldProceeds: 0, realized: 0, fees: 0, fills: 0, buyVolUsd: 0, sellVolUsd: 0 });
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
  function isTaker(rec) {
    return !!(rec && (rec.taker || /market/i.test(String(rec.ordertype || rec.orderType || ''))));
  }
  function recordFill(rec) {
    if (!rec) return;
    lastFillAt = Date.now();
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
    if (isTaker(rec)) takerFees += fee;
    inv.set(sym, (inv.get(sym) || 0) + (buy ? qty : -qty));
    const b = book(sym);
    const notional = rec.filledValue > 0 ? Number(rec.filledValue) : qty * px;
    b.fills += 1;
    b.fees += fee;
    if (buy) b.buyVolUsd = (b.buyVolUsd || 0) + notional; else b.sellVolUsd = (b.sellVolUsd || 0) + notional;
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
  const transfers = [];
  let lastFillAt = 0;
  function noteTransfer(usd, src) {
    const n = Number(usd);
    if (!Number.isFinite(n) || !n || startEquity == null) return;
    startEquity += n;
    transfers.push({ ts: Date.now(), usd: n, src: src || 'detected' });
    console.log('TRANSFER ' + (n >= 0 ? '+' : '') + n.toFixed(2) + ' ' + (src || 'detected') + ' start=' + startEquity.toFixed(2));
  }
  function markWallet(equity) {
    const n = Number(equity);
    if (!Number.isFinite(n)) return;
    if (startEquity == null) startEquity = n;
    else if (lastEquity != null) {
      const d = n - lastEquity;
      const quiet = Date.now() - lastFillAt > 8000;
      if (quiet && Math.abs(d) > Math.max(0.5, Math.abs(lastEquity) * 0.05)) noteTransfer(d, 'cash-jump');
    }
    lastEquity = n;
  }
  function markHoldings(live) {
    if (!live) return;
    markWallet(live.totalEquity);
    for (const [raw, p] of Object.entries(live.positions || {})) {
      const sym = key(raw);
      const mid = Number(p.mid) || 0;
      const qty = Number(p.amount || 0) + Number(p.hold || 0);
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
    const walletExBank = wallet != null ? wallet + bankedRunUsd() : null;
    const symbols = new Set([...priceBy.keys(), ...makerBy.keys(), ...books.keys()]);
    const rows = [];
    for (const sym of symbols) {
      const b = books.get(sym) || { fills: 0, fees: 0 };
      rows.push({ symbol: sym, price: priceBy.get(sym) || 0, maker: makerBy.get(sym) || 0, fills: b.fills || 0, fees: b.fees || 0, buyUsd: b.buyVolUsd || 0, sellUsd: b.sellVolUsd || 0 });
    }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const other = wallet != null ? wallet + bankedRunUsd() - priceAcc - makerAcc + feesPaid : null;
    const netDep = transfers.reduce((s, t) => s + t.usd, 0);
    return { startEquity, lastEquity, walletGain: walletExBank, walletRaw: wallet, pricePnl: priceAcc, makerPnl: makerAcc, fees: feesPaid, netMaker: makerAcc - feesPaid, takerFees, otherPnl: other, transfers, netDeposits: netDep, rows, startedAt, elapsedMs: Date.now() - startedAt };
  }
  function print(mids = {}, tag = 'MM gain') {
    const s = snapshot(mids);
    console.log('\n-- ' + tag + ' --');
    if (s.walletGain != null) console.log('  WALLET ' + fmt(s.walletGain) + '   ex-bank  raw=' + fmt(s.walletRaw) + '  start=' + s.startEquity.toFixed(2) + ' now=' + s.lastEquity.toFixed(2));
    console.log('  PRICE  ' + fmt(s.pricePnl) + '   inventory x each mid tick');
    console.log('  MAKER  ' + fmt(s.makerPnl) + '   fill vs mid (no fees)');
    console.log('  FEES   ' + fmt(-s.fees) + '   all venue commission (not in MAKER)');
    console.log('  NET    ' + fmt(s.netMaker) + '   maker + fees');
    console.log('  TAKER  ' + fmt(-(s.takerFees || 0)) + '   market-order fees only');
    if (s.otherPnl != null) console.log('  GAP    ' + fmt(s.otherPnl) + '   residual so WALLET+BANK=PRICE+MAKER-FEES+GAP');
    const b = bankedTotalUsd();
    if (b > 0) console.log('  BANK   ' + fmt(b) + '   moved to trade-bot-bank  wallet+bank=' + ((s.walletGain || 0) + b).toFixed(4));
    console.log('  HOLDX  ' + fmt(holdRealizedUsd()) + '   realized from rise-hold exits');
    for (const r of s.rows) {
      console.log('  ' + r.symbol.padEnd(6) + ' price=' + fmt(r.price) + '  maker=' + fmt(r.maker) + '  fills=' + r.fills + ' buy=$' + (r.buyUsd || 0).toFixed(2) + ' sell=$' + (r.sellUsd || 0).toFixed(2) + ' fees=' + r.fees.toFixed(4));
    }
    if (!s.rows.length) console.log('  no inventory/fills yet');
    return s;
  }
  function adjustFee(rec, fee, already = 0) {
    const n = Number(fee);
    if (!(n > 0)) return;
    const delta = n - Number(already || 0);
    if (!delta) return;
    feesPaid += delta;
    if (isTaker(rec)) takerFees += delta;
    const bk = books.get(symbolOf(rec));
    if (bk) bk.fees += delta;
  }
  function avgBuy(symbol) {
    const b = books.get(String(symbol || '').toUpperCase());
    if (!b || !(b.boughtQty > 0)) return 0;
    return b.boughtCost / b.boughtQty;
  }
  return { recordFill, markWallet, markHoldings, snapshot, print, adjustFee, avgBuy, noteTransfer };
}
