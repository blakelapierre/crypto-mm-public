import { coinbaseRequest } from './coinbase.js';

let last = null;
let lastAt = 0;

export function feeTierSnap() { return last; }

export async function refreshFeeTier(cfg) {
  if (cfg.exchange !== 'coinbase') return last;
  if (Date.now() - lastAt < Number(process.env.FEE_TIER_MS || 300000) && last) return last;
  try {
    const data = await coinbaseRequest(cfg, 'GET', '/api/v3/brokerage/transaction_summary?product_type=SPOT');
    const ft = data.fee_tier || {};
    const vol = Number(data.total_volume || data.advanced_trade_only_volume || 0);
    const to = Number(ft.usd_to || (ft.volume_types_and_range && ft.volume_types_and_range[0] && ft.volume_types_and_range[0].vol_to) || 0);
    last = {
      volume: vol,
      fees: Number(data.total_fees || data.advanced_trade_only_fees || 0),
      tier: ft.pricing_tier || '',
      makerBps: Number(ft.maker_fee_rate || 0) * 10000,
      takerBps: Number(ft.taker_fee_rate || 0) * 10000,
      volFrom: Number(ft.usd_from || 0),
      volTo: to,
      need: to > vol ? to - vol : 0,
    };
    lastAt = Date.now();
  } catch (e) {
    console.warn('fee tier', e.message);
  }
  return last;
}

export function etaNextTierHours(volPerHour) {
  if (!last || !(last.need > 0) || !(volPerHour > 0)) return null;
  return last.need / volPerHour;
}
