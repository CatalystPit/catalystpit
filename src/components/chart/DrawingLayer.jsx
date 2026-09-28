'use client';
import { memo, useEffect, useRef, useCallback } from 'react';
import {
  TOOLS, tool, hitTest, createDrawing, moveDrawing, fibLevels, barLevels, snapToLevel, measureBetween,
  constrainAngle,
  HANDLE_RADIUS, DEFAULT_STYLE,
} from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColor } from '../../lib/chart/chart-theme.mjs';
import { gestureToken } from '../../lib/chart/chart-history.mjs';
import {
  logicalOfTime, timeOfLogical, timeDeltaSeconds,
} from '../../lib/chart/chart-coords.mjs';
import { projectDrawings, resolveAnchor, labelX } from '../../lib/chart/chart-project.mjs';
import { selectionBox } from '../../lib/chart/drawing-toolbar.mjs';
import {
  sanitizeLabelStyle, labelFont, labelBox, labelHeight, labelAnchorPoint, LABEL_GAP,
} from '../../lib/chart/drawing-label.mjs';
import { axisLabelSpecs, reconcileAxisLabels, priceLineOptionsFor, priceInPlot } from '../../lib/chart/price-axis-labels.mjs';
import {
  idleTool, armTool, clickTool, hoverTool, cancelDraft, clearSuppression, draftPreview, hasDraft,
} from '../../lib/chart/chart-tool-lifecycle.mjs';

// The drawing surface: one canvas sitting over the chart.
//
// WHY A CANVAS OVERLAY. Lightweight Charts has no drawing tools of its own; it has price lines and a
// series-primitive API, neither of which can express a ray, a rectangle or a Fibonacci fan. An
// overlay that shares the chart's coordinate system gives every tool the same treatment and keeps
// the chart itself untouched — nothing here reaches into its internals.
//
// ONE EXCEPTION, AND IT IS DELIBERATE: a price level's chip on the right-hand axis. That chip is
// drawn by the price scale, not by a pane, so a canvas cannot put anything there. Each price-labelled
// drawing therefore gets a native price line with `lineVisible: false` — it contributes the axis chip
// and draws no line, so the geometry, selection, dragging and styling all stay here where they were.
// See price-axis-labels.mjs. The library also formats that chip with the series' own price formatter,
// which is how an instrument's precision is honoured without a decimal count being hard-coded.
//
// EVERY ANCHOR IS STORED AS { time, price } AND PROJECTED AT PAINT TIME. The chart's own scales do
// the conversion, so a drawing tracks its level exactly through zoom, pan, resize and a reload.
//
// POINTER EVENTS PASS THROUGH when no tool is armed and nothing is selected, so the chart keeps its
// own zoom, pan and crosshair. The overlay only captures input when it is actually being used.

const dashFor = (dash) => (dash === 'dashed' ? [7, 5] : dash === 'dotted' ? [2, 4] : []);

function DrawingLayerBase({
  chart, series, theme, symbol, bars,
  drawings, onChange, activeTool, onToolUsed,
  selectedIds = [], onSelect, visible = true, style = DEFAULT_STYLE, magnet = false,
  onRequestText, onOpenSettings, clearSignal = 0, toolDefaults = null,
  onSelectionBox,
}) {
  const canvasRef = useRef(null);
  // drawing id -> { spec, handle } for the axis chips, so each is created once and only updated when
  // its price or colour actually changes. A ref, not state: it is the chart's state, not React's, and
  // putting it in state would re-render on every reconciliation.
  const axisRef = useRef(new Map());
  // Which series the chips above belong to, so a recreated series cannot be handed stale handles.
  const axisOwnerRef = useRef(null);
  // The series, readable from the unmount cleanup, which must not close over a stale prop.
  const seriesRef = useRef(null);
  seriesRef.current = series;
  /**
   * WHERE EACH DRAWING'S TEXT LANDED, IN PIXELS — rebuilt on every paint.
   *
   * ⚠️ IT HAS TO BE MEASURED, NOT PREDICTED. The box depends on the glyph widths in the font that was
   * actually used, which only the canvas knows. The pointer handler needs the same rectangle the reader
   * can see, so it reads the one the painter just produced rather than recomputing a second opinion.
   */
  const textRectsRef = useRef(new Map());
  const onSelectionBoxRef = useRef(null);
  onSelectionBoxRef.current = onSelectionBox || null;
  const stateRef = useRef({});
  const s = stateRef.current;
  s.drawings = drawings; s.activeTool = activeTool;
  // A Set, so the paint loop asks "is this one selected" once per drawing rather than scanning.
  s.selected = new Set(selectedIds);
  s.theme = theme; s.visible = visible; s.style = style; s.bars = bars; s.magnet = magnet;
  s.toolDefaults = toolDefaults;
  // THE PLACEMENT STATE MACHINE lives in chart-tool-lifecycle.mjs. Re-armed only when the prop
  // actually names a different tool, so a half-placed two-point shape survives the re-renders that
  // a crosshair move causes — and is discarded the moment the user picks a different tool.
  if (!s.life) s.life = idleTool();
  if (s.life.activeTool !== activeTool) s.life = armTool(s.life, activeTool);

  /**
   * IS THE POINTER ON A DRAWING'S TEXT?
   *
   * ⚠️ ONLY ON A SELECTED DRAWING, and that is the whole interaction model. Writing on a chart sits on
   * top of the candles a reader is trying to read; if any stray word could swallow a press, ordinary
   * panning would start failing in places the reader cannot see the reason for. Selecting first says
   * "I mean this one", and only then does its text become something to grab.
   *
   * ⚠️ AND A NOTE IS EXCLUDED, because a note's text IS the drawing. Dragging it must move the drawing,
   * which the normal drag path already does — treating it as a caption would let the words wander off
   * the thing they are.
   */
  const textHitAt = (pt) => {
    for (const [id, r] of textRectsRef.current) {
      if (r.note) continue;
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return id;
    }
    return null;
  };

  // ── data space <-> screen space ──
  const toScreen = useCallback((pt) => {
    if (!chart || !series) return null;
    const y = series.priceToCoordinate(pt.price);
    if (y == null) return null;
    // A time the scale knows resolves directly. One it does NOT — an anchor drawn into empty space
    // past the last candle — is placed through the logical axis instead, which is unbounded. Without
    // this second path a future anchor simply vanished, because timeToCoordinate returns null for
    // anything outside the data.
    let x = chart.timeScale().timeToCoordinate(pt.time);
    if (x == null) {
      const logical = logicalOfTime(pt.time, stateRef.current.bars || []);
      if (logical == null) return null;
      x = chart.timeScale().logicalToCoordinate(logical);
    }
    return x == null ? null : { x, y };
  }, [chart, series]);

  const toData = useCallback((x, y) => {
    if (!chart || !series) return null;
    const price = series.coordinateToPrice(y);
    if (price == null) return null;
    // SNAPPED TO A BAR. timeToCoordinate only resolves times the scale knows about, so a point
    // placed between bars would vanish on the next repaint. Snapping also matches how every charting
    // tool behaves: a level belongs to a candle.
    const logical = chart.timeScale().coordinateToLogical(x);
    const list = stateRef.current.bars || [];
    if (!list.length || logical == null) return null;
    // NOT CLAMPED TO A BAR ANY MORE. Inside the data this still resolves to a candle's own time, so
    // anchors keep landing on bars and every stored drawing is unaffected; beyond it the moment is
    // extrapolated from the bar spacing. That single change is what lets a trendline, a ray or a
    // Fibonacci be drawn into empty chart space at all.
    const time = timeOfLogical(logical, list);
    if (time == null) return null;
    const inData = logical >= 0 && logical <= list.length - 1;
    const bar = inData ? list[Math.round(logical)] : null;

    // MAGNET. With it on, an anchor placed near a candle's open, high, low or close lands exactly on
    // it. Off — the default — this whole branch is skipped and the price is wherever the pointer is,
    // which is why the crosshair and every existing drawing behave identically to before.
    //
    // The nearness test is done in PIXELS, so it means the same thing at every zoom level, and the
    // decision itself lives in chart-drawings.mjs where it can be tested without a browser.
    // Magnet needs a candle to snap TO, so it applies only where one exists. In empty space it is
    // simply inert — which is what keeps magnet from making future-space drawing impossible.
    if (stateRef.current.magnet && bar) {
      const levels = barLevels(bar)
        .map((lvl) => ({ price: lvl, y: series.priceToCoordinate(lvl) }))
        .filter((l) => l.y != null);
      const snapped = snapToLevel(y, levels);
      if (snapped != null) return { time: bar.time, price: snapped, snapped: true };
    }
    return { time, price };
  }, [chart, series]);

  /**
   * THE LIVE PRICE ON THE AXIS, while a tool is armed or a drawing is being dragged.
   *
   * ⚠️ ROOT CAUSE THIS FIXES. The chart's crosshair already puts the pointer's price on the right
   * axis — `crosshair.horzLine` has its label on by default and chart-theme gives it the neutral
   * `crosshairLabel` colour for exactly this readout. It stopped the moment a drawing tool was
   * picked, because the overlay sets `pointerEvents: auto` while it is in use, so the chart below
   * never received another mousemove and its crosshair froze where the pointer last crossed it. The
   * readout was not missing; it was starved. So the overlay hands the position back.
   *
   * setCrosshairPosition, not a label of our own: it is the SAME chip the chart draws when nothing is
   * armed, so the number is formatted by the series' own formatter and stays correct through zoom,
   * pan, autoscale, resize and a timeframe change. A hand-drawn label would have to re-derive all of
   * that, and would be the second price source this must not have.
   */
  const showCursorPrice = useCallback((data) => {
    if (!chart || !series || !data || !Number.isFinite(data.price)) return;
    try { chart.setCrosshairPosition(data.price, data.time, series); }
    catch { /* an extrapolated time the scale will not take; the chip is not worth an exception */ }
  }, [chart, series]);

  /** Put the crosshair back under the chart's own control. */
  const clearCursorPrice = useCallback(() => {
    try { chart?.clearCrosshairPosition(); } catch { /* chart gone */ }
  }, [chart]);

  /**
   * THE PLOT'S OWN MEASUREMENTS, not the canvas's.
   *
   * The canvas is inset:0 over the whole chart, so it also covers the price-scale gutter and the
   * time axis; anything pinned to ITS width lands out over the price scale. The time scale reports
   * the plot, which is the space the chart's own coordinates are expressed in.
   */
  const plotSize = useCallback(() => {
    const cv = canvasRef.current;
    // clientWidth/Height, never width/height: the backing store is multiplied by devicePixelRatio,
    // and feeding that to coordinateToPrice asks for a price far below the bottom of the chart.
    const cssW = cv?.clientWidth || 0;
    const cssH = cv?.clientHeight || 0;
    let w = cssW, h = cssH;
    try {
      const tw = chart?.timeScale?.().width?.();
      const th = chart?.timeScale?.().height?.();
      if (Number.isFinite(tw) && tw > 0) w = tw;
      if (Number.isFinite(th) && th > 0 && cssH > th) h = cssH - th;
    } catch { /* the time scale is optional here; the canvas box is a safe fallback */ }
    return { plotWidth: w, plotHeight: h };
  }, [chart]);

  /** How this chart converts, handed to the pure projection so the geometry needs no chart at all. */
  const scale = useCallback(() => {
    if (!chart || !series) return null;
    const { plotWidth, plotHeight } = plotSize();
    return {
      plotWidth,
      plotHeight,
      toY: (price) => series.priceToCoordinate(price),
      toX: (time) => {
        // A time the scale knows resolves directly. One it does NOT — an anchor drawn into empty
        // space past the last candle — goes through the logical axis instead, which is unbounded.
        const direct = chart.timeScale().timeToCoordinate(time);
        if (direct != null) return direct;
        const logical = logicalOfTime(time, stateRef.current.bars || []);
        if (logical == null) return null;
        return chart.timeScale().logicalToCoordinate(logical);
      },
    };
  }, [chart, series, plotSize]);

  /** The visible window, in data space — what a ray extends across. */
  const currentView = useCallback(() => {
    const list = stateRef.current.bars || [];
    if (!chart || !series || !list.length) return null;
    // THE LOGICAL RANGE, NOT THE DATA RANGE. The time-based window reports only where bars exist,
    // so a horizontal line or a Fibonacci level stopped dead at the last candle instead of carrying
    // on across the empty space the trader is looking at.
    const lr = chart.timeScale().getVisibleLogicalRange();
    const from = lr ? timeOfLogical(lr.from, list) : list[0].time;
    const to = lr ? timeOfLogical(lr.to, list) : list[list.length - 1].time;
    const { plotHeight } = plotSize();
    const high = series.coordinateToPrice(0);
    const low = series.coordinateToPrice(plotHeight);
    return { from, to, high: high ?? 0, low: low ?? 0 };
  }, [chart, series, plotSize]);

  /**
   * Every visible drawing, resolved to pixels, ready to paint or hit-test.
   *
   * The geometry itself lives in chart-project.mjs and knows nothing about Lightweight Charts, which
   * is what lets the pixels a browser actually strokes be asserted in a test without a browser.
   */
  const project = useCallback(() => {
    const view = currentView();
    const sc = scale();
    if (!view || !sc) return [];
    const { items, dropped } = projectDrawings(stateRef.current.drawings, view, sc, tool);
    // Anything unplaceable is a bug, not a silent omission — that silence is exactly how a Fibonacci
    // came to show labels with no lines under them.
    stateRef.current.dropped = dropped;
    return items;
  }, [currentView, scale]);

  // ── paint ──
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const textRects = new Map();
    textRectsRef.current = textRects;
    if (!stateRef.current.visible) return;

    const p = palette(stateRef.current.theme);
    // ⚠️ PROJECTED ONCE, USED TWICE. The paint loop and the toolbar's position need the same pixels,
    // and projecting twice per frame would let them disagree by a frame — the toolbar lagging the
    // drawing it is attached to during a drag is exactly how one looks broken.
    const projected = project();
    for (const d of projected) {
      if (d.visible === false) continue;
      const colour = indicatorColor(stateRef.current.theme, d.style.color);
      const isSel = stateRef.current.selected.has(d.id);

      // A rectangle gets a wash so it reads as a zone rather than four lines.
      if (tool(d.type)?.fill && d.handles.length === 2) {
        const [a, b] = d.handles;
        ctx.save();
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = colour;
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.restore();
      }

      ctx.save();
      ctx.lineWidth = d.style.width;
      ctx.setLineDash(dashFor(d.style.dash));
      // A LEVEL'S OWN COLOUR applies to its line as well as its label; segments come back in the
      // same order the levels do, so the two line up without the renderer knowing what a level is.
      const segColours = tool(d.type)?.levels
        ? fibLevels(d.source.points, d.source.levels).map((l) => indicatorColor(stateRef.current.theme, l.color ?? d.style.color))
        : null;
      d.segments.forEach(([a, b], i) => {
        ctx.strokeStyle = segColours?.[i] || colour;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      });
      ctx.restore();

      // Fibonacci prints its ratio and price, which is the entire point of the tool.
      if (tool(d.type)?.levels && d.source.points.length === 2) {
        const lv = fibLevels(d.source.points, d.source.levels);
        const rows = lv
          .map((l) => ({ ...l, y: series?.priceToCoordinate(l.price) }))
          .filter((l) => l.y != null);

        // OPTIONAL BANDS between adjacent levels. Off by default — the clean look is a set of lines,
        // and a filled Fibonacci over candles is the fastest way to make a chart unreadable. When it
        // is on the alpha is deliberately tiny, and alternating bands are skipped so the zones read
        // as separate rather than as one wash.
        if (d.source.fill && rows.length > 1) {
          ctx.save();
          ctx.globalAlpha = 0.07;
          for (let i = 0; i < rows.length - 1; i += 1) {
            if (i % 2 === 1) continue;
            ctx.fillStyle = indicatorColor(stateRef.current.theme, rows[i].color ?? d.style.color);
            const top = Math.min(rows[i].y, rows[i + 1].y);
            // Across the plot, not across the panel: cw includes the price-scale gutter, and a wash
            // running under the axis reads as a rendering fault.
            ctx.fillRect(0, top, plotSize().plotWidth, Math.abs(rows[i + 1].y - rows[i].y));
          }
          ctx.restore();
        }

        ctx.save();
        ctx.font = "10px 'DM Sans', sans-serif";
        ctx.textBaseline = 'bottom';
        const plotW = plotSize().plotWidth;
        rows.forEach((lvl, i) => {
          // PER-LEVEL COLOUR when the level declares one, the drawing's own colour otherwise — which
          // is what keeps the default a single clean hue.
          ctx.fillStyle = indicatorColor(stateRef.current.theme, lvl.color ?? d.style.color);
          const label = `${(lvl.ratio * 100).toFixed(1)}%  ${lvl.price.toFixed(2)}`;
          // AT THE RIGHT-HAND END OF ITS OWN LEVEL. The previous expression was
          // Math.max(4, Math.min(cw - w - 6, cw - w - 6)) — a Math.min of a value with itself — so
          // every label was pinned to the far right of the PANEL, out over the price scale and
          // nowhere near the drawing it belonged to.
          const w = ctx.measureText(label).width;
          const seg = d.segments[i];
          ctx.fillText(label, seg ? labelX(seg, w, plotW) : Math.max(4, plotW - w - 6), lvl.y - 2);
        });
        ctx.restore();
      }

      // ── TEXT ON THE CHART ────────────────────────────────────────────────────────────────────
      //
      // ⚠️ PLAIN TEXT, NO PLATE. Both kinds used to be drawn inside a rounded, stroked, filled box, so
      // a one-word note read as a badge stuck onto the chart rather than as writing on it. Professional
      // charting tools draw the glyphs and nothing else; the reader is annotating a chart, not adding
      // widgets to one. What is left is the text, and — only while the drawing is selected — a faint
      // dashed outline saying "this is the thing you can drag". That disappears on deselect.
      //
      // ⚠️ AND THE BOX IS RECORDED, NOT JUST DRAWN. textRects is what makes the writing grabbable: the
      // pointer handler needs to know where the glyphs ended up, and the only place that is known is
      // here, after measuring them in the font they were actually painted in.
      {
        const def = tool(d.source.type);
        const isNote = def?.hasText === true;
        const body = isNote
          ? (d.source.text || '')
          : (typeof d.source.label === 'string' ? d.source.label.trim() : '');
        if (body) {
          const lstyle = sanitizeLabelStyle(d.source.labelStyle);
          const { plotWidth, plotHeight } = plotSize();
          const plotBox = { w: plotWidth, h: plotHeight };
          ctx.save();
          ctx.font = labelFont(lstyle);
          const tw = ctx.measureText(body).width;

          // A note's anchor IS the drawing, so its text hangs off its own handle. An attached caption
          // is placed along the line it belongs to, or wherever the user dragged it to.
          let box = null;
          if (isNote) {
            const a = d.handles[0];
            if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
              box = labelBox([a, a], lstyle, tw, plotBox, { at: { x: a.x + LABEL_GAP, y: a.y - labelHeight(lstyle) / 2 } });
            }
          } else {
            const seg = d.segments[0] || (d.handles[0] ? [d.handles[0], d.handles[0]] : null);
            // The manual position, projected from data space to pixels. Absent until the user drags.
            const at = labelAnchorPoint(lstyle, toScreen);
            if (seg) box = labelBox(seg, lstyle, tw, plotBox, at ? { at } : {});
          }

          if (box) {
            const ink = lstyle.color === undefined
              ? colour : indicatorColor(stateRef.current.theme, lstyle.color);
            ctx.fillStyle = ink;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(body, box.textX, box.textY);
            // The one temporary affordance, and only while selected.
            if (isSel) {
              ctx.save();
              ctx.strokeStyle = ink;
              ctx.globalAlpha = 0.45;
              ctx.lineWidth = 1;
              ctx.setLineDash([3, 3]);
              ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
              ctx.restore();
            }
            textRects.set(d.id, { x: box.x, y: box.y, w: box.w, h: box.h, note: isNote });
          }
          ctx.restore();
        }
      }

      if (isSel) {
        ctx.save();
        ctx.fillStyle = p.background;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        for (const hnd of d.handles) {
          ctx.beginPath(); ctx.arc(hnd.x, hnd.y, HANDLE_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    }

    // ── WHERE THE SELECTION IS, IN PIXELS ─────────────────────────────────────
    //
    // ⚠️ REPORTED FROM THE PAINT PASS, NOT COMPUTED BY THE TOOLBAR. The toolbar has no access to the
    // chart's scales and must never grow one: a second projection would be a second opinion about
    // where a drawing is, and the two would diverge on exactly the frames that matter — during a
    // drag, during a zoom, during a resize. This is the same `projected` the strokes came from, so
    // the toolbar is attached to the pixels a user can actually see.
    //
    // ⚠️ AND IT IS ONLY EMITTED WHEN IT CHANGES. paint() runs on every crosshair move; calling
    // setState from it unconditionally would re-render the chart on every pointer event.
    if (onSelectionBoxRef.current) {
      const sel = projected.filter((d) => stateRef.current.selected.has(d.id) && d.visible !== false);
      const box = sel.length ? selectionBox(sel) : null;
      // ⚠️ THE PLOT TRAVELS WITH THE BOX. Clamping the toolbar needs the drawable area, which is the
      // canvas MINUS the price scale and the time axis — a number only this component can ask the
      // chart for. Sending the container's size instead would let the toolbar settle over the price
      // scale, which is the one part of a chart a trader is always reading.
      const { plotWidth, plotHeight } = plotSize();
      const key = box
        ? `${box.x.toFixed(1)},${box.y.toFixed(1)},${box.w.toFixed(1)},${box.h.toFixed(1)},${plotWidth},${plotHeight}`
        : '';
      if (key !== stateRef.current.boxKey) {
        stateRef.current.boxKey = key;
        onSelectionBoxRef.current(box ? { box, plot: { w: plotWidth, h: plotHeight } } : null);
      }
    }

    // THE MEASUREMENT. Painted over everything because it is what the user is reading right now.
    const meas = stateRef.current.measure;
    if (meas?.points?.length === 2) {
      const list = stateRef.current.bars || [];
      const r = measureBetween(meas.points[0], meas.points[1], list);
      const p1 = toScreen(meas.points[0]);
      const p2 = toScreen(meas.points[1]);
      if (p1 && p2 && r) {
        const pal = palette(stateRef.current.theme);
        const tone = r.up ? pal.up : pal.down;
        ctx.save();
        // The shaded span, then its outline: the shape says "from here to here" at a glance.
        ctx.fillStyle = r.up ? pal.volumeUp : pal.volumeDown;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = tone;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
        // The direction arrow, down the middle.
        ctx.beginPath(); ctx.moveTo((p1.x + p2.x) / 2, p1.y); ctx.lineTo((p1.x + p2.x) / 2, p2.y); ctx.stroke();

        // EVERY FIGURE IS DERIVED, AND A MISSING ONE IS OMITTED — never shown as zero. Volume is not
        // reported at all: summing it over a range needs data this chart does not hold.
        const lines = [];
        if (r.change != null) {
          lines.push(`${r.change >= 0 ? '+' : '−'}${Math.abs(r.change).toFixed(2)}`
            + (r.pct != null ? `  (${r.change >= 0 ? '+' : '−'}${Math.abs(r.pct).toFixed(2)}%)` : ''));
        }
        const second = [];
        if (r.bars != null) second.push(`${r.bars} bar${r.bars === 1 ? '' : 's'}`);
        if (r.duration) second.push(r.duration);
        if (second.length) lines.push(second.join('  ·  '));

        if (lines.length) {
          // Tabular figures: the numbers change on every pointer move, and proportional digits make
          // the whole box breathe in and out as they do.
          ctx.font = "600 11.5px 'DM Sans', sans-serif";
          ctx.letterSpacing = '0px';
          const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
          const h = lines.length * 15 + 9;
          // Clamped into the canvas, so a measurement taken at the edge still reads.
          const bx = Math.max(4, Math.min((p1.x + p2.x) / 2 - w / 2, (canvasRef.current?.clientWidth || 0) - w - 4));
          const by = Math.max(4, Math.min(p2.y + (p2.y >= p1.y ? 8 : -h - 8), (canvasRef.current?.clientHeight || 0) - h - 4));
          ctx.fillStyle = tone;
          ctx.beginPath();
          if (ctx.roundRect) { ctx.roundRect(bx, by, w, h, 5); ctx.fill(); } else ctx.fillRect(bx, by, w, h);
          ctx.fillStyle = '#FFFFFF';
          ctx.textBaseline = 'top';
          lines.forEach((t, i) => ctx.fillText(t, bx + 8, by + 6 + i * 15));
        }
        ctx.restore();
      }
    }

    // THE IN-PROGRESS SHAPE. For a two-point tool that is the placed anchor plus the cursor; for a
    // ONE-POINT tool it is the cursor alone, which is the case that used to draw nothing at all —
    // arming Horizontal Line or Vertical Line gave no feedback whatsoever until the click landed.
    const draft = draftPreview(stateRef.current.life);
    if (draft) {
      const def = tool(draft.type);
      const pts = draft.points;
      {
        const view = currentView();
        const sc = scale();
        ctx.save();
        ctx.strokeStyle = indicatorColor(stateRef.current.theme, stateRef.current.style.color);
        ctx.lineWidth = stateRef.current.style.width;
        ctx.setLineDash([4, 4]);
        for (const [a, b] of def.segments(pts, view, stateRef.current.draftExtra)) {
          // The same resolver the committed drawings use: a draft whose endpoints are plot edges
          // has to be placeable too, or the tool would show nothing until the click landed.
          const p1 = resolveAnchor(a, sc), p2 = resolveAnchor(b, sc);
          if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
        }
        ctx.restore();
      }
    }
  }, [project, toScreen, currentView, scale, plotSize, series]);

  // Escape (handled by the chart, which owns the shortcuts) clears a measurement and any half-placed
  // shape. A counter rather than a callback: the layer keeps these in a ref, so there is no state to
  // lift and nothing to keep in sync.
  useEffect(() => {
    if (!clearSignal) return;
    stateRef.current.measure = null;
    stateRef.current.life = cancelDraft(stateRef.current.life || idleTool());
    // Cancelling mid-placement takes the preview with it: there is no longer a level being chosen.
    clearCursorPrice();
    paint();
  }, [clearSignal, paint, clearCursorPrice]);

  // PUTTING THE TOOL DOWN ENDS THE PREVIEW. Without this the temporary chip stayed on the axis after
  // the tool was disarmed — a price the user is no longer placing, sitting next to the real ones.
  useEffect(() => {
    if (!activeTool) clearCursorPrice();
  }, [activeTool, clearCursorPrice]);

  // ⚠️ DECLARED BEFORE THE EFFECT BELOW THAT DEPENDS ON IT. A dependency array is evaluated on the
  // first render, so listing a `const` declared further down reads it inside its temporal dead zone
  // and throws. That is how a chart regression reached production once before.
  /**
   * THE PRICE CHIPS ON THE RIGHT-HAND AXIS, one per price-labelled drawing.
   *
   * Each is a native price line with its line hidden, so the chip is the library's own — same shape,
   * same font and same formatter as the current-price chip above it, which means an instrument's
   * precision is inherited rather than guessed at. The number comes from the drawing's stored anchor
   * via the tool's `priceLabel`, so the chip and the line cannot disagree: there is one price.
   *
   * ⚠️ THE CURRENT-PRICE CHIP IS UNTOUCHED. These are additional price lines on the same series; the
   * series' own `priceLineVisible`/`lastValueVisible` are not read or written here, so the market
   * price keeps its label and every drawing chip sits alongside it.
   */
  const syncAxisChips = useCallback(() => {
    if (!series) return;
    // ⚠️ A NEW SERIES MEANS THE OLD CHIPS ARE ALREADY GONE. CPChart removes and re-adds the price
    // series on a chart-type change, and every price line on it dies with it. The handles we hold
    // would then point at a destroyed object, so the map is dropped rather than reconciled against —
    // reconciling would try to applyOptions a dead line, and removePriceLine it from the wrong
    // series. Nothing is removed here because there is nothing left to remove.
    if (axisOwnerRef.current !== series) {
      axisRef.current = new Map();
      axisOwnerRef.current = series;
    }
    // ⚠️ THE PLOT'S BOUNDS, MEASURED NOW. A level outside them gets no chip rather than a chip
    // pinned to the edge, and the test is made against the chart's own conversion so it stays right
    // through zoom, a price-scale drag, autoscale and a resize.
    const { plotHeight } = plotSize();
    const specs = axisLabelSpecs(stateRef.current.drawings, tool, {
      visible: stateRef.current.visible,
      colorOf: (d) => indicatorColor(stateRef.current.theme, d.style?.color),
      inView: (price) => priceInPlot(price, (v) => series.priceToCoordinate(v), 0, plotHeight),
    });
    axisRef.current = reconcileAxisLabels(axisRef.current, specs, {
      create: (spec) => series.createPriceLine(priceLineOptionsFor(spec)),
      update: (handle, spec) => handle.applyOptions(priceLineOptionsFor(spec)),
      remove: (handle) => series.removePriceLine(handle),
    });
  }, [series, plotSize]);

  // Props that change the chips: the drawings themselves, their colours, and whether the layer shows.
  useEffect(() => { syncAxisChips(); }, [drawings, theme, visible, syncAxisChips]);

  // Repaint whenever the chart moves. Subscribing to the chart's own events keeps the overlay in
  // lockstep with it instead of guessing with a timer.
  useEffect(() => {
    if (!chart) return undefined;
    const onRange = () => { paint(); syncAxisChips(); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => { paint(); syncAxisChips(); });
    if (canvasRef.current) ro.observe(canvasRef.current);

    // ⚠️ THERE IS NO EVENT FOR A VERTICAL SCALE CHANGE.
    //
    // Lightweight Charts publishes subscriptions for the time range, clicks, the crosshair and size —
    // and nothing at all for the price scale. So dragging the price axis, or its own autoscale
    // settling after new data, moves every price on the chart with no notification: the overlay would
    // keep its last pixels and a chip would keep its last in-view answer.
    //
    // The crosshair fires on any pointer movement over the chart, which includes a price-scale drag,
    // and the legend already listens to it — so the cost is one extra handler on an event we pay for
    // anyway. What it does is deliberately almost nothing: read the price at the top and bottom of the
    // plot, compare with the last pair, and only act when they have actually moved. A drag repaints;
    // a mouse crossing the chart does not.
    let lastSig = null;
    const onCrosshair = () => {
      if (!series) return;
      const { plotHeight } = plotSize();
      const top = series.coordinateToPrice(0);
      const bottom = series.coordinateToPrice(plotHeight);
      if (top == null || bottom == null) return;
      const sig = `${top}:${bottom}:${plotHeight}`;
      if (sig === lastSig) return;
      lastSig = sig;
      paint();
      syncAxisChips();
    };
    try { chart.subscribeCrosshairMove(onCrosshair); } catch { /* optional */ }

    paint();
    syncAxisChips();
    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* chart gone */ }
      try { chart.unsubscribeCrosshairMove(onCrosshair); } catch { /* chart gone */ }
      ro.disconnect();
    };
  }, [chart, series, paint, plotSize, syncAxisChips]);

  useEffect(() => { paint(); }, [drawings, selectedIds, theme, visible, bars, activeTool, paint]);


  // Every chip comes off when the layer goes away, so a symbol change or an unmount cannot leave
  // orphans on the axis of the next chart.
  useEffect(() => () => {
    const host = seriesRef.current;
    if (!host) return;
    for (const { handle } of axisRef.current.values()) {
      try { host.removePriceLine(handle); } catch { /* chart already gone */ }
    }
    axisRef.current = new Map();
  }, []);

  /**
   * SELECTION COMES FROM THE CHART'S OWN CLICK, not from the canvas.
   *
   * The overlay is pointer-transparent while idle so the chart keeps its native pan, zoom and
   * crosshair — which also means it never sees the click that would select a drawing. Lightweight
   * Charts reports the click with its coordinates, so the hit test runs there instead and the
   * overlay stays out of the way until there is something to drag.
   */
  useEffect(() => {
    if (!chart) return undefined;
    const onClick = (param) => {
      // COMMITTING SWALLOWS THE NEXT CHART CLICK. Lightweight Charts reports this click AFTER our
      // pointerdown has already committed and disarmed the tool, so without this the handler saw no
      // armed tool, hit-tested, missed, and deselected the drawing made a moment earlier.
      if (stateRef.current.life?.suppressClick) {
        stateRef.current.life = clearSuppression(stateRef.current.life);
        return;
      }
      if (stateRef.current.life?.activeTool || !stateRef.current.visible) return;
      if (!param?.point) { onSelect(null); return; }
      // ⚠️ THE TEXT IS A TARGET HERE TOO, AND THIS IS THE ONLY PLACE IT CAN BE WHILE NOTHING IS
      // SELECTED. The overlay that owns the caption's own hit-testing is pointerEvents:none until
      // something is selected — that is what keeps the chart's pan, zoom and crosshair native — so a
      // click on a caption never reached it, and reaching the caption still meant finding its line
      // first. The chart reports the click with coordinates, so the same rectangles are consulted
      // here. Once selected the overlay is live and the drag path takes over.
      const onText = textHitAt(param.point);
      if (onText) { onSelect(onText, false); return; }
      const hit = hitTest(param.point, project());
      // Always a fresh selection: the chart's own click carries no modifier we can read, and the
      // canvas (which does) is what handles shift-clicking a second drawing.
      onSelect(hit ? hit.id : null, false);
    };
    chart.subscribeClick(onClick);
    return () => { try { chart.unsubscribeClick(onClick); } catch { /* chart gone */ } };
  }, [chart, project, onSelect]);

  // ── interaction ──
  const localPoint = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /**
   * The pointer position, with SHIFT snapping the segment to the nearest 45°.
   *
   * Constrained in screen space and then converted back, because an angle is something the eye
   * judges against pixels — the same two anchors subtend a different angle at every zoom level, so
   * snapping in price/time space would produce a line that looks like no particular angle at all.
   */
  const anchorAt = (pt, e) => {
    const first = s.life?.points?.[0];
    if (!e?.shiftKey || !first) return toData(pt.x, pt.y);
    const from = toScreen(first);
    if (!from) return toData(pt.x, pt.y);
    const c = constrainAngle(from, pt);
    return toData(c.x, c.y);
  };

  const onPointerDown = (e) => {
    const pt = localPoint(e);
    // PLACING a new drawing. WHEN it commits is the lifecycle's decision, and it is the same
    // decision for every tool: a one-point tool commits on this click, a two-point tool on the next.
    if (s.life?.activeTool) {
      const toolId = s.life.activeTool;
      const def = tool(toolId);
      const data = anchorAt(pt, e);
      if (!data) return;
      const step = clickTool(s.life, data);
      s.life = step.state;
      if (step.commit) {
        const pts = step.commit;
        if (def.transient) {
          // A MEASUREMENT IS NOT A DRAWING. It answers a question and is then done with, so it is
          // held here and painted, never stored and never in the object tree.
          s.measure = { type: def.id, points: pts };
        } else if (def.hasText) {
          // A note needs its text before it exists — an empty label on the chart is just a dot the
          // user has to go and find again. The caller opens the editor and creates it on commit.
          // The click's VIEWPORT position travels with it, so the editor opens where the note will
          // be rather than hanging off the bottom of the chart.
          onRequestText?.(pts, { x: e.clientX, y: e.clientY });
        } else {
          const made = createDrawing(toolId, pts, s.style, s.drawings, s.toolDefaults?.[toolId] || {});
          if (made) { onChange([...s.drawings, made]); onSelect(made.id); }
        }
        onToolUsed();
        // The preview has served its purpose — the committed drawing owns that price now, and carries
        // its own chip. Leaving the temporary one up would show the same number twice.
        clearCursorPrice();
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
      paint();
      return;
    }
    // ⚠️ DRAGGING THE WRITING COMES FIRST, BEFORE hitTest AND BEFORE THE CHART SEES THE PRESS. The
    // caption usually sits ON its own line, so whichever of the two is asked first is the one you can
    // grab — and a reader pressing on the word "support" means the word. Returning here is what keeps
    // the gesture from also moving the drawing underneath and from panning the chart.
    const textId = textHitAt(pt);
    if (textId) {
      const target = s.drawings.find((d) => d.id === textId);
      // ⚠️ CLICKING THE WORDS SELECTS THE DRAWING THEY BELONG TO. It used to require the drawing to be
      // selected already, so reaching a caption meant finding and clicking its line first — which is
      // exactly the thing the caption exists to save you from.
      onSelect(textId, !!e.shiftKey);
      if (target && !target.locked) {
        // ⚠️ NO DELTA ARITHMETIC. The pointer's own data coordinates ARE the new position, so there is
        // nothing to convert, accumulate or shift — which is where the horizontal axis was lost.
        s.textDrag = { id: textId, token: gestureToken('text') };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.stopPropagation?.();
        e.preventDefault?.();
      }
      paint();
      return;
    }
    // A click anywhere with no tool armed dismisses a measurement — the same gesture that dismisses
    // it on every platform that has one.
    if (s.measure) { s.measure = null; paint(); }
    // SELECTING or starting a drag. Shift adds to the selection rather than replacing it, which is
    // the gesture every drawing program uses.
    const hit = hitTest(pt, project());
    const additive = !!e.shiftKey;
    onSelect(hit ? hit.id : null, additive);
    if (hit && !additive) {
      // Dragging one of several selected drawings moves THE WHOLE SELECTION, by one delta computed
      // once — which is what makes a group move robust: there is no accumulated per-item drift.
      // A HANDLE drag is different: resizing is about one drawing's anchor, so it stays singular.
      const group = (s.selected.has(hit.id) && s.selected.size > 1 && hit.handle == null)
        ? s.drawings.filter((x) => s.selected.has(x.id) && !x.locked)
        : s.drawings.filter((x) => x.id === hit.id && !x.locked);
      if (group.length) {
        const data = toData(pt.x, pt.y);
        // ONE TOKEN FOR THE WHOLE DRAG. Every pointer move reports a change; tagging them all with
        // the same token collapses them into the single undo step a user expects, instead of a
        // hundred one-pixel steps.
        s.drag = { handle: hit.handle, from: data, originals: group, token: gestureToken('drag') };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    }
    paint();
  };

  // Double-clicking a drawing opens its settings, which is where every charting tool puts them.
  const onDoubleClick = (e) => {
    const hit = hitTest(localPoint(e), project());
    if (hit) onOpenSettings?.(hit.id);
  };

  const onPointerMove = (e) => {
    const pt = localPoint(e);
    if (s.life?.activeTool) {
      const hover = anchorAt(pt, e);
      s.life = hoverTool(s.life, hover);
      // The price under the cursor, on the axis, before anything is committed — which is the whole
      // point of a preview: the user picks the level by reading it, not by guessing.
      showCursorPrice(hover);
      // A ruler that only reports once both ends are placed is far less useful than one that counts
      // as you move, so the measurement updates live from the first anchor to the cursor.
      if (tool(s.life.activeTool)?.transient && s.life.cursor && s.life.points[0]) {
        s.measure = { type: s.life.activeTool, points: [s.life.points[0], s.life.cursor] };
      }
      paint();
      return;
    }
    // ⚠️ MOVING THE WRITING MOVES ONLY THE WRITING. The offset is recomputed from the drag's own start
    // point each frame rather than accumulated, so there is no per-move drift over a long drag — the
    // same reason the drawing drag measures every step from its original.
    if (s.textDrag) {
      // ⚠️ THE POINTER'S OWN TIME AND PRICE, STORED VERBATIM. Both axes move because both come from the
      // same projection the chart uses for everything else — no offset, no delta, no time arithmetic
      // of our own, which is where the horizontal axis was being silently dropped on daily charts.
      const now = toData(pt.x, pt.y);
      if (!now) return;
      onChange(s.drawings.map((d) => (d.id !== s.textDrag.id ? d : {
        ...d,
        labelStyle: sanitizeLabelStyle({ ...sanitizeLabelStyle(d.labelStyle), at: { time: now.time, price: now.price } }),
      })), s.textDrag.token);
      paint();
      return;
    }
    if (!s.drag) return;
    const now = toData(pt.x, pt.y);
    if (!now || !s.drag.from) return;
    // Dragging an existing level gets the same readout, so the user can see the price they are
    // moving it TO rather than only where it started.
    showCursorPrice(now);
    const dTime = timeDeltaSeconds(s.drag.from.time, now.time);
    const dPrice = now.price - s.drag.from.price;
    // Every drawing in the group takes the SAME delta, each measured from its own original — so a
    // group keeps its shape exactly, however far or long the drag runs.
    const movedById = new Map();
    for (const orig of s.drag.originals) {
      movedById.set(orig.id, moveDrawing(orig, { dTime, dPrice }, s.drag.handle));
    }
    onChange(s.drawings.map((d) => movedById.get(d.id) || d), s.drag.token);
  };

  const endDrag = (e) => {
    if (s.textDrag) {
      // Release SAVES it: every move already wrote through onChange under one token, so the whole
      // drag is one undo step and the last position is the stored one.
      s.textDrag = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    if (s.drag) { s.drag = null; e.currentTarget.releasePointerCapture?.(e.pointerId); clearCursorPrice(); }
  };

  // The pointer leaving the plot ends the preview, exactly as it ends the chart's own crosshair.
  const onPointerLeave = () => clearCursorPrice();

  // The overlay is INERT unless it is doing something: no armed tool, no selection and no draft means
  // the chart underneath owns the pointer and keeps its native zoom, pan and crosshair.
  const interactive = !!activeTool || selectedIds.length > 0 || hasDraft(s.life);

  return (
    <canvas
      ref={canvasRef}
      // Marked so the export can find it without a ref being threaded through three components.
      data-cp-drawings=""
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={onPointerLeave}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 3,
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: activeTool ? 'crosshair' : (selectedIds.length ? 'move' : 'default'),
      }}
    />
  );
}

// MEMOISED. The chart re-renders on every crosshair move — that is one setState per pointer move by
// design, to keep the legend live — and without this, DrawingLayer re-rendered with it even though
// none of its props had changed. Its callers pass stable callbacks for the same reason.
const DrawingLayer = memo(DrawingLayerBase);
export default DrawingLayer;
