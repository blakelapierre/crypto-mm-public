export function incrementDecimals(inc) {
  const n = Number(inc);
  if (!Number.isFinite(n) || n <= 0) return 2;
  const s = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function snapToIncrement(price, increment) {
  const inc = Number(increment);
  if (!Number.isFinite(inc) || inc <= 0) return Number(price);
  const n = Math.round(Number(price) / inc) * inc;
  return Number(n.toFixed(incrementDecimals(inc)));
}

export function formatOnIncrement(price, increment) {
  const inc = Number(increment);
  const d = incrementDecimals(inc);
  if (!Number.isFinite(inc) || inc <= 0) return String(price);
  const n = Math.round(Number(price) / inc) * inc;
  return n.toFixed(d);
}

// A rejected post-only price is retried further from the market, never closer.
// Buy: min(original, fresh bid), snapped down. Sell: max(original, fresh ask), snapped up.
export function postOnlyRetryPx({ side = 'buy', original = 0, freshBid = 0, freshAsk = 0, inc = 0 } = {}) {
  const buy = String(side).toLowerCase() !== 'sell';
  const orig = Number(original) || 0;
  const tick = Number(inc) > 0 ? Number(inc) : 0;
  const down = (px) => {
    if (!(px > 0)) return 0;
    if (!(tick > 0)) return px;
    return Number((Math.floor(px / tick + 1e-8) * tick).toFixed(12));
  };
  const up = (px) => {
    if (!(px > 0)) return 0;
    if (!(tick > 0)) return px;
    return Number((Math.ceil(px / tick - 1e-8) * tick).toFixed(12));
  };
  if (!(orig > 0)) return 0;
  if (buy) {
    const bid = Number(freshBid) || 0;
    const ask = Number(freshAsk) || 0;
    let px = orig;
    if (bid > 0) px = Math.min(px, bid);
    if (ask > 0 && px >= ask) px = ask - (tick || px * 1e-8);
    px = down(px);
    if (!(px > 0) || px > orig + 1e-12) px = down(orig);
    if (px > orig + 1e-12) px = orig;
    return px;
  }
  const ask = Number(freshAsk) || 0;
  let px = orig;
  if (ask > 0) px = Math.max(px, ask);
  px = up(px);
  if (!(px > 0) || px + 1e-12 < orig) px = up(orig);
  if (px + 1e-12 < orig) px = orig;
  return px;
}

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
  return Math.max(0, Number(((Number(q) * cfg.orderSizeHaircut) / (1 + cfg.feeBufferPct)).toFixed(2)));
}
export function calculateVolume(cfg, mid, sizeUsd, ordermin, lotDecimals) {
  let v = sizeUsd / mid;
  const minV = (ordermin || 0) * cfg.volumeSafetyMargin;
  if (v < minV) v = minV;
  return formatVolume(v, lotDecimals);
}

const KRAKEN_ASSET_MAP = {
  XXBT: 'BTC', XBT: 'BTC', XXDG: 'DOGE', XDG: 'DOGE',
  XXRP: 'XRP', XXLM: 'XLM', XLTC: 'LTC', XETH: 'ETH', XXMR: 'XMR',
  ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', ZCAD: 'CAD', ZAUD: 'AUD', ZJPY: 'JPY', ZCHF: 'CHF',
};

export function normalizeAsset(code) {
  const a = String(code || '').toUpperCase();
  if (KRAKEN_ASSET_MAP[a]) return KRAKEN_ASSET_MAP[a];
  return a;
}
