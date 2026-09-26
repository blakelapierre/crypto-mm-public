import crypto from 'crypto';
import qs from 'querystring';
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
export async function krakenPublic(endpoint, params = {}) {
  const q = qs.stringify(params);
  const res = await fetch(`${KRAKEN_BASE}/0/public/${endpoint}${q ? '?' + q : ''}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(' | '));
  return data.result;
}
