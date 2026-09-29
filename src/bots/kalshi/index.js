import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig } from '../../shared/env.js';
import { postStatus } from '../../shared/status-client.js';
import { logSession, logEvent } from '../../shared/fill-log.js';
import { listIncentivePrograms, listOpenMarkets, getMarket, getBalance, placeYesBid } from '../../shared/kalshi.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/kalshi.env');
process.env.BOT = process.env.BOT || 'kalshi';
const cfg = baseConfig();

function score(p) {
  return Number(p.total_rewards || p.reward_pool || p.reward_amount || p.estimated_reward || 0)
    || Number(p.discount_factor || 0) * 100
    || Number(p.target_size || 0);
}

function tickersOf(p) {
  const raw = p.market_tickers || p.tickers || p.markets || [];
  if (Array.isArray(raw)) {
    return raw.map((x) => (typeof x === 'string' ? x : x.ticker || x.market_ticker)).filter(Boolean);
  }
  if (p.market_ticker) return [p.market_ticker];
  if (p.event_ticker) return [];
  return [];
}

async function pickMarkets() {
  const data = await listIncentivePrograms(process.env.KALSHI_INCENTIVE_STATUS || 'active');
  const programs = data.incentive_programs || data.incentives || data.programs || [];
  programs.sort((a, b) => score(b) - score(a));
  console.log('kalshi incentives n=' + programs.length);
  const top = programs.slice(0, Number(process.env.KALSHI_MAX_PROGRAMS || 8));
  const tickers = [];
  for (const p of top) {
    const ts = tickersOf(p);
    console.log('  ' + (p.incentive_id || p.id || p.title || p.event_ticker || '?') +
      ' score=' + score(p) + ' tickers=' + (ts.join(',') || p.event_ticker || ''));
    tickers.push(...ts);
  }
  const unique = [...new Set(tickers)].slice(0, Number(process.env.KALSHI_MAX_MARKETS || 6));
  if (!unique.length && top[0] && top[0].event_ticker) {
    const mk = await listOpenMarkets();
    const ev = new Set(top.map((p) => p.event_ticker).filter(Boolean));
    return (mk.markets || []).filter((m) => ev.has(m.event_ticker)).slice(0, Number(process.env.KALSHI_MAX_MARKETS || 6));
  }
  if (!unique.length) return [];
  const mk = await listOpenMarkets(unique);
  return mk.markets || [];
}

async function main() {
  logSession({ exchange: 'kalshi', quote: 'USD' });
  let markets = [];
  try {
    markets = await pickMarkets();
  } catch (e) {
    console.warn('incentive list', e.message);
  }
  if (!markets.length) console.log('no incentive markets yet — set KALSHI_API_KEY + KALSHI_API_SECRET_FILE');

  const clip = Number(process.env.KALSHI_CLIP || 2);
  const half = Number(process.env.KALSHI_HALF_CENTS || 2) / 100;
  while (true) {
    const rows = [];
    for (const m of markets) {
      try {
        const det = (await getMarket(m.ticker)).market || m;
        const bid = Number(det.yes_bid_dollars || det.yes_bid || 0);
        const ask = Number(det.yes_ask_dollars || det.yes_ask || 0);
        const mid = bid && ask ? (bid + ask) / 2 : Number(det.last_price_dollars || det.last_price || 0.5);
        const px = Math.max(0.01, Math.min(0.99, mid - half));
        rows.push({
          symbol: det.ticker || m.ticker,
          pair: det.ticker || m.ticker,
          mid, bids: 0, asks: 0, bidUsd: 0, askUsd: 0, buyUsd: 0, sellUsd: 0,
          vol: '', w: '', fee: '',
        });
        if (!cfg.dryRun && mid > 0) {
          try {
            const r = await placeYesBid(det.ticker || m.ticker, clip, px);
            logEvent('place', { pair: det.ticker, symbol: det.ticker, side: 'buy', price: px, size: clip, id: r.order && r.order.order_id, mid });
            console.log('  YES bid ' + det.ticker + ' ' + clip + ' @ ' + px);
          } catch (e) {
            console.warn('  order ' + (det.ticker || '') + ' ' + e.message);
          }
        } else {
          console.log('  [dry] YES ' + (det.ticker || m.ticker) + ' mid=' + mid + ' bid@' + px);
        }
      } catch (e) {
        console.warn('market', m.ticker, e.message);
      }
      await sleep(200);
    }
    let bal = {};
    try { bal = await getBalance(); } catch { /* no key */ }
    postStatus({
      bot: 'kalshi', exchange: 'kalshi', quote: 'USD',
      pnl: { walletGain: 0, lastEquity: Number(bal.balance || bal.available_balance || 0) / 100 },
      markets: rows,
    });
    await sleep(Number(process.env.UPDATE_INTERVAL_MS || 15000));
    try { markets = await pickMarkets(); } catch { /* keep */ }
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
