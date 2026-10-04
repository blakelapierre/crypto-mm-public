const hits = new Map();

export function noteCapture(symbol, offBps) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return;
  const need = Number(process.env.MIN_CAPTURE_BPS || 50);
  if (Number(offBps) >= need) { hits.set(sym, 0); return; }
  hits.set(sym, (hits.get(sym) || 0) + 1);
}

export function insideFeeDrop(symbol) {
  return (hits.get(String(symbol || '').toUpperCase()) || 0) >= Number(process.env.INSIDE_FEE_DROPS || 3);
}
