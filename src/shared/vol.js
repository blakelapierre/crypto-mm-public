import { krakenPublic } from './kraken.js';

function score(changePct, volumeUsd) {
  const c = Math.abs(Number(changePct) || 0);
  const v = Math.max(0, Number(volumeUsd) || 0);
  return c * Math.log10(1 + v);
}

export async function rankByVolatility(cfg, productMap) {
  const minVol = cfg.volMinVolumeUsd || 0;
  const rows = [];
  if (cfg.exchange === 'kraken') {
    let tick = {};
    try { tick = await krakenPublic('Ticker'); } catch (e) { console.warn('vol ticker', e.message); }
    for (const [sym, info] of Object.entries(productMap)) {
      const raw = tick[info.pair];
      if (!raw) continue;
      const hi = parseFloat((raw.h && (raw.h[1] || raw.h[0])) || 0);
      const lo = parseFloat((raw.l && (raw.l[1] || raw.l[0])) || 0);
      const last = parseFloat((raw.c && raw.c[0]) || 0);
      const mid = last || (hi + lo) / 2;
      const rangePct = mid > 0 ? ((hi - lo) / mid) * 100 : 0;
      const vol = parseFloat((raw.v && raw.v[1]) || 0) * mid;
      if (vol < minVol) continue;
      rows.push({ symbol: sym, ...info, change24h: rangePct, volume24h: vol, volScore: score(rangePct, vol) });
    }
  } else {
    for (const [sym, info] of Object.entries(productMap)) {
      const rangePct = info.change24h || 0;
      const vol = info.volume24h || 0;
      if (vol < minVol) continue;
      rows.push({ symbol: sym, ...info, volScore: score(rangePct, vol) });
    }
  }
  rows.sort((a, b) => b.volScore - a.volScore);
  return rows;
}
