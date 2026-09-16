'use client';
import { useEffect, useRef, useCallback } from 'react';
import {
  TOOLS, tool, hitTest, createDrawing, moveDrawing, fibLevels,
  HANDLE_RADIUS, DEFAULT_STYLE,
} from '../../lib/chart/chart-drawings.mjs';
import { palette, indicatorColor } from '../../lib/chart/chart-theme.mjs';

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
  selectedId, onSelect, visible = true, style = DEFAULT_STYLE,
}) {
  const canvasRef = useRef(null);
  const stateRef = useRef({});
  const s = stateRef.current;
  s.drawings = drawings; s.activeTool = activeTool; s.selected = selectedId;
  s.theme = theme; s.visible = visible; s.style = style; s.bars = bars;

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
    return { time: list[idx].time, price };
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
      const segs = def.segments(d.points, view);
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
      const isSel = d.id === stateRef.current.selected;

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
        for (const lvl of fibLevels(d.source.points)) {
          const y = series?.priceToCoordinate(lvl.price);
          if (y == null) continue;
          ctx.fillText(`${(lvl.ratio * 100).toFixed(1)}%  ${lvl.price.toFixed(2)}`, 6, y - 3);
        }
        ctx.restore();
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
        for (const [a, b] of def.segments(pts, view)) {
          const p1 = toScreen(a), p2 = toScreen(b);
          if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); }
        }
        ctx.restore();
      }
    }
  }, [project, toScreen, currentView, series]);

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

  useEffect(() => { paint(); }, [drawings, selectedId, theme, visible, bars, activeTool, paint]);

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
      onSelect(hit ? hit.id : null);
    };
    chart.subscribeClick(onClick);
    return () => { try { chart.unsubscribeClick(onClick); } catch { /* chart gone */ } };
  }, [chart, project, onSelect]);

  // ── interaction ──
  const localPoint = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e) => {
    const pt = localPoint(e);
    // PLACING a new drawing.
    if (s.activeTool) {
      const def = tool(s.activeTool);
      const data = toData(pt.x, pt.y);
      if (!data) return;
      s.draft = s.draft?.type === s.activeTool ? s.draft : { type: s.activeTool, points: [] };
      s.draft.points.push(data);
      if (s.draft.points.length >= def.points) {
        const made = createDrawing(s.activeTool, s.draft.points, s.style, s.drawings);
        s.draft = null;
        if (made) { onChange([...s.drawings, made]); onSelect(made.id); }
        onToolUsed();
      }
      e.currentTarget.setPointerCapture?.(e.pointerId);
      paint();
      return;
    }
    // SELECTING or starting a drag.
    const hit = hitTest(pt, project());
    onSelect(hit ? hit.id : null);
    if (hit) {
      const d = s.drawings.find((x) => x.id === hit.id);
      const data = toData(pt.x, pt.y);
      s.drag = { id: hit.id, handle: hit.handle, from: data, original: d };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    paint();
  };

  const onPointerMove = (e) => {
    const pt = localPoint(e);
    if (s.draft?.points?.length) { s.draft.cursor = toData(pt.x, pt.y); paint(); return; }
    if (!s.drag) return;
    const now = toData(pt.x, pt.y);
    if (!now || !s.drag.from) return;
    const dTime = (typeof now.time === 'number' && typeof s.drag.from.time === 'number') ? now.time - s.drag.from.time : 0;
    const dPrice = now.price - s.drag.from.price;
    const moved = moveDrawing(s.drag.original, { dTime, dPrice }, s.drag.handle);
    onChange(s.drawings.map((d) => (d.id === moved.id ? moved : d)));
  };

  const endDrag = (e) => {
    if (s.drag) { s.drag = null; e.currentTarget.releasePointerCapture?.(e.pointerId); }
  };

  // The overlay is INERT unless it is doing something: no armed tool, no selection and no draft means
  // the chart underneath owns the pointer and keeps its native zoom, pan and crosshair.
  const interactive = !!activeTool || !!selectedId || !!s.draft;

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 3,
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: activeTool ? 'crosshair' : (selectedId ? 'move' : 'default'),
      }}
    />
  );
}
