// POLITICIANS — the newest high-level action wins, and ticker mode is visible.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-politicians-ux.mjs
//
// ⚠️ THE DEFECT. One piece of state answered two different questions. The chart needs a ticker at all
// times — the rail defaults to the busiest name so the frame is never empty — while the transactions
// table should filter only on a ticker the READER chose. Both read `selectedTicker`, so a default was
// indistinguishable from a choice. Clicking AAPL then Most Recent re-sorted the member grid while the
// table stayed pinned to AAPL, and the control just pressed appeared to do nothing.
//
// ⚠️ AND THE SAME CONFUSION HID A SECOND BUG: because the rail auto-selects on mount, "All
// Transactions" was never all of them on first load — the page opened filtered to one company.
//
// The interaction is asserted two ways: the wiring, as code shapes, and the behaviour, by replaying
// the exact sequence from the report against a faithful model of the component's state.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const LIST = code('src/app/politicians/PoliticiansList.jsx');
const CHART = code('src/app/politicians/CongressChartSection.jsx');
const TX = code('src/app/politicians/CongressTransactions.jsx');

L('⚠️ the two questions are held in two pieces of state');
{
  ok('the chart\'s ticker and the reader\'s pin are separate', /const \[tickerPinned, setTickerPinned\] = useState\(false\);/.test(LIST));
  ok('⚠️ a reader\'s click pins; an automatic default does not',
    /if \(!opts\?\.auto\) setTickerPinned\(!!t\);/.test(LIST));
  ok('⚠️ the rail\'s default declares itself automatic',
    /onSelectTicker\?\.\(list\[0\]\.ticker, \{ auto: true \}\)/.test(CHART));
  ok('…and the chart is still handed the selected ticker, defaulted or chosen',
    /<CongressChartSection ticker=\{selectedTicker\} onSelectTicker=\{selectTicker\} \/>/.test(LIST));
  ok('⚠️ the transactions table filters on the PINNED ticker only',
    /ticker=\{tickerPinned \? selectedTicker : null\}/.test(LIST));
  ok('both discovery surfaces route their clicks through the pinning handler',
    /<CongressOverview onSelectTicker=\{selectTicker\}/.test(LIST) && /onSelectTicker=\{selectTicker\}/.test(LIST));
}

L('⚠️ sort, chamber and party release the ticker');
{
  ok('a navigate() wrapper exists and clears the pin', /setTickerPinned\(false\); setter\(value\);/.test(LIST));
  for (const [label, re] of [
    ['SORT', /<PillGroup label="SORT"\s+options=\{SORTS\}\s+value=\{view\}\s+onChange=\{navigate\(setView\)\} \/>/],
    ['CHAMBER', /label="CHAMBER" options=\{CHAMBERS\} value=\{chamber\} onChange=\{navigate\(setChamber\)\}/],
    ['PARTY', /label="PARTY"\s+options=\{PARTIES\}\s+value=\{party\}\s+onChange=\{navigate\(setParty\)\}/],
  ]) ok(`⚠️ the ${label} control goes through navigate()`, re.test(LIST), String(re).slice(0, 60));
  // ⚠️ AND NOTHING SETS THE RAW SETTER DIRECTLY ANY MORE, which is how the bug would come back.
  ok('⚠️ no pill is wired straight to a bare setter', !/onChange=\{set(View|Chamber|Party)\}/.test(LIST));
  ok('the member grid still reloads on those controls', /\}, \[view, chamber, party, lbWindow\]\);/.test(LIST));
}

L('⚠️ ticker mode is visible, and still clearable the old way');
{
  ok('the filter is a removable chip carrying the ticker', /title=\{`Showing \$\{ticker\} only/.test(TX));
  ok('…with an explicit clear affordance in it', /aria-hidden style=\{\{ fontSize: 13/.test(TX));
  ok('…and a screen-reader label, since × alone says nothing', /Clear the \{ticker\} filter/.test(TX));
  ok('the count says what it is counting', /\$\{ticker \? ` in \$\{ticker\}` : ''\}/.test(TX));
  ok('⚠️ the heading stops pretending to be "All" while filtered',
    /\{ticker \? 'Transactions' : 'All Transactions'\}/.test(TX));
  ok('⚠️ the original "clear ticker" control is KEPT, as asked', /clear ticker/.test(TX));
  ok('clearing unpins rather than blanking the chart', /onClearTicker \? onClearTicker\(\) : onSelectTicker\?\.\(null\)/.test(TX));
  ok('…and the parent passes that handler', /onClearTicker=\{\(\) => setTickerPinned\(false\)\}/.test(LIST));
  // No banner, no extra vertical space: the chip lives in the existing header row.
  ok('the chip sits in the existing header row, not a new block',
    /display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'/.test(TX));
}

L('⚠️ replaying the reported sequence against the component\'s state model');
{
  // A faithful model of the three lines that matter. If the wiring assertions above hold, this is
  // what the component does.
  const mk = () => {
    const s = { selectedTicker: null, tickerPinned: false, view: 'most_active', chamber: '', party: '' };
    return {
      s,
      autoDefault: (t) => { if (!s.selectedTicker) { s.selectedTicker = t; } },          // { auto: true }
      clickTicker: (t) => { s.selectedTicker = t; s.tickerPinned = !!t; },
      navigate: (k, v) => { s.tickerPinned = false; s[k] = v; },
      clearTicker: () => { s.tickerPinned = false; },
      get chartTicker() { return s.selectedTicker; },
      get tableTicker() { return s.tickerPinned ? s.selectedTicker : null; },
    };
  };

  // 1 ── first load: the rail defaults, the table must NOT be filtered.
  let m = mk();
  m.autoDefault('NVDA');
  ok('on first load the chart has a ticker', m.chartTicker === 'NVDA');
  ok('⚠️ …and "All Transactions" really is all of them', m.tableTicker === null);

  // 2 ── the reader clicks AAPL: both follow.
  m.clickTicker('AAPL');
  ok('clicking AAPL moves the chart', m.chartTicker === 'AAPL');
  ok('…and filters the table', m.tableTicker === 'AAPL');

  // 3 ── the reported bug: a sort click must take effect.
  m.navigate('view', 'recent');
  ok('⚠️ Most Recent clears the ticker filter', m.tableTicker === null);
  ok('…and the sort actually changed', m.s.view === 'recent');
  ok('…while the chart keeps the name it was showing', m.chartTicker === 'AAPL');

  // 4 ── every one of the four sorts, and the chamber/party filters.
  for (const v of ['most_active', 'top_volume', 'recent', 'leaderboard']) {
    const x = mk(); x.autoDefault('NVDA'); x.clickTicker('AAPL'); x.navigate('view', v);
    ok(`⚠️ sort "${v}" releases the ticker`, x.tableTicker === null && x.s.view === v);
  }
  for (const [k, v] of [['chamber', 'house'], ['chamber', 'senate'], ['party', 'Democrat'], ['party', 'Republican']]) {
    const x = mk(); x.autoDefault('NVDA'); x.clickTicker('AAPL'); x.navigate(k, v);
    ok(`⚠️ ${k}="${v}" releases the ticker`, x.tableTicker === null && x.s[k] === v);
  }

  // 5 ── the manual control still works, and is not the only way out.
  m = mk(); m.autoDefault('NVDA'); m.clickTicker('AAPL'); m.clearTicker();
  ok('clear ticker still unpins', m.tableTicker === null);
  ok('⚠️ …and does NOT leave the chart empty', m.chartTicker === 'AAPL');

  // 6 ── re-pinning after navigating away works, so the mode is not one-shot.
  m.clickTicker('MSFT');
  ok('a ticker can be picked again afterwards', m.tableTicker === 'MSFT' && m.chartTicker === 'MSFT');

  // 7 ── clicking the SAME sort again while pinned still takes effect, which was the complaint.
  const y = mk(); y.autoDefault('NVDA'); y.navigate('view', 'recent'); y.clickTicker('AAPL');
  y.navigate('view', 'recent');
  ok('⚠️ re-clicking the active sort still releases the ticker', y.tableTicker === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
