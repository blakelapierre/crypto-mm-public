import { bankedTotalUsd } from './bank.js';

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
  const body = JSON.stringify({ ...payload, banked: bankedTotalUsd(), ts: Date.now() });
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
