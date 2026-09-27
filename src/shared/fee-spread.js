const fills = [];
const MAX = 80;

export function noteFeeFill(fee, notional) {
  const f = Number(fee) || 0;
  const n = Number(notional) || 0;
  if (!(n > 0)) return;
  fills.push({ fee: f, notional: n, t: Date.now() });
  while (fills.length > MAX) fills.shift();
}

export function realizedFeeBps() {
  if (!fills.length) return null;
  const n = fills.reduce((s, x) => s + x.notional, 0);
  const f = fills.reduce((s, x) => s + x.fee, 0);
  if (!(n > 0)) return null;
  return (f / n) * 10000;
}

export function applySpreadFromFees(cfg) {
  const fee = realizedFeeBps();
  if (fee == null) return cfg.mmSpreadBps;
  const edge = cfg.minEdgeBps || 20;
  const lo = cfg.minHalfSpreadBps || 10;
  const hi = cfg.maxHalfSpreadBps || 200;
  const next = Math.min(hi, Math.max(lo, fee + edge));
  if (Math.abs(next - (cfg.mmSpreadBps || 0)) >= 1) {
    console.log('spread ' + Number(cfg.mmSpreadBps).toFixed(0) + ' -> ' + next.toFixed(0) + ' bps  (realized fee ' + fee.toFixed(1) + ' + edge ' + edge + ', n=' + fills.length + ')');
    cfg.mmSpreadBps = next;
  }
  if (fee >= 15 && cfg.joinTouch) {
    cfg.joinTouch = false;
    console.log('JOIN_TOUCH off — fee too high to quote the touch');
  }
  return cfg.mmSpreadBps;
}
