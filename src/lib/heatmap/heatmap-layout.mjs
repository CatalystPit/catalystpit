// THE HEATMAP'S LOOK AND SHAPE — one implementation, both heatmaps.
//
// The colour scale and the sector-treemap layout were inline in components/HeatMap.jsx, which was
// fine while the Terminal panel was the only heatmap. The dedicated /heatmap page is the second, and
// a second copy of a colour ramp is how two heatmaps end up disagreeing about what green means.
//
// So the DESIGN SYSTEM lives here — pure, testable, no React — and both surfaces render from it.
// The Terminal panel's appearance is unchanged by construction: this is its own code, moved.

import { treemap } from '../treemap.js';

/**
 * Diverging heat colour. Semantic, so it is the SAME in light and dark mode — tiles always carry
 * white text, and a green tile that meant +2% on one theme must not mean +2% somewhere else on the
 * other.
 *
 * CLAMPED AT ±3%. Beyond that the colour stops intensifying, which is deliberate: a single −40%
 * name would otherwise flatten the entire rest of the board into indistinguishable mid-tones.
 * A near-zero return lands on the subdued centre colour rather than reading as a weak green.
 *
 * ⚠️ The clamp is a DAILY scale. A 1Y board where most names are up 30% saturates completely, which
 * is why scaleFor() widens it per timeframe.
 */
export function heatColor(pct, scale = 3) {
  if (pct == null || Number.isNaN(Number(pct))) return '#2f3a34';   // unknown ≠ flat: a distinct grey
  const s = scale > 0 ? scale : 3;
  const p = Math.max(-s, Math.min(s, Number(pct))) / s;             // −1..1
  if (p >= 0) return `rgb(${Math.round(60 - 44 * p)},${Math.round(78 + 92 * p)},${Math.round(66 + 20 * p)})`;
  const a = -p;
  return `rgb(${Math.round(60 + 150 * a)},${Math.round(78 - 40 * a)},${Math.round(66 - 42 * a)})`;
}

/**
 * How many percent counts as "fully saturated" for a window.
 *
 * A 3% day is a big day; a 3% year is noise. Holding the daily scale across every timeframe would
 * make the 1Y board a uniform sheet of maximum green and destroy the comparison the heatmap exists
 * to make. These are the conventional magnitudes for each horizon, not fitted to current data — a
 * scale that moved with the market would make two days' boards incomparable.
 */
export const SCALE_BY_TIMEFRAME = Object.freeze({ '1D': 3, '1W': 6, '1M': 12, '1Y': 40 });
export const scaleFor = (timeframe) => SCALE_BY_TIMEFRAME[timeframe] ?? 3;

/** The bucket a return falls in — used for the legend and by tests, never for colour directly. */
export function heatBucket(pct, scale = 3) {
  if (pct == null || Number.isNaN(Number(pct))) return 'unknown';
  const p = Number(pct);
  const near = scale * 0.05;              // within 5% of the scale reads as flat
  if (p > near) return 'up';
  if (p < -near) return 'down';
  return 'flat';
}

export const SECTOR_OTHER = 'Other';

/**
 * Group rows into sectors for the treemap.
 *
 * A security with no sector goes to "Other" and is NEVER given a guessed one. Roughly a fifth of the
 * large-cap board is foreign issuers that file 20-F and therefore carry no SIC code to derive a
 * sector from; "Other" is an honest answer and a wrong sector is a false fact on a trading surface.
 */
export function groupBySector(rows) {
  const bySec = new Map();
  for (const r of rows || []) {
    if (!r?.ticker) continue;
    const s = r.sector || SECTOR_OTHER;
    if (!bySec.has(s)) bySec.set(s, []);
    bySec.get(s).push(r);
  }
  return [...bySec.entries()]
    .map(([name, items]) => ({ name, items, value: items.reduce((a, x) => a + (Number(x.marketCap) || 0), 0) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
}

export const SECTOR_HEADER_PX = 13;

/**
 * THE SMALLEST TILE WORTH DRAWING, in square pixels.
 *
 * Measured on the real universe against a 1400×760 board: 500 securities gives a smallest tile of
 * ~18px square, 1,000 gives ~10px, 2,000 gives ~5px, and all 5,553 gives a smallest tile of
 * effectively ZERO — thousands of sub-pixel elements that cost DOM and paint while showing nobody
 * anything.
 *
 * So a tile below this area is NOT DRAWN, and the count of what was left out is returned so the page
 * can say so. That is the honest version of a large universe: the board stays legible and bounded,
 * the omission is disclosed with a number, and narrowing by sector brings the smaller names back
 * because the same market cap is then divided among far fewer securities.
 *
 * 16px² (4×4) is the floor: below that a tile cannot carry colour a reader can actually judge.
 */
export const MIN_TILE_AREA = 16;

/**
 * Lay the board out: sectors by total market cap, securities by market cap within their sector.
 *
 * TILE AREA IS MARKET CAP, never the return — size is how much of the market a name represents and
 * colour is how it moved, which is the whole grammar of a heatmap. Returns a flat list of
 * { kind: 'sector' | 'tile' } so a renderer can draw it in one pass.
 */
export function layoutTiles(rows, width, height, { minArea = MIN_TILE_AREA } = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const w = Number(width), h = Number(height);
  if (!(w >= 40) || !(h >= 40)) return [];

  const out = [];
  for (const sr of treemap(groupBySector(rows), 0, 0, w, h)) {
    out.push({ kind: 'sector', name: sr.name, x: sr.x, y: sr.y, w: sr.w, h: sr.h });
    const innerY = sr.y + SECTOR_HEADER_PX;
    const innerH = sr.h - SECTOR_HEADER_PX;
    // A sector band too short to hold a tile gets its header and nothing else, rather than tiles of
    // negative height.
    if (innerH < 8 || sr.w < 8) continue;
    const items = sr.items.map((it) => ({ ...it, value: Number(it.marketCap) || 0 }));
    for (const tr of treemap(items, sr.x, innerY, sr.w, innerH)) {
      // Below the legibility floor the tile is omitted rather than painted invisibly. See
      // MIN_TILE_AREA: this is what keeps "all eligible" a usable board instead of 5,553 specks.
      if (tr.w * tr.h < minArea) continue;
      out.push({ kind: 'tile', ...tr });
    }
  }
  return out;
}

/**
 * How many securities the board actually drew, and how many were too small to draw.
 *
 * Returned so the page can DISCLOSE the omission with a number. A heatmap that quietly drops the
 * bottom of its universe is lying about the market by omission; one that says "1,240 smaller
 * securities are not shown at this size" is telling the reader exactly where to look next.
 */
export function tileCoverage(rows, tiles) {
  const total = (rows || []).filter((r) => r?.ticker && Number(r.marketCap) > 0).length;
  const drawn = (tiles || []).filter((t) => t.kind === 'tile').length;
  return { total, drawn, hidden: Math.max(0, total - drawn) };
}

/** Whether a tile has room for its ticker, and for its percentage under it. */
export const showsTicker = (t) => t.w > 30 && t.h > 18;
export const showsPct = (t) => t.w > 44 && t.h > 34;
