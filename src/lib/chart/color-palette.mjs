// THE INDICATOR COLOR PALETTE.
//
// One palette, one hex validator, no React — so the swatch grid, the chart, the persistence layer and
// the tests all agree about what a color is and which ones exist.
//
// ⚠️ WHY HEX AND NOT ONLY AN INDEX. Indicator colors used to be an INDEX into a six-entry themed
// array, which had a real virtue: a colour chosen for the light canvas was automatically swapped for
// one that reads on the dark canvas. It also meant the whole product offered six colours. A palette
// this size cannot be maintained as two parallel themed arrays, so a stored color may now be either:
//
//   a NUMBER   a legacy index into the themed six — still resolved through the theme, unchanged
//   a STRING   an explicit #RRGGBB the user picked, used verbatim in both themes
//
// Both shapes persist and both render, so nothing saved before this change moves, and nothing here
// has to guess which the user meant. The cost is that an explicit colour is the user's problem in
// both themes, which is the correct trade: they asked for that colour.
//
// ⚠️ THE FAMILIES CARRY THEIR OWN MID-TONES. Every ramp runs light to dark through a mid-tone that
// reads on BOTH canvases, so a user picking from the middle of any column gets something legible
// either way without knowing which theme they will be in tomorrow.

/** A grayscale ramp, white through black. */
export const GRAYS = [
  '#FFFFFF', '#E6E8E6', '#CDD1CE', '#B0B5B2', '#8E948F',
  '#6C726E', '#4E544F', '#343A36', '#1C211E', '#000000',
];

/**
 * The colour families, each light → dark. Ten families of eight shades.
 *
 * Ordered as a spectrum so the grid reads as one continuous surface rather than a bag of swatches,
 * which is what makes a large palette scannable instead of overwhelming.
 */
export const FAMILIES = [
  { key: 'red',    label: 'Red',    shades: ['#FFD9D6', '#FFAEA8', '#FF7F76', '#F65246', '#DC3226', '#B3241A', '#8A1A12', '#5E100B'] },
  { key: 'orange', label: 'Orange', shades: ['#FFE6CC', '#FFC894', '#FFA65C', '#F5872E', '#D96C14', '#B0550C', '#864008', '#5B2B05'] },
  { key: 'amber',  label: 'Amber',  shades: ['#FFF3CC', '#FFE28F', '#FFCF54', '#F2B824', '#D19C0C', '#A87C08', '#7E5C05', '#553D03'] },
  { key: 'green',  label: 'Green',  shades: ['#D9F5E2', '#A8E8C0', '#71D69B', '#41BE75', '#2A9E5B', '#1F8049', '#166036', '#0D4124'] },
  { key: 'teal',   label: 'Teal',   shades: ['#D2F4EE', '#9DE7DA', '#66D5C3', '#35BCA6', '#219C88', '#197E6D', '#125E51', '#0A3F36'] },
  { key: 'cyan',   label: 'Cyan',   shades: ['#D2F0F7', '#9BDFEF', '#63C9E3', '#31ADCC', '#1C8FAC', '#15738B', '#0F5568', '#093946'] },
  { key: 'blue',   label: 'Blue',   shades: ['#D8E6FF', '#A9C7FF', '#77A4FF', '#4A80F0', '#2A60D4', '#1F4AA8', '#16357B', '#0D2151'] },
  { key: 'indigo', label: 'Indigo', shades: ['#E0DEFF', '#BEB9FF', '#9A91FF', '#7A6BF0', '#5B4BD4', '#4539A8', '#31287B', '#1E1851'] },
  { key: 'purple', label: 'Purple', shades: ['#F0DBFA', '#DCB4F2', '#C489E6', '#A963D2', '#8C48B4', '#6F3790', '#52276A', '#361846'] },
  { key: 'pink',   label: 'Pink',   shades: ['#FFDCEB', '#FFB0D0', '#FF80B2', '#F25391', '#D43872', '#A82A59', '#7B1D3F', '#511128'] },
];

/** Every swatch in the palette, in grid order: the grayscale row, then one row per family. */
export const PALETTE_ROWS = [GRAYS, ...FAMILIES.map((f) => f.shades)];
export const PALETTE = PALETTE_ROWS.flat();

/**
 * The shades that read acceptably on BOTH canvases — the middle of every ramp.
 *
 * Offered as the collapsed row so the common case needs no popover, and so the default suggestions
 * cannot be a colour that vanishes on one of the two themes.
 */
export const COMMON_COLORS = FAMILIES.map((f) => f.shades[3]);

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;
const SHORT_HEX_RE = /^#?([0-9a-fA-F]{3})$/;

/** Is this a colour we will store? Accepts #RRGGBB and #RGB, with or without the hash. */
export const isValidHex = (v) => typeof v === 'string' && (HEX_RE.test(v.trim()) || SHORT_HEX_RE.test(v.trim()));

/**
 * A hex string in one canonical shape — '#RRGGBB', uppercase — or null.
 *
 * ⚠️ CANONICALISED ON THE WAY IN, so '#abc', 'ABCDEF' and '#AbCdEf' cannot become three different
 * stored values that render identically. Without this, "is this swatch the selected one" is a
 * comparison that fails for reasons the user cannot see.
 */
export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const short = SHORT_HEX_RE.exec(s);
  if (short) {
    const [r, g, b] = short[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const full = HEX_RE.exec(s);
  return full ? `#${full[1].toUpperCase()}` : null;
}

/** Is this stored value an explicit colour rather than a legacy palette index? */
export const isExplicitColor = (v) => typeof v === 'string' && normalizeHex(v) !== null;

/**
 * A stored colour value from anything a caller might hand us, or null for "use the default".
 *
 * Numbers stay numbers (a legacy themed index); strings become canonical hex; anything else is null
 * rather than a guess, so a corrupt stored value falls back to the registry's colour instead of
 * painting a series black.
 */
export function coerceColorValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
  const hex = normalizeHex(v);
  if (hex) return hex;
  // A numeric string is an index that has been through JSON as text.
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.max(0, Math.round(n)) : null;
}
