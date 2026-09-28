export function backtestRungs(points, feeBps) {
  if (!points || points.length < 8) return null;
  const fee = (Number(feeBps) || 35) / 10000;
  let best = null;
  for (const levels of [1, 2, 3]) {
    for (const stepBps of [25, 40, 55, 80, 110]) {
      const step = stepBps / 10000;
      let touches = 0, edge = 0;
      let mid = Number(points[0].p != null ? points[0].p : points[0].mid);
      if (!(mid > 0)) continue;
      for (let i = 1; i < points.length; i++) {
        const raw = points[i];
        const px = Number(raw.p != null ? raw.p : raw.mid);
        if (!(px > 0)) continue;
        const move = (px - mid) / mid;
        if (move <= -step) {
          const L = Math.min(levels, Math.max(1, Math.floor(Math.abs(move) / step)));
          touches += 1;
          edge += L * step - 2 * fee;
        } else if (move >= step) {
          const L = Math.min(levels, Math.max(1, Math.floor(move / step)));
          touches += 1;
          edge += L * step - 2 * fee;
        }
        mid = px;
      }
      const row = { levels, stepBps, touches, edgePct: edge * 100 };
      if (!best || row.edgePct > best.edgePct) best = row;
    }
  }
  return best;
}
