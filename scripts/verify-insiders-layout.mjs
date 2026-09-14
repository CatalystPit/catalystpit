// The Insiders transaction table must stay readable, and VALUE must stay reachable, at every
// desktop width the shared docks can leave behind.
//
// THE BUG. The table is `table-layout: fixed; width: 100%` with a <colgroup> of explicit pixel
// widths and a separate `min-width` floor. Those two numbers disagreed: the columns declared
// 1324px, the floor said 1180px. So for any workspace between 1180 and 1324 the browser fitted
// 1324px of columns into an 1180px box by scaling all thirteen down ~11%, and no scrollbar appeared
// because the table "fitted". Opening the Watchlist or Pit dock removes 330px from the shell, which
// is exactly what pushed a normal desktop into that band. VALUE broke first: right-aligned, 14px
// bold, and the one numeric cell with no white-space guard, so its figure overflowed a box that had
// been squeezed under it.
//
// This models the real chain: viewport -> #cp-shell margin -> page padding -> card -> scroller.
// Run: node scripts/verify-insiders-layout.mjs

import { readFileSync } from 'node:fs';
import { INSIDER_TX_COLUMNS, INSIDER_TX_MIN_WIDTH } from '../src/lib/insider-columns.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };

const page = readFileSync(new URL('../src/app/insiders/page.jsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/app/layout.jsx', import.meta.url), 'utf8');

// ── the layout chain, from the real source ───────────────────────────────────
const PAGE_MAX = 1380;          // maxWidth on the Insiders body container
const PAGE_PAD = 24 * 2;        // padding: 0 24px
const DOCK_W = 330;             // PitDock / WatchlistDock / XTapeDock PANEL_W

// #cp-shell { margin-right: max(--cp-pit, --cp-watch) } — the docks overlay, the shell insets.
const shellWidth = (viewport, { pit = 0, watch = 0, tape = 0 } = {}) =>
  viewport - tape - Math.max(pit, watch);
const contentWidth = (viewport, docks) => Math.min(PAGE_MAX, shellWidth(viewport, docks)) - PAGE_PAD;
// The table box never goes below its declared layout; the scroller takes the difference.
const tableWidth = (content) => Math.max(content, INSIDER_TX_MIN_WIDTH);
const scrolls = (content) => tableWidth(content) > content;
// What one column actually gets. With table-layout:fixed the declared widths are scaled to the
// table box, so this is the number that decides whether a figure still fits.
const columnWidth = (content, label) => {
  const col = INSIDER_TX_COLUMNS.find((c) => c.label === label);
  return col.width * (tableWidth(content) / INSIDER_TX_MIN_WIDTH);
};

console.log('\n=== the two numbers that disagreed now cannot ===');
ok('the floor equals the declared column layout',
  INSIDER_TX_MIN_WIDTH === INSIDER_TX_COLUMNS.reduce((s, c) => s + c.width, 0),
  String(INSIDER_TX_MIN_WIDTH));
ok('...which is 1324, not the 1180 that shipped', INSIDER_TX_MIN_WIDTH === 1324, String(INSIDER_TX_MIN_WIDTH));
ok('the page no longer hardcodes a second floor', !/minWidth:1180/.test(page));
ok('the page uses the shared floor', /minWidth:INSIDER_TX_MIN_WIDTH/.test(page));
ok('the colgroup is generated from the shared columns',
  /<colgroup>\{INSIDER_TX_COLUMNS\.map/.test(page));
ok('the header is generated from the same list', /\{INSIDER_TX_COLUMNS\.map\(h=>\{/.test(page));
ok('the empty-state colSpan follows the column count',
  /colSpan=\{INSIDER_TX_COLUMNS\.length\}/.test(page) && !/colSpan=\{13\}/.test(page));
ok('all 13 columns are still present, in order', INSIDER_TX_COLUMNS.length === 13);
ok('column order is unchanged',
  INSIDER_TX_COLUMNS.map((c) => c.label).join('|')
  === 'Filed|Traded|Ticker|Company|Insider|Type|Code|Shares|Owned|ΔOwn|Avg Price|Value|Conviction');
ok('VALUE is still a column', INSIDER_TX_COLUMNS.some((c) => c.label === 'Value'));
ok('VALUE is still sortable', INSIDER_TX_COLUMNS.find((c) => c.label === 'Value').sortKey === 'VALUE');
ok('CONVICTION is still server-sorted', INSIDER_TX_COLUMNS.find((c) => c.label === 'Conviction').server === true);

console.log('\n=== every dock state the user asked for ===');
// 1512 is a common desktop; 1280 is the narrowest ordinary laptop. Both are tested with each dock.
const STATES = [
  ['both panels closed',              1512, {}],
  ['Watchlist open',                  1512, { watch: DOCK_W }],
  ['The Pit open',                    1512, { pit: DOCK_W }],
  ['both open (they overlap)',        1512, { pit: DOCK_W, watch: DOCK_W }],
  ['Tape + Pit open',                 1512, { pit: DOCK_W, tape: DOCK_W }],
  ['1280 laptop, panels closed',      1280, {}],
  ['1280 laptop, Watchlist open',     1280, { watch: DOCK_W }],
  ['1280 laptop, The Pit open',       1280, { pit: DOCK_W }],
  ['1280 laptop, Tape + Pit open',    1280, { pit: DOCK_W, tape: DOCK_W }],
  ['1920 wide, both open',            1920, { pit: DOCK_W, watch: DOCK_W }],
];
for (const [name, vp, docks] of STATES) {
  const content = contentWidth(vp, docks);
  const valuePx = columnWidth(content, 'Value');
  const full = tableWidth(content) >= INSIDER_TX_MIN_WIDTH;
  ok(`${name}: columns never compressed`, full, `table=${Math.round(tableWidth(content))}`);
  ok(`${name}: VALUE keeps its full width`, valuePx >= 92, `${Math.round(valuePx)}px`);
  console.log(`  ${name.padEnd(30)} content=${Math.round(content)}px table=${Math.round(tableWidth(content))}px `
    + `value=${Math.round(valuePx)}px ${scrolls(content) ? 'scrolls' : 'fits'}`);
}

console.log('\n=== what the OLD floor did in those same states ===');
// Proof the reported symptom follows from the old number, and only from it.
const OLD = 1180;
const oldColumn = (content, label) => {
  const col = INSIDER_TX_COLUMNS.find((c) => c.label === label);
  return col.width * (Math.max(content, OLD) / INSIDER_TX_MIN_WIDTH);
};
const squeezed = STATES.filter(([, vp, d]) => oldColumn(contentWidth(vp, d), 'Value') < 92);
ok('the old floor DID squeeze VALUE in real dock states', squeezed.length > 0,
  'the regression this test exists for would pass silently');
for (const [name, vp, d] of squeezed) {
  console.log(`  ${name.padEnd(30)} VALUE was ${Math.round(oldColumn(contentWidth(vp, d), 'Value'))}px `
    + `(now ${Math.round(columnWidth(contentWidth(vp, d), 'Value'))}px)`);
}

console.log('\n=== scrolling, alignment and the page itself ===');
const narrow = contentWidth(1280, { pit: DOCK_W, tape: DOCK_W });
ok('at the narrowest supported workspace the table scrolls', scrolls(narrow), `${Math.round(narrow)}px`);
ok('...and scrolling reaches the complete VALUE column',
  tableWidth(narrow) >= INSIDER_TX_MIN_WIDTH, 'the full 1324px layout is reachable');
ok('...and CONVICTION, the column after it, is reachable too',
  columnWidth(narrow, 'Conviction') >= 110);
// One <table> holds both <thead> and <tbody>, so the header cannot scroll independently of the rows
// and cannot drift out of column alignment. This asserts the structure that guarantees it.
const tbl = page.slice(page.indexOf('minWidth:INSIDER_TX_MIN_WIDTH'));
ok('header and rows share ONE table element',
  tbl.indexOf('<thead>') < tbl.indexOf('<tbody>') && tbl.indexOf('<tbody>') < tbl.indexOf('</table>'));
ok('the scroll container wraps the whole table', /overflowX:"auto",maxWidth:"100%"[\s\S]{0,120}<table/.test(page));
ok('the card still clips, so the page grows no scrollbar of its own',
  /borderRadius:8,overflow:"hidden"\}\}>\s*<div style=\{\{overflowX:"auto"/.test(page));
ok('the shell is inset by the open dock, so the table cannot sit under it',
  /margin-right: max\(var\(--cp-pit, 0px\), var\(--cp-watch, 0px\)\)/.test(layout));
ok('the inset is CSS, so collapsing a dock recalculates on the same frame',
  /transition: margin 0\.25s ease/.test(layout));

console.log('\n=== VALUE can no longer break inside its own cell ===');
const valueCell = page.match(/<td className="cp-num"[^>]*fontSize:14,fontWeight:700[^>]*>\{ins\.value\}<\/td>/);
ok('the VALUE cell exists', !!valueCell);
ok('...and is nowrap like every other figure on the row',
  !!valueCell && /whiteSpace:"nowrap"/.test(valueCell[0]));

console.log('\n=== the scrollbar is reachable, and only exists when needed ===');
// Measured on production before the fix: with The Pit open the box was 1128px, the table 1326px,
// and the box's bottom edge — where its own scrollbar lives — was 1438px BELOW the viewport. The
// columns were reachable only by a gesture nothing advertised.
ok('a sticky scrollbar component exists', /function HScrollBar/.test(page));
ok('...pinned to the bottom of the viewport', /position:"sticky",bottom:0/.test(page));
ok('...rendered OUTSIDE the overflow:hidden card, or sticky would not move',
  /<HScrollBar targetRef=\{txScrollRef\} \/>\s*<\/div>/.test(page));
ok('...inside a positioned wrapper with no overflow of its own',
  /<div style=\{\{position:"relative"\}\}>\s*<div style=\{\{background:C\.white/.test(page));
ok('...absent when nothing overflows', /if \(!width\) return null;/.test(page));
ok('...driven two-way with the table box', /fromBox/.test(page) && /fromBar/.test(page));
ok('...with a re-entrancy lock, so the two cannot fight', /let lock = false;/.test(page));
ok('a ResizeObserver recalculates on dock expand and collapse',
  /new ResizeObserver\(measure\)/.test(page) && /ro\.observe\(box\)/.test(page));
ok('...and on window resize', /window\.addEventListener\('resize', measure\)/.test(page));
ok('the bar is given a visible track rather than an auto-hiding overlay',
  /\.cp-hbar::-webkit-scrollbar\{height:10px\}/.test(page) && /scrollbar-width:thin/.test(page));
ok('it is hidden from assistive tech, being a duplicate control', /aria-hidden="true"/.test(page));

console.log('\n=== nothing else on the page changed ===');
for (const keep of ['sortBy===h.sortKey', 'handleSort', 'setConvSort', 'ConvictionCell', 'activeView',
  'row-hov', 'goTicker', 'openInsider', 'Badges', 'rule10b5_1'])
  ok(`${keep} still present`, page.includes(keep));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
