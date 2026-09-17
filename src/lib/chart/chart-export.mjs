// CHART EXPORT.
//
// Composes the picture a user actually sees into one PNG: the chart's own canvas, the drawing
// overlay on top of it, and a caption naming the symbol, the interval and the source.
//
// WHY COMPOSE RATHER THAN SCREENSHOT THE PAGE. The chart is two stacked canvases plus DOM — the
// legend and the toolbar are HTML, not pixels — and no browser API turns arbitrary DOM into an image
// without a third-party rasteriser. So the export draws what it can prove: Lightweight Charts hands
// back its own canvas, our overlay IS a canvas, and the caption is drawn here from the same values
// the legend is given. Nothing outside the chart is captured, which also means a Terminal panel's
// chrome, other panels and the rest of the app can never leak into a shared image.
//
// Pure except for the canvas it makes, so the layout maths is testable without a browser.

export const CAPTION_HEIGHT = 34;
export const EXPORT_PADDING = 0;

/**
 * Where each piece goes in the exported image.
 *
 * Kept separate from the drawing so the geometry can be checked without a canvas: an export that is
 * one pixel short crops the time axis, and that is not something to discover by eye.
 */
export function exportLayout(width, height, { caption = true } = {}) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const capH = caption ? CAPTION_HEIGHT : 0;
  return {
    width: w,
    height: h + capH,
    chart: { x: 0, y: 0, width: w, height: h },
    caption: caption ? { x: 0, y: h, width: w, height: capH } : null,
  };
}

/** The caption text, from the same values the on-chart legend is given. */
export function captionFor({ symbol, interval, chartType, delayed }) {
  const bits = [symbol, interval, chartType].filter(Boolean);
  if (delayed) bits.push('delayed');
  return bits.join('  ·  ');
}

/** A filename that sorts and does not collide: SYMBOL_interval_YYYY-MM-DD_HHMM.png */
export function exportFilename(symbol, interval, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    + `_${pad(when.getHours())}${pad(when.getMinutes())}`;
  const safe = String(symbol || 'chart').replace(/[^A-Za-z0-9.\-]/g, '');
  const iv = String(interval || '').replace(/[^A-Za-z0-9]/g, '');
  return [safe || 'chart', iv, stamp].filter(Boolean).join('_') + '.png';
}

/**
 * Compose the export canvas.
 *
 * `chartCanvas` comes from the library's own takeScreenshot(); `overlayCanvas` is our drawing layer.
 * Either may be missing — a chart with no drawings has no overlay worth compositing — and the result
 * is still correct.
 */
export function composeExport({
  chartCanvas, overlayCanvas, width, height, caption, background, textColor, subColor, attribution,
}) {
  if (typeof document === 'undefined') return null;
  const layout = exportLayout(width, height, { caption: !!caption });
  const out = document.createElement('canvas');
  // Exported at the device pixel ratio, so a chart captured on a retina screen is not soft.
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  out.width = Math.floor(layout.width * dpr);
  out.height = Math.floor(layout.height * dpr);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // A SOLID BACKGROUND, always. The chart may be transparent inside a Terminal panel, and a PNG with
  // an alpha hole looks broken everywhere it is pasted.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, layout.width, layout.height);

  if (chartCanvas) ctx.drawImage(chartCanvas, layout.chart.x, layout.chart.y, layout.chart.width, layout.chart.height);
  if (overlayCanvas) ctx.drawImage(overlayCanvas, layout.chart.x, layout.chart.y, layout.chart.width, layout.chart.height);

  if (layout.caption) {
    const { x, y, width: cw, height: ch } = layout.caption;
    ctx.fillStyle = background;
    ctx.fillRect(x, y, cw, ch);
    ctx.textBaseline = 'middle';
    ctx.font = "600 12px 'DM Sans', sans-serif";
    ctx.fillStyle = textColor;
    ctx.fillText(caption, 10, y + ch / 2);
    // The library's licence requires visible attribution wherever the chart is published, and an
    // exported image travels further than the page does.
    if (attribution) {
      ctx.font = "10px 'DM Sans', sans-serif";
      ctx.fillStyle = subColor;
      const tw = ctx.measureText(attribution).width;
      ctx.fillText(attribution, Math.max(10, cw - tw - 10), y + ch / 2);
    }
  }
  return out;
}
