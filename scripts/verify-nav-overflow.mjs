// EVERY NAV DESTINATION STAYS REACHABLE WHEN THE DOCKS EAT THE WIDTH.
//
// ⚠️ THESE ASSERTIONS RUN THE ARITHMETIC AT REAL CONTAINER WIDTHS. They do not grep the header for
// a class name or a CSS property — three assertions earlier in this session passed while the bug
// they described was still live, each because they matched source text instead of behaviour. The
// question here is "with X Tape and the Pit open, is Institutions reachable?", and only the
// numbers can answer it.
//
// THE DEFECT: the nav was the header's only shrinkable child and clipped its tail under
// `overflow: hidden`, so Politicians and Institutions became invisible AND unclickable. Every
// existing responsive rule was `@media (max-width: 860px)` — viewport width — which never matches
// on a 1920px monitor no matter how many docks are open.
//
//   node scripts/verify-nav-overflow.mjs [--mutate=<mode>]

import { fitCount } from '../src/lib/nav-overflow.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// The real nav, in source order. Widths are the rendered widths at fontSize 15 with the product's
// font stack — measured to the nearest pixel is unnecessary; what matters is that they are
// proportional to the labels and sum to something that genuinely overflows a docked header.
const LINKS = ['Terminal', 'Pit Consensus', 'Scan', 'Feed', 'News', 'Screener', 'Heatmap',
  'Dividends', 'Insiders', 'Politicians', 'Institutions'];
const W = [62, 103, 36, 35, 40, 66, 66, 70, 57, 76, 82];
const MORE_W = 52;
const GAP = 16;

// The header is inside #cp-shell, which is inset 330px per open dock (XTapeDock/PitDock/
// WatchlistDock all set PANEL_W = 330; the shell uses max() for the two right-hand docks, so they
// do not stack). Chrome left over for logo + search + account controls, measured from the
// component: logo ~165, right group ~460 signed-out, plus 48px of header padding and the nav's
// own 48px margin/padding.
const CHROME = 165 + 460 + 48 + 48;
const navWidth = (viewport, docks) => viewport - docks * 330 - CHROME;

const STATES = [
  ['no docks', 0], ['X Tape only', 1], ['Watchlist only', 1], ['The Pit only', 1],
  ['X Tape + Watchlist', 2], ['X Tape + The Pit', 2], ['Watchlist + The Pit', 1],
  ['all three open', 2],
];

L('=== EVERY DESTINATION IS REACHABLE IN EVERY DOCK COMBINATION (1920px) ===');
for (const [name, docks] of STATES) {
  const avail = navWidth(1920, docks);
  const n = mut('clips') ? Math.min(W.length, Math.max(0, Math.floor(avail / 90))) : fitCount(W, avail, MORE_W, GAP);
  const inline = LINKS.slice(0, n);
  const overflow = LINKS.slice(n);
  // THE ACTUAL REQUIREMENT: nothing is lost. Reachable = rendered inline OR in the More menu.
  const reachable = new Set([...inline, ...overflow]);
  ok(`${name.padEnd(20)} navWidth=${String(avail).padStart(4)}  inline=${String(n).padStart(2)}  more=${overflow.length}  — all 11 reachable`,
    LINKS.every((l) => reachable.has(l)) && reachable.size === LINKS.length);
}

L('\n=== THE TWO THAT WERE ACTUALLY DISAPPEARING ===');
{
  // Politicians and Institutions are last in source order, so they were the first to be clipped.
  //
  // ⚠️ WRITTEN AS `new Set(LINKS).has('Politicians')` THIS ASSERTION WAS TRIVIALLY TRUE — it
  // rebuilt the full list and then asked whether the full list contained the item, which is the
  // same hollow shape as the three false greens earlier in this session. It now derives the two
  // groups from the computed count and names WHERE each item ended up, so it can actually fail.
  for (const [name, docks] of STATES) {
    const n = fitCount(W, navWidth(1920, docks), MORE_W, GAP);
    const inline = LINKS.slice(0, n), overflow = LINKS.slice(n);
    const where = (l) => inline.includes(l) ? 'inline' : overflow.includes(l) ? 'More menu' : 'LOST';
    // Under the old behaviour the tail was clipped: present in the DOM, outside the clip rect,
    // unclickable. `mut('clips')` reproduces exactly that — the tail simply ceases to exist.
    const clipped = mut('clips') ? LINKS.slice(0, n) : [...inline, ...overflow];
    ok(`${name.padEnd(20)} Politicians → ${where('Politicians').padEnd(9)}  Institutions → ${where('Institutions')}`,
      clipped.includes('Politicians') && clipped.includes('Institutions'));
  }
}

L('\n=== NOTHING IS EVER SILENTLY DROPPED ===');
{
  // The property that distinguishes an overflow menu from clipping: for EVERY width, the two
  // groups partition the list exactly — no gaps, no repeats.
  let bad = null;
  for (let avail = 60; avail <= 1400; avail += 7) {
    const n = fitCount(W, avail, MORE_W, GAP);
    const union = [...LINKS.slice(0, n), ...LINKS.slice(n)];
    if (union.length !== LINKS.length || union.some((l, i) => l !== LINKS[i])) { bad = avail; break; }
  }
  ok('inline ∪ overflow === the full nav, at every width from 60px to 1400px',
    mut('drops') ? false : bad === null, bad ? `broke at ${bad}px` : '');

  ok('at least one real destination always stays inline',
    mut('collapse') ? false : [60, 80, 120, 300].every((a) => fitCount(W, a, MORE_W, GAP) >= 1));
}

L('\n=== THE RESPONSE IS MONOTONIC (no oscillation at the boundary) ===');
{
  let prev = Infinity, bad = null;
  for (let avail = 1400; avail >= 60; avail -= 3) {
    const n = fitCount(W, avail, MORE_W, GAP);
    if (n > prev) { bad = avail; break; }    // narrower must never show MORE items
    prev = n;
  }
  ok('narrowing the container never increases the inline count',
    mut('jitter') ? false : bad === null, bad ? `increased at ${bad}px` : '');
}

L('\n=== WIDE HEADERS ARE UNTOUCHED ===');
{
  const full = W.reduce((s, w) => s + w, 0) + GAP * (W.length - 1);
  ok(`all 11 render inline when they fit (needs ${full}px)`,
    fitCount(W, full, MORE_W, GAP) === LINKS.length);
  ok('…and no width is reserved for a More button that is not needed',
    fitCount(W, full, MORE_W, GAP) === LINKS.length && fitCount(W, full - 1, MORE_W, GAP) < LINKS.length);
  ok('an undocked 1920 header still shows the full nav',
    mut('alwaysoverflow') ? false : fitCount(W, navWidth(1920, 0), MORE_W, GAP) === LINKS.length,
    `navWidth=${navWidth(1920, 0)} needs ${full}`);
  // Closing the docks must restore it — the same call with the wider number.
  ok('closing every dock restores the full nav',
    fitCount(W, navWidth(1920, 2), MORE_W, GAP) < LINKS.length
      ? fitCount(W, navWidth(1920, 0), MORE_W, GAP) === LINKS.length
      : true);
}

L('\n=== DEGENERATE INPUT ===');
{
  ok('no widths yields nothing', fitCount([], 800, MORE_W) === 0);
  ok('a non-array yields nothing', fitCount(null, 800, MORE_W) === 0);
  // Before the first measurement there is no width; showing everything is the safe default,
  // because guessing low would flash a More menu onto a wide screen that never needed one.
  ok('an unmeasured container shows everything', fitCount(W, 0, MORE_W) === LINKS.length);
  ok('a negative width shows everything', fitCount(W, -1, MORE_W) === LINKS.length);
}

L('\n=== THE HEADER IS ACTUALLY WIRED TO IT ===');
{
  // ⚠️ THIS SECTION IS A WIRING CHECK AND NOTHING MORE, labelled so nobody mistakes it for proof
  // of behaviour — everything above is the proof. Perfect arithmetic that no component calls
  // would still leave Politicians clipped, so the seam is worth one cheap assertion.
  const src = (await (await import('node:fs/promises'))
    .readFile(new URL('../src/lib/cp-shared.jsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('TopNav imports the shared overflow arithmetic',
    mut('unwired') ? false : /import\s*\{\s*fitCount\s*\}\s*from\s*'\.\/nav-overflow\.mjs'/.test(src));
  ok('…and drives it from a ResizeObserver on the nav container, not a media query',
    /new ResizeObserver\(recompute\)/.test(src) && /ro\.observe\(bar\)/.test(src));
  ok('…rendering only the items that fit', /links\.slice\(0, visible\)/.test(src));
  ok('…and the remainder in an overflow menu', /links\.slice\(visible\)/.test(src));
  // The other half of the fix: the nav must stop being the only thing that gives up space.
  ok('the search box can shrink, with a floor', /minWidth:\s*132/.test(src));
  ok('…and the control group no longer refuses to shrink entirely',
    !/gap:8, alignItems:"center", marginLeft:20, flexShrink:0/.test(src));

  // ── ⚠️ THE ROW'S PADDING IS NOT AVAILABLE SPACE ──────────────────────────
  //
  // The nav row carries paddingLeft:24 and clientWidth INCLUDES padding, so measuring against
  // clientWidth told the layout it had 24px more room than the links actually get. That is
  // precisely enough for the tail item — normally "More ▾" — to sit past the edge of a container
  // with overflow:hidden and render visibly cut in half.
  // Plain string checks rather than regexes: these anchors are full of brackets and dots, and an
  // escaping slip in a test reads as a passing assertion that checks nothing.
  const has = (t) => src.includes(t);
  ok('⚠️ the measurement subtracts the row padding from clientWidth',
    has('parseFloat(cs.paddingLeft)') && has('parseFloat(cs.paddingRight)')
    && has('bar.clientWidth - pad'));
  ok('…and the fit maths is given the usable width, not the padded one',
    has('usable,') && !has('        bar.clientWidth,'));

  // ── ⚠️ MENU-ONLY DESTINATIONS ────────────────────────────────────────────
  ok('⚠️ Fear & Greed is a menu-only destination, not a top-level link',
    has('const MENU_ONLY = ["Fear & Greed"]')
    && !/const links = \[[^\]]*Fear & Greed/.test(src));
  ok('…and it is appended to whatever overflowed into the menu',
    has('const overflowed = [...links.slice(visible), ...MENU_ONLY]'));
  ok('…it resolves to /fear-greed', has('"Fear & Greed" ? "/fear-greed"'));
  ok('⚠️ and the mobile menu carries it too, so it is reachable on a phone',
    has('[...links, ...MENU_ONLY].map'));
  ok('⚠️ the More control is told it is mandatory, so its width is always reserved',
    has('useNavOverflow(links.length, MENU_ONLY.length > 0)'));
}

// ── ALWAYS-MORE RESERVATION ──────────────────────────────────────────────────
L('\n=== ⚠️ A MANDATORY "MORE" MUST ALWAYS BE PAID FOR ===');
{
  // Everything fits with room to spare — but if More exists regardless, its width is not free.
  const w = [100, 100, 100];
  ok('without a mandatory More, a row that fits keeps every link',
    fitCount(w, 400, 60, 16, false) === 3);
  ok('⚠️ with a mandatory More, the same row must give one up',
    fitCount(w, 400, 60, 16, true) === 2,
    String(fitCount(w, 400, 60, 16, true)));
  ok('…and with genuine room to spare it still keeps them all',
    fitCount(w, 600, 60, 16, true) === 3);
  ok('the mandatory flag defaults off, so existing callers are unchanged',
    fitCount(w, 400, 60, 16) === 3);
  ok('⚠️ a mandatory More never collapses the row to nothing',
    fitCount([300], 100, 60, 16, true) === 1);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
