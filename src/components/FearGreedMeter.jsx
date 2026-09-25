'use client';
import { C } from '../lib/cp-shared';
import {
  angleFor, pointAt, segPath, labelPlacement, SEGMENTS, SEGMENT_COLOR, SEGMENT_LABEL_COLOR,
  SCALE_MARKS, R, CX, CY, BAND, VIEW_W, VIEW_H, SCORE_Y, ZONE_Y, NEEDLE_TIP, SCALE_R,
} from '../lib/fear-greed/meter.mjs';

// THE FEAR & GREED METER — a semicircular sentiment dial, drawn from scratch.
//
// ── ⚠️ WHY AN ARC AND NOT A BAR ─────────────────────────────────────────────
//
// A horizontal bar makes a reader measure: they find the marker, find the ends, and work out the
// proportion. A dial is read positionally — 39 is visibly left of centre, in the fear half, without
// counting anything. That is the entire reason this replaced the bar, so every decision below
// serves legibility of POSITION.
//
// ── ⚠️ THE ARC IS THE LEGEND ────────────────────────────────────────────────
//
// Each zone is named INSIDE the band that represents it, and there is no key underneath. That is
// not only tidier — it is what makes the unequal widths mean something. NEUTRAL is eleven points
// wide and EXTREME FEAR twenty-four, so a reader who sees a wide red slice and a thin grey one has
// learned the actual ranges without reading a number. A separate legend would have let the drawn
// widths drift from the real ones unnoticed; a label sitting in its own colour cannot.
//
// ── ⚠️ THE NEEDLE GETS THE INSIDE OF THE DIAL TO ITSELF ─────────────────────
//
// The score used to be printed inside the arc, and at a greed reading the blade ran straight
// through the digits. Nothing inside the semicircle competes with the needle now: the number and
// the zone sit BELOW the pivot, in space the needle cannot reach, and the blade stops short of the
// band so it never crosses a zone label either.
//
// ── ⚠️ OUR OWN GEOMETRY AND OUR OWN PALETTE ─────────────────────────────────
//
// The familiar financial-sentiment dial is a concept, not an asset. Nothing here is lifted: the
// sweep, radius, band thickness, label fitting, needle shape, hub, type scale and colours are all
// Catalyst Pit's.
//
// ── ⚠️ SCALING WITHOUT CLIPPING ─────────────────────────────────────────────
//
// The SVG has a fixed viewBox and `width: 100%`, so the whole face — bands, labels, needle, score —
// scales as one piece and the relationships that were proved in viewBox units hold at every width.
// A label that fits its band on a desktop fits it on a phone, because it is the same drawing.

/**
 * ⚠️ THE GEOMETRY LIVES IN lib/fear-greed/meter.mjs, NOT HERE.
 *
 * A reversed sweep is the one error a rendered dial hides — the picture still looks like a meter,
 * with the wrong end of the scale on the left. And a label overflowing its band is the one error
 * that only shows up at a width nobody tested. Pure functions can be asserted with numbers; JSX
 * cannot, so the mapping and the label fitting are imported rather than written inline.
 */
const ZONE_TEXT = (label) => {
  if (label === 'EXTREME FEAR' || label === 'FEAR') return C.red;
  if (label === 'GREED' || label === 'EXTREME GREED') return C.green;
  return C.muted;
};

export default function FearGreedMeter({ score, zone, asOf }) {
  const has = Number.isFinite(Number(score));
  const s = has ? Math.min(100, Math.max(0, Number(score))) : 50;
  const angle = angleFor(s);

  // The needle: a slim tapered blade rather than a speedometer pointer, with a hub over the pivot.
  const [tipX, tipY] = pointAt(angle, NEEDLE_TIP);
  const [lx, ly] = pointAt(angle + 90, 7);
  const [rx, ry] = pointAt(angle - 90, 7);

  return (
    <div style={{ width: '100%', maxWidth: 460, margin: '0 auto' }}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        // ⚠️ The score and zone are announced as text; the drawing itself is decorative to a
        // screen reader, which would otherwise read a list of path coordinates.
        role="img"
        aria-label={has ? `Fear and Greed index ${Math.round(s)}, ${zone}` : 'Fear and Greed index unavailable'}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        {/* the band: one arc per zone, its width the zone's actual range */}
        {SEGMENTS.map((seg) => (
          <path
            key={seg.key}
            d={segPath(seg.from, seg.to)}
            fill="none"
            stroke={SEGMENT_COLOR[seg.key]}
            strokeOpacity={has ? 1 : 0.35}
            strokeWidth={BAND}
            strokeLinecap="butt"
          />
        ))}

        {/* each zone named inside its own colour, laid along the arc */}
        {SEGMENTS.map((seg) => (
          <g key={`l-${seg.key}`} opacity={has ? 1 : 0.55}>
            {labelPlacement(seg).map((p, i) => (
              <text
                key={i}
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                transform={`rotate(${p.rotation.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
                style={{
                  fontFamily: "'DM Sans',sans-serif", fontSize: p.fontSize, fontWeight: 700,
                  letterSpacing: '0.05em', fill: SEGMENT_LABEL_COLOR,
                }}
              >{p.line}</text>
            ))}
          </g>
        ))}

        {/* 0 / 50 / 100 — kept, but secondary to the words in the bands */}
        {SCALE_MARKS.map((v) => {
          const a = angleFor(v);
          const [tx, ty] = pointAt(a, R + BAND / 2 + 1);
          const [ex, ey] = pointAt(a, R + BAND / 2 + 5);
          const [nx, ny] = pointAt(a, SCALE_R);
          const anchor = v === 0 ? 'start' : v === 100 ? 'end' : 'middle';
          return (
            <g key={v}>
              <line x1={tx} y1={ty} x2={ex} y2={ey} stroke={C.border2} strokeWidth="1.5" />
              <text
                x={nx} y={ny} textAnchor={anchor} dominantBaseline="central"
                style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 10, fill: C.dim, letterSpacing: '0.04em' }}
              >{v}</text>
            </g>
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

        {/* the reading, below the pivot where the needle never goes */}
        <text
          x={CX} y={SCORE_Y} textAnchor="middle"
          style={{ fontSize: 58, fontWeight: 700, fill: C.ink, fontVariantNumeric: 'tabular-nums' }}
        >{has ? Math.round(s) : '—'}</text>
        <text
          x={CX} y={ZONE_Y} textAnchor="middle"
          style={{
            fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 700,
            letterSpacing: '0.16em', fill: has ? ZONE_TEXT(zone) : C.dim,
          }}
        >{has ? zone : 'UNAVAILABLE'}</text>
      </svg>

      {asOf && (
        <div style={{ textAlign: 'center', marginTop: 2, fontFamily: "'DM Sans',sans-serif", fontSize: 9.5, color: C.dim, letterSpacing: '0.8px' }}>
          AS OF {asOf} · DAILY
        </div>
      )}
    </div>
  );
}
