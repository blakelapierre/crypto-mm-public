import fs from 'fs';
import path from 'path';
import { noteFeeFill, assumedMakerFeeBps } from './fee-spread.js';
import { noteTapeFill } from './pair-tape.js';
import { invalidateLiveCache } from './portfolio.js';
import { postFill } from './status-client.js';

let resolved = null;

function filePath() {
  const raw = process.env.FILL_LOG;
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  const bot = String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
  const rel = raw && raw.trim() ? raw.trim() : 'logs/fills-' + bot + '.jsonl';
  return path.resolve(process.cwd(), rel);
}

function appendLine(row) {
  const dest = filePath();
  if (!dest) return;
  if (!resolved) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    resolved = dest;
    console.log('fill log -> ' + dest);
  }
  fs.appendFileSync(dest, JSON.stringify(row) + '\n');
}

export function logSession(extra = {}) {
  try {
    appendLine({
      kind: 'session',
      ts: new Date().toISOString(),
      bot: process.env.BOT || 'ladder',
      ...extra,
    });
  } catch (e) { console.warn('fill log session', e.message); }
}

export function logFeeUpdate(orderId, fee, extra = {}) {
  try {
    const row = {
      kind: 'fee',
      ts: new Date().toISOString(),
      orderId,
      fee: Number(fee) || 0,
      pair: extra.pair || null,
      notional: extra.notional != null ? Number(extra.notional) : null,
    };
    appendLine(row);
    if (row.notional) noteFeeFill(row.fee, row.notional, row.pair);
  } catch (e) { console.warn('fill log fee', e.message); }
}

export function logFill(rec, extra = {}) {
  try {
    const notional = rec.filledValue > 0 ? Number(rec.filledValue) : rec.price && rec.size ? Number(rec.price) * Number(rec.size) : null;
    const venueFee = Number(rec.venueFee != null ? rec.venueFee : (extra.venueFee != null ? extra.venueFee : (rec.feeSource === 'pending' ? 0 : rec.fee))) || 0;
    const pnlFee = Number(rec.fee) || 0;
    if (pnlFee > 0 && notional) noteFeeFill(pnlFee, notional, rec.pair);
    noteTapeFill(rec.pair, rec.side, rec.price, rec.size);
    invalidateLiveCache();
    const row = {
      kind: 'fill',
      ts: extra.ts || new Date().toISOString(),
      orderId: rec.orderId || rec.id || extra.orderId || null,
      venue: rec.venue || extra.venue || null,
      pair: rec.pair || null,
      symbol: rec.symbol || null,
      side: rec.side || null,
      level: rec.level == null ? null : rec.level,
      price: Number(rec.price) || null,
      size: Number(rec.size) || null,
      fee: venueFee,
      feeSource: venueFee > 0 ? 'venue' : 'pending',
      mid: rec.mid != null ? Number(rec.mid) : null,
      filledValue: rec.filledValue != null ? Number(rec.filledValue) : null,
      notional,
    };
    postFill({ ...row, fee: pnlFee || venueFee });
    appendLine(row);
  } catch (e) {
    console.warn('fill log', e.message);
  }
}
