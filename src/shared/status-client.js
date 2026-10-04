import { bankedTotalUsd, bankedRunUsd } from './bank.js';

const url = () => process.env.STATUS_URL || ('http://127.0.0.1:' + (process.env.STATUS_PORT || 8787));
const token = () => process.env.STATUS_TOKEN || '';
function base() {
  return String(url() || '').replace(/\/$/, '').replace(/\/(status|fill|mids|orders)$/,'');
}

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(token() ? { 'X-Status-Token': token() } : {}),
  };
}

export function postStatus(payload) {
  const dest = url();
  if (!dest) return;
  const body = JSON.stringify({ ...payload, banked: bankedTotalUsd(), bankedRun: bankedRunUsd(), ts: Date.now() });
  fetch(base() + '/status', { method: 'POST', headers: headers(), body })
    .catch((e) => console.warn('status post', e.message));
}

export function postFill(fill) {
  const dest = url();
  if (!dest || !fill) return;
  const body = JSON.stringify({
    bot: process.env.BOT || 'ladder',
    fill: { ...fill, ts: fill.ts || new Date().toISOString() },
  });
  fetch(base() + '/fill', { method: 'POST', headers: headers(), body })
    .catch((e) => console.warn('fill post', e.message));
}

const midBuf = new Map();
let midTimer = null;
export function postMids(rows) {
  const dest = url();
  if (!dest || !rows || !rows.length) return;
  for (const r of rows) {
    if (!r || !r.symbol || !(Number(r.mid) > 0)) continue;
    midBuf.set(String(r.symbol).toUpperCase(), r);
  }
  if (midTimer) return;
  midTimer = setTimeout(() => {
    midTimer = null;
    const mids = [...midBuf.values()];
    midBuf.clear();
    if (!mids.length) return;
    fetch(base() + '/mids', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ bot: process.env.BOT || 'ladder', exchange: process.env.EXCHANGE || '', mids }),
    }).catch((e) => console.warn('mids post', e.message));
  }, Number(process.env.MID_POST_MS || 400));
}

export async function pullVenueScan(exchange) {
  const dest = url();
  if (!dest) return null;
  try {
    const r = await fetch(base() + '/scan?exchange=' + encodeURIComponent(exchange || process.env.EXCHANGE || ''), { headers: headers() });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
export function postVenueScan(exchange, ranked) {
  const dest = url();
  if (!dest || !ranked) return;
  fetch(base() + '/scan', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ exchange: exchange || process.env.EXCHANGE || '', bot: process.env.BOT || '', ranked: ranked.slice(0, 40) }),
  }).catch(() => {});
}
export async function pullVenueMids(exchange) {
  const dest = url();
  if (!dest) return [];
  try {
    const r = await fetch(base() + '/mids?exchange=' + encodeURIComponent(exchange || process.env.EXCHANGE || ''), { headers: headers() });
    if (!r.ok) return [];
    const j = await r.json();
    return j.mids || [];
  } catch { return []; }
}

export async function pullLiveConfig(bot) {
  const dest = url();
  if (!dest) return null;
  try {
    const r = await fetch(base() + '/live-config?bot=' + encodeURIComponent(bot || process.env.BOT || 'ladder'), { headers: headers() });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export function postOrders(symbol, orders, extra = {}) {
  const dest = url();
  if (!dest || !symbol) return;
  const body = JSON.stringify({
    bot: process.env.BOT || 'ladder',
    symbol,
    orders,
    ...extra,
  });
  fetch(base() + '/orders', { method: 'POST', headers: headers(), body })
    .catch((e) => console.warn('orders post', e.message));
}
