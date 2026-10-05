import fs from 'fs';
import path from 'path';
import { coinbaseRequest } from './coinbase.js';
import { pendingFillsSince, logFeeUpdate, logFill, feeCountsSnap } from './fill-log.js';
import { noteVenueFee, venueFeeStats, assumedMakerFeeBps } from './fee-spread.js';

let report = { venue: 0, pending: 0, estBps: null, realBps: null, tier: null, summaryFees: null, venueN: 0 };
export function feeReport() {
  const counts = feeCountsSnap();
  const vs = venueFeeStats();
  return { ...report, venue: counts.venue, pending: counts.pending, realBps: vs.bps, venueN: vs.n, estBps: assumedMakerFeeBps() };
}

function statePath() {
  const bot = String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
  return path.resolve(process.cwd(), 'logs', 'state-' + bot + '.json');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
  catch { return { cursor: null, seenFills: [], transfers: [] }; }
}
function saveState(s) {
  s.seenFills = (s.seenFills || []).slice(-4000);
  s.transfers = (s.transfers || []).slice(-500);
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(s));
}
function feeOf(fills) {
  let n = 0;
  for (const f of fills || []) n += Number(f.commission || f.fee || 0) || 0;
  return n;
}

export async function runVenueRecon(cfg, orderRegistry, pnl) {
  if (!cfg || cfg.exchange !== 'coinbase') return feeReport();
  const state = loadState();
  state.seenFills = state.seenFills || [];
  state.transfers = state.transfers || [];
  const seen = new Set(state.seenFills);
  const seenTx = new Set(state.transfers);

  const pending = pendingFillsSince(48 * 3600000).slice(0, 40);
  for (let i = 0; i < pending.length; i += 5) {
    const batch = pending.slice(i, i + 5);
    const q = batch.map((p) => 'order_ids=' + encodeURIComponent(p.id)).join('&');
    let data;
    try { data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/fills?' + q + '&limit=100'); }
    catch (e) { console.warn('fee backfill', e.message); break; }
    const byOrder = new Map();
    for (const f of data.fills || []) {
      if (!byOrder.has(f.order_id)) byOrder.set(f.order_id, []);
      byOrder.get(f.order_id).push(f);
    }
    for (const p of batch) {
      const fee = feeOf(byOrder.get(p.id));
      if (!(fee > 0)) continue;
      const notional = p.notional || (Number(p.price) * Number(p.size));
      const rec = orderRegistry && orderRegistry.get(p.id);
      if (rec && rec.pnlRecorded && pnl && pnl.adjustFee) {
        const already = rec.feeAccounted || (notional * assumedMakerFeeBps() / 10000);
        pnl.adjustFee(rec, fee, already);
        rec.fee = fee;
        rec.feeAccounted = fee;
        rec.needFee = false;
        rec.feeSource = 'venue';
      }
      noteVenueFee(fee, notional, p.pair);
      logFeeUpdate(p.id, fee, { pair: p.pair, notional, src: 'venue' });
      console.log('  FEE venue ' + String(p.id).slice(0, 8) + ' ' + fee.toFixed(4));
    }
  }

  const start = state.cursor || new Date(Date.now() - 2 * 60 * 1000).toISOString();
  try {
    const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/orders/historical/fills?start_sequence_timestamp=' + encodeURIComponent(start) + '&limit=100');
    let newest = start;
    for (const f of data.fills || []) {
      const eid = String(f.entry_id || f.trade_id || '');
      if (eid && seen.has(eid)) continue;
      if (eid) { seen.add(eid); state.seenFills.push(eid); }
      const ts = f.sequence_timestamp || f.trade_time || '';
      if (ts > newest) newest = ts;
      const id = f.order_id;
      if (!id || (orderRegistry && orderRegistry.has(id))) continue;
      const side = String(f.side || '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') continue;
      const px = Number(f.price) || 0;
      const sz = Number(f.size) || 0;
      const fee = Number(f.commission) || 0;
      const rec = {
        orderId: id, pair: f.product_id, symbol: String(f.product_id || '').split('-')[0],
        side, price: px, size: sz, fee, filledValue: px * sz,
        taker: String(f.liquidity_indicator || '').toUpperCase() === 'TAKER',
        why: 'untracked', venue: 'coinbase',
      };
      console.log('UNTRACKED FILL ' + rec.symbol + ' ' + rec.side + ' ' + sz + ' @ ' + px + ' fee=' + fee);
      if (pnl) pnl.recordFill(rec);
      logFill(rec, { orderId: id, venueFee: fee });
    }
    state.cursor = newest;
  } catch (e) { console.warn('venue fills', e.message); }

  try {
    const accts = await coinbaseRequest(cfg, 'GET', '/v2/accounts?limit=100');
    const quote = String(cfg.quote || 'USDC').toUpperCase();
    const acct = (accts.data || []).find((a) => String((a.currency && a.currency.code) || '').toUpperCase() === quote);
    if (acct && acct.id) {
      const tx = await coinbaseRequest(cfg, 'GET', '/v2/accounts/' + acct.id + '/transactions?limit=25');
      for (const t of tx.data || []) {
        const type = String(t.type || '');
        if (!/deposit|withdraw|transfer|send|receive/i.test(type)) continue;
        if (/buy|sell|trade|advanced/i.test(type)) continue;
        if (!t.id || seenTx.has(t.id)) continue;
        const raw = Number(t.amount && t.amount.amount);
        if (!raw) continue;
        const sign = /withdraw|send/i.test(type) && !/receive/i.test(type) ? -Math.abs(raw) : Math.abs(raw);
        if (pnl && pnl.noteTransfer(sign, type, t.id)) {
          seenTx.add(t.id);
          state.transfers.push(t.id);
        }
      }
    }
  } catch (e) {
    if (!runVenueRecon.txWarned) {
      runVenueRecon.txWarned = true;
      console.warn('transfer history', e.message);
    }
  }

  try {
    const sum = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/transaction_summary');
    const vs = venueFeeStats();
    report = {
      ...feeReport(),
      tier: sum.fee_tier && (sum.fee_tier.pricing_tier || sum.fee_tier.maker_fee_rate),
      makerRate: sum.fee_tier && sum.fee_tier.maker_fee_rate,
      summaryFees: Number(sum.total_fees),
    };
    if (vs.n >= 20 && vs.bps > 0) process.env.MAKER_FEE_BPS = String(Math.round(vs.bps));
    console.log('  FEES venue=' + report.venue + ' pending=' + report.pending + ' realBps=' + (vs.bps == null ? 'n/a' : Number(vs.bps).toFixed(1)) + ' tier=' + (report.tier || '') + ' summary=' + (report.summaryFees ?? ''));
  } catch (e) { console.warn('fee summary', e.message); }

  try { saveState(state); } catch (e) { console.warn('state save', e.message); }
  return feeReport();
}

export function startVenueRecon(cfg, orderRegistry, pnl) {
  const ms = Number(process.env.VENUE_RECON_MS || 300000);
  const tick = () => runVenueRecon(cfg, orderRegistry, pnl).catch((e) => console.warn('venue recon', e.message));
  setTimeout(tick, 20000);
  setInterval(tick, ms);
}
