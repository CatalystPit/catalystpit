// THE TERMINAL'S NEWS INSPECTOR — the same pattern as Evidence, and the same source as the badge.
//
// What can go wrong here that nobody sees until it is in front of a trader:
//
//   1. THE PANEL DISAGREES WITH THE BADGE THAT OPENED IT. The badge means "a fresh 8-K in the last
//      24 hours". A panel reading a different source could show nothing behind a badge that is lit,
//      or a story that has nothing to do with why the badge appeared.
//   2. ONE TICKER'S NEWS UNDER ANOTHER'S NAME. MSTR then NVDA two seconds apart.
//   3. A SECOND PANEL PER CLICK, or the row's existing chart action stolen by the badge.
//
// Run: node scripts/verify-terminal-news.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const bus = read('../src/lib/terminalNewsBus.js');
// ⚠️ THE PANEL IS NOW A PLACEMENT, NOT AN IMPLEMENTATION.
//
// NewsPanel used to hold the fetch, the merge, the race guards and the cache, and these
// assertions read it. All of that moved into the ONE shared body that the chart drawer, the
// Watchlist badge and this panel now all render — so the assertions follow the behaviour to
// where it lives rather than being deleted along with the file that used to hold it. What is
// asserted about NewsPanel itself is the one thing left to assert: that it delegates.
const panel = read('../src/components/terminal/TickerNews.jsx');
const placement = read('../src/components/terminal/NewsPanel.jsx');
const term = read('../src/app/terminal/TerminalClient.jsx');
const route = read('../src/app/api/eightk/route.js');
const lib = read('../src/lib/eightk.js');
const signals = read('../src/app/api/watchlist/signals/route.js');

L('⚠️ THE PANEL READS THE SAME SOURCE AS THE BADGE THAT OPENS IT');
{
  // The badge is "a fresh 8-K in the last 24h" from eightk_filings. A panel opened by that badge has
  // to be able to show the filing that caused it.
  ok('the badge is still driven by 8-K filings', /eightkFilings/.test(signals) && /24 hours/.test(signals));
  ok('⚠️ the panel reads the canonical 8-K route', /\/api\/eightk\?ticker=/.test(panel));
  ok('⚠️ …which is the same route the site-wide wire uses, not a new one',
    /recentEightK/.test(route) && (route.match(/export async function GET/g) || []).length === 1);
  ok('…and the same read, with a filter added', /const where = sym \? and\(eq\(eightkFilings\.ticker, sym\), base\) : base;/.test(lib));
  ok('⚠️ the wire\'s own behaviour is unchanged when no ticker is given',
    /const materialOnly = ticker \? sp\.get\('all'\) === '0' : sp\.get\('all'\) !== '1';/.test(route)
    && /const days = ticker \? [^:]+: 7;/.test(route));
  ok('a ticker is validated before it reaches the query', /TICKER_RE\.test\(ticker\)/.test(route));

  // ⚠️ NO SECOND INGESTION, NO SECOND CLASSIFIER.
  ok('⚠️ the panel ingests nothing', !/fetch\(['"`]https?:/.test(code(panel)));
  // ⚠️ A CALL, NOT A MENTION. The note explaining that classification happens elsewhere names the
  // function that does it — inside a JSX block comment, whose continuation lines a line-based
  // comment stripper cannot see. Requiring the call parenthesis tests what the panel DOES rather
  // than what it says about itself, which is what the assertion meant in the first place.
  ok('⚠️ …and classifies nothing — the labels arrived on the row',
    /\{n\.headline\}/.test(panel)
    && !/classifyItems\(|impactOf\(|scoreItems?\(/.test(panel));
  ok('…including whether a filing was material', /!n\.material/.test(panel));
  ok('the filing itself is linked, never our summary of it', /href=\{n\.url\}/.test(panel));
  ok('newest first is the order the canonical read returns', /desc\(eightkFilings\.filedAt\)/.test(lib));
}

L('⚠️ THE BADGE STILL MEANS WHAT IT MEANT');
{
  ok('the signals route is untouched apart from nothing at all',
    /interval '24 hours'/.test(signals) && /news: \[\.\.\.new Set\(news\)\]/.test(signals));
  // ⚠️ THE PANEL'S WINDOW IS WIDER THAN THE BADGE'S ON PURPOSE, AND SAYS SO. The badge asks "is
  // there something new today"; a trader who clicked it is asking what has been going on.
  ok('⚠️ the panel marks which items are fresh by the badge\'s own rule',
    /isFresh\(n\.at\)/.test(panel) && />NEW</.test(panel)
    && /export const FRESH_MS = 24 \* 60 \* 60 \* 1000;/.test(read('../src/lib/terminal/ticker-news.mjs')));
  // ⚠️ THE EMPTY STATE WIDENED WITH THE SOURCES. It said "no filings or press releases", which was
  // honest when those were the only paths and became too narrow once the wire was added — a reader
  // would not know a wire story naming the ticker had also been looked for and not found.
  ok('⚠️ an empty panel does not claim nothing happened',
    /Nothing attributed to \{sym\} in the recent window/.test(panel)
    && /no filing, press release or wire story naming it/.test(panel));
  ok('…and a failure does not claim it either', /not a statement that there is none/.test(panel));
  ok('nothing here invents a badge', !/setSig|sig\.news\.push/.test(panel));
}

L('⚠️ ONE PANEL, RE-POINTED — THE EVIDENCE PATTERN, FOLLOWED');
{
  ok('there is a dedicated news channel', /export function inspectNews/.test(bus) && /export function onNewsRequest/.test(bus));
  // ⚠️ NOT THE EVIDENCE CHANNEL. One channel carrying both would re-point the evidence inspector
  // every time a trader read some news.
  ok('⚠️ it is not the evidence channel', !/inspectEvidence|__cpEvidenceBus/.test(code(bus)));
  ok('⚠️ nor the symbol bus', !/selectTerminalSymbol/.test(code(bus)));
  ok('the Terminal subscribes to it', /onNewsRequest\(\(sym\) =>/.test(term));
  ok('…points the inspector at the ticker', /setNewsSym\(sym\)/.test(term));
  ok('…opens the panel and raises it', /addPanel\('tickernews'\)/.test(term) && /bringToFront\('tickernews'\)/.test(term));
  ok('⚠️ opening is idempotent, so a second click cannot add a second panel',
    /const addPanel = \(id\) => \{ if \(visibleRef\.current\.includes\(id\)\) return;/.test(term));
  ok('the panel is registered once', (term.match(/id: 'tickernews'/g) || []).length === 1);
  ok('…with a default position', /tickernews:\s*\{ x:/.test(term));
  // ⚠️ A SEPARATE PANEL FROM THE MARKET-WIDE WIRE. Two panels about news answering different
  // questions need two ids, or opening one would replace the other.
  ok('⚠️ it is not the market-wide news wire', /id: 'newswire'/.test(term) && /id: 'tickernews'/.test(term));
  ok('it carries its own symbol, so reading news never moves the chart',
    /<NewsPanel symbol={newsSym} \/>/.test(term) && !/selectedSymbol/.test(panel));
  ok('the chart still follows the workspace symbol', /<ChartBody symbol={selectedSymbol} \/>/.test(term));
}

L('⚠️ THE BADGE IS THE ACTION — THE ROW IS NOT');
{
  ok('the NEWS badge calls the inspector', /inspectNews\(r\.ticker\)/.test(term));
  // ⚠️ ONLY THE NEWS BADGE. HALT and PIT have nothing behind them to inspect, and making every
  // badge clickable would promise inspectors that do not exist.
  ok("⚠️ only the news badge is actionable", /const actionable = k === 'news';/.test(term));
  ok('…the others stay labels', /if \(!actionable\) return <span key=\{k\}/.test(term));
  // ⚠️ THE ROW'S OWN ACTION MUST SURVIVE. Clicking the ticker loads it in the chart; the badge sits
  // inside that row and would otherwise trigger both.
  ok('⚠️ the badge stops the click reaching the row', /e\.stopPropagation\(\); inspectNews/.test(term));
  ok('the ticker still loads in the chart', /onClick=\{\(\) => onPick && onPick\(r\.ticker\)\}/.test(term));
  ok('the row\'s ticker-page arrow is untouched', /title="Open ticker page"/.test(term));
  ok('the badge is reachable from a keyboard', /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'/.test(term));
  ok('⚠️ and it does not navigate', !/href=.*inspectNews/.test(term));
}

L('⚠️ NEVER ONE TICKER\'S NEWS UNDER ANOTHER\'S NAME');
{
  ok('⚠️ a superseded request cannot land', /gen !== reqRef\.current/.test(panel));
  ok('⚠️ and the payload is only painted when it names the ticker asked for',
    /const shown = data && data\.ticker === sym \? data : null;/.test(panel));
  ok('a cache miss clears rather than leaving the previous ticker on screen',
    /\} else \{ setData\(null\); setState\('loading'\); \}/.test(panel));
  ok('every request is on a clock', /setTimeout\(\(\) => ctl\.abort\(\), 20_000\)/.test(panel));
  ok('a failure with nothing behind it is stated, not left loading', /state === 'error'/.test(panel));
  ok('the company name comes from the filing, not from this panel',
    /pr\?\.companyName \|\| null/.test(panel));
}

L('THE CACHE IS BOUNDED, AND THE WATCHLIST IS NOT TOUCHED');
{
  ok('keyed by symbol', /cacheGet\(sym\)/.test(panel));
  ok('⚠️ bounded', /while \(cache\.size > MAX_CACHED\)/.test(panel));
  ok('…and expiring', /now - hit\.at > TTL_MS/.test(panel));
  ok('a read counts as a use', /cache\.delete\(sym\); cache\.set\(sym, hit\);/.test(panel));
  ok('⚠️ a cache hit still refreshes', !/if \(cached\) \{[\s\S]{0,200}return;/.test(panel));
  // ⚠️ THE WATCHLIST MUST NOT RELOAD. The inspector is a separate panel with a separate request;
  // opening it adds an id to `visible`, which leaves every other panel's element and key alone.
  ok('⚠️ panels are keyed by id, so opening one cannot remount another',
    /<div key={id} onPointerDownCapture/.test(term));
  ok('the news request is the panel\'s own, not the watchlist\'s',
    /\/api\/eightk\?ticker=/.test(panel) && !/\/api\/eightk/.test(term.split('function WatchlistBody')[1] || ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
