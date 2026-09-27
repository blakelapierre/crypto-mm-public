export function formatPrice(p, d) {
  return Number(Number(p).toFixed(d));
}
export function formatVolume(v, d) {
  return Number(Number(v).toFixed(d));
}
export function safeSpend(cfg, a) {
  return Math.max(0, Number(a) * cfg.capitalSafetyMargin);
}
export function safeQuoteSize(cfg, q) {
  return Math.max(
    0,
    Number(((Number(q) * cfg.orderSizeHaircut) / (1 + cfg.feeBufferPct)).toFixed(2))
  );
}
export function calculateVolume(cfg, mid, sizeUsd, ordermin, lotDecimals) {
  let v = sizeUsd / mid;
  const minV = (ordermin || 0) * cfg.volumeSafetyMargin;
  if (v < minV) v = minV;
  return formatVolume(v, lotDecimals);
}

const KRAKEN_ASSET_MAP = {
  XXBT: 'BTC',
  XBT: 'BTC',
  XXDG: 'DOGE',
  XDG: 'DOGE',
  XXRP: 'XRP',
  XXLM: 'XLM',
  XLTC: 'LTC',
  XETH: 'ETH',
  XXMR: 'XMR',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZGBP: 'GBP',
  ZCAD: 'CAD',
  ZAUD: 'AUD',
  ZJPY: 'JPY',
  ZCHF: 'CHF',
};

export function normalizeAsset(code) {
  const a = String(code || '').toUpperCase();
  if (KRAKEN_ASSET_MAP[a]) return KRAKEN_ASSET_MAP[a];
  // Do not strip a leading X (XRP was becoming RP).
  return a;
}
