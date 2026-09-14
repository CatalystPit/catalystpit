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

export const INSIDER_TX_COLUMNS = [
  { label: 'Filed',      sortKey: 'DATE',   align: 'left',  width: 96 },
  { label: 'Traded',     sortKey: null,     align: 'left',  width: 88 },
  { label: 'Ticker',     sortKey: 'TICKER', align: 'left',  width: 92 },
  { label: 'Company',    sortKey: null,     align: 'left',  width: 128 },
  { label: 'Insider',    sortKey: null,     align: 'left',  width: 164 },
  { label: 'Type',       sortKey: null,     align: 'left',  width: 150 },
  { label: 'Code',       sortKey: null,     align: 'left',  width: 44 },
  { label: 'Shares',     sortKey: 'SHARES', align: 'right', width: 92 },
  { label: 'Owned',      sortKey: null,     align: 'right', width: 92 },
  { label: 'ΔOwn',       sortKey: null,     align: 'right', width: 80 },
  { label: 'Avg Price',  sortKey: null,     align: 'right', width: 96 },
  { label: 'Value',      sortKey: 'VALUE',  align: 'right', width: 92 },
  { label: 'Conviction', sortKey: null,     align: 'right', width: 110, server: true },
];

// The width below which the table stops shrinking and the surrounding box scrolls instead. It is
// exactly the layout the columns declare, so the columns are never compressed at all: either the
// workspace fits the table, or the table scrolls inside it at full size.
export const INSIDER_TX_MIN_WIDTH = INSIDER_TX_COLUMNS.reduce((sum, c) => sum + c.width, 0);
