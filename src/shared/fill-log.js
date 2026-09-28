import fs from 'fs';
import path from 'path';
import { noteFeeFill } from './fee-spread.js';
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

export function logFill(rec, extra = {}) {
  try {
    const notional = rec.filledValue > 0 ? Number(rec.filledValue) : rec.price && rec.size ? Number(rec.price) * Number(rec.size) : null;
    if (notional) noteFeeFill(rec.fee, notional, rec.pair);
    noteTapeFill(rec.pair, rec.side, rec.price, rec.size);
    invalidateLiveCache();
    const row = {
      ts: new Date().toISOString(),
      orderId: rec.orderId || rec.id || extra.orderId || null,
      venue: rec.venue || extra.venue || null,
      pair: rec.pair || null,
      symbol: rec.symbol || null,
      side: rec.side || null,
      level: rec.level == null ? null : rec.level,
      price: Number(rec.price) || null,
      size: Number(rec.size) || null,
      fee: Number(rec.fee) || 0,
      mid: rec.mid != null ? Number(rec.mid) : null,
      filledValue: rec.filledValue != null ? Number(rec.filledValue) : null,
      notional,
    };
    postFill(row);
    const dest = filePath();
    if (!dest) return;
    if (!resolved) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      resolved = dest;
      console.log('fill log -> ' + dest);
    }
    fs.appendFileSync(dest, JSON.stringify(row) + '\n');
  } catch (e) {
    console.warn('fill log', e.message);
  }
}
