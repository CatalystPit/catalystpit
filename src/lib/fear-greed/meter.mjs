// THE METER'S GEOMETRY — pure, so the needle cannot silently point the wrong way.
//
// ⚠️ THE ONE ERROR A RENDERED DIAL HIDES. Every other mistake in a gauge is visible at a glance; a
// reversed sweep is not, because the picture still looks like a plausible meter. A reader would see
// EXTREME GREED drawn on the left and a score of 39 sitting in it, and the only clue would be the
// word underneath disagreeing with the position. Keeping the mapping out of the JSX means it can be
// asserted with numbers.
//
// Geometry is Catalyst Pit's own: a half turn, 0 at the left, drawn clockwise as the score rises.

import { ZONE_BANDS } from './model.mjs';

/** Arc radius, in viewBox units. */
export const R = 150;
/** Centre of the dial inside the viewBox. */
export const CX = 190;
/** The pivot, on the diameter of the semicircle. */
export const CY = 190;
/** Thickness of the coloured band. */
export const BAND = 30;

/**
 * The drawing area.
 *
 * ⚠️ THE BOX IS TALLER THAN THE SEMICIRCLE ON PURPOSE. The score used to be printed inside the arc,
 * where the needle swings — at a greed reading the blade ran straight through the digits. The
 * number now lives BELOW the pivot, in space the needle can never reach, which is what the extra
 * height buys. NEEDLE_TIP stops the blade short of the band for the same reason: a needle that
 * entered the band would cross whichever zone label it happened to be pointing at.
 */
export const VIEW_W = 380;

/**
 * The two sizes this dial is drawn at.
 *
 * ⚠️ ONLY TYPE AND CROP CHANGE. CX, CY, R and BAND are NOT in here, and must never be: the arc,
 * the band boundaries and the needle's angle are the same numbers in the rail card as on the full
 * page, which is what makes the two drawings the same instrument rather than two interpretations of
 * one. A second set of radii would be a second gauge, free to disagree about where 39 points.
 *
 * What does differ is that the compact one is rendered about 300px wide instead of 460, so its
 * lettering is set LARGER in viewBox units to survive the smaller scale, the empty band above the
 * arc is cropped off the top, and the numeric scale is dropped — at that size 0/50/100 are noise,
 * and the five named bands are the legend that matters.
 */
export const LAYOUT = Object.freeze({
  full: Object.freeze({
    viewY: 0, viewH: 292, scoreY: CY + 62, zoneY: CY + 84,
    scoreSize: 58, zoneSize: 14, scaleSize: 10, showScale: true,
  }),
  compact: Object.freeze({
    viewY: 16, viewH: 262, scoreY: CY + 58, zoneY: CY + 78,
    scoreSize: 62, zoneSize: 15, scaleSize: 10, showScale: false,
  }),
});

/** The full-size layout's numbers, which the rest of the page still refers to by name. */
export const VIEW_H = LAYOUT.full.viewH;
/** Baseline of the big score, below the pivot. */
export const SCORE_Y = LAYOUT.full.scoreY;
/** Baseline of the zone word, directly beneath the score. */
export const ZONE_Y = LAYOUT.full.zoneY;
/** How far the needle reaches: up to the band's inner edge, with a gap, never into it. */
export const NEEDLE_TIP = R - BAND / 2 - 4;
/** Radius of the 0 / 50 / 100 scale markers, outside the band. */
export const SCALE_R = R + BAND / 2 + 12;

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
 * The five bands of the arc — the index's own zone boundaries, derived rather than retyped.
 *
 * ⚠️ THE ARC IS THE LEGEND. There is no key underneath any more: each zone is named inside the
 * band that represents it, so the widths a reader sees ARE the ranges. That only holds while these
 * bands and `zoneFor` come from the same source, which is why they do.
 */
export const SEGMENTS = ZONE_BANDS;

/** Midpoint score of a band — where its name is centred. */
export function segMid(seg) {
  return (seg.from + seg.to) / 2;
}

/** Arc length of a band along the centre of the ring, in viewBox units. */
export function segArcLength(seg, radius = R) {
  return ((seg.to - seg.from) / 100) * Math.PI * radius;
}

/**
 * Rotation that lays text along the arc at a given angle.
 *
 * At the top of the dial this is 0 (horizontal); at the ends it approaches ±90, so a label always
 * sits square to its own slice of the ring rather than square to the page.
 */
export function labelRotation(angle) {
  return 90 - angle;
}

/**
 * A band's name, broken into the lines it is drawn on.
 *
 * ⚠️ SPLIT, NOT RETYPED. "EXTREME FEAR" needs two lines to fit inside its slice; deriving the break
 * from the label itself means a renamed zone cannot end up with a stale label stacked in the arc.
 */
export function labelLines(label) {
  return String(label).includes(' ') ? String(label).split(' ') : [String(label)];
}

/**
 * Advance width of a line, in viewBox units — the same crude estimate the fitter uses.
 *
 * Uppercase DM Sans runs close to 0.62em per glyph; the extra term is the tracking. This does not
 * need to be exact, only conservative, because it exists to prove a label cannot outgrow its band.
 */
export function textWidth(line, fontSize, tracking = 0.05) {
  const n = String(line).length;
  return n === 0 ? 0 : fontSize * (0.62 * n + tracking * (n - 1));
}

/** Smallest and largest type the arc will use. */
export const LABEL_MIN = 7;
export const LABEL_MAX = 10;

/**
 * Type size for a band's name, chosen so the name fits INSIDE the band.
 *
 * ⚠️ THIS IS WHY NEUTRAL IS SMALLER THAN THE REST. Its slice is eleven points wide against twenty
 * for FEAR and twenty-four for EXTREME FEAR — a fixed size that fits the wide bands overflows the
 * narrow one, and a label spilling out of its own colour is exactly the failure the fitter exists
 * to make impossible. The bands are NOT equal widths, because the ranges are not equal.
 */
export function labelFontSize(seg, radius = R) {
  const lines = labelLines(seg.label);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
  const available = segArcLength(seg, radius) - 10; // 5 units of clearance at each boundary
  const unit = textWidth(longest, 1);
  const raw = unit > 0 ? available / unit : LABEL_MAX;
  return Math.max(LABEL_MIN, Math.min(LABEL_MAX, Math.floor(raw * 10) / 10));
}

/**
 * Where each line of a band's name is drawn: [x, y, rotation], centred in the ring.
 *
 * Two-line names straddle the centre of the ring; one-line names sit on it. The offsets stay well
 * inside BAND so no line touches the edge of its own colour.
 */
export function labelPlacement(seg, radius = R) {
  const lines = labelLines(seg.label);
  const angle = angleFor(segMid(seg));
  const rotation = labelRotation(angle);
  const fontSize = labelFontSize(seg, radius);
  const spread = lines.length > 1 ? 5.5 : 0;
  return lines.map((line, i) => {
    // The first line sits FURTHER OUT than the second, so the name reads outside-in along a radius.
    const r = radius + (lines.length > 1 ? spread - i * spread * 2 : 0);
    const [x, y] = pointAt(angle, r);
    return { line, x, y, rotation, fontSize };
  });
}

/**
 * The gauge face's colours.
 *
 * ⚠️ FIXED, NOT THEME TOKENS, AND THAT IS DELIBERATE. Every other surface on the site flips with
 * the colour scheme, but these five carry white text inside them. A token that lightens in dark
 * mode — C.red goes from #A83030 to #E06B6B — would take white lettering from readable to
 * unreadable at the exact moment the rest of the page got easier to read. A gauge face is an
 * instrument: it looks the same under either scheme, and every colour here clears 4.5:1 against
 * white, which the suite checks rather than trusts.
 */
export const SEGMENT_COLOR = Object.freeze({
  'extreme-fear': '#8A2626',
  fear: '#B04E4A',
  neutral: '#67705F',
  greed: '#348052',
  'extreme-greed': '#1E5C38',
});

/** Lettering inside the bands. */
export const SEGMENT_LABEL_COLOR = '#FFFFFF';

/** The numeric reference points kept around the arc — deliberately only three. */
export const SCALE_MARKS = Object.freeze([0, 50, 100]);

/**
 * Where a scale number is printed.
 *
 * ⚠️ THE TWO ENDS CANNOT BE PUSHED FURTHER OUT. 0 and 100 sit ON the horizontal diameter, so
 * "further out along the radius" is "further along the diameter" — straight into the band's own
 * end cap, which is exactly where "100" was landing, printed over the dark green. Everything below
 * the diameter is empty, so the end numbers go there and only the midpoint rides above the arc.
 */
export function scaleMarkPlacement(v) {
  const a = angleFor(v);
  if (a === 180 || a === 0) {
    return { x: CX + (a === 0 ? R : -R), y: CY + 16, anchor: 'middle', tick: false };
  }
  const [x, y] = pointAt(a, SCALE_R);
  return { x, y, anchor: 'middle', tick: true };
}
