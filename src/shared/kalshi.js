import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const BASE = process.env.KALSHI_BASE || 'https://api.elections.kalshi.com';

function loadPem() {
  const file = process.env.KALSHI_API_SECRET_FILE || process.env.KALSHI_KEY_FILE;
  if (file && fs.existsSync(path.resolve(process.cwd(), file))) {
    return fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
  }
  return process.env.KALSHI_API_SECRET || process.env.KALSHI_PRIVATE_KEY || '';
}

function sign(pem, text) {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType === 'ed25519') {
    return crypto.sign(null, Buffer.from(text), key).toString('base64');
  }
  const s = crypto.createSign('RSA-SHA256');
  s.update(text);
  s.end();
  return s.sign({
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}

export async function kalshiRequest(method, apiPath, body = null) {
  const urlPath = apiPath.startsWith('/trade-api') ? apiPath : '/trade-api/v2' + apiPath;
  const qs = urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '';
  const pathNoQ = urlPath.split('?')[0];
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const keyId = process.env.KALSHI_API_KEY || process.env.KALSHI_ACCESS_KEY || '';
  const pem = loadPem();
  if (keyId && pem) {
    const ts = String(Date.now());
    headers['KALSHI-ACCESS-KEY'] = keyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = ts;
    headers['KALSHI-ACCESS-SIGNATURE'] = sign(pem, ts + method.toUpperCase() + pathNoQ);
  }
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(BASE + pathNoQ + qs, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error('Kalshi ' + res.status + ' ' + method + ' ' + pathNoQ + ': ' + text.slice(0, 300));
  return data;
}

export async function listIncentivePrograms(status = 'active') {
  return kalshiRequest('GET', '/incentive_programs?status=' + encodeURIComponent(status));
}

export async function listOpenMarkets(tickers) {
  const q = tickers && tickers.length
    ? '/markets?status=open&tickers=' + encodeURIComponent(tickers.join(','))
    : '/markets?status=open&limit=200';
  return kalshiRequest('GET', q);
}

export async function getMarket(ticker) {
  return kalshiRequest('GET', '/markets/' + encodeURIComponent(ticker));
}

export async function getBalance() {
  return kalshiRequest('GET', '/portfolio/balance');
}

export async function placeYesBid(ticker, count, priceDollars) {
  return kalshiRequest('POST', '/portfolio/orders', {
    ticker,
    side: 'yes',
    action: 'buy',
    count: Number(count),
    type: 'limit',
    yes_price_dollars: String(Number(priceDollars).toFixed(4)),
  });
}
