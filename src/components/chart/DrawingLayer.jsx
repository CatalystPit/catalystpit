'use client';
import { useEffect, useRef, useCallback } from 'react';
import {
  TOOLS, tool, hitTest, createDrawing, moveDrawing, fibLevels, barLevels, snapToLevel, measureBetween,
  constrainAngle,
  HANDLE_RADIUS, DEFAULT_STYLE,
} from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColor } from '../../lib/chart/chart-theme.mjs';
import { gestureToken } from '../../lib/chart/chart-history.mjs';

// The drawing surface: one canvas sitting over the chart.
//
// WHY A CANVAS OVERLAY. Lightweight Charts has no drawing tools of its own; it has price lines and a
// series-primitive API, neither of which can express a ray, a rectangle or a Fibonacci fan. An
// overlay that shares the chart's coordinate system gives every tool the same treatment and keeps
// the chart itself untouched — nothing here reaches into its internals.
//
// EVERY ANCHOR IS STORED AS { time, price } AND PROJECTED AT PAINT TIME. The chart's own scales do
// the conversion, so a drawing tracks its level exactly through zoom, pan, resize and a reload.
//
// POINTER EVENTS PASS THROUGH when no tool is armed and nothing is selected, so the chart keeps its
// own zoom, pan and crosshair. The overlay only captures input when it is actually being used.

const dashFor = (dash) => (dash === 'dashed' ? [7, 5] : dash === 'dotted' ? [2, 4] : []);

export default function DrawingLayer({
  chart, series, theme, symbol, bars,
  drawings, onChange, activeTool, onToolUsed,
  selectedIds = [], onSelect, visible = true, style = DEFAULT_STYLE, magnet = false,
  onRequestText, onOpenSettings, clearSignal = 0,
}) {
  const canvasRef = useRef(null);
  const stateRef = useRef({});
  const s = stateRef.current;
  s.drawings = drawings; s.activeTool = activeTool;
  // A Set, so the paint loop asks "is this one selected" once per drawing rather than scanning.
  s.selected = new Set(selectedIds);
  s.theme = theme; s.visible = visible; s.style = style; s.bars = bars; s.magnet = magnet;

  // ── data space <-> screen space ──
  const toScreen = useCallback((pt) => {
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(pt.time);
    const y = series.priceToCoordinate(pt.price);
    return (x == null || y == null) ? null : { x, y };
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
    if (!list.length) return null;
    const idx = Math.max(0, Math.min(list.length - 1, Math.round(logical ?? 0)));
    const bar = list[idx];

    // MAGNET. With it on, an anchor placed near a candle's open, high, low or close lands exactly on
    // it. Off — the default — this whole branch is skipped and the price is wherever the pointer is,
    // which is why the crosshair and every existing drawing behave identically to before.
    //
    // The nearness test is done in PIXELS, so it means the same thing at every zoom level, and the
    // decision itself lives in chart-drawings.mjs where it can be tested without a browser.
    if (stateRef.current.magnet) {
      const levels = barLevels(bar)
        .map((price) => ({ price, y: series.priceToCoordinate(price) }))
        .filter((l) => l.y != null);
      const snapped = snapToLevel(y, levels);
      if (snapped != null) return { time: bar.time, price: snapped, snapped: true };
    }
    return { time: bar.time, price };
  }, [chart, series]);

  /** The visible window, in data space — what a ray or a horizontal line extends across. */
  const currentView = useCallback(() => {
    const list = stateRef.current.bars || [];
    if (!chart || !series || !list.length) return null;
    const range = chart.timeScale().getVisibleRange();
    const from = range?.from ?? list[0].time;
    const to = range?.to ?? list[list.length - 1].time;
    const h = canvasRef.current?.height || 0;
    const high = series.coordinateToPrice(0);
    const low = series.coordinateToPrice(h);
    return { from, to, high: high ?? 0, low: low ?? 0 };
  }, [chart, series]);

  /** Every visible drawing, resolved to pixels, ready to paint or hit-test. */
  const project = useCallback(() => {
    const view = currentView();
    if (!view) return [];
    const out = [];
    for (const d of stateRef.current.drawings || []) {
      const def = tool(d.type);
      if (!def) continue;
      // The DRAWING is passed too: extension flags and a custom level set belong to the drawing,
      // not to the tool, so the tool cannot resolve its own geometry without it.
      const segs = def.segments(d.points, view, d);
      const screenSegs = [];
      for (const [a, b] of segs) {
        const p1 = toScreen(a), p2 = toScreen(b);
        if (p1 && p2) screenSegs.push([p1, p2]);
      }
      const handles = d.points.map(toScreen).filter(Boolean);
      if (!screenSegs.length && !handles.length) continue;
      out.push({ id: d.id, type: d.type, visible: d.visible, style: d.style, segments: screenSegs, handles, source: d });
    }
    return out;
  }, [toScreen, currentView]);

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
    if (!stateRef.current.visible) return;

    const p = palette(stateRef.current.theme);
    for (const d of project()) {
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
      ctx.strokeStyle = colour;
      ctx.lineWidth = d.style.width;
      ctx.setLineDash(dashFor(d.style.dash));
      for (const [a, b] of d.segments) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();

      // Fibonacci prints its ratio and price, which is the entire point of the tool.
      if (tool(d.type)?.levels && d.source.points.length === 2) {
        ctx.save();
        ctx.fillStyle = colour;
        ctx.font = "10px 'DM Sans', sans-serif";
        for (const lvl of fibLevels(d.source.points, d.source.levels)) {
          const y = series?.priceToCoordinate(lvl.price);
          if (y == null) continue;
          ctx.fillText(`${(lvl.ratio * 100).toFixed(1)}%  ${lvl.price.toFixed(2)}`, 6, y - 3);
        }
        ctx.restore();
      }

      // A TEXT NOTE IS ITS STRING. It draws no segments, so without this it would be invisible.
      if (tool(d.source.type)?.hasText) {
        const anchor = d.handles[0];
        if (anchor) {
          ctx.save();
          ctx.font = "600 12px 'DM Sans', sans-serif";
          ctx.textBaseline = 'middle';
          const label = d.source.text || 'Note';
          const w = ctx.measureText(label).width;
          // A backing plate, so a note stays readable over candles rather than fighting them.
          ctx.fillStyle = p.tooltipBg;
          ctx.strokeStyle = colour;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect?.(anchor.x + 6, anchor.y - 10, w + 12, 20, 4);
          if (ctx.roundRect) { ctx.fill(); ctx.stroke(); }
          ctx.fillStyle = colour;
          ctx.fillText(label, anchor.x + 12, anchor.y);
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
          ctx.font = "600 11.5px 'DM Sans', sans-serif";
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

    // The in-progress shape, drawn from the anchors placed so far plus the cursor.
    const draft = stateRef.current.draft;
    if (draft?.points?.length && draft.cursor) {
      const def = tool(draft.type);
      const pts = [...draft.points, draft.cursor].slice(0, def.points);
      if (pts.length === def.points) {
        const view = currentView();
        ctx.save();
        ctx.strokeStyle = indicatorColor(stateRef.current.theme, stateRef.current.style.color);
        ctx.lineWidth = stateRef.current.style.width;
        ctx.setLineDash([4, 4]);
        for (const [a, b] of def.segments(pts, view, stateRef.current.draftExtra)) {
          const p1 = toScreen(a), p2 = toScreen(b);
          if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
        }
        ctx.restore();
      }
    }
  }, [project, toScreen, currentView, series]);

  // Escape (handled by the chart, which owns the shortcuts) clears a measurement and any half-placed
  // shape. A counter rather than a callback: the layer keeps these in a ref, so there is no state to
  // lift and nothing to keep in sync.
  useEffect(() => {
    if (!clearSignal) return;
    stateRef.current.measure = null;
    stateRef.current.draft = null;
    paint();
  }, [clearSignal, paint]);

  // Repaint whenever the chart moves. Subscribing to the chart's own events keeps the overlay in
  // lockstep with it instead of guessing with a timer.
  useEffect(() => {
    if (!chart) return undefined;
    const onRange = () => paint();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => paint());
    if (canvasRef.current) ro.observe(canvasRef.current);
    paint();
    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* chart gone */ }
      ro.disconnect();
    };
  }, [chart, paint]);

  useEffect(() => { paint(); }, [drawings, selectedIds, theme, visible, bars, activeTool, paint]);

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
      if (stateRef.current.activeTool || !stateRef.current.visible) return;
      if (!param?.point) { onSelect(null); return; }
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
    const first = s.draft?.points?.[0];
    if (!e?.shiftKey || !first) return toData(pt.x, pt.y);
    const from = toScreen(first);
    if (!from) return toData(pt.x, pt.y);
    const c = constrainAngle(from, pt);
    return toData(c.x, c.y);
  };

  const onPointerDown = (e) => {
    const pt = localPoint(e);
    // PLACING a new drawing.
    if (s.activeTool) {
      const def = tool(s.activeTool);
      const data = anchorAt(pt, e);
      if (!data) return;
      s.draft = s.draft?.type === s.activeTool ? s.draft : { type: s.activeTool, points: [] };
      s.draft.points.push(data);
      if (s.draft.points.length >= def.points) {
        const pts = s.draft.points;
        s.draft = null;
        if (def.transient) {
          // A MEASUREMENT IS NOT A DRAWING. It answers a question and is then done with, so it is
          // held here and painted, never stored and never in the object tree.
          s.measure = { type: def.id, points: pts };
        } else if (def.hasText) {
          // A note needs its text before it exists — an empty label on the chart is just a dot the
          // user has to go and find again. The caller opens the editor and creates it on commit.
          onRequestText?.(pts);
        } else {
          const made = createDrawing(s.activeTool, pts, s.style, s.drawings);
          if (made) { onChange([...s.drawings, made]); onSelect(made.id); }
        }
        onToolUsed();
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
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
    if (s.draft?.points?.length) {
      s.draft.cursor = anchorAt(pt, e);
      // A ruler that only reports once both ends are placed is far less useful than one that counts
      // as you move, so the measurement updates live from the first anchor to the cursor.
      if (tool(s.draft.type)?.transient && s.draft.cursor) {
        s.measure = { type: s.draft.type, points: [s.draft.points[0], s.draft.cursor] };
      }
      paint();
      return;
    }
    if (!s.drag) return;
    const now = toData(pt.x, pt.y);
    if (!now || !s.drag.from) return;
    const dTime = (typeof now.time === 'number' && typeof s.drag.from.time === 'number') ? now.time - s.drag.from.time : 0;
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
    if (s.drag) { s.drag = null; e.currentTarget.releasePointerCapture?.(e.pointerId); }
  };

  // The overlay is INERT unless it is doing something: no armed tool, no selection and no draft means
  // the chart underneath owns the pointer and keeps its native zoom, pan and crosshair.
  const interactive = !!activeTool || selectedIds.length > 0 || !!s.draft;

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
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 3,
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: activeTool ? 'crosshair' : (selectedIds.length ? 'move' : 'default'),
      }}
    />
  );
}
