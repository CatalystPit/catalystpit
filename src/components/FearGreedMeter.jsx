'use client';
import { C } from '../lib/cp-shared';
import { angleFor, pointAt, segPath, SEGMENTS, R, CX, CY, BAND } from '../lib/fear-greed/meter.mjs';

// THE FEAR & GREED METER — a semicircular sentiment dial, drawn from scratch.
//
// ── ⚠️ WHY AN ARC AND NOT A BAR ─────────────────────────────────────────────
//
// A horizontal bar makes a reader measure: they find the marker, find the ends, and work out the
// proportion. A dial is read positionally — 39 is visibly left of centre, in the fear half, without
// counting anything. That is the entire reason this replaced the bar, so every decision below
// serves legibility of POSITION: a wide sweep, thick band, high-contrast needle, and zone labels
// sitting outside the arc where they never collide with it.
//
// ── ⚠️ OUR OWN GEOMETRY AND OUR OWN PALETTE ─────────────────────────────────
//
// The familiar financial-sentiment dial is a concept, not an asset. Nothing here is lifted: the
// sweep, radius, band thickness, tick placement, needle shape, hub, type scale and colours are all
// Catalyst Pit's — the same forest-green / cream / clay language the rest of the site uses, with
// the fear and greed treatments already established by the zone pills and the scan rows.
//
// ── ⚠️ SCALING WITHOUT CLIPPING ─────────────────────────────────────────────
//
// The SVG has a fixed viewBox and `width: 100%`, so it scales with its column and never overlaps
// the sticky header. The viewBox carries enough padding above the arc for the outer labels and the
// stroke's round cap, which is the detail that otherwise crops the tips at small widths.

/**
 * ⚠️ THE GEOMETRY LIVES IN lib/fear-greed/meter.mjs, NOT HERE.
 *
 * A reversed sweep is the one error a rendered dial hides — the picture still looks like a meter,
 * with the wrong end of the scale on the left. Pure functions can be asserted with numbers; JSX
 * cannot, so the mapping is imported rather than written inline.
 */
const ANGLE_FOR = angleFor;
const pt = pointAt;

/** Colours for the five bands, in the site's own fear/neutral/greed treatment. */
const SEGMENT_FILL = {
  'extreme-fear': { fill: C.red, opacity: 0.92 },
  fear: { fill: C.red, opacity: 0.52 },
  neutral: { fill: C.border2, opacity: 1 },
  greed: { fill: C.greenMid, opacity: 0.55 },
  'extreme-greed': { fill: C.greenMid, opacity: 0.95 },
};

const ZONE_TEXT = (label) => {
  if (label === 'EXTREME FEAR' || label === 'FEAR') return C.red;
  if (label === 'GREED' || label === 'EXTREME GREED') return C.green;
  return C.muted;
};

export default function FearGreedMeter({ score, zone, asOf }) {
  const has = Number.isFinite(Number(score));
  const s = has ? Math.min(100, Math.max(0, Number(score))) : 50;
  const angle = ANGLE_FOR(s);

  // The needle: a slim tapered blade rather than a speedometer pointer. Built from three points so
  // it reads as a precision marker at any size, with a hub covering the pivot.
  const [tipX, tipY] = pt(angle, R - 6);
  const [lx, ly] = pt(angle + 90, 7);
  const [rx, ry] = pt(angle - 90, 7);

  // Tick marks at each boundary, drawn just inside the band.
  const ticks = [0, 25, 45, 56, 76, 100];

  return (
    <div style={{ width: '100%', maxWidth: 460, margin: '0 auto' }}>
      <svg
        viewBox="0 0 380 232"
        // ⚠️ The score and zone are announced as text; the drawing itself is decorative to a
        // screen reader, which would otherwise read a list of path coordinates.
        role="img"
        aria-label={has ? `Fear and Greed index ${Math.round(s)}, ${zone}` : 'Fear and Greed index unavailable'}
        style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
      >
        {/* the band */}
        {SEGMENTS.map((seg) => {
          const paint = SEGMENT_FILL[seg.key];
          return (
            <path
              key={seg.key}
              d={segPath(seg.from, seg.to)}
              fill="none"
              stroke={paint.fill}
              strokeOpacity={has ? paint.opacity : paint.opacity * 0.35}
              strokeWidth={BAND}
              strokeLinecap="butt"
            />
          );
        })}

        {/* boundary ticks, inside the band so they never touch the labels */}
        {ticks.map((t) => {
          const a = ANGLE_FOR(t);
          const [x1, y1] = pt(a, R - BAND / 2 + 2);
          const [x2, y2] = pt(a, R + BAND / 2 - 2);
          return (
            <line key={t} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={C.white} strokeOpacity={0.5} strokeWidth={t === 50 ? 0 : 1.5} />
          );
        })}

        {/* end + midpoint scale numbers, outside the arc */}
        {[{ v: 0, anchor: 'start' }, { v: 50, anchor: 'middle' }, { v: 100, anchor: 'end' }].map(({ v, anchor }) => {
          const [x, y] = pt(ANGLE_FOR(v), R + BAND / 2 + 14);
          return (
            <text key={v} x={x} y={v === 50 ? y + 4 : y} textAnchor={anchor}
              style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, fill: C.dim, letterSpacing: '0.5px' }}>
              {v}
            </text>
          );
        })}

        {/* the needle, only when there is a score to point at */}
        {has && (
          <>
            <polygon
              points={`${tipX.toFixed(2)},${tipY.toFixed(2)} ${lx.toFixed(2)},${ly.toFixed(2)} ${rx.toFixed(2)},${ry.toFixed(2)}`}
              fill={C.ink}
            />
            <circle cx={CX} cy={CY} r={11} fill={C.ink} />
            <circle cx={CX} cy={CY} r={5} fill={C.white} />
          </>
        )}

        {/* the score, centred inside the dial */}
        <text x={CX} y={CY - 46} textAnchor="middle"
          style={{ fontSize: 66, fontWeight: 700, fill: C.ink, fontVariantNumeric: 'tabular-nums' }}>
          {has ? Math.round(s) : '—'}
        </text>
        <text x={CX} y={CY - 16} textAnchor="middle"
          style={{
            fontFamily: "'DM Sans',sans-serif", fontSize: 15, fontWeight: 700,
            letterSpacing: '2px', fill: has ? ZONE_TEXT(zone) : C.dim,
          }}>
          {has ? zone : 'UNAVAILABLE'}
        </text>
      </svg>

      {/* Zone words below the dial rather than crowded around the arc, in reading order. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4, marginTop: 2, padding: '0 2px' }}>
        {SEGMENTS.map((seg) => (
          <span key={seg.key} style={{
            flex: '1 1 0', textAlign: 'center', fontFamily: "'DM Sans',sans-serif",
            fontSize: 8.5, letterSpacing: '0.4px', lineHeight: 1.3,
            color: zone === seg.label ? ZONE_TEXT(seg.label) : C.dim,
            fontWeight: zone === seg.label ? 700 : 400,
          }}>{seg.label}</span>
        ))}
      </div>
      {asOf && (
        <div style={{ textAlign: 'center', marginTop: 8, fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: C.dim, letterSpacing: '0.8px' }}>
          AS OF {asOf} · DAILY
        </div>
      )}
    </div>
  );
}
