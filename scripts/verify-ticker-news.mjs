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
  mergeTickerNews, fromEightK, fromEvidence, fromPressReleases, accessionOf, isFresh, FRESH_MS, SOURCE,
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
  ok('…in parallel', /await Promise\.all\(\[/.test(shared));
  ok('⚠️ and one path failing does not blank the panel',
    /if \(!ek && !evi && !pr\)/.test(shared));
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
  ok('…and is dropped, not wrapped, on a narrow toolbar', /\{!overflowed && \(\s*<ToolButton theme=\{theme\} width=\{narrow \? 30 : 72\}/.test(chart));
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
  ok('an empty result does not claim nothing happened', /not filed/.test(shared));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
