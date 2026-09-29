import crypto from 'crypto';
import qs from 'querystring';
import WebSocket from 'ws';
import { noteApi } from './api-timing.js';

const KRAKEN_BASE = 'https://api.kraken.com';

function krakenSign(reqPath, postData, secret) {
  const nonce = postData.nonce;
  const message = qs.stringify(postData);
  const hash = crypto.createHash('sha256').update(nonce + message).digest();
  const hmac = crypto.createHmac('sha512', Buffer.from(secret, 'base64'));
  hmac.update(reqPath); hmac.update(hash);
  return hmac.digest('base64');
}

let nonceSeq = 0;
let privateChain = Promise.resolve();
function nextNonce() {
  const n = Date.now() * 1000 + (nonceSeq = (nonceSeq + 1) % 1000);
  return n;
}
export async function krakenPrivate(cfg, endpoint, params = {}) {
  const run = async () => {
    const t0 = Date.now();
    try {
      const reqPath = '/0/private/' + endpoint;
      const nonce = nextNonce();
      const body = { nonce: String(nonce), ...params };
      const res = await fetch(KRAKEN_BASE + reqPath, {
        method: 'POST',
        headers: { 'API-Key': cfg.krakenApiKey, 'API-Sign': krakenSign(reqPath, body, cfg.krakenApiSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs.stringify(body),
      });
      const data = await res.json();
      noteApi('kraken', endpoint, Date.now() - t0, !(data.error && data.error.length));
      if (data.error && data.error.length) throw new Error(data.error.join(' | '));
      return data.result;
    } catch (e) {
      noteApi('kraken', endpoint, Date.now() - t0, false);
      throw e;
    }
  };
  const queued = privateChain.then(run, run);
  privateChain = queued.catch(() => {});
  return queued;
}

export function startKrakenUserWs(cfg, onStatus) {
  if (!cfg.useUserWebsocket || cfg.dryRun || !cfg.krakenApiKey) return { close() {} };
  let ws = null;
  let timer = null;
  let closed = false;
  let backoff = 5000;
  let cachedTok = null;
  async function token() {
    if (cachedTok) return cachedTok;
    const r = await krakenPrivate(cfg, 'GetWebSocketsToken');
    cachedTok = r && r.token;
    return cachedTok;
  }
  function handle(msg) {
    if (!Array.isArray(msg)) return;
    const channel = msg.find((x) => x === 'ownTrades' || x === 'openOrders');
    if (!channel) return;
    const payload = msg[0];
    if (!payload) return;
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [id, o] of Object.entries(row)) {
        if (!o || typeof o !== 'object') continue;
        if (channel === 'ownTrades' || o.ordertxid) {
          onStatus(o.ordertxid || id, 'FILLED', {
            filledSize: parseFloat(o.vol || 0) || 0,
            avgPrice: parseFloat(o.price || 0) || 0,
            filledValue: parseFloat(o.cost || 0) || 0,
            fee: parseFloat(o.fee || 0) || 0,
            ordertype: o.ordertype || o.orderType,
            taker: /market/i.test(String(o.ordertype || o.orderType || '')),
          });
        } else if (channel === 'openOrders') {
          const raw = String(o.status || '').toLowerCase();
          if (!raw) continue;
          const map = { closed: 'FILLED', open: 'OPEN', pending: 'OPEN', canceled: 'CANCELLED', cancelled: 'CANCELLED', expired: 'EXPIRED' };
          const st = map[raw];
          if (!st) continue;
          onStatus(id, st, { filledSize: parseFloat(o.vol_exec || 0) || 0, avgPrice: parseFloat(o.avg_price || o.avgPrice || 0) || 0 });
        }
      }
    }
  }
  const connect = async () => {
    if (closed) return;
    let tok;
    try { tok = await token(); } catch (e) { console.warn('Kraken WS token', e.message); cachedTok = null; schedule(); return; }
    if (!tok) { schedule(); return; }
    try { ws = new WebSocket('wss://ws-auth.kraken.com'); } catch (e) { console.warn('Kraken WS create', e.message); schedule(); return; }
    ws.on('open', () => {
      console.log('Kraken user WS connected');
      backoff = 5000;
      ws.send(JSON.stringify({ event: 'subscribe', subscription: { name: 'ownTrades', token: tok } }));
      ws.send(JSON.stringify({ event: 'subscribe', subscription: { name: 'openOrders', token: tok } }));
    });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg && msg.event === 'subscriptionStatus' && msg.status === 'error') {
        console.warn('Kraken WS sub', msg.errorMessage || msg.error || JSON.stringify(msg));
        cachedTok = null;
        return;
      }
      if (msg && (msg.event === 'heartbeat' || msg.event === 'systemStatus' || msg.event === 'subscriptionStatus')) return;
      handle(msg);
    });
    ws.on('close', () => { if (!closed) { console.warn('Kraken user WS closed'); schedule(); } });
    ws.on('error', (e) => console.warn('Kraken WS', e.message));
  };
  const schedule = () => {
    if (timer || closed) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60000);
    timer = setTimeout(() => { timer = null; connect(); }, wait);
  };
  connect();
  return { close() { closed = true; try { if (ws) ws.close(); } catch { /* ignore */ } } };
}

export function toWsPair(pair) {
  const s = String(pair || '');
  if (!s || s.includes('/')) return s;
  return s.replace(/(USD[CT]?|EUR|GBP)$/i, '/$1');
}

export function startKrakenTickerWs(pairs, onTick) {
  const list = [...new Set((pairs || []).map(toWsPair).filter(Boolean))];
  if (!list.length) return { close() {}, setPairs() {} };
  let ws = null;
  let timer = null;
  let closed = false;
  let want = list;
  function subscribe(sock, names) {
    if (!sock || sock.readyState !== 1 || !names.length) return;
    sock.send(JSON.stringify({ event: 'subscribe', pair: names, subscription: { name: 'ticker' } }));
  }
  const connect = () => {
    if (closed) return;
    try { ws = new WebSocket('wss://ws.kraken.com'); } catch (e) { console.warn('Kraken ticker WS', e.message); schedule(); return; }
    ws.on('open', () => { console.log('Kraken ticker WS ' + want.join(',')); subscribe(ws, want); });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg && msg.event === 'subscriptionStatus') {
        if (msg.status === 'error') console.warn('Kraken ticker sub', msg.errorMessage || JSON.stringify(msg));
        else console.log('Kraken ticker sub', msg.status, msg.pair || msg.channelName || '');
        return;
      }
      if (!Array.isArray(msg)) return;
      const ch = msg[2] || msg[1];
      if (ch !== 'ticker') return;
      const data = msg[1] || {};
      const pair = msg[3] || msg[4];
      const bid = parseFloat((data.b && data.b[0]) || 0);
      const ask = parseFloat((data.a && data.a[0]) || 0);
      const last = parseFloat((data.c && data.c[0]) || 0);
      if (!(bid > 0 && ask > 0) && !(last > 0)) return;
      onTick({ pair, bid: bid || last, ask: ask || last, mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : last });
    });
    ws.on('close', () => { if (!closed) schedule(); });
    ws.on('error', (e) => console.warn('Kraken ticker', e.message));
  };
  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; connect(); }, 5000);
  };
  connect();
  return {
    close() { closed = true; try { if (ws) ws.close(); } catch { /* ignore */ } },
    setPairs(next) { want = [...new Set((next || []).map(toWsPair).filter(Boolean))]; subscribe(ws, want); },
  };
}

export async function krakenPublic(endpoint, params = {}) {
  const t0 = Date.now();
  try {
    const q = qs.stringify(params);
    const res = await fetch(KRAKEN_BASE + '/0/public/' + endpoint + (q ? '?' + q : ''));
    const data = await res.json();
    noteApi('kraken', 'PUB ' + endpoint, Date.now() - t0, !(data.error && data.error.length));
    if (data.error && data.error.length) throw new Error(data.error.join(' | '));
    return data.result;
  } catch (e) {
    noteApi('kraken', 'PUB ' + endpoint, Date.now() - t0, false);
    throw e;
  }
}
