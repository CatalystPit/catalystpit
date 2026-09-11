// Squarified treemap (Bruls, Huizing, van Wijk). nodes:[{value,...}] → [{...node, x,y,w,h}] filling
// the rect, keeping tiles as close to square as possible. Shared by the homepage Market Heat Map and
// the Insider Activity Heatmap so both use one proven layout engine.
export function treemap(nodes, X, Y, W, H) {
  const res = [];
  const clean = nodes.filter((n) => n.value > 0);
  const total = clean.reduce((s, n) => s + n.value, 0);
  if (!(total > 0) || !(W > 0) || !(H > 0)) return res;
  const scale = (W * H) / total;
  const items = clean.map((n) => ({ node: n, area: n.value * scale })).sort((a, b) => b.area - a.area);
  let x = X, y = Y, w = W, h = H;
  const worst = (row, side) => {
    const s = row.reduce((a, i) => a + i.area, 0); if (s <= 0) return Infinity;
    const mx = Math.max(...row.map((i) => i.area)), mn = Math.min(...row.map((i) => i.area));
    const s2 = s * s, sd2 = side * side;
    return Math.max((sd2 * mx) / s2, s2 / (sd2 * mn));
  };
  const commit = (row) => {
    const s = row.reduce((a, i) => a + i.area, 0);
    if (w <= h) { const strip = s / w; let cx = x; for (const it of row) { const iw = it.area / strip; res.push({ ...it.node, x: cx, y, w: iw, h: strip }); cx += iw; } y += strip; h -= strip; }
    else { const strip = s / h; let cy = y; for (const it of row) { const ih = it.area / strip; res.push({ ...it.node, x, y: cy, w: strip, h: ih }); cy += ih; } x += strip; w -= strip; }
  };
  let row = [], i = 0;
  while (i < items.length) {
    const side = Math.min(w, h);
    const cand = [...row, items[i]];
    if (row.length === 0 || worst(cand, side) <= worst(row, side)) { row = cand; i++; }
    else { commit(row); row = []; }
  }
  if (row.length) commit(row);
  return res;
}
