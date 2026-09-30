import fs from 'fs';
import path from 'path';

function logsRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'logs');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), 'logs');
}

function listLogFiles(root) {
  const out = [];
  function walk(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(jsonl)$/i.test(name) && /debug-|fills-/.test(name)) out.push(p);
    }
  }
  walk(root);
  return out.sort();
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function finish(cur, sessions) {
  if (!cur) return;
  const k = cur.lastKpi || {};
  const vol = cur.buyUsd + cur.sellUsd;
  const net = Number(k.maker || 0) - Number(k.fees || 0);
  sessions.push({
    bot: cur.bot,
    exchange: cur.exchange,
    quote: cur.quote,
    start: cur.startIso,
    end: cur.endIso,
    mins: cur.startMs && cur.endMs ? Math.max(0, (cur.endMs - cur.startMs) / 60000) : null,
    wallet: k.wallet,
    price: k.price,
    maker: k.maker,
    fees: k.fees,
    net,
    gap: k.gap,
    equity: k.equity,
    cash: k.cash,
    inv: k.inv,
    fills: cur.fills || k.fills || 0,
    buyUsd: +cur.buyUsd.toFixed(2),
    sellUsd: +cur.sellUsd.toFixed(2),
    vol: +vol.toFixed(2),
    parks: cur.parks,
    covers: cur.covers,
    names: Object.keys(cur.bySym).length,
    top: Object.entries(cur.bySym).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, v]) => s + ' $' + v.toFixed(0)),
  });
}

export function summarizeSessions({ limit = 24 } = {}) { // per bot
  const root = logsRoot();
  const files = listLogFiles(root);
  const sessions = [];
  let cur = null;
  let day = null;

  function dayMs(ms) {
    if (!day) return null;
    const t = Date.parse(day + 'T00:00:00.000Z');
    return Number.isFinite(t) && Number.isFinite(ms) ? t + Number(ms) : null;
  }

  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const row = parseLine(line);
      if (!Array.isArray(row) || !row.length) continue;
      const kind = row[0];
      if (kind === 'shapes') continue;
      if (kind === 6 || kind === 'day') { day = row[1]; continue; }
      if (kind === 0 || kind === 'session') {
        finish(cur, sessions);
        const ms = dayMs(row[1]);
        cur = {
          bot: row[2] || path.basename(file),
          exchange: row[3] || '',
          quote: row[4] || '',
          startMs: ms,
          startIso: ms ? new Date(ms).toISOString() : null,
          endMs: ms,
          endIso: ms ? new Date(ms).toISOString() : null,
          lastKpi: null,
          fills: 0,
          buyUsd: 0,
          sellUsd: 0,
          parks: 0,
          covers: 0,
          bySym: {},
        };
        continue;
      }
      if (!cur) continue;
      if (kind === 5 || kind === 'kpi') {
        const ms = dayMs(row[1]);
        if (ms) { cur.endMs = ms; cur.endIso = new Date(ms).toISOString(); }
        cur.lastKpi = {
          wallet: row[2], price: row[3], maker: row[4], fees: row[5],
          taker: row[6], gap: row[7], bank: row[8], equity: row[9],
          cash: row[10], inv: row[11], fills: row[12],
        };
        continue;
      }
      if (kind === 3 || kind === 'fill') {
        cur.fills += 1;
        const side = String(row[6] || '').toLowerCase();
        const notion = Number(row[13] || 0);
        const sym = row[5] || (row[4] ? String(row[4]).split('-')[0] : '');
        if (side === 'buy') cur.buyUsd += notion;
        else if (side === 'sell') cur.sellUsd += notion;
        if (sym) cur.bySym[sym] = (cur.bySym[sym] || 0) + notion;
        continue;
      }
      if (kind === 2 || kind === 'cancel') {
        if (String(row[6] || '') === 'park') cur.parks += 1;
        continue;
      }
      if (kind === 1 || kind === 'place') {
        if (String(row[3] || '') === 'sell' && Number(row[4]) === 1) cur.covers += 1;
      }
    }
  }
  finish(cur, sessions);
  const by = new Map();
  for (const s of sessions) {
    const k = String(s.bot || 'bot');
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  const out = [];
  for (const list of by.values()) {
    list.sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
    out.push(...list.slice(0, limit));
  }
  out.sort((a, b) => String(a.bot || '').localeCompare(String(b.bot || '')) || String(b.start || '').localeCompare(String(a.start || '')));
  return out;
}

let cache = { at: 0, rows: [] };
export function cachedSessionSummaries(ttlMs = 60000) {
  if (Date.now() - cache.at < ttlMs && cache.rows.length) return cache.rows;
  try { cache = { at: Date.now(), rows: summarizeSessions() }; }
  catch { /* keep old */ }
  return cache.rows;
}
