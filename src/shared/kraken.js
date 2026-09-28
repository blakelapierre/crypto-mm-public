import crypto from 'crypto';
import qs from 'querystring';
import WebSocket from 'ws';

const KRAKEN_BASE = 'https://api.kraken.com';

function krakenSign(reqPath, postData, secret) {
  const nonce = postData.nonce;
  const message = qs.stringify(postData);
  const hash = crypto.createHash('sha256').update(nonce + message).digest();
  const hmac = crypto.createHmac('sha512', Buffer.from(secret, 'base64'));
  hmac.update(reqPath); hmac.update(hash);
  return hmac.digest('base64');
}

export async function krakenPrivate(cfg, endpoint, params = {}) {
  const reqPath = `/0/private/${endpoint}`;
  const nonce = Date.now() * 1000;
  const body = { nonce, ...params };
  const res = await fetch(KRAKEN_BASE + reqPath, {
    method: 'POST',
    headers: { 'API-Key': cfg.krakenApiKey, 'API-Sign': krakenSign(reqPath, body, cfg.krakenApiSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qs.stringify(body),
  });
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(' | '));
  return data.result;
}

export function startKrakenUserWs(cfg, onStatus) {
  if (!cfg.useUserWebsocket || cfg.dryRun || !cfg.krakenApiKey) return { close() {} };
  let ws = null;
  let timer = null;
  let closed = false;
  async function token() {
    const r = await krakenPrivate(cfg, 'GetWebSocketsToken');
    return r && r.token;
  }
  function handle(msg) {
    if (!Array.isArray(msg)) return;
    const channel = msg[1] || msg[msg.length - 1];
    const payload = msg[0];
    if (!payload) return;
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      const entries = typeof row === 'object' && !Array.isArray(row) ? Object.entries(row) : [];
      for (const [id, o] of entries) {
        if (channel === 'ownTrades' || o.ordertxid) {
          onStatus(o.ordertxid || id, 'FILLED', {
            filledSize: parseFloat(o.vol || 0) || 0,
            avgPrice: parseFloat(o.price || 0) || 0,
            filledValue: parseFloat(o.cost || 0) || 0,
            fee: parseFloat(o.fee || 0) || 0,
          });
        } else if (channel === 'openOrders' || o.status) {
          const map = { closed: 'FILLED', open: 'OPEN', canceled: 'CANCELLED', cancelled: 'CANCELLED', expired: 'EXPIRED' };
          const st = map[String(o.status || '').toLowerCase()] || String(o.status || '').toUpperCase();
          onStatus(id, st, {
            filledSize: parseFloat(o.vol_exec || 0) || 0,
            avgPrice: parseFloat(o.avg_price || o.avgPrice || 0) || 0,
          });
        }
      }
    }
  }
  const connect = async () => {
    if (closed) return;
    let tok;
    try { tok = await token(); } catch (e) { console.warn('Kraken WS token', e.message); schedule(); return; }
    if (!tok) { schedule(); return; }
    try { ws = new WebSocket('wss://ws-auth.kraken.com'); } catch (e) { console.warn('Kraken WS create', e.message); schedule(); return; }
    ws.on('open', () => {
      console.log('Kraken user WS connected');
      ws.send(JSON.stringify({ event: 'subscribe', subscription: { name: 'ownTrades', token: tok } }));
      ws.send(JSON.stringify({ event: 'subscribe', subscription: { name: 'openOrders', token: tok } }));
    });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.event === 'heartbeat' || msg.event === 'systemStatus' || msg.event === 'subscriptionStatus') return;
      handle(msg);
    });
    ws.on('close', () => { if (!closed) { console.warn('Kraken user WS closed'); schedule(); } });
    ws.on('error', (e) => console.warn('Kraken WS', e.message));
  };
  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; connect(); }, 5000);
  };
  connect();
  return { close() { closed = true; try { ws && ws.close(); } catch { /* ignore */ } } };
}

export async function krakenPublic(endpoint, params = {}) {
  const q = qs.stringify(params);
  const res = await fetch(`${KRAKEN_BASE}/0/public/${endpoint}${q ? '?' + q : ''}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(' | '));
  return data.result;
}
