// The Insiders transaction table's columns, in one place, because the bug was two places.
//
// The table is `table-layout: fixed; width: 100%` with a <colgroup> of explicit pixel widths and a
// separate `min-width` floor on the table box. Those two numbers have to agree: the colgroup summed
// to 1324px while the floor said 1180px, so for every workspace narrower than 1324 the browser had
// to fit 1324px of declared columns into an 1180px box and scaled all thirteen down by ~11%. No
// horizontal scrollbar appeared, because as far as the scroll container was concerned the table
// fitted — it had simply been squeezed. That is what clipped the right-hand columns when the
// Watchlist or Pit dock took 330px out of the workspace, and VALUE went first: it is right-aligned,
// carries the largest type on the row (14px bold) and was the one numeric cell with no
// white-space/ellipsis guard, so its figure overflowed a box that was no longer wide enough.
//
// Deriving the floor from the widths makes the two impossible to disagree again: change a width,
// and the minimum the table will accept before it scrolls changes with it.

// Widths are sized to the CONTENT each column actually carries, at 7px of cell padding per side.
// The old set was 1324px of mostly whitespace, which pushed VALUE off the right edge as soon as a
// dock took 330px out of the shell. Sized down to what the data needs, the whole table fits the
// docked workspace on an ordinary wide monitor and VALUE is simply there, with the scroll viewport
// still in place as the fallback for narrower or custom dock setups.
//
// The numbers below are text width + 14px padding, measured against the widest real value each
// column holds. Nothing numeric is squeezed below its own content: Shares carries "5,039,989",
// Owned the same, Value "$458.3K" at 14px bold. Company and Insider are the two columns that were
// ALREADY ellipsised, so they absorb the reduction.
export const INSIDER_TX_COLUMNS = [
  { label: 'Filed',      sortKey: 'DATE',   align: 'left',  width: 84 },   // 2026-09-14 + filing link
  { label: 'Traded',     sortKey: null,     align: 'left',  width: 76 },   // 2026-09-14
  { label: 'Ticker',     sortKey: 'TICKER', align: 'left',  width: 78 },   // logo + up to 5 chars
  { label: 'Company',    sortKey: null,     align: 'left',  width: 84 },   // ellipsised
  { label: 'Insider',    sortKey: null,     align: 'left',  width: 100 },  // ellipsised, 2-3 lines
  { label: 'Type',       sortKey: null,     align: 'left',  width: 84 },   // badge, wraps
  { label: 'Code',       sortKey: null,     align: 'left',  width: 24 },   // a single letter
  { label: 'Shares',     sortKey: 'SHARES', align: 'right', width: 78 },
  { label: 'Owned',      sortKey: null,     align: 'right', width: 74 },
  { label: 'ΔOwn',       sortKey: null,     align: 'right', width: 54 },   // -34.7%
  { label: 'Avg Price',  sortKey: null,     align: 'right', width: 66 },
  { label: 'Value',      sortKey: 'VALUE',  align: 'right', width: 84 },   // $458.3K, 14px bold
  { label: 'Conviction', sortKey: null,     align: 'right', width: 74, server: true },
];

// The width below which the table stops shrinking and the surrounding box scrolls instead. It is
// exactly the layout the columns declare, so the columns are never compressed at all: either the
// workspace fits the table, or the table scrolls inside it at full size.
export const INSIDER_TX_MIN_WIDTH = INSIDER_TX_COLUMNS.reduce((sum, c) => sum + c.width, 0);
