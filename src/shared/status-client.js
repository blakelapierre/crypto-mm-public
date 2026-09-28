import { bankedTotalUsd } from './bank.js';

const url = () => process.env.STATUS_URL || '';
const token = () => process.env.STATUS_TOKEN || '';

export function postStatus(payload) {
  const dest = url();
  if (!dest) return;
  const body = JSON.stringify({ ...payload, banked: bankedTotalUsd(), ts: Date.now() });
  fetch(dest.replace(/\/$/, '') + '/status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { 'X-Status-Token': token() } : {}),
    },
    body,
  }).catch((e) => console.warn('status post', e.message));
}
