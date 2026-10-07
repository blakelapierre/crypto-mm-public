process.env.BOT = process.env.BOT || 'margin';
process.env.BOT_CONFIG = process.env.BOT_CONFIG || 'configs/margin.env';
process.env.EXCHANGE = process.env.EXCHANGE || 'kraken';
process.env.QUOTE = process.env.QUOTE || 'USD';
process.env.MARGIN_LEVERAGE = process.env.MARGIN_LEVERAGE || '2';
process.env.PORTFOLIO_FRACTION = process.env.PORTFOLIO_FRACTION || '0';
process.env.BANK_START_PCT = process.env.BANK_START_PCT || '0';
// SHORT_BOOK=0 keeps the old behavior: the long ladder with leverage on both sides.
const mod = process.env.SHORT_BOOK === '0' ? '../ladder/index.js' : './short.js';
const { main } = await import(mod);
main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
