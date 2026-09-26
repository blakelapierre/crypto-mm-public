export function formatPrice(p, d) { return Number(Number(p).toFixed(d)); }
export function formatVolume(v, d) { return Number(Number(v).toFixed(d)); }
export function safeSpend(cfg, a) { return Math.max(0, Number(a) * cfg.capitalSafetyMargin); }
export function safeQuoteSize(cfg, q) {
  return Math.max(0, Number(((Number(q) * cfg.orderSizeHaircut) / (1 + cfg.feeBufferPct)).toFixed(2)));
}
export function calculateVolume(cfg, mid, sizeUsd, ordermin, lotDecimals) {
  let v = sizeUsd / mid;
  const minV = (ordermin || 0) * cfg.volumeSafetyMargin;
  if (v < minV) v = minV;
  return formatVolume(v, lotDecimals);
}
export function normalizeAsset(code) {
  let a = String(code || '').toUpperCase().replace(/^X/, '').replace(/^Z/, '');
  if (a === 'XBT' || a === 'XXBT') return 'BTC';
  if (a === 'XDG') return 'DOGE';
  return a;
}
