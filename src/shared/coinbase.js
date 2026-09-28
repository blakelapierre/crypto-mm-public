import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { noteApi, noteApiCacheHit } from './api-timing.js';

const COINBASE_BASE = 'https://api.coinbase.com';
export const COINBASE_USER_WS = 'wss://advanced-trade-ws-user.coinbase.com';
export const COINBASE_MARKET_WS = 'wss://advanced-trade-ws.coinbase.com';
const bookHttpCache = new Map();
const tickerBooks = new Map();
function bookCacheTtl() { return Number(process.env.BOOK_CACHE_MS || 300); }
function tickerStaleMs() { return Number(process.env.TICKER_STALE_MS || 120000); }

export function coinbaseWsMids() {
  const out = {};
  const stale = tickerStaleMs();
  const now = Date.now();
  for (const [pair, rec] of tickerBooks) {
    if (rec && rec.mid > 0 && now - rec.at <= stale) out[pair] = rec;
  }
  return out;
}
export function coinbaseWsBook(pair) {
  const rec = tickerBooks.get(String(pair || '').toUpperCase());
  if (!rec || Date.now() - rec.at > tickerStaleMs()) return null;
  return rec;
}
function noteTicker(pair, bid, ask, last) {
  const p = String(pair || '').toUpperCase();
  if (!p) return null;
  const b = Number(bid), a = Number(ask), l = Number(last);
  const mid = b > 0 && a > 0 ? (b + a) / 2 : l > 0 ? l : 0;
  if (!(mid > 0)) return null;
  const rec = { pair: p, bid: b || mid, ask: a || mid, mid, last: l || mid, at: Date.now() };
  tickerBooks.set(p, rec);
  return rec;
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function shortPath(p) {
  return String(p || '').split('?')[0].replace('/api/v3/brokerage', '');
}

export function readCoinbaseSecretRaw(cfg) {
  let secret = cfg.coinbaseApiSecret;
  const file = process.env.COINBASE_API_SECRET_FILE;
  if (file) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) throw new Error('Missing ' + full);
    secret = fs.readFileSync(full, 'utf8');
  }
  if (!secret) throw new Error('Set COINBASE_API_SECRET or COINBASE_API_SECRET_FILE=./coinbase.pem');
  return String(secret).trim().replace(/\\n/g, '\n');
}

export function loadCoinbaseSigningKey(cfg) {
  const raw = readCoinbaseSecretRaw(cfg);
  if (raw.includes('BEGIN')) {
    for (const pem of [raw, raw.replace('BEGIN EC PRIVATE KEY', 'BEGIN PRIVATE KEY').replace('END EC PRIVATE KEY', 'END PRIVATE KEY')]) {
      try {
        const privateKey = crypto.createPrivateKey(pem);
        return { privateKey, alg: privateKey.asymmetricKeyType === 'ed25519' ? 'EdDSA' : 'ES256' };
      } catch { /* next */ }
    }
    throw new Error('Bad Coinbase PEM');
  }
  const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
  if (decoded.length !== 64 && decoded.length !== 32) throw new Error('Ed25519 length ' + decoded.length);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), decoded.subarray(0, 32)]);
  return { privateKey: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), alg: 'EdDSA' };
}

export function coinbaseJwt(cfg, method, reqPath, { forWebsocket = false } = {}) {
  const keyName = cfg.coinbaseApiKey.trim();
  const { privateKey, alg } = loadCoinbaseSigningKey(cfg);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, typ: 'JWT', kid: keyName, nonce: crypto.randomBytes(16).toString('hex') };
  const payload = { sub: keyName, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120 };
  if (!forWebsocket && method && reqPath) {
    const pathOnly = reqPath.split('?')[0];
    const uriClaim = method + ' api.coinbase.com' + pathOnly;
    payload.uri = uriClaim; payload.uris = [uriClaim];
  }
  const data = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const sig = alg === 'EdDSA'
    ? crypto.sign(null, Buffer.from(data), privateKey)
    : crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return data + '.' + base64url(sig);
}

export async function coinbaseRequest(cfg, method, reqPath, bodyObj = null) {
  const t0 = Date.now();
  try {
    if (method === 'GET' && String(reqPath).includes('best_bid_ask')) {
      const ttl = bookCacheTtl();
      const hit = bookHttpCache.get(reqPath);
      if (ttl > 0 && hit && Date.now() - hit.at < ttl) { noteApiCacheHit(); return hit.data; }
    }
    const headers = {
      Authorization: 'Bearer ' + coinbaseJwt(cfg, method, reqPath),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const opts = { method, headers };
    if (bodyObj && method !== 'GET') opts.body = JSON.stringify(bodyObj);
    const res = await fetch(COINBASE_BASE + reqPath, opts);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    noteApi('coinbase', method + ' ' + shortPath(reqPath), Date.now() - t0, res.ok);
    if (!res.ok) throw new Error('Coinbase ' + res.status + ' ' + method + ' ' + reqPath + ': ' + JSON.stringify(data));
    if (method === 'GET' && String(reqPath).includes('best_bid_ask')) bookHttpCache.set(reqPath, { at: Date.now(), data });
    return data;
  } catch (e) {
    noteApi('coinbase', method + ' ' + shortPath(reqPath), Date.now() - t0, false);
    throw e;
  }
}

export async function coinbasePublic(reqPath) {
  const t0 = Date.now();
  try {
    const res = await fetch(COINBASE_BASE + reqPath, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    noteApi('coinbase', 'PUB ' + shortPath(reqPath), Date.now() - t0, res.ok);
    if (!res.ok) throw new Error(JSON.stringify(data));
    return data;
  } catch (e) {
    noteApi('coinbase', 'PUB ' + shortPath(reqPath), Date.now() - t0, false);
    throw e;
  }
}

export function startCoinbaseUserWs(cfg, onStatus) {
  if (!cfg.useUserWebsocket || cfg.dryRun) return { close() {} };
  let ws = null;
  let timer = null;
  const connect = () => {
    try { ws = new WebSocket(COINBASE_USER_WS); } catch (e) { console.warn('WS create failed', e.message); schedule(); return; }
    ws.on('open', () => {
      console.log('Coinbase user WS connected');
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'user', jwt: coinbaseJwt(cfg, null, null, { forWebsocket: true }) }));
    });
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.channel === 'subscriptions' || msg.type === 'heartbeat') return;
      const events = msg.events || (msg.type ? [msg] : []);
      for (const ev of events) {
        for (const o of ev.orders || []) {
          const id = o.order_id || o.orderId;
          const status = o.status || o.order_status;
          if (id && status) onStatus(id, status);
        }
        if (ev.order_id && ev.status) onStatus(ev.order_id, ev.status);
      }
      if (msg.order_id && msg.status) onStatus(msg.order_id, msg.status);
    });
    ws.on('close', () => { console.warn('Coinbase user WS closed'); schedule(); });
    ws.on('error', (e) => console.warn('WS error', e.message));
  };
  const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; connect(); }, 5000); };
  connect();
  return { close() { try { if (ws) ws.close(); } catch { /* ignore */ } } };
}

export function startCoinbaseTickerWs(pairs, onTick) {
  const products = [...new Set((pairs || []).map((p) => String(p || '').toUpperCase()).filter(Boolean))];
  if (!products.length) return { close() {} };
  let ws = null;
  let timer = null;
  const connect = () => {
    try { ws = new WebSocket(COINBASE_MARKET_WS); }
    catch (e) { console.warn('Coinbase ticker WS create', e.message); schedule(); return; }
    ws.on('open', () => {
      console.log('Coinbase ticker WS ' + products.join(','));
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats', product_ids: products.slice(0, 1) }));
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'ticker', product_ids: products }));
    });
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.channel === 'heartbeats' || msg.channel === 'subscriptions') return;
      for (const ev of msg.events || []) {
        for (const tk of ev.tickers || []) {
          const rec = noteTicker(tk.product_id, tk.best_bid || tk.bid, tk.best_ask || tk.ask, tk.price);
          if (rec && onTick) onTick(rec);
        }
      }
    });
    ws.on('close', () => { console.warn('Coinbase ticker WS closed'); schedule(); });
    ws.on('error', (e) => console.warn('Coinbase ticker WS', e.message));
  };
  const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; connect(); }, 4000); };
  connect();
  return { close() { try { if (ws) ws.close(); } catch { /* ignore */ } } };
}
