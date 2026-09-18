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
 * THE SECTOR HEADER IS PART OF THE GEOMETRY, NOT PAINT ON TOP OF IT.
 *
 * The defect this fixes, measured on the live Top 500 board at 1400×700: the squarified layout gave
 * "Real Estate" — a single security — a band 7.7px tall at y=692.3, flush with the bottom of the
 * canvas. The header was rendered at a FIXED 13px from the top of that band, so it painted from
 * 692.3 to 705.3: 5.3px PAST the canvas, clipped by the container's overflow. The same band left
 * `innerH = 7.7 − 13 = −5.3`, which the old `innerH < 8` guard turned into "draw no tiles at all", so
 * the sector's security disappeared from a board that claimed to show 500.
 *
 * Two rules now hold, and both are asserted:
 *   1. a header is CLAMPED to its sector's rect and can never paint outside it, and
 *   2. the board is sized so no sector is thinner than a header plus one tile row in the first place.
 *
 * MIN_SECTOR_HEIGHT is that second rule; fitBoardHeight below is what enforces it.
 */

/**
 * The area a security wants before its tile stops being a sliver — about 30x30.
 *
 * Not a hard guarantee: a treemap gives the biggest names most of the canvas by design, so this is
 * the AVERAGE the board aims for when choosing its height. It is what turns "Top 2000" from a wall
 * of specks into a map worth scrolling.
 */
export const COMFORTABLE_TILE_AREA = 900;

export const MIN_TILE_ROW_PX = 10;
export const MIN_SECTOR_HEIGHT = SECTOR_HEADER_PX + MIN_TILE_ROW_PX;

/**
 * The height this board actually needs, given the width it actually has.
 *
 * TWO FLOORS, both measured against the real universe at 1400 wide:
 *
 *   density      — roughly COMFORTABLE_TILE_AREA per security, so Top 2000 gets 1300px and draws all
 *                  2,000 tiles instead of 1,841 on a cramped board.
 *   sector fit   — the thinnest sector band must clear MIN_SECTOR_HEIGHT. Top 500 settles at 720px;
 *                  at the 700px the page previously forced, "Real Estate" got 7.7px and its header
 *                  painted past the bottom edge. That is the clipping this function exists to stop.
 *
 * The page SCROLLS. A taller map that shows every security beats a short one that hides a sector,
 * and the only ceiling is a sanity cap so a pathological universe cannot produce an endless page —
 * past it the legibility floor takes over and the page states how many it left out.
 *
 * Deterministic: same rows and width in, same height out. Nothing measures the DOM.
 */
export function fitBoardHeight(rows, width, { minHeight = 460, maxHeight = 2200, step = 20 } = {}) {
  const w = Number(width);
  if (!Array.isArray(rows) || !rows.length || !(w >= 40)) return minHeight;
  const groups = groupBySector(rows);
  if (!groups.length) return minHeight;

  // FLOOR 1 — DENSITY. Five hundred securities on a 460px board is not clipped, but it is a wall of
  // slivers, and the page scrolls: height is cheap and legibility is not. The board therefore asks
  // for roughly COMFORTABLE_TILE_AREA per security before anything else is considered. Capped, so a
  // 5,553-security universe does not demand a five-thousand-pixel page — beyond the cap the
  // legibility floor takes over and says how many it left out.
  const dense = Math.ceil((rows.length * COMFORTABLE_TILE_AREA) / w / step) * step;
  const floor = Math.min(maxHeight, Math.max(minHeight, dense));

  // FLOOR 2 — NO SQUEEZED SECTOR. Walk up until the thinnest sector band can hold its header and a
  // row of tiles. This is the one that fixes the clipped bottom row; the treemap's orientation flips
  // with aspect ratio, so it is searched rather than solved.
  for (let h = floor; h <= maxHeight; h += step) {
    const rects = treemap(groups, 0, 0, w, h);
    if (!rects.length) continue;
    let thinnest = Infinity;
    for (const r of rects) if (r.h < thinnest) thinnest = r.h;
    if (thinnest >= MIN_SECTOR_HEIGHT) return h;
  }
  return maxHeight;
}

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
    // THE HEADER CANNOT EXCEED ITS SECTOR. Clamped rather than fixed, so a thin band paints a short
    // header inside its own rect instead of spilling past it — and past the canvas when that band is
    // at the bottom, which is exactly the clipping this replaced.
    const headerH = Math.min(SECTOR_HEADER_PX, sr.h);
    out.push({ kind: 'sector', name: sr.name, x: sr.x, y: sr.y, w: sr.w, h: sr.h, headerH });

    const innerY = sr.y + headerH;
    const innerH = sr.h - headerH;
    // Nothing left to draw into. With a fitted board height this does not arise; the guard stays so
    // a forced-short canvas degrades to "header only" rather than to tiles of negative height.
    if (innerH < 1 || sr.w < 1) continue;

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
