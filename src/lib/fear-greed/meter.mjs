// THE METER'S GEOMETRY — pure, so the needle cannot silently point the wrong way.
//
// ⚠️ THE ONE ERROR A RENDERED DIAL HIDES. Every other mistake in a gauge is visible at a glance; a
// reversed sweep is not, because the picture still looks like a plausible meter. A reader would see
// EXTREME GREED drawn on the left and a score of 39 sitting in it, and the only clue would be the
// word underneath disagreeing with the position. Keeping the mapping out of the JSX means it can be
// asserted with numbers.
//
// Geometry is Catalyst Pit's own: a half turn, 0 at the left, drawn clockwise as the score rises.

/** Arc radius, in viewBox units. */
export const R = 150;
/** Centre of the dial inside a 380-wide viewBox. */
export const CX = 190;
/** Baseline of the semicircle. */
export const CY = 182;
/** Thickness of the coloured band. */
export const BAND = 30;

/**
 * Score to SVG angle, in degrees measured anticlockwise from east.
 *
 * ⚠️ 0 IS 180° (LEFT) AND 100 IS 0° (RIGHT). The angle DECREASES as the score rises, which is why
 * every arc segment is drawn with sweep-flag 1 — clockwise.
 */
export function angleFor(score) {
  const s = Math.min(100, Math.max(0, Number(score) || 0));
  return 180 - (s / 100) * 180;
}

/** A point on the dial at `angle` degrees and `radius` units from the centre. */
export function pointAt(angle, radius) {
  const rad = (angle * Math.PI) / 180;
  return [CX + radius * Math.cos(rad), CY - radius * Math.sin(rad)];
}

/** An SVG arc path along the band between two scores. */
export function segPath(from, to, radius = R) {
  const [x1, y1] = pointAt(angleFor(from), radius);
  const [x2, y2] = pointAt(angleFor(to), radius);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * The five bands of the arc.
 *
 * ⚠️ THE BOUNDARIES ARE THE INDEX'S OWN — 0-24 / 25-44 / 45-55 / 56-75 / 76-100 — not round
 * numbers chosen to look tidy. Drawing the arc on a different scale from the one the score is
 * classified on would let the needle sit in a band whose name contradicts the word printed below.
 * The .5 offsets put each cut halfway between two integer scores so neither band claims a value
 * belonging to the other.
 */
export const SEGMENTS = Object.freeze([
  { key: 'extreme-fear', from: 0, to: 24.5, label: 'EXTREME FEAR' },
  { key: 'fear', from: 24.5, to: 44.5, label: 'FEAR' },
  { key: 'neutral', from: 44.5, to: 55.5, label: 'NEUTRAL' },
  { key: 'greed', from: 55.5, to: 75.5, label: 'GREED' },
  { key: 'extreme-greed', from: 75.5, to: 100, label: 'EXTREME GREED' },
]);
