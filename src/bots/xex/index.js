import { setTimeout as sleep } from 'timers/promises';
import { loadProjectEnv, baseConfig, STABLECOINS } from '../../shared/env.js';
import { createExchange } from '../../shared/exchange.js';
import { getMarketCapRanking } from '../../shared/coingecko.js';
import { scanAndTrade, requiredBps } from './strategy.js';
loadProjectEnv('configs/xex.env');
const cfg = baseConfig();
const ex = createExchange(cfg, new Map());
async function main() {
  console.log(`BOT=xex quote=${cfg.quote} dryRun=${cfg.dryRun} minEdge=${requiredBps(cfg)}bps`);
  if (!cfg.krakenApiKey || !cfg.krakenApiSecret) throw new Error('Need Kraken keys');
  const cbMap = await ex.getProducts('coinbase');
  const krMap = await ex.getProducts('kraken');
  const ranking = await getMarketCapRanking(25);
  const universe = [];
  for (const row of ranking) {
    if (STABLECOINS.has(row.symbol)) continue;
    if (cbMap[row.symbol] && krMap[row.symbol]) universe.push({ symbol: row.symbol, cb: cbMap[row.symbol], kr: krMap[row.symbol] });
    if (universe.length >= cfg.mmMaxPairs) break;
  }
  let gross = 0, lastTrade = 0;
  while (true) {
    for (const u of universe) {
      try {
        if (Date.now() - lastTrade < cfg.cooldownMs) { await sleep(200); continue; }
        const traded = await scanAndTrade(cfg, ex, u.symbol, u.cb, u.kr, gross);
        if (traded > 0) { gross += traded; lastTrade = Date.now(); }
      } catch (e) { console.error(u.symbol, e.message); }
      await sleep(cfg.rateLimitMs);
    }
    await sleep(cfg.updateIntervalMs);
  }
}
main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
