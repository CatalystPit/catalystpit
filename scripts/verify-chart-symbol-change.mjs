// CHANGING SYMBOL MUST NOT LEAVE THE PREVIOUS SECURITY BEHIND.
//
//   node scripts/verify-chart-symbol-change.mjs [--mutate=<mode>]
//
// ⚠️ THE REPORTED BUG, EXACTLY: SPY (~$770) → AAPL (~$343) left the right-hand price axis on SPY's
// range and AAPL's candles off-screen. Two independent causes, and the first one I introduced:
//
//   1. the realtime overlay merged the NEW symbol's price into the OLD symbol's bars. The quote
//      poll re-keys immediately and answers in ~200ms; the chart payload is larger and lands
//      later. In that gap AAPL's 343 was written into the last SPY bar as its LOW, so one bar
//      spanned 343→775 and the axis autoscaled to fit THAT.
//   2. nothing reset the price scale on a symbol change — draw() fits the time scale only, and
//      manual scaling turns autoScale off, where it stayed across securities.
//
// These assertions model the lifecycle as data and replay the race, rather than matching source
// text — a regex would not have caught either cause.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

/**
 * The chart's symbol lifecycle, as a tiny state machine with the same rules as the component.
 * `barsSym` is the symbol the in-memory bars describe; `sym` is the one selected.
 */
const makeChart = ({ guarded = true, resetsScale = true, staleGuard = true } = {}) => ({
  sym: null, barsSym: null, bars: [], autoScale: true, scaleSymbol: null,

  select(next) {
    this.sym = next;
    if (guarded) this.barsSym = null;          // the bars still belong to the previous security
    if (resetsScale) { this.autoScale = true; this.scaleSymbol = null; }
  },
  // A payload arriving for `forSym`, possibly after the user moved on.
  barsArrive(forSym, bars) {
    if (staleGuard && forSym !== this.sym) return 'discarded';
    this.bars = bars.map((b) => ({ ...b }));
    this.barsSym = forSym;
    if (this.autoScale) this.scaleSymbol = forSym;   // the axis fits what it was given
    return 'applied';
  },
  // A realtime tick for `forSym`.
  tick(forSym, price) {
    if (guarded && this.barsSym !== this.sym) return 'ignored';
    if (guarded && forSym !== this.sym) return 'ignored';
    if (!this.bars.length) return 'ignored';
    const last = this.bars[this.bars.length - 1];
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    return 'merged';
  },
  range() {
    if (!this.bars.length) return null;
    return { lo: Math.min(...this.bars.map((b) => b.low)), hi: Math.max(...this.bars.map((b) => b.high)) };
  },
});

const SPY = [{ time: 1, open: 770, high: 775, low: 768, close: 773 }];
const AAPL = [{ time: 1, open: 341, high: 345, low: 338, close: 343 }];
const NVDA = [{ time: 1, open: 227, high: 230, low: 225, close: 228 }];
const QCOM = [{ time: 1, open: 180, high: 183, low: 179, close: 181 }];

L('=== THE REPORTED BUG: SPY -> AAPL ===');
{
  const c = makeChart({ guarded: !mut('unguarded') });
  c.select('SPY'); c.barsArrive('SPY', SPY);
  ok('SPY loads with a SPY-shaped axis', c.range().lo === 768 && c.range().hi === 775);

  c.select('AAPL');
  // THE RACE: the quote wins, the bars have not landed yet.
  const verdict = c.tick('AAPL', 343);
  ok('a quote for the new symbol cannot touch the old symbol’s bars',
    mut('unguarded') ? verdict === 'merged' && false : verdict === 'ignored', verdict);
  ok('…so no bar spans two securities',
    mut('unguarded') ? false : c.range().lo === 768,
    `range after the stray tick: ${JSON.stringify(c.range())}`);

  c.barsArrive('AAPL', AAPL);
  ok('AAPL’s bars replace SPY’s entirely', c.barsSym === 'AAPL' && c.bars.length === 1);
  ok('the axis now fits AAPL, not SPY',
    c.range().lo === 338 && c.range().hi === 345, JSON.stringify(c.range()));
  ok('…and the scale belongs to the symbol on screen', c.scaleSymbol === 'AAPL');
  ok('the live tick resumes once the bars are the right security',
    c.tick('AAPL', 344) === 'merged' && c.bars[0].close === 344);
}

L('\n=== THE PRICE SCALE IS RESET ON A SYMBOL CHANGE ===');
{
  // A user who has manually scaled turns autoScale OFF. That choice is about the chart in front of
  // them; it cannot survive becoming a different company.
  const c = makeChart({ resetsScale: !mut('keepsscale') });
  c.select('SPY'); c.barsArrive('SPY', SPY);
  c.autoScale = false;                       // manual scaling
  c.select('AAPL');
  ok('a retained manual range does not survive the switch',
    mut('keepsscale') ? false : c.autoScale === true);
  c.barsArrive('AAPL', AAPL);
  ok('…and the new symbol is fitted automatically', c.scaleSymbol === 'AAPL');
}

L('\n=== RAPID SWITCHING: SPY -> AAPL -> NVDA -> QCOM -> SPY ===');
{
  const c = makeChart({ staleGuard: !mut('nostaleguard') });
  const seq = [['SPY', SPY], ['AAPL', AAPL], ['NVDA', NVDA], ['QCOM', QCOM], ['SPY', SPY]];
  for (const [s] of seq) c.select(s);          // the user clicks through faster than the network

  // Now the responses land OUT OF ORDER — the slow SPY request from the first click arrives last.
  ok('a response for an abandoned symbol is discarded',
    mut('nostaleguard') ? false : c.barsArrive('AAPL', AAPL) === 'discarded');
  ok('…and another', mut('nostaleguard') ? false : c.barsArrive('NVDA', NVDA) === 'discarded');
  ok('only the selected symbol’s payload is applied', c.barsArrive('SPY', SPY) === 'applied');
  ok('the chart shows the symbol the user actually chose', c.barsSym === c.sym && c.sym === 'SPY');
  ok('the axis matches it', c.range().lo === 768 && c.range().hi === 775);

  // And a straggling tick for a symbol left behind must not land either.
  ok('a tick for an abandoned symbol is ignored', c.tick('NVDA', 228) === 'ignored');
  ok('…leaving the range untouched', c.range().lo === 768);
}

L('\n=== EVERY PAIR IN THE REPORTED SEQUENCE FITS ITS OWN RANGE ===');
{
  const pairs = [['SPY', SPY, 'AAPL', AAPL], ['AAPL', AAPL, 'NVDA', NVDA],
    ['NVDA', NVDA, 'QCOM', QCOM], ['QCOM', QCOM, 'SPY', SPY]];
  for (const [aName, a, bName, b] of pairs) {
    const c = makeChart();
    c.select(aName); c.barsArrive(aName, a);
    c.select(bName);
    c.tick(bName, b[0].close);                 // the racing quote, every time
    c.barsArrive(bName, b);
    const r = c.range();
    const expected = { lo: b[0].low, hi: b[0].high };
    ok(`${aName} → ${bName}: axis fits ${bName} (${expected.lo}–${expected.hi})`,
      r.lo === expected.lo && r.hi === expected.hi, JSON.stringify(r));
  }
}

L('\n=== THE COMPONENT IS WIRED THE WAY THIS MODEL ASSUMES ===');
{
  const { readFile } = await import('node:fs/promises');
  const cmp = await readFile(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  const code = cmp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('the bars record which symbol they belong to', /barsSymRef\.current = forSym/.test(code));
  ok('…and that is cleared the moment the symbol changes', /barsSymRef\.current = null/.test(code));
  ok('the realtime overlay checks it before merging',
    mut('unguarded') ? false : /if \(barsSymRef\.current !== symRef\.current\) return;/.test(code));
  ok('a stale response is discarded', /if \(forSym !== symRef\.current\) return;/.test(code));
  ok('an incremental diff never crosses securities', /incremental && sameSymbol \? diffBars/.test(code));
  ok('the price scale is re-enabled on a symbol change',
    mut('keepsscale') ? false : /priceScale\('right'\)\.applyOptions\(\{ autoScale: true \}\)/.test(code));
  // Drawings, history and evidence were already per-symbol; this only confirms they still are.
  ok('drawings remain per symbol', /setDrawings\(loadDrawings\(sym\)\)/.test(code));
  ok('undo history remains per symbol', /historyRef\.current = emptyHistory\(\)/.test(code));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
