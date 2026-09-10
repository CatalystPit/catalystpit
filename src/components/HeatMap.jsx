'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { C } from '../lib/cp-shared';

// Finviz-style market heat map: a squarified treemap grouped by sector, tiles sized by market cap and
// colored by change % (green up / red down). Data from /api/heatmap (our own screener_stocks). Click a
// tile → onPick(symbol) if provided (Terminal), else navigate to the ticker page.

// Diverging heat color (semantic — same in light/dark; tiles always carry white text).
function heatColor(pct) {
  if (pct == null || isNaN(pct)) return '#2f3a34';
  const p = Math.max(-3, Math.min(3, pct)) / 3;   // -1..1, clamped at ±3%
  if (p >= 0) return `rgb(${Math.round(60 - 44 * p)},${Math.round(78 + 92 * p)},${Math.round(66 + 20 * p)})`;
  const a = -p;
  return `rgb(${Math.round(60 + 150 * a)},${Math.round(78 - 40 * a)},${Math.round(66 - 42 * a)})`;
}

// Squarified treemap (Bruls et al.). nodes:[{value,...}] → [{...node, x,y,w,h}] filling the rect.
function treemap(nodes, X, Y, W, H) {
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

export default function HeatMap({ onPick, limit = 150 }) {
  const [rows, setRows] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const wrap = useRef(null);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    const load = async () => { try { const r = await fetch(`/api/heatmap?limit=${limit}`, { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (alive) setRows(j?.rows || []); } catch { if (alive) setRows([]); } };
    load(); const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [limit]);
  useEffect(() => {
    const el = wrap.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { for (const e of es) setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const pick = (t) => { if (onPick) onPick(t); else router.push(`/ticker/${encodeURIComponent(t)}`); };

  const tiles = useMemo(() => {
    if (!rows || !rows.length || size.w < 40 || size.h < 40) return [];
    const bySec = {};
    for (const r of rows) { const s = r.sector || 'Other'; (bySec[s] ||= []).push(r); }
    const sectors = Object.entries(bySec).map(([name, items]) => ({ name, items, value: items.reduce((a, x) => a + (x.marketCap || 0), 0) })).filter((s) => s.value > 0);
    const secRects = treemap(sectors, 0, 0, size.w, size.h);
    const out = [];
    const HEADER = 13;
    for (const sr of secRects) {
      out.push({ kind: 'sector', name: sr.name, x: sr.x, y: sr.y, w: sr.w });
      const innerY = sr.y + HEADER, innerH = sr.h - HEADER;
      if (innerH < 8 || sr.w < 8) continue;
      for (const tr of treemap(sr.items.map((it) => ({ ...it, value: it.marketCap || 0 })), sr.x, innerY, sr.w, innerH)) out.push({ kind: 'tile', ...tr });
    }
    return out;
  }, [rows, size]);

  return (
    <div ref={wrap} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: C.bg }}>
      {rows === null && <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12.5 }}>Loading heat map…</div>}
      {rows && rows.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: C.muted, fontSize: 12.5 }}>No market data yet.</div>}
      {tiles.map((t, i) => t.kind === 'sector'
        ? <div key={`s${i}`} style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: 13, overflow: 'hidden', fontSize: 8.5, fontWeight: 800, letterSpacing: 0.4, color: C.dim, textTransform: 'uppercase', padding: '2px 4px', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{t.name}</div>
        : (
          <button key={`t${i}`} onClick={() => pick(t.ticker)} title={`${t.ticker}${t.changePct != null ? '  ' + (t.changePct > 0 ? '+' : '') + t.changePct.toFixed(2) + '%' : ''}`}
            style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: t.h, background: heatColor(t.changePct), border: `1px solid ${C.bg}`, boxSizing: 'border-box', cursor: 'pointer', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 0, lineHeight: 1.05 }}>
            {t.w > 30 && t.h > 18 && <span className="cp-tkr" style={{ fontSize: Math.min(15, Math.max(8, t.w / 5.5)), fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>{t.ticker}</span>}
            {t.w > 44 && t.h > 34 && t.changePct != null && <span className="cp-num" style={{ fontSize: Math.min(11, Math.max(7.5, t.w / 8)), opacity: 0.95 }}>{t.changePct > 0 ? '+' : ''}{t.changePct.toFixed(1)}%</span>}
          </button>
        ))}
    </div>
  );
}
