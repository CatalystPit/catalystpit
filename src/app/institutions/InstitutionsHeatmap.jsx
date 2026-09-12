'use client';

// Institutional Accumulation Heatmap. Sectors are the parent tiles, tickers nest inside them.
// Tile AREA is institutional position value; tile COLOUR is the quarter-over-quarter change in
// shares held. Deliberately its own component: the Insiders heatmap is approved and untouched, and
// the two answer different questions.
//
// The layout engine is the shared squarified treemap already proven on the other two maps.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { C } from '../../lib/cp-shared';
import { treemap } from '../../lib/treemap';

const HEIGHT = 520;
const HEADER = 14;        // sector label strip
const GAP = 2;
const MIN_W = 16, MIN_H = 12;   // below this a tile cannot carry a label, so it is folded away

// Green accumulate, red reduce, grey no meaningful change. Same ramp shape the Insiders map uses:
// pale to deep, log-scaled, so the common small moves stay distinguishable instead of all reading
// as the same faint tint.
const RAMP_GREEN = [[221, 244, 226], [138, 212, 158], [45, 152, 82], [14, 82, 44]];
const RAMP_RED = [[252, 216, 216], [244, 150, 150], [212, 66, 66], [124, 20, 24]];
const NEUTRAL = [170, 176, 172];
const FLAT_PCT = 2;        // under this a position is "roughly unchanged"
const FULL_PCT = 60;       // at or beyond this the colour is fully saturated
const LOG_K = 24;

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const ramp = (stops, t) => {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return lerp(stops[i], stops[i + 1], x - i);
};
function tileColor(pct) {
  if (pct == null) return `rgb(${NEUTRAL.join(',')})`;
  const mag = Math.abs(pct);
  if (mag < FLAT_PCT) return `rgb(${NEUTRAL.join(',')})`;
  const norm = Math.min(1, (mag - FLAT_PCT) / (FULL_PCT - FLAT_PCT));
  const t = Math.log1p(LOG_K * norm) / Math.log1p(LOG_K);
  return `rgb(${ramp(pct > 0 ? RAMP_GREEN : RAMP_RED, t).join(',')})`;
}
// Text that stays readable on whatever the tile turned out to be.
const inkFor = (pct) => {
  if (pct == null) return '#10231A';
  const mag = Math.abs(pct);
  if (mag < FLAT_PCT) return '#10231A';
  const norm = Math.min(1, (mag - FLAT_PCT) / (FULL_PCT - FLAT_PCT));
  return Math.log1p(LOG_K * norm) / Math.log1p(LOG_K) > 0.45 ? '#FFFFFF' : '#10231A';
};

const money = (n) => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
};
const shares = (n) => {
  const v = Math.abs(Number(n) || 0);
  const s = Number(n) < 0 ? '-' : '';
  if (v >= 1e9) return `${s}${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${s}${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${s}${(v / 1e3).toFixed(0)}K`;
  return `${s}${Math.round(v)}`;
};
const pctText = (p) => (p == null ? 'new position' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`);

// Hover card, portaled to the body so the heatmap's own overflow cannot clip it, with the font
// pinned because a portal leaves the page wrapper's font chain.
function HoverCard({ tile, anchor, ceiling }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useEffect(() => {
    if (!ref.current || !anchor) return;
    const card = ref.current.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const above = r.top - card.height - 10;
    const top = above >= (ceiling ?? 0) ? above : r.bottom + 10;
    const left = Math.max(8, Math.min(window.innerWidth - card.width - 8, r.left + r.width / 2 - card.width / 2));
    setPos({ left, top });
  }, [tile, anchor, ceiling]);
  if (typeof document === 'undefined') return null;
  const up = (tile.pctChange ?? 0) > 0;
  return createPortal(
    <div ref={ref} style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 2147483000,
      pointerEvents: 'none', background: C.white, border: `1px solid ${C.border}`, borderRadius: 8,
      boxShadow: '0 10px 30px rgba(0,0,0,0.22)', padding: '10px 12px', width: 264,
      fontFamily: "'DM Sans',sans-serif", fontSize: 11, lineHeight: 1.55, color: C.text }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 2 }}>
        <span className="cp-tkr" style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{tile.ticker}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: tile.pctChange == null ? C.muted : up ? C.green : C.red, marginLeft: 'auto' }}>
          {pctText(tile.pctChange)}
        </span>
      </div>
      <div style={{ color: C.muted, fontSize: 10.5, marginBottom: 7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tile.issuer || tile.ticker} {'·'} {tile.sector || 'Unclassified'}
      </div>
      {[['Institutional value', money(tile.value)],
        ['Shares this quarter', shares(tile.curShares)],
        ['Shares last quarter', tile.prevShares ? shares(tile.prevShares) : 'none'],
        ['Shares ' + (tile.deltaShares >= 0 ? 'added' : 'reduced'), shares(tile.deltaShares)],
        ['Reporting institutions', tile.funds.toLocaleString('en-US')]].map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ color: C.dim }}>{k}</span>
          <span className="cp-num" style={{ fontWeight: 600, color: C.ink }}>{v}</span>
        </div>
      ))}
    </div>, document.body);
}

export default function InstitutionsHeatmap() {
  const wrapRef = useRef(null);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(1100);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/institutions-heatmap?limit=260')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) { if (j && !j.error) setData(j); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const measure = () => { if (wrapRef.current) setWidth(wrapRef.current.clientWidth || 1100); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [data]);

  // Two passes: sectors fill the box, then each sector's tickers fill its own rect. Tiles too small
  // to label are dropped rather than rendered as unreadable slivers.
  const layout = useMemo(() => {
    if (!data?.sectors?.length || !(width > 0)) return [];
    const sectors = treemap(data.sectors.map((s) => ({ ...s, value: s.value })), 0, 0, width, HEIGHT);
    const out = [];
    for (const s of sectors) {
      if (s.w < 40 || s.h < HEADER + 14) continue;
      const inner = { x: s.x + GAP, y: s.y + HEADER + GAP, w: s.w - GAP * 2, h: s.h - HEADER - GAP * 2 };
      const tiles = treemap(s.tickers.map((t) => ({ ...t, value: t.value })), inner.x, inner.y, inner.w, inner.h)
        .filter((t) => t.w >= MIN_W && t.h >= MIN_H);
      out.push({ ...s, tiles });
    }
    return out;
  }, [data, width]);

  if (failed) return null;
  const cov = data?.coverage;

  return (
    <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px',
        borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fontWeight: 700,
          letterSpacing: '0.8px', color: C.dim, textTransform: 'uppercase' }}>Institutional Accumulation</span>
        {data?.quarter && (
          <span style={{ fontSize: 10.5, color: C.muted }}>
            {data.prevQuarter} {'→'} {data.quarter} {'·'} size = position value {'·'} colour = change in shares held
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 9.5, color: C.muted }}>reduced</span>
          {[-60, -20, -6, 0, 6, 20, 60].map((p) => (
            <span key={p} style={{ width: 13, height: 9, borderRadius: 2, background: tileColor(p) }} />
          ))}
          <span style={{ fontSize: 9.5, color: C.muted }}>added</span>
        </span>
      </div>

      <div ref={wrapRef} style={{ position: 'relative', height: HEIGHT, background: C.surface }}>
        {!data ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: C.muted, fontSize: 12.5 }}>Loading institutional positions.</div>
        ) : layout.map((s) => (
          <div key={s.sector}>
            <div style={{ position: 'absolute', left: s.x, top: s.y, width: s.w, height: HEADER,
              background: C.green, color: '#fff', fontSize: 9, fontWeight: 700, letterSpacing: '0.4px',
              padding: '0 5px', display: 'flex', alignItems: 'center', overflow: 'hidden',
              whiteSpace: 'nowrap', fontFamily: "'DM Sans',sans-serif" }}>
              {s.sector.toUpperCase()}
            </div>
            {s.tiles.map((t) => (
              <div key={t.ticker}
                onMouseEnter={(e) => setHover({ tile: t, anchor: e.currentTarget })}
                onMouseLeave={() => setHover(null)}
                style={{ position: 'absolute', left: t.x, top: t.y, width: t.w - 1, height: t.h - 1,
                  background: tileColor(t.pctChange), color: inkFor(t.pctChange),
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden', cursor: 'default' }}>
                {t.w >= 34 && t.h >= 16 && (
                  <span className="cp-tkr" style={{ fontSize: Math.min(12, Math.max(8, t.w / 5)), fontWeight: 700, lineHeight: 1 }}>
                    {t.ticker}
                  </span>
                )}
                {t.w >= 52 && t.h >= 30 && (
                  <span className="cp-num" style={{ fontSize: 9, lineHeight: 1.3, opacity: 0.9 }}>{pctText(t.pctChange)}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Coverage stated on the page, because a heatmap implies completeness it does not have. */}
      {cov && (
        <div style={{ padding: '8px 13px', fontSize: 10, color: C.dim, lineHeight: 1.55, borderTop: `1px solid ${C.border}` }}>
          <b style={{ color: C.muted }}>Reads green almost everywhere because the 13F backfill is still ingesting,
          so the earlier quarter is less complete than the current one and most positions look larger by
          comparison. Treat the direction as provisional until it finishes.</b>{' '}
          {data.shown.toLocaleString('en-US')} of {cov.tickers.toLocaleString('en-US')} tickers
          shown, {money(cov.coveredValue)} of institutional value, from the {cov.fundsBoth.toLocaleString('en-US')} funds
          that filed both quarters. {money(cov.excludedValue)} is excluded for want of a verifiable
          price or filing scale, and {money(cov.unclassifiedValue)} has no sector and is grouped as
          Unclassified rather than guessed.
        </div>
      )}

      {hover && <HoverCard tile={hover.tile} anchor={hover.anchor} ceiling={wrapRef.current?.getBoundingClientRect().top} />}
    </div>
  );
}
