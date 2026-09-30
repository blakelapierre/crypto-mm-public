import { loadProjectEnv, baseConfig } from '../shared/env.js';
import { bankAuthCfg, dumpBankToTrade, refreshBankHoldings } from '../shared/bank.js';
import { createExchange } from '../shared/exchange.js';
import { coinbaseRequest } from '../shared/coinbase.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/ladder.env');

const pct = Number(String(process.argv[2] || process.env.BANK_CASH_PCT || '50').replace(/%/g, ''));
if (!(pct > 0 && pct <= 100)) {
  console.error('Usage: npm run bank-cash -- 50');
  process.exit(1);
}

const cfg = baseConfig();
cfg.exchange = 'coinbase';
const auth = bankAuthCfg(cfg);
if (!(auth.coinbaseApiKey && (auth.coinbaseApiSecret || auth.coinbaseSecretFile))) {
  console.error('Set BANK_COINBASE_API_KEY (bank key must allow trade + transfer)');
  process.exit(1);
}

const quote = String(cfg.quote || 'USDC').toUpperCase();
const stables = new Set(['USDC', 'USD', 'USDT', 'DAI', quote]);

async function main() {
  const ex = createExchange({ ...auth, exchange: 'coinbase', quote, dryRun: false });
  const products = await ex.getProducts();
  const accts = await coinbaseRequest(auth, 'GET', '/api/v3/brokerage/accounts?limit=250');
  const jobs = [];
  for (const a of accts.accounts || []) {
    const cur = String(a.currency || '').toUpperCase();
    const avail = parseFloat((a.available_balance && a.available_balance.value) || 0) || 0;
    if (!cur || stables.has(cur) || !(avail > 0)) continue;
    const info = products[cur];
    if (!info || !info.pair) {
      console.log('  skip ' + cur + ' no ' + quote + ' market');
      continue;
    }
    const sell = avail * (pct / 100);
    const minV = (info.ordermin || 0) * 1.05;
    if (!(sell >= minV)) {
      console.log('  skip ' + cur + ' qty ' + sell + ' < min ' + minV);
      continue;
    }
    jobs.push({ cur, pair: info.pair, sell, minV });
  }
  console.log('bank-cash ' + pct + '% -> ' + quote + ' n=' + jobs.length);
  for (const j of jobs) {
    try {
      console.log('  SELL ' + j.cur + ' ' + j.sell + ' ' + j.pair);
      await ex.marketSell(j.pair, j.sell);
    } catch (e) { console.warn('  sell fail ' + j.cur, e.message); }
  }
  await new Promise((r) => setTimeout(r, 2500));
  console.log('move ' + pct + '% of bank ' + quote + ' -> trade');
  await dumpBankToTrade(cfg, pct / 100);
  try { await refreshBankHoldings(cfg); } catch { /* ignore */ }
}

main().catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
