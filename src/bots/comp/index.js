process.env.BOT_CONFIG = 'configs/comp.env';
process.env.EXCHANGE = 'kraken';
process.env.QUOTE = process.env.QUOTE || 'USD';
process.env.SYMBOLS = process.env.SYMBOLS || 'GNOT';
process.env.PORTFOLIO_FRACTION = process.env.PORTFOLIO_FRACTION || '0';
process.env.MM_MAX_PAIRS = process.env.MM_MAX_PAIRS || '2';
if (process.env.INV_FRACTION && !process.env.MM_INVENTORY_FRACTION) {
  process.env.MM_INVENTORY_FRACTION = process.env.INV_FRACTION;
}
const { main } = await import('../ladder/index.js');
main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
