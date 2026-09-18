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
// ⚠️ change_pct here is END-OF-DAY: screener_stocks is rebuilt once daily, pre-market, from settled
// candles, so this panel shows the last COMPLETED session's move and not an intraday one. The
// dedicated page states its own freshness; this panel's contract is unchanged pending the licensed
// provider. See the heatmap section of HANDOFF.md.

export default function HeatMap({ onPick, limit = 150 }) {
  const [rows, setRows] = useState(null);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/heatmap?limit=${limit}`, { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setRows(j?.rows || []);
      } catch { if (alive) setRows([]); }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [limit]);

  const pick = (t) => { if (onPick) onPick(t); else router.push(`/ticker/${encodeURIComponent(t)}`); };

  // `changePct` is this endpoint's field name; the canvas reads `pct`, which is the name the
  // performance board uses. Mapped here rather than renaming the Terminal's API contract.
  const tiles = rows === null ? null : rows.map((r) => ({ ...r, pct: r.changePct ?? null }));

  return <HeatmapCanvas rows={tiles} onPick={pick} scale={3} />;
}
