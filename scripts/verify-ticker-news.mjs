// TICKER NEWS — one implementation, three surfaces, and three canonical paths merged into one list.
//
// What can go wrong, in order of how badly:
//
//   1. THE SAME DISCLOSURE SHOWN THREE TIMES. One 8-K produces a filing row, a catalyst event AND a
//      press release. Concatenating them makes a quiet day look busy and a busy one unreadable.
//   2. TWO DIFFERENT FILINGS MERGED INTO ONE. The opposite mistake, and the silent one — matching on
//      date or headline would fold two genuinely different disclosures into a single row.
//   3. THREE SURFACES DRIFTING. Chart, Watchlist and panel answering "what is this ticker's news"
//      differently is how a product ends up with three answers.
//
// Run: node scripts/verify-ticker-news.mjs

import { readFileSync } from 'node:fs';
import {
  mergeTickerNews, fromEightK, fromEvidence, fromPressReleases, fromWire, headlineKey,
  accessionOf, isFresh, FRESH_MS, SOURCE,
} from '../src/lib/terminal/ticker-news.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ACC = '0001193125-26-401636';
const EK = [{ accession: ACC, ticker: 'MSTR', company: 'Strategy Inc', items: ['Other event', 'Reg FD'],
  primaryLabel: 'Other event', material: false, url: 'https://sec.gov/a', filedAt: '2026-09-25T12:03:17.000Z' }];
const EV = [{ evidenceId: `MSTR|CATALYST|SEC_8K_OTHER|${ACC}`, ticker: 'MSTR', family: 'catalyst',
  type: 'sec_8k_other', subtype: '8.01', materiality: 0.45, publicTime: '2026-09-25T12:03:17.000Z',
  eventTime: '2026-09-24T00:00:00.000Z' }];
const PR = [{ filingDate: '2026-09-25', items: ['2.02', '7.01'], headline: 'Strategy Announces Q2 Results',
  excerpt: 'Currently holds 843,770 bitcoin…', url: `https://sec.gov/Archives/${ACC}.htm` }];

L('⚠️ ONE DISCLOSURE IS ONE ROW');
{
  const merged = mergeTickerNews({ eightk: EK, evidence: EV, pressReleases: PR, ticker: 'MSTR', company: 'Strategy Inc' });
  ok('⚠️ three records of one filing collapse to one row', merged.length === 1, `got ${merged.length}`);
  ok('⚠️ …and the row keeps the description that has the words in it',
    merged[0].headline === 'Strategy Announces Q2 Results');
  ok('…which is the press release', merged[0].source === SOURCE.PRESS);
  ok('⚠️ the row says which other paths carried it, rather than implying one source',
    (merged[0].alsoFrom || []).includes(SOURCE.FILING) && (merged[0].alsoFrom || []).includes(SOURCE.EVIDENCE));
  ok('a url survives the merge', !!merged[0].url);
  ok('the company name survives it too', merged[0].company === 'Strategy Inc');

  // ⚠️ THE ACCESSION IS WHAT JOINS THEM, and two of the three bury it.
  ok('an accession is read out of an evidence compound id', accessionOf(EV[0]) === ACC.replace(/-/g, ''));
  ok('…and out of a filing url', accessionOf(PR[0]) === ACC.replace(/-/g, ''));
  ok('…and off a filing row directly', accessionOf(EK[0]) === ACC.replace(/-/g, ''));
  ok('a record with no accession anywhere reports none', accessionOf({ ticker: 'X' }) === null);
}

L('⚠️ TWO DIFFERENT FILINGS ARE NEVER ONE ROW');
{
  // Same issuer, same day, two genuinely different 8-Ks. This is the merge mistake that is silent.
  const two = mergeTickerNews({
    eightk: [
      { accession: '0001193125-26-400001', ticker: 'AAA', primaryLabel: 'Results of operations', filedAt: '2026-09-25T10:00:00Z' },
      { accession: '0001193125-26-400002', ticker: 'AAA', primaryLabel: 'Departure of directors', filedAt: '2026-09-25T15:00:00Z' },
    ],
    ticker: 'AAA',
  });
  ok('⚠️ two filings by one issuer on one day stay two rows', two.length === 2);
  ok('…newest first', two[0].headline === 'Departure of directors');

  // And a record with no accession must not be folded into one that has a different one.
  const mixed = mergeTickerNews({
    eightk: [{ accession: ACC, ticker: 'AAA', primaryLabel: 'Other event', filedAt: '2026-09-25T10:00:00Z' }],
    pressReleases: [{ filingDate: '2026-09-25', headline: 'Unrelated release', url: null }],
    ticker: 'AAA',
  });
  ok('⚠️ an accession-less record is not merged into one with an accession', mixed.length === 2);
}

L('⚠️ TIME DECIDES THE ORDER; RICHNESS ONLY DECIDES THE WORDS');
{
  const out = mergeTickerNews({
    eightk: [{ accession: 'AAAAAAAAAA26000009', ticker: 'BBB', primaryLabel: 'Fresh filing', filedAt: '2026-09-25T12:00:00Z' }],
    pressReleases: [{ filingDate: '2024-01-02', headline: 'Old but wordy release', url: null }],
    ticker: 'BBB',
  });
  ok('⚠️ an old press release does not outrank this morning\'s filing', out[0].headline === 'Fresh filing');
  ok('…and the old one is still there, below it', out.length === 2 && out[1].headline === 'Old but wordy release');
}

L('⚠️ NEWS IS DISCLOSURE, NOT RESEARCH');
{
  // The evidence payload carries insider, institution and congress families too. A news panel
  // listing a Form 4 as "news" would be a second, worse Evidence inspector.
  const mixedFamilies = fromEvidence([
    { evidenceId: 'X|CATALYST|A|0001111111-26-000001', family: 'catalyst', ticker: 'X', type: 'sec_8k_other', publicTime: '2026-09-25T00:00:00Z' },
    { evidenceId: 'X|INSIDER|B|0001111111-26-000002', family: 'insider', ticker: 'X', type: 'form4', publicTime: '2026-09-25T00:00:00Z' },
    { evidenceId: 'X|CONGRESS|C|0001111111-26-000003', family: 'congress', ticker: 'X', type: 'ptr', publicTime: '2026-09-25T00:00:00Z' },
  ]);
  ok('⚠️ only catalyst events become news', mixedFamilies.length === 1);
  ok('…and it is the catalyst', /8-K|sec/i.test(mixedFamilies[0].headline));

  // ⚠️ publicTime, NOT eventTime. When the market could first have known is what makes it news.
  const t = fromEvidence([{ evidenceId: 'X|CATALYST|A|0001111111-26-000004', family: 'catalyst', ticker: 'X',
    type: 'sec_8k_other', eventTime: '2026-09-01T00:00:00Z', publicTime: '2026-09-25T00:00:00Z' }]);
  ok('⚠️ an event is dated from when it became public', t[0].at === Date.parse('2026-09-25T00:00:00Z'));
}

L('EACH PATH IS CARRIED THROUGH, NOT REINTERPRETED');
{
  const e = fromEightK(EK)[0];
  ok('a filing keeps the label the canonical classifier gave it', e.headline === 'Other event');
  ok('…and its material flag', e.material === false);
  ok('…and its remaining items as detail', e.detail === 'Reg FD');
  const p = fromPressReleases(PR, 'MSTR', 'Strategy Inc')[0];
  ok('a press release keeps its own headline', p.headline === 'Strategy Announces Q2 Results');
  ok('…and an excerpt, bounded', p.detail.length <= 220);
  ok('an undated record is dropped rather than shown with no time',
    fromEightK([{ accession: 'z', ticker: 'Q', filedAt: 'not a date' }]).length === 0);
  ok('nothing here scores or ranks',
    !/impactOf|materialityOf|rankBy|score\(/.test(read('../src/lib/terminal/ticker-news.mjs')));
}

L('THE BADGE AND THE PANEL AGREE ON WHAT "NEW" MEANS');
{
  ok('fresh is the badge\'s own 24 hours', FRESH_MS === 24 * 60 * 60 * 1000);
  const now = Date.parse('2026-09-25T12:00:00Z');
  ok('an item from this morning is new', isFresh(Date.parse('2026-09-25T08:00:00Z'), now));
  ok('one from two days ago is not', !isFresh(Date.parse('2026-09-23T08:00:00Z'), now));
  ok('an undated item is never new', !isFresh(NaN, now));
}

L('⚠️ THREE SURFACES, ONE IMPLEMENTATION');
{
  const shared = read('../src/components/terminal/TickerNews.jsx');
  const panel = read('../src/components/terminal/NewsPanel.jsx');
  const chart = read('../src/components/chart/CPChart.jsx');
  const term = read('../src/app/terminal/TerminalClient.jsx');

  ok('the shared body exists', /export default function TickerNewsBody/.test(shared));
  ok('⚠️ the standalone panel is a placement, not an implementation',
    /<TickerNewsBody symbol={symbol} \/>/.test(panel) && panel.split('\n').length < 20);
  ok('⚠️ …and it fetches nothing of its own', !/fetch\(/.test(panel));
  ok('the chart drawer renders the same body', /<TickerNewsBody symbol={sym} compact/.test(chart));
  ok('⚠️ …and fetches nothing of its own either', !/api\/eightk|api\/press-releases/.test(chart));
  ok('the Watchlist badge reaches it through the same panel',
    /inspectNews\(r\.ticker\)/.test(term) && /<NewsPanel symbol={newsSym} \/>/.test(term));
  ok('⚠️ the panel is still available from + Add panel', /id: 'tickernews'/.test(term));
  // ⚠️ THE ONLY DIFFERENCE BETWEEN THE SURFACES IS HOW MUCH ROOM THEY HAVE.
  ok('the surfaces differ by one prop', /compact = false/.test(shared));

  // ⚠️ NOT ONLY 8-K. The first version read one path and could only ever show which SEC item was
  // filed under, never what the filing said.
  ok('⚠️ all three canonical per-ticker paths are read',
    /api\/eightk\?ticker=/.test(shared) && /api\/evidence\?ticker=/.test(shared) && /api\/press-releases\?ticker=/.test(shared));
  // ⚠️ AND THE FOURTH, WHICH IS THE ONE THAT MAKES IT NEWS. The other three are all SEC-derived;
  // the wire carries stories ABOUT the company, and a control labelled News that could not show one
  // was mislabelled.
  ok('⚠️ …and the wire, which carries the actual stories',
    /\/api\/wire\?ticker=/.test(shared));
  ok('a failure of any ONE path still renders the rest',
    /if \(!ek && !evi && !pr && !wr\)/.test(shared));

  ok('…in parallel', /await Promise\.all\(\[/.test(shared));
  ok('⚠️ and one path failing does not blank the panel',
    /if \(!ek && !evi && !pr && !wr\)/.test(shared));
}

L('⚠️ OPENING NEWS DOES NOT DISTURB THE CHART');
{
  const chart = read('../src/components/chart/CPChart.jsx');
  // ⚠️ THE DRAWER IS A SIBLING OF THE CANVAS, NOT A REPLACEMENT FOR IT. If it swapped out the chart
  // host, closing it would rebuild the Lightweight Charts instance — losing zoom, drawings,
  // indicators and interval, and refetching the candles.
  ok('⚠️ the chart host is not conditional on the drawer',
    /<div ref={hostRef} style={{ position: 'absolute', inset: 0 }} \/>/.test(chart)
    && !/newsOpen \? null : <div ref={hostRef}/.test(chart));
  ok('the drawer is an absolutely positioned overlay', /position: 'absolute', right: 0, top: 0, bottom: 0, zIndex: 7/.test(chart));
  ok('⚠️ it does not appear in the bar-loading dependencies, so it cannot trigger a refetch',
    /\}, \[sym, tf, extended, draw, onSymbolResolved\]\);/.test(chart));
  ok('⚠️ clicks in the drawer are not chart clicks',
    /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}[\s\S]{0,200}TickerNewsBody/.test(chart));
  ok('it inspects the chart\'s own symbol', /<TickerNewsBody symbol={sym}/.test(chart));
  ok('the toolbar action is a toggle, so closing returns to the full chart', /setNewsOpen\(\(v\) => !v\)/.test(chart));
  ok('…and the drawer closes itself too', /onClose={\(\) => setNewsOpen\(false\)}/.test(chart));
  ok('the action sits with the other chart-level questions', /title="News for this ticker"/.test(chart));
  ok('…and is dropped from the row, not wrapped, on a narrow toolbar', /\{!overflowed && \(\s*<ToolButton theme=\{theme\} width=\{narrow \? 30 : 72\}/.test(chart));

  // ⚠️ RESIZING MAY MOVE AN ACTION; IT MAY NOT REMOVE ONE. Below the overflow threshold the News
  // button stops rendering, which took a capability away rather than relocating it. Indicators and
  // the evidence rows were already in the overflow menu; News now is too.
  ok('⚠️ every toolbar action survives a narrow panel — News is in the overflow menu',
    /<MenuItem theme=\{theme\} role="menuitemcheckbox" left="▤"[\s\S]{0,200}>News<\/MenuItem>/.test(chart));
  ok('…as is Indicators', /right=\{active\.length \? String\(active\.length\) : undefined\}>Indicators</.test(chart));
  ok('…and the evidence rows, which are the SAME rows the wide toolbar renders',
    (chart.match(/evidenceMenuItems\(\{ theme, vis: evidenceVis, onChange: setEvidenceVis \}\)/g) || []).length === 2);
  // ⚠️ THE SAME ACTION, NOT A SECOND ONE.
  ok('⚠️ the overflow News opens the same drawer', (chart.match(/setNewsOpen\(\(v\) => !v\)/g) || []).length === 2);
  ok('…and there is exactly one drawer to open', (chart.match(/<TickerNewsBody symbol=\{sym\} compact/g) || []).length === 1);
  // Not shown twice at any one width: the row button renders only when NOT overflowed, the menu
  // item only when it is.
  ok('⚠️ no action is offered twice at the same width',
    /\{overflowed\s*\n?[\s\S]{0,400}\? \(/.test(chart) && /\{!overflowed && \(/.test(chart));
}

L('⚠️ NEVER ONE TICKER\'S NEWS UNDER ANOTHER\'S NAME');
{
  const shared = read('../src/components/terminal/TickerNews.jsx');
  ok('⚠️ a superseded request cannot land', /gen !== reqRef\.current/.test(shared));
  ok('⚠️ and the payload is only painted when it names the ticker asked for',
    /const shown = data && data\.ticker === sym \? data : null;/.test(shared));
  ok('a cache miss clears rather than leaving the previous ticker on screen',
    /\} else \{ setData\(null\); setState\('loading'\); \}/.test(shared));
  ok('every request is on a clock', /setTimeout\(\(\) => ctl\.abort\(\), 20_000\)/.test(shared));
  ok('…and the clock is cleared when the ticker changes', /clearTimeout\(timer\); ctl\.abort\(\);/.test(shared));
  ok('the cache is bounded', /while \(cache\.size > MAX_CACHED\)/.test(shared));
  ok('…and expiring', /now - hit\.at > TTL_MS/.test(shared));
  ok('a read counts as a use', /cache\.delete\(sym\); cache\.set\(sym, hit\);/.test(shared));
  // ⚠️ THE EMPTY STATE HAD TO WIDEN WITH THE SOURCES. It used to say "no filings or press
  // releases", which was honest when those were the only two paths and became too narrow the
  // moment the wire was added — a reader would not know a wire story had also been looked for.
  ok('an empty result does not claim nothing happened',
    /Nothing attributed to {sym} in the recent window/.test(shared)
    && /no filing, press release or wire story naming it/.test(shared));
}


L('⚠️ THE WIRE IS WHAT MAKES THIS NEWS, AND ITS ATTRIBUTION IS THE SOURCE\'S');
{
  const WIRE = [
    { seq: '1', headline: 'Apple HomePod mini 2 to come in new variants: report', published_at: '2026-09-25T15:26:14Z', tickers: ['AAPL'], importance: 0, wireCategory: 'MARKETS' },
    { seq: '2', headline: 'Broad market drifts lower into the close', published_at: '2026-09-25T20:00:00Z', tickers: [], importance: 1 },
    { seq: '3', headline: 'QCOM and AAPL settle', published_at: '2026-09-25T12:00:00Z', tickers: ['QCOM', 'AAPL'], importance: 3, source_count: 6 },
  ];
  const got = fromWire(WIRE, 'AAPL');
  ok('⚠️ only items whose STATED tickers include this one', got.length === 2);
  ok('⚠️ a story naming no ticker is never attributed to one',
    !got.some((x) => /Broad market/.test(x.headline)));
  ok('a story naming several tickers counts for each of them',
    got.some((x) => /QCOM and AAPL/.test(x.headline)));
  ok('the wire\'s own importance decides material, not a re-reading of the headline',
    got.find((x) => x.seq !== undefined || true) && got.some((x) => x.material === true) && got.some((x) => x.material === false));
  ok('⚠️ a story carried by several outlets says so rather than appearing several times',
    got.find((x) => /QCOM/.test(x.headline)).sources === 6);
  ok('an undated wire item is dropped rather than shown with no time',
    fromWire([{ seq: '9', headline: 'x', tickers: ['AAPL'], published_at: 'nope' }], 'AAPL').length === 0);
  ok('nothing here infers a ticker', !/includes\(sym\) \|\| /.test(readFileSync(new URL('../src/lib/terminal/ticker-news.mjs', import.meta.url), 'utf8')));
}

L('⚠️ ONE EVENT IS ONE ROW, EVEN WITHOUT A FILING ID');
{
  // A press release and the wire item echoing its headline have no accession in common.
  const merged = mergeTickerNews({
    pressReleases: [{ filingDate: '2026-09-25', headline: 'Apple Announces Record Quarter', url: null }],
    wire: [{ seq: '1', headline: 'Apple announces record quarter', published_at: '2026-09-25T13:00:00Z', tickers: ['AAPL'], importance: 2 }],
    ticker: 'AAPL',
  });
  ok('⚠️ the echoed headline collapses into one row', merged.length === 1);
  ok('…keeping the richer record', merged[0].source === SOURCE.PRESS);
  ok('…and naming the other path it came from', (merged[0].alsoFrom || []).includes(SOURCE.WIRE));

  // ⚠️ A WIRE HEADLINE BEATS A FILING LABEL. "Company reports record quarterly revenue" and
  // "Results of operations" are the same event; the first is the one a trader can read, and a
  // ranking that preferred the filing would put the drawer back where it started.
  //
  // ⚠️ THEY MUST ACTUALLY MERGE FOR THIS TO TEST ANYTHING. A first version gave the two records
  // nothing in common — no shared accession, no shared headline — so they correctly stayed two rows
  // and the assertion passed whichever won. They share the accession here, which is the join that
  // makes the precedence question arise at all.
  const ACC2 = '0001193125-26-400777';
  const vsFiling = mergeTickerNews({
    eightk: [{ accession: ACC2, ticker: 'AAA', primaryLabel: 'Results of operations', filedAt: '2026-09-25T13:00:00Z' }],
    wire: [{ seq: '1', headline: 'Company reports record quarterly revenue on strong demand',
      published_at: '2026-09-25T13:00:00Z', tickers: ['AAA'], url: `https://sec.gov/Archives/${ACC2}.htm` }],
    ticker: 'AAA',
  });
  ok('the two records of one event are joined by the accession', vsFiling.length === 1, `got ${vsFiling.length}`);
  ok('⚠️ a readable wire headline outranks a filing label for the same event',
    vsFiling[0].source === SOURCE.WIRE && /record quarterly revenue/.test(vsFiling[0].headline));
  ok('…and the filing is still named as a path it came from',
    (vsFiling[0].alsoFrom || []).includes(SOURCE.FILING));

  // The same question against the evidence engine's label.
  const vsEvidence = mergeTickerNews({
    evidence: [{ evidenceId: `AAA|CATALYST|SEC_8K_OTHER|${ACC2}`, ticker: 'AAA', family: 'catalyst',
      type: 'sec_8k_other', publicTime: '2026-09-25T13:00:00Z' }],
    wire: [{ seq: '1', headline: 'Company reports record quarterly revenue on strong demand',
      published_at: '2026-09-25T13:00:00Z', tickers: ['AAA'], url: `https://sec.gov/Archives/${ACC2}.htm` }],
    ticker: 'AAA',
  });
  ok('⚠️ …and outranks the evidence label too',
    vsEvidence.length === 1 && vsEvidence[0].source === SOURCE.WIRE);
  // But a press release — the issuer's own words — still beats the wire's paraphrase of them.
  const vsPress = mergeTickerNews({
    pressReleases: [{ filingDate: '2026-09-25', headline: 'Issuer Announces Record Quarter', url: `https://sec.gov/Archives/${ACC2}.htm` }],
    wire: [{ seq: '1', headline: 'Company reports record quarterly revenue on strong demand',
      published_at: '2026-09-25T13:00:00Z', tickers: ['AAA'], url: `https://sec.gov/Archives/${ACC2}.htm` }],
    ticker: 'AAA',
  });
  ok('the issuer own words still outrank a report of them',
    vsPress.length === 1 && vsPress[0].source === SOURCE.PRESS);

  // ⚠️ AND IT CANNOT MERGE TWO DIFFERENT STORIES ON ONE DAY.
  const two = mergeTickerNews({
    wire: [
      { seq: '1', headline: 'Apple announces record quarter for services revenue', published_at: '2026-09-25T13:00:00Z', tickers: ['AAPL'] },
      { seq: '2', headline: 'Apple names a new chief financial officer effective January', published_at: '2026-09-25T18:00:00Z', tickers: ['AAPL'] },
    ],
    ticker: 'AAPL',
  });
  ok('⚠️ two different stories on one day stay two rows', two.length === 2);
  ok('…newest first', /chief financial officer/.test(two[0].headline));

  // A short headline is not a reliable key, so it is never used as one.
  ok('⚠️ a very short headline is not treated as a story key', headlineKey('Halted', Date.now()) === null);
  ok('a real headline produces a day-scoped key', /^h:\d{4}-\d{2}-\d{2}:/.test(headlineKey('Apple announces record quarter for services', Date.parse('2026-09-25T13:00:00Z'))));
  // ⚠️ THE ACCESSION STILL WINS. Two filings on one day have different accessions and different
  // headlines; the id pass runs first so a headline coincidence cannot override it.
  ok('the accession pass runs before the headline pass',
    readFileSync(new URL('../src/lib/terminal/ticker-news.mjs', import.meta.url), 'utf8')
      .indexOf('const byKey = new Map();') < readFileSync(new URL('../src/lib/terminal/ticker-news.mjs', import.meta.url), 'utf8').indexOf('const byStory = new Map();'));
}

L('⚠️ THE NEWS DRAWER TAKES ROOM FROM THE CHART, IT DOES NOT COVER IT');
{
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  // ⚠️ THE DEFECT: as an overlay it sat on the right-hand side, which is where the newest candles
  // and the current price label are — so opening News hid the one thing it is opened to react to.
  ok('⚠️ the chart box gives up its right edge while the drawer is open',
    /right: newsOpen \? NEWS_DRAWER_W : 0/.test(chart));
  ok('…by the same width the drawer occupies', /width: NEWS_DRAWER_W,/.test(chart)
    && (chart.match(/const NEWS_DRAWER_W = \d+;/g) || []).length === 1);
  ok('⚠️ the drawing canvas shrinks with it, so drawings stay in register',
    /right: newsOpen \? NEWS_DRAWER_W : 0[\s\S]{0,400}<div ref={hostRef}[\s\S]{0,1200}<DrawingLayer/.test(chart));
  ok('⚠️ and opening it still cannot refetch candles',
    /\}, \[sym, tf, extended, draw, onSymbolResolved\]\);/.test(chart));
  ok('the chart is never conditionally unmounted by the drawer',
    !/newsOpen \? null : <div ref={hostRef}/.test(chart));
}

L('⚠️ AN EVIDENCE MARKER EXPLAINS ITSELF');
{
  const chart = readFileSync(new URL('../src/components/chart/CPChart.jsx', import.meta.url), 'utf8');
  // ⚠️ THE CARD ALWAYS EXISTED AND WAS CLICK-ONLY. A marker you have to guess is clickable is a
  // marker that explains nothing to the reader who hovered it and got silence.
  ok('⚠️ hovering a bar that carries evidence shows the card',
    /setMarkerHover\(hits\.length \? \{ items: hits/.test(chart));
  ok('⚠️ …and only where there is evidence, so it cannot flicker over a dense chart',
    /const hits = evidenceAtBar\(markerMapRef\.current, param\.time\);/.test(chart));
  ok('⚠️ a click pins it, so the pointer can reach a source link',
    /if \(pinnedRef\.current\)/.test(chart) && /setMarkerHover\(null\);\s*\n\s*setMarkerDetail\(\{ items/.test(chart));
  ok('the card renders either one', /detail={markerDetail \|\| markerHover}/.test(chart));
  ok('dismissing clears both', /onClose={\(\) => \{ setMarkerDetail\(null\); setMarkerHover\(null\); \}}/.test(chart));
  // ⚠️ NO SECOND INTERPRETATION. The card is the existing one, printing the canonical object.
  ok('⚠️ it is the existing EvidenceCard, not a new tooltip', /<EvidenceCard/.test(chart));
  ok('…fed from the same canonical marker map', /evidenceAtBar\(markerMapRef\.current/.test(chart));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
