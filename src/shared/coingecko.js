const COINGECKO = process.env.COINGECKO_URL || 'https://api.coingecko.com/api/v3';

export async function getMarketCapRanking(limit = 40) {
  const per = Math.min(250, Math.max(1, Number(limit) || 40));
  const url = `${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${per}&page=1&sparkline=false`;
  const headers = { accept: 'application/json' };
  const key = process.env.COINGECKO_API_KEY || process.env.COINGECKO_DEMO_API_KEY || '';
  if (key) {
    headers['x-cg-demo-api-key'] = key;
    headers['x-cg-pro-api-key'] = key;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('CoinGecko ' + res.status + (body ? ': ' + body.slice(0, 160) : ''));
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('CoinGecko unexpected payload');
  return data.map((c) => ({ symbol: String(c.symbol || '').toUpperCase(), market_cap: Number(c.market_cap) || 0 }));
}
