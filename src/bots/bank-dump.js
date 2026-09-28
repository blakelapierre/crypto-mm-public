import { loadProjectEnv, baseConfig } from '../shared/env.js';
import { dumpBankToTrade } from '../shared/bank.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/ladder.env');

const arg = process.argv[2];
const raw = arg != null && arg !== '' ? arg : process.env.BANK_DUMP_PCT || '50';
const pct = Number(String(raw).replace(/%/g, ''));
if (!(pct > 0 && pct <= 100)) {
  console.error('Usage: node src/bots/bank-dump.js [percent]   default 50');
  process.exit(1);
}

const cfg = baseConfig();
if (process.env.COINBASE_BANK_API_KEY) cfg.coinbaseApiKey = process.env.COINBASE_BANK_API_KEY;
if (process.env.COINBASE_BANK_API_SECRET) cfg.coinbaseApiSecret = process.env.COINBASE_BANK_API_SECRET;
if (process.env.COINBASE_BANK_API_SECRET_FILE) {
  process.env.COINBASE_API_SECRET_FILE = process.env.COINBASE_BANK_API_SECRET_FILE;
}
if (!cfg.coinbaseApiKey) {
  console.error('Set COINBASE_BANK_API_KEY and COINBASE_BANK_API_SECRET or COINBASE_BANK_API_SECRET_FILE');
  process.exit(1);
}
cfg.exchange = 'coinbase';

dumpBankToTrade(cfg, pct / 100).catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
