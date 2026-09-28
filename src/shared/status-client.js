import { bankedTotalUsd, bankedRunUsd } from './bank.js';

const url = () => process.env.STATUS_URL || '';
const token = () => process.env.STATUS_TOKEN || '';

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
  fetch(dest.replace(/\/$/, '') + '/status', { method: 'POST', headers: headers(), body })
    .catch((e) => console.warn('status post', e.message));
}

export function postFill(fill) {
  const dest = url();
  if (!dest || !fill) return;
  const body = JSON.stringify({
    bot: process.env.BOT || 'ladder',
    fill: { ...fill, ts: fill.ts || new Date().toISOString() },
  });
  fetch(dest.replace(/\/$/, '') + '/fill', { method: 'POST', headers: headers(), body })
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
    fetch(dest.replace(/\/$/, '') + '/mids', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ bot: process.env.BOT || 'ladder', mids }),
    }).catch((e) => console.warn('mids post', e.message));
  }, Number(process.env.MID_POST_MS || 400));
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
  fetch(dest.replace(/\/$/, '') + '/orders', { method: 'POST', headers: headers(), body })
    .catch((e) => console.warn('orders post', e.message));
}
