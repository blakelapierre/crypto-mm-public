process.env.BOT = process.env.BOT || 'margin';
process.env.BOT_CONFIG = process.env.BOT_CONFIG || 'configs/margin.env';
process.env.EXCHANGE = process.env.EXCHANGE || 'kraken';
process.env.QUOTE = process.env.QUOTE || 'USD';
process.env.PORTFOLIO_FRACTION = process.env.PORTFOLIO_FRACTION || '0';
process.env.BANK_START_PCT = process.env.BANK_START_PCT || '0';
process.env.MARGIN_LEVERAGE = process.env.MARGIN_LEVERAGE || '2';
process.env.MM_MAX_PAIRS = process.env.MM_MAX_PAIRS || process.env.MM_MAX_PAIRS || '4';
if (process.env.INV_FRACTION && !process.env.MM_INVENTORY_FRACTION) {
  process.env.MM_INVENTORY_FRACTION = process.env.INV_FRACTION;
}
const { main } = await import('../ladder/index.js');
main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
