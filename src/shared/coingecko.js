const COINGECKO = 'https://api.coingecko.com/api/v3';
export async function getMarketCapRanking(limit = 40) {
  const res = await fetch(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`);
  if (!res.ok) throw new Error('CoinGecko failed');
  return (await res.json()).map((c) => ({ symbol: String(c.symbol || '').toUpperCase(), market_cap: Number(c.market_cap) || 0 }));
}
