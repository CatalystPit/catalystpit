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

/**
 * A grayscale ramp, white through black. TEN steps, because it is a column like every other family.
 *
 * ⚠️ THE GRID IS NINE COLUMNS BY TEN ROWS, so grayscale is one of the nine columns rather than a row of
 * its own. That is what makes every column the same shape: one hue, ten brightness levels, read top to
 * bottom. It also means the row index means the same thing across the whole palette — row 5 is the
 * mid-tone of every family at once.
 */
export const GRAYS = [
  '#FFFFFF', '#F0F2F0', '#DCDFDD', '#C2C7C3', '#A4AAA6',
  '#868C88', '#6A706C', '#4C524E', '#2C312E', '#000000',
];

/**
 * The colour families, each light → dark, ten shades apiece.
 *
 * ⚠️ EIGHT FAMILIES PLUS GRAYSCALE MAKES THE NINE COLUMNS. Ordered as a spectrum — red through pink,
 * orange, yellow, green, teal, blue, purple — so the grid reads as one continuous surface rather than a
 * bag of swatches, which is what makes ninety colours scannable instead of overwhelming.
 *
 * ⚠️ TEN LEVELS, NOT EIGHT. The previous ramps had eight, which made the top and bottom of each family
 * jump: there was a pastel and a near-black with little between them at the ends. Ten gives a usable
 * light tint AND a usable deep shade in every hue, which is the point of a professional palette — a
 * drawing on a dark chart and the same drawing on a light one want different ends of the same column.
 */
export const FAMILIES = [
  { key: 'red',    label: 'Red',    shades: ['#FFE5E3', '#FFC7C2', '#FFA39B', '#FF7F76', '#F65B4E', '#DC3226', '#BC241A', '#991C13', '#73140D', '#4A0B06'] },
  { key: 'pink',   label: 'Pink',   shades: ['#FFE6F1', '#FFC9E0', '#FFA6CB', '#FF80B2', '#F45F98', '#D43872', '#B32B5E', '#8E2049', '#691634', '#440D1F'] },
  { key: 'orange', label: 'Orange', shades: ['#FFEEDC', '#FFD9B5', '#FFC08A', '#FFA65C', '#F58A33', '#D96C14', '#B8570F', '#94440B', '#6D3107', '#472004'] },
  { key: 'yellow', label: 'Yellow', shades: ['#FFF8DC', '#FFEFB0', '#FFE384', '#FFD457', '#F2BE2C', '#D1A00C', '#B08609', '#8C6A07', '#674D05', '#433203'] },
  { key: 'green',  label: 'Green',  shades: ['#E2F8EA', '#BDEFD0', '#94E4B2', '#6AD494', '#45BE76', '#2A9E5B', '#21854B', '#1A6A3C', '#124E2B', '#0A321B'] },
  { key: 'teal',   label: 'Teal',   shades: ['#DDF7F2', '#B6EFE4', '#8AE3D3', '#5FD3BE', '#3ABBA5', '#219C88', '#1B8373', '#15685B', '#0F4C43', '#09312A'] },
  { key: 'blue',   label: 'Blue',   shades: ['#E2ECFF', '#C0D6FF', '#9BBCFF', '#77A4FF', '#5188F7', '#2A60D4', '#2250B3', '#1B408F', '#132F69', '#0B1D43'] },
  { key: 'purple', label: 'Purple', shades: ['#F1E6FF', '#DECBFF', '#C8ABFA', '#B08AEE', '#9668DB', '#7A48BE', '#663A9F', '#522E80', '#3C215E', '#26143C'] },
];

/** Every swatch in the palette, in grid order: the grayscale row, then one row per family. */
/**
 * THE GRID THE PICKER DRAWS: 9 rows of 10, all 90 swatches, no scrolling.
 *
 * ⚠️ TRANSPOSED, AND THAT IS THE WHOLE POINT. Laid out as one row per family this is eleven rows —
 * a grey row of ten, then ten rows of eight — which is tall and narrow, and tall enough that the
 * popover needed a scroll container. A palette behind a scrollbar is a palette the user cannot see, so
 * choosing from it means hunting. Turning the families into COLUMNS gives ten columns of eight shades
 * plus the grey row on top: exactly 9 x 10, every swatch visible at once, and the shape reads better
 * anyway — a column is one hue light-to-dark, a row is the same intensity across the spectrum.
 */
export const PALETTE_GRID = Array.from(
  { length: Math.max(GRAYS.length, ...FAMILIES.map((f) => f.shades.length)) },
  (_, shade) => [GRAYS[shade], ...FAMILIES.map((f) => f.shades[shade])].filter(Boolean),
);

/**
 * Every swatch, flat.
 *
 * ⚠️ DERIVED FROM THE FAMILIES, NOT FROM THE GRID. Flattening the grid would also be correct today,
 * but it makes the list's ORDER an artefact of a layout decision — and a later change to the grid's
 * shape would then silently reorder the palette for every caller that walks it.
 */
export const PALETTE = [...GRAYS, ...FAMILIES.flatMap((f) => f.shades)];

/** How many columns the grid uses. Read by the picker to size itself without measuring. */
export const PALETTE_COLUMNS = Math.max(...PALETTE_GRID.map((r) => r.length));
export const PALETTE_ROWS = PALETTE_GRID.length;

/**
 * The shades that read acceptably on BOTH canvases — the middle of every ramp.
 *
 * Offered as the collapsed row so the common case needs no popover, and so the default suggestions
 * cannot be a colour that vanishes on one of the two themes.
 */
export const COMMON_COLORS = FAMILIES.map((f) => f.shades[5]);

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
