'use client';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { C } from '../lib/cp-shared';
import {
  BANDS, Y_TICKS, availableTimeframes, defaultTimeframe, filterHistory, zoneGutter, zoneFontSize,
  xTickIndexes, tickCountFor, formatTick, formatFull, nearestIndex, zoneLabel,
} from '../lib/fear-greed/history-chart.mjs';

// THE FEAR & GREED HISTORY CHART.
//
// ── ⚠️ A LINE WITH NO SCALE IS A DECORATION ─────────────────────────────────
//
// What used to be here was a green line between two dates. It told a reader the shape of the past
// two years and nothing else — not what value any point held, and not whether the market had been
// frightened or greedy while it drew that shape. The shape is the least interesting thing about
// this series. Everything added below exists to answer "what NUMBER, and what did that MEAN":
// a fixed 0-100 axis, the five zones shaded behind the line and named down the side, and a tooltip
// that reads out the stored observation.
//
// ── ⚠️ THE AXIS IS FIXED AT 0-100 AND MUST STAY THAT WAY ────────────────────
//
// Auto-scaling to the observed range is the default in every charting library and it would ruin
// this chart specifically. The zones are absolute — 45-55 is NEUTRAL whatever the data did — so a
// frame that moves with the data would slide the shaded bands up and down between one window and
// the next, and a quiet fortnight in the forties would be redrawn as a mountain range. The scale is
// the index's scale. See history-chart.mjs.
//
// ── ⚠️ THE CHART IS DRAWN IN PIXELS, NOT IN A SCALED viewBox ────────────────
//
// The gauge can use a fixed viewBox because it scales as one piece; this cannot. A viewBox stretched
// to fit a phone would shrink every date and axis number with it, and 9px type at a 0.45 scale is
// 4px type. So the wrapper is MEASURED and the SVG is drawn 1:1 at that width, which keeps the
// lettering at its real size on every screen. Narrow screens then lose date ticks — never the Y
// axis, which is the part that makes the line readable.

const ZONE_FG = (label) => {
  if (label === 'EXTREME FEAR' || label === 'FEAR') return C.red;
  if (label === 'GREED' || label === 'EXTREME GREED') return C.green;
  return C.muted;
};

// Restrained shading: the index's own two hues, deeper at the extremes so the five bands are
// distinguishable, but nowhere near strong enough to compete with the line drawn over them.
const BAND_PAINT = {
  'extreme-fear': { fill: C.red, opacity: 0.13 },
  fear: { fill: C.red, opacity: 0.06 },
  neutral: { fill: C.muted, opacity: 0.05 },
  greed: { fill: C.green, opacity: 0.06 },
  'extreme-greed': { fill: C.green, opacity: 0.13 },
};

export default function FearGreedHistory({ history }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [tf, setTf] = useState(null);
  const [hover, setHover] = useState(null);

  // ⚠️ MEASURED, NOT ASSUMED. See the note above — the type size depends on this being real.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const options = useMemo(() => availableTimeframes(history), [history]);
  const active = tf && options.some((o) => o.key === tf) ? tf : defaultTimeframe(history);
  const pts = useMemo(() => filterHistory(history, active), [history, active]);

  const H = width > 0 && width < 420 ? 200 : 240;
  // ⚠️ THE PLOT STOPS BEFORE THE ZONE NAMES. Drawn inside the plot they were crossed out by the
  // index line, halo and all. Reserving the gutter makes the collision impossible instead of
  // unlikely. See zoneGutter in history-chart.mjs.
  const padL = 32, padR = zoneGutter(width), padT = 10, padB = 24;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = H - padT - padB;
  const n = pts.length;

  const x = useCallback((i) => (n < 2 ? padL : padL + (i / (n - 1)) * plotW), [n, plotW]);
  const y = useCallback((v) => padT + (1 - Math.min(100, Math.max(0, v)) / 100) * plotH, [plotH]);

  const onMove = useCallback((clientX) => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const r = el.getBoundingClientRect();
    const f = plotW > 0 ? (clientX - r.left - padL) / plotW : 0;
    setHover(nearestIndex(f, n));
  }, [n, plotW]);

  if (n < 2) return null;

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  // ⚠️ The tick budget is the PLOT's width, not the card's — the gutter is not drawable space.
  const ticks = xTickIndexes(n, tickCountFor(plotW));
  const last = pts[n - 1];
  const lastZone = zoneLabel(last.score);
  const hi = hover !== null && hover >= 0 && hover < n ? hover : null;
  const hp = hi === null ? null : pts[hi];

  return (
    <div style={{ padding: '2px 16px 14px' }}>
      {/* window controls. The session count is NOT repeated here — the card footer already
          carries it, and a number printed twice invites the two to disagree. */}
      {options.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => { setTf(o.key); setHover(null); }}
                style={{
                  fontFamily: "'DM Sans',sans-serif", fontSize: 10, letterSpacing: '0.5px',
                  padding: '3px 9px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${o.key === active ? C.greenBorder : C.border}`,
                  background: o.key === active ? C.greenLight : 'transparent',
                  color: o.key === active ? C.green : C.muted,
                  fontWeight: o.key === active ? 700 : 400,
                }}
              >{o.key}</button>
            ))}
          </div>
        </div>
      )}

      <div
        ref={wrapRef}
        style={{ position: 'relative', width: '100%' }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
      >
        {width > 0 && (
          <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} style={{ display: 'block' }}
            role="img" aria-label={`Catalyst Pit Fear and Greed history, ${active}, ${n} sessions, latest ${Math.round(last.score)} ${lastZone}`}>
            {/* the zones, behind everything */}
            {BANDS.map((b) => {
              const paint = BAND_PAINT[b.key];
              const top = y(b.to), bottom = y(b.from);
              return (
                <rect key={b.key} x={padL} y={top} width={plotW} height={Math.max(0, bottom - top)}
                  fill={paint.fill} fillOpacity={paint.opacity} />
              );
            })}

            {/* the fixed 0-100 grid */}
            {Y_TICKS.map((v) => (
              <g key={v}>
                <line x1={padL} y1={y(v)} x2={padL + plotW} y2={y(v)}
                  stroke={C.border2} strokeOpacity={v === 50 ? 0.7 : 0.4} strokeWidth="1"
                  strokeDasharray={v === 50 ? '4 3' : '2 4'} />
                <text x={padL - 6} y={y(v)} textAnchor="end" dominantBaseline="central"
                  style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, fill: C.dim }}>{v}</text>
              </g>
            ))}

            {/* each zone named beside its own band, in the gutter the plot stops short of */}
            {BANDS.map((b) => (
              <text key={`z-${b.key}`} x={padL + plotW + 7} y={(y(b.to) + y(b.from)) / 2}
                textAnchor="start" dominantBaseline="central"
                style={{
                  fontFamily: "'DM Sans',sans-serif", fontSize: zoneFontSize(width), letterSpacing: '0.06em',
                  fill: ZONE_FG(b.label), fillOpacity: 0.85,
                }}>{b.label}</text>
            ))}

            {/* the index itself, over the zones */}
            <path d={line} fill="none" stroke={C.green} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />

            {/* the latest reading — the only observation that gets a permanent dot */}
            <circle cx={x(n - 1)} cy={y(last.score)} r="4" fill={ZONE_FG(lastZone)} stroke={C.white} strokeWidth="1.8" />

            {/* what the pointer is on */}
            {hp && (
              <>
                <line x1={x(hi)} y1={padT} x2={x(hi)} y2={padT + plotH} stroke={C.dim} strokeOpacity="0.5" strokeWidth="1" />
                <circle cx={x(hi)} cy={y(hp.score)} r="3.5" fill={C.white} stroke={ZONE_FG(zoneLabel(hp.score))} strokeWidth="2" />
              </>
            )}

            {/* dates, thinned on narrow screens rather than dropped entirely */}
            {ticks.map((i, k) => (
              <text key={i} x={x(i)} y={H - 6}
                textAnchor={k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'}
                style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, fill: C.dim }}>
                {formatTick(pts[i].date, active)}
              </text>
            ))}
          </svg>
        )}

        {hp && (
          <div style={{
            position: 'absolute', top: 2, left: Math.min(Math.max(x(hi), 62), Math.max(62, width - 62)),
            transform: 'translateX(-50%)', pointerEvents: 'none',
            background: C.white, border: `1px solid ${C.border2}`, borderRadius: 6,
            boxShadow: '0 6px 18px rgba(0,0,0,0.12)', padding: '6px 10px', textAlign: 'center', minWidth: 104,
          }}>
            <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: C.dim, letterSpacing: '0.4px' }}>
              {formatFull(hp.date)}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>
              {Math.round(hp.score)}
            </div>
            <div style={{
              fontFamily: "'DM Sans',sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: '0.9px',
              color: ZONE_FG(zoneLabel(hp.score)),
            }}>{zoneLabel(hp.score)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
