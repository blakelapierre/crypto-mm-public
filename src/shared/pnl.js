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
    fillCash += buy ? -(notional + fee) : (notional - fee);
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
  let unattributed = 0;
  let lastFillAt = 0;
  let fillCash = 0;
  let lastPosMap = null;
  const transferIds = new Set();
  let recentTransfer = 0;
  let recentTransferAt = 0;
  function noteTransfer(usd, src, id) {
    const n = Number(usd);
    if (!Number.isFinite(n) || !n || startEquity == null) return false;
    if (id && transferIds.has(String(id))) return false;
    const tol = Math.max(0.05, Math.abs(n) * 0.01);
    if (transfers.some((t) => Math.abs(t.usd - n) <= tol && Date.now() - t.ts < 600000)) return false;
    if (id) transferIds.add(String(id));
    startEquity += n;
    recentTransfer += n;
    recentTransferAt = Date.now();
    transfers.push({ ts: Date.now(), usd: n, src: src || 'detected', id: id || null });
    console.log('TRANSFER ' + (n >= 0 ? '+' : '') + n.toFixed(2) + ' ' + (src || 'detected') + (id ? ' ' + id : '') + ' start=' + startEquity.toFixed(2));
    return true;
  }
  let lastCash = null;
  let lastPosValue = null;
  let lastCashDelta = 0;
  function unexplainedCashMove() {
    return Math.abs(lastCashDelta) >= Number(process.env.DEPOSIT_DETECT_USD || 1) && Date.now() - recentTransferAt > 15000;
  }
  function markWallet(equity) {
    const n = Number(equity);
    if (!Number.isFinite(n)) return;
    if (startEquity == null) startEquity = n;
    lastEquity = n;
  }
  function markHoldings(live) {
    if (!live) return;
    const pos = Number(live.positionsValue || 0);
    const cash = Number(live.freeQuote || 0) + Number(live.quoteHold || 0);
    const prevEq = lastEquity;
    const prevCash = lastCash;
    const dCash = prevCash == null ? null : cash - prevCash;
    markWallet(live.totalEquity);
    const nowMap = new Map();
    for (const [sym, p] of Object.entries(live.positions || {})) {
      nowMap.set(sym, { qty: Number(p.amount || 0) + Number(p.hold || 0), mid: Number(p.mid || 0) });
    }
    function qtyStable() {
      if (!lastPosMap) return true;
      const dustUsd = Number(process.env.DUST_EXIT_USD || 0.15);
      const keys = new Set([...lastPosMap.keys(), ...nowMap.keys()]);
      for (const k of keys) {
        const a = lastPosMap.get(k);
        const b = nowMap.get(k);
        const qa = a ? a.qty : 0;
        const qb = b ? b.qty : 0;
        if (Math.abs(qa - qb) <= 1e-8) continue;
        const mid = (b && b.mid) || (a && a.mid) || 0;
        if (!(mid > 0) || Math.abs(qa - qb) * mid > dustUsd) return false;
      }
      return true;
    }
    let mtm = 0;
    let qtyVal = 0;
    if (lastPosMap) {
      const keys = new Set([...lastPosMap.keys(), ...nowMap.keys()]);
      for (const k of keys) {
        const a = lastPosMap.get(k);
        const b = nowMap.get(k);
        const qa = a ? a.qty : 0;
        const qb = b ? b.qty : 0;
        const midPrev = a && a.mid > 0 ? a.mid : 0;
        const midNow = b && b.mid > 0 ? b.mid : 0;
        const midUse = midNow > 0 ? midNow : midPrev;
        if (qa && midPrev > 0 && midNow > 0) mtm += qa * (midNow - midPrev);
        if (midUse > 0) qtyVal += (qb - qa) * midUse;
      }
    }
    if (prevEq != null && dCash != null && startEquity != null) {
      const step = Number(live.totalEquity) - prevEq;
      const residual = step - mtm - qtyVal - fillCash;
      const residualCash = dCash - fillCash;
      const minDep = Number(process.env.DEPOSIT_DETECT_USD || 1);
      const tol = Math.max(0.05, Math.abs(residualCash) * 0.02);
      if (Math.abs(residualCash) >= minDep && Math.abs(residual - residualCash) <= tol) {
        const bucket = Math.floor(Date.now() / 60000);
        noteTransfer(residualCash, 'cash-residual', 'cash-residual:' + bucket + ':' + residualCash.toFixed(2));
      }
    }
    fillCash = 0;
    if (prevEq != null && dCash != null && startEquity != null) {
      const step = Number(live.totalEquity) - prevEq;
      const tol = Math.max(0.05, Math.abs(step) * 0.01);
      const noFill = Date.now() - lastFillAt > 60000;
      const minDep = Number(process.env.DEPOSIT_DETECT_USD || 1);
      if (noFill && qtyStable() && Math.abs(Math.abs(dCash) - Math.abs(step)) <= tol && Math.sign(dCash) === Math.sign(step) && Math.abs(step) >= minDep) {
        const bucket = Math.floor(Date.now() / 60000);
        noteTransfer(step, 'equity-step', 'equity-step:' + bucket + ':' + step.toFixed(2));
      }
    }
    lastCashDelta = dCash == null ? 0 : dCash;
    if (dCash != null) {
      const recentFill = Date.now() - lastFillAt < 20000;
      const recentXfer = Date.now() - recentTransferAt < 120000;
      if (!recentFill && !recentXfer && Math.abs(dCash) > Math.max(0.5, Math.abs(prevCash) * 0.05)) console.log('CASH JUMP unconfirmed ' + dCash.toFixed(2) + ' not booked');
    }
    if (prevEq != null && Date.now() - lastFillAt > 60000) {
      const step = Number(live.totalEquity) - prevEq;
      const explained = Date.now() - recentTransferAt < 120000 ? recentTransfer : 0;
      if (explained) recentTransfer = 0;
      const residual = step - explained;
      if (Math.abs(residual) > Math.max(0.5, Math.abs(prevEq) * 0.05)) {
        unattributed += residual;
        const bits = [];
        for (const [sym, row] of nowMap) {
          const prev = lastPosMap && lastPosMap.get(sym);
          if (!prev || Math.abs((prev.qty || 0) - row.qty) > 1e-8) bits.push(sym + ' ' + (prev ? prev.qty : 0) + '->' + row.qty);
        }
        console.log('EQUITY STEP ' + residual.toFixed(2) + ' unattributed cash ' + (dCash == null ? '' : dCash.toFixed(2)) + ' ' + bits.slice(0, 6).join(' '));
      }
    }
    lastCash = cash;
    lastPosValue = pos;
    lastPosMap = nowMap;
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
    const other = wallet != null ? wallet + bankedRunUsd() - priceAcc - makerAcc + feesPaid - unattributed : null;
    const netDep = transfers.reduce((s, t) => s + t.usd, 0);
    return { startEquity, lastEquity, walletGain: walletExBank, walletRaw: wallet, pricePnl: priceAcc, makerPnl: makerAcc, fees: feesPaid, netMaker: makerAcc - feesPaid, takerFees, otherPnl: other, unattributed, transfers, netDeposits: netDep, rows, startedAt, elapsedMs: Date.now() - startedAt };
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
  return { recordFill, markWallet, markHoldings, snapshot, print, adjustFee, avgBuy, noteTransfer, unexplainedCashMove };
}
