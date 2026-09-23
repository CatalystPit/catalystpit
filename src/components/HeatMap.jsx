'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import HeatmapCanvas from './heatmap/HeatmapCanvas';

// THE TERMINAL'S HEAT MAP PANEL.
//
// Finviz-style market heat map: a squarified treemap grouped by sector, tiles sized by market cap and
// coloured by change % (green up / red down). Data from /api/heatmap (our own screener_stocks). Click
// a tile → onPick(symbol) if provided (Terminal), else navigate to the ticker page.
//
// The layout, colour ramp and tile rendering moved to HeatmapCanvas / heatmap-layout.mjs when the
// dedicated /heatmap page was built, so there is ONE heatmap implementation rather than two that
// drift. This file is now what it always should have been: a data source and a click handler. The
// panel's appearance is unchanged — that is the same code, in one place.
//
// ⚠️ TWO DATA SOURCES, CHOSEN BY THE CALLER — see the `shared` prop below.
//
//   default (Terminal)  /api/heatmap — change_pct off screener_stocks, rebuilt once daily
//                       pre-market, so it shows the last COMPLETED session's move.
//   shared (homepage)   /api/heatmap/performance — the shared 15-minute market snapshot the
//                       dedicated /heatmap page uses, with its session lifecycle.

/**
 * @param shared  Read the SHARED 15-minute market snapshot instead of the legacy board.
 *
 * ⚠️ THE HOMEPAGE WAS SHOWING LAST NIGHT'S CLOSES WHILE /heatmap SHOWED TODAY. Both render this
 * component, but it fetched `/api/heatmap` — the Terminal's original endpoint, which reads prices
 * off screener_stocks and is therefore only as fresh as the nightly rebuild. The dedicated page
 * uses `/api/heatmap/performance`, which owns the shared snapshot: one market-wide capture every
 * 15 minutes during the regular session, frozen after the bell, zero upstream requests overnight,
 * at weekends or on holidays, and identical for every viewer.
 *
 * Opt-in rather than a default so the Terminal's panel keeps the contract it has today — this
 * change is scoped to the homepage card.
 *
 * ⚠️ AND IT ADDS NO UPSTREAM COST. The performance route serves an existing snapshot; a homepage
 * viewer costs a KV read and never a provider call, however many of them arrive.
 */
export default function HeatMap({ onPick, limit = 150, shared = false }) {
  const [rows, setRows] = useState(null);
  const router = useRouter();

  // Entitlement decides only which URL is asked for — the server resolves the session itself and
  // hands a Free caller the completed-session board regardless. `rt=1` is a cache key, never a
  // grant; without the split the CDN would serve one audience's board to the other.
  const [entitled, setEntitled] = useState(false);
  useEffect(() => {
    if (!shared) return undefined;
    let alive = true;
    fetch('/api/me/plan', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setEntitled(j?.tier === 'pro' || j?.tier === 'elite'); })
      .catch(() => {});
    return () => { alive = false; };
  }, [shared]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const url = shared
          ? `/api/heatmap/performance?timeframe=1D&universe=top500${entitled ? '&rt=1' : ''}`
          : `/api/heatmap?limit=${limit}`;
        const r = await fetch(url, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        // The shared board is the Top 500; this card shows the largest `limit` of them, which is
        // the same universe seen through a smaller window — never a different universe.
        if (alive) setRows(shared ? (j?.rows || []).slice(0, limit) : (j?.rows || []));
      } catch { if (alive) setRows([]); }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [limit, shared, entitled]);

  const pick = (t) => { if (onPick) onPick(t); else router.push(`/ticker/${encodeURIComponent(t)}`); };

  // ⚠️ THE TWO ENDPOINTS NAME THE SAME NUMBER DIFFERENTLY. The shared board returns `pct`; the
  // legacy Terminal board returns `changePct`, and the canvas reads `pct`. Coalescing here keeps
  // the Terminal's API contract untouched.
  const tiles = rows === null ? null : rows.map((r) => ({ ...r, pct: r.pct ?? r.changePct ?? null }));

  return <HeatmapCanvas rows={tiles} onPick={pick} scale={3} />;
}
