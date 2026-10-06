import fs from 'fs';
import path from 'path';
import { noteFeeFill, noteVenueFee } from './fee-spread.js';
import { noteTapeFill } from './pair-tape.js';
import { invalidateLiveCache } from './portfolio.js';
import { postFill } from './status-client.js';
import { rotatePxLog } from './px-log.js';

let resolved = null;
let debugResolved = null;

function botName() {
  return String(process.env.BOT || 'ladder').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'ladder';
}

const SHAPE_LIST = [
  ['session', 'ts', 'bot', 'exchange', 'quote'],
  ['place', 'ts', 'symbol', 'side', 'level', 'price', 'size', 'id', 'mid'],
  ['cancel', 'ts', 'id', 'side', 'level', 'price', 'why', 'offBps', 'mid'],
  ['fill', 'ts', 'id', 'venue', 'pair', 'symbol', 'side', 'level', 'price', 'size', 'fee', 'feeSrc', 'mid', 'notional'],
  ['fee', 'ts', 'id', 'pair', 'fee', 'notional', 'src'],
  ['kpi', 'ts', 'wallet', 'price', 'maker', 'fees', 'taker', 'gap', 'bank', 'equity', 'cash', 'inv', 'fills'],
  ['day', 'date'],
];
const SHAPE_ID = Object.fromEntries(SHAPE_LIST.map((s, i) => [s[0], i]));

let dayKey = null;
function packTs(iso) {
  const d = new Date(iso);
  const key = d.toISOString().slice(0, 10);
  const start = Date.parse(key + 'T00:00:00.000Z');
  if (dayKey !== key) {
    dayKey = key;
    try { writeBoth([SHAPE_ID.day, key]); } catch { /* ignore */ }
  }
  return d.getTime() - start;
}
function packRow(kind, obj) {
  const id = SHAPE_ID[kind];
  const spec = id == null ? null : SHAPE_LIST[id];
  const row = { ts: obj.ts || new Date().toISOString(), bot: process.env.BOT || 'ladder', ...obj };
  if (row.id == null && row.orderId) row.id = row.orderId;
  if (row.feeSrc == null && row.feeSource) row.feeSrc = row.feeSource;
  if (!spec) return [kind, row];
  const vals = spec.slice(1).map((k) => (row[k] == null ? null : row[k]));
  if (spec[1] === 'ts') vals[0] = packTs(row.ts);
  return [id, ...vals];
}

function filePath() {
  const raw = process.env.FILL_LOG;
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  const rel = raw && raw.trim() ? raw.trim() : 'logs/fills-' + botName() + '.jsonl';
  return path.resolve(process.cwd(), rel);
}

function debugPath() {
  const raw = process.env.DEBUG_LOG;
  if (raw === '0' || raw === 'off') return null;
  const rel = raw && raw.trim() ? raw.trim() : 'logs/debug-' + botName() + '.jsonl';
  return path.resolve(process.cwd(), rel);
}

function appendTo(destHolder, destFn, label, row) {
  const dest = destFn();
  if (!dest) return;
  if (!destHolder.v) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    destHolder.v = dest;
    console.log(label + ' -> ' + dest);
  }
  fs.appendFileSync(destHolder.v, JSON.stringify(row) + '\n');
}

const fillDest = { v: null };
const debugDest = { v: null };
function appendLine(row) { appendTo(fillDest, filePath, 'fill log', row); }
function appendDebug(row) { appendTo(debugDest, debugPath, 'debug log', row); }
function writeBoth(row) { appendLine(row); appendDebug(row); }

export function logEvent(kind, extra = {}) {
  try { writeBoth(packRow(kind, extra)); } catch { /* ignore */ }
}

function rotateFile(dest) {
  if (!dest || !fs.existsSync(dest)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.dirname(dest), 'archives');
  fs.mkdirSync(dir, { recursive: true });
  const arch = path.join(dir, path.basename(dest).replace(/\.(jsonl|log)$/i, '') + '-' + stamp + path.extname(dest));
  try {
    fs.renameSync(dest, arch);
    console.log('rotated ' + dest + ' -> ' + arch);
  } catch (e) { console.warn('log rotate', e.message); }
}
function archiveLooseLogs(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const dest = path.join(dir, 'archives');
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jsonl|json)$/i.test(name)) continue;
      if (name.startsWith('fills-') && !name.includes('20')) continue;
      if (name.startsWith('debug-') && !name.includes('20')) continue;
      if (name.startsWith('px-') && !name.includes('20')) continue;
      if (name.startsWith('vol-scan-') && name.endsWith('.json') && !name.includes('20')) continue;
      if (name.startsWith('console-') && !name.includes('20')) continue;
      if (/20\d{2}-/.test(name)) {
        try { fs.renameSync(path.join(dir, name), path.join(dest, name)); } catch {}
      }
    }
  } catch (e) { console.warn('log archive', e.message); }
}

function consolePath() {
  const bot = String(process.env.BOT || 'bot').toLowerCase();
  return path.resolve(process.cwd(), 'logs', 'console-' + bot + '.log');
}
let consoleHooked = false;
export function startConsoleLog() {
  if (consoleHooked) return;
  consoleHooked = true;
  const dest = consolePath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    rotateFile(dest);
  } catch { /* ignore */ }
  const write = (level, args) => {
    try {
      const line = new Date().toISOString() + ' ' + level + ' ' + args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      fs.appendFileSync(dest, line + '\n');
    } catch { /* ignore */ }
  };
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => { orig.log(...a); write('log', a); };
  console.warn = (...a) => { orig.warn(...a); write('warn', a); };
  console.error = (...a) => { orig.error(...a); write('err', a); };
}
export function logSession(extra = {}) {
  try {
    archiveLooseLogs(path.dirname(filePath() || debugPath() || path.resolve(process.cwd(), 'logs/x')));
    rotateFile(filePath());
    rotateFile(debugPath());
    rotatePxLog();
    startConsoleLog();
    fillDest.v = null;
    debugDest.v = null;
    writeBoth(['shapes', SHAPE_LIST]);
    writeBoth(packRow('session', extra));
  } catch (e) { console.warn('fill log session', e.message); }
}

const feeCounts = { venue: 0, pending: 0 };
export function feeCountsSnap() { return { ...feeCounts }; }

export function pendingFillsSince(maxAgeMs = 48 * 3600000) {
  const main = filePath();
  if (!main) return [];
  const files = [];
  const dir = path.join(path.dirname(main), 'archives');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('fills-') && name.endsWith('.jsonl')) files.push(path.join(dir, name));
    }
  }
  if (fs.existsSync(main)) files.push(main);
  const cutoff = Date.now() - maxAgeMs;
  const pending = new Map();
  const updated = new Set();
  for (const file of files) {
    let day = null;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(row)) continue;
      if (row[0] === SHAPE_ID.day) { day = row[1]; continue; }
      if (row[0] === SHAPE_ID.fee && row[2]) { updated.add(String(row[2])); continue; }
      if (row[0] !== SHAPE_ID.fill || !day) continue;
      const ts = Date.parse(day + 'T00:00:00.000Z') + Number(row[1] || 0);
      if (!(ts >= cutoff)) continue;
      if (row[11] !== 'pending' && row[11] !== 'est' || !row[2]) continue;
      pending.set(String(row[2]), {
        id: String(row[2]), ts, pair: row[4], symbol: row[5], side: row[6],
        price: Number(row[8]) || 0, size: Number(row[9]) || 0, notional: Number(row[13]) || 0,
      });
    }
  }
  for (const id of updated) pending.delete(id);
  return [...pending.values()];
}

export function logFeeUpdate(orderId, fee, extra = {}) {
  try {
    const row = {
      ts: new Date().toISOString(),
      orderId,
      fee: Number(fee) || 0,
      pair: extra.pair || null,
      notional: extra.notional != null ? Number(extra.notional) : null,
      src: extra.src || null,
    };
    writeBoth(packRow('fee', { ...row, id: orderId }));
    if (row.src === 'venue') {
      feeCounts.venue += 1;
      if (feeCounts.pending > 0) feeCounts.pending -= 1;
    }
  } catch (e) { console.warn('fill log fee', e.message); }
}

export function logFill(rec, extra = {}) {
  try {
    const notional = rec.filledValue > 0 ? Number(rec.filledValue) : rec.price && rec.size ? Number(rec.price) * Number(rec.size) : null;
    const venueFee = Number(rec.venueFee != null ? rec.venueFee : (extra.venueFee != null ? extra.venueFee : (rec.feeSource === 'pending' ? 0 : rec.fee))) || 0;
    const pnlFee = Number(rec.fee) || 0;
    if (venueFee > 0 && notional) {
      noteVenueFee(venueFee, notional, rec.pair);
      feeCounts.venue += 1;
    } else if (pnlFee > 0 && notional) {
      noteFeeFill(pnlFee, notional, rec.pair);
      feeCounts.pending += 1;
    }
    noteTapeFill(rec.pair, rec.side, rec.price, rec.size);
    invalidateLiveCache();
    const row = {
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
      feeSource: venueFee > 0 ? 'venue' : 'est',
      mid: rec.mid != null ? Number(rec.mid) : null,
      filledValue: rec.filledValue != null ? Number(rec.filledValue) : null,
      notional,
    };
    postFill({ ...row, kind: 'fill', fee: pnlFee || venueFee });
    writeBoth(packRow('fill', { ...row, id: row.orderId, feeSrc: row.feeSource }));
  } catch (e) {
    console.warn('fill log', e.message);
  }
}

export function logKpi(snap = {}, extra = {}) {
  try {
    writeBoth(packRow('kpi', {
      wallet: snap.walletGain,
      price: snap.pricePnl,
      maker: snap.makerPnl,
      fees: snap.fees,
      taker: snap.takerFees,
      gap: snap.otherPnl,
      bank: extra.bank,
      equity: snap.lastEquity,
      cash: extra.cash,
      inv: extra.inv,
      fills: extra.fills,
    }));
  } catch (e) { console.warn('kpi log', e.message); }
}
