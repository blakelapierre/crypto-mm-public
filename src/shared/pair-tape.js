const last = new Map();

function rec(pair) {
  const k = String(pair || '').toUpperCase();
  if (!last.has(k)) last.set(k, { buys: [], sells: [], buyNot: 0, sellNot: 0, buyQ: 0, sellQ: 0 });
  return last.get(k);
}

export function noteTapeFill(pair, side, price, size) {
  const px = Number(price), q = Number(size);
  if (!(px > 0) || !(q > 0) || !pair) return;
  const r = rec(pair);
  const row = { px, q, n: px * q };
  const cap = Number(process.env.TAPE_WINDOW || 40);
  if (String(side).toLowerCase() === 'buy') {
    r.buys.push(row); r.buyNot += row.n; r.buyQ += q;
    while (r.buys.length > cap) {
      const x = r.buys.shift();
      r.buyNot -= x.n; r.buyQ -= x.q;
    }
  } else {
    r.sells.push(row); r.sellNot += row.n; r.sellQ += q;
    while (r.sells.length > cap) {
      const x = r.sells.shift();
      r.sellNot -= x.n; r.sellQ -= x.q;
    }
  }
}

export function tapeEdgeBps(pair) {
  const r = rec(pair);
  if (!(r.buyQ > 0) || !(r.sellQ > 0)) return null;
  const ab = r.buyNot / r.buyQ;
  const as_ = r.sellNot / r.sellQ;
  const mid = (ab + as_) / 2;
  if (!(mid > 0)) return null;
  return ((as_ - ab) / mid) * 10000;
}

export function tapeSizeMult(pair) {
  const e = tapeEdgeBps(pair);
  if (e == null) return 1;
  if (e <= Number(process.env.TOXIC_EDGE_BPS || -40)) return Number(process.env.TOXIC_SIZE_MULT || 0.35);
  if (e <= 0) return Number(process.env.FLAT_SIZE_MULT || 0.7);
  return 1;
}

export function tapeStats(pair) {
  const r = rec(pair);
  return { edgeBps: tapeEdgeBps(pair), buyN: r.buys.length, sellN: r.sells.length };
}
