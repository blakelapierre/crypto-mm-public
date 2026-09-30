import { loadProjectEnv, baseConfig } from '../shared/env.js';
import { dumpBankToTrade, dumpTradeToBank } from '../shared/bank.js';

loadProjectEnv(process.env.BOT_CONFIG || 'configs/ladder.env');

const args = process.argv.slice(2).map((s) => String(s));
function pctOf(raw) {
  return Number(String(raw == null ? '' : raw).replace(/%/g, ''));
}

const cfg = baseConfig();
cfg.exchange = 'coinbase';

const a0 = String(args[0] || '').toLowerCase();
const a1 = String(args[1] || '').toLowerCase();
let dir = 'bank-to-trade';
let pct = pctOf(args[0] != null ? args[0] : process.env.BANK_DUMP_PCT || '50');
if (a0 === 'tradebot' && a1 === 'bank') {
  dir = 'trade-to-bank';
  pct = pctOf(args[2] != null ? args[2] : '100');
} else if (a0 === 'bank' && (a1 === 'tradebot' || a1 === 'trade')) {
  dir = 'bank-to-trade';
  pct = pctOf(args[2] != null ? args[2] : '50');
}

if (!(pct > 0 && pct <= 100)) {
  console.error('Usage:');
  console.error('  npm run dump -- 50');
  console.error('  npm run dump -- bank tradebot 50');
  console.error('  npm run dump -- tradebot bank 100');
  process.exit(1);
}

if (dir === 'bank-to-trade') {
  if (!(process.env.BANK_COINBASE_API_KEY || process.env.BANK_API_KEY || process.env.COINBASE_BANK_API_KEY)) {
    console.error('Set BANK_COINBASE_API_KEY for bank -> trade');
    process.exit(1);
  }
  dumpBankToTrade(cfg, pct / 100).catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
} else {
  dumpTradeToBank(cfg, pct / 100).catch((e) => { console.error('Fatal:', e.message || e); process.exit(1); });
}
