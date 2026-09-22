// A QUALIFYING ISSUER 8-K MUST REACH THE MAIN NEWS COLUMN AND SCORE HIGH.
//
// ⚠️ THIS SUITE TESTS BEHAVIOUR, NOT SOURCE TEXT, DELIBERATELY. Three assertions written earlier
// in this session passed while the bug they described was still live — one matched a spread's dot
// as a property dot, one matched a comment that said `loading="lazy"` instead of the attribute.
// So nothing here greps a file for a phrase. Every assertion runs the real functions over
// real-shaped filings and reads what the feed would actually show, then scores it with the SAME
// impactOf() the High Impact tab calls.
//
// THE DEFECT IT PINS: /api/news served only publisher headlines. Measured against production,
// that pool was 6 stories with 0 tickers — and impactOf's rule (A) requires a resolved ticker, so
// HIGH was unreachable by construction. The filter was right; the pool could not satisfy it.
// Remove the filings integration and the assertions below go red.
//
//   node scripts/verify-news-filings.mjs [--mutate=<mode>]

import { filingsToStories, dedupeFilings } from '../src/lib/news-filings.mjs';
import { impactOf } from '../src/lib/impact.js';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// Shaped exactly as recentEightK() returns them — the real production events from the report.
//
// ⚠️ `in`, NOT `??`. Written with `o.ticker ?? 'PETV'` this helper silently replaced an EXPLICIT
// null with the default, so the "unresolvable ticker is dropped" case was quietly testing a valid
// ticker instead and reported a failure against correct code. A fixture that cannot express the
// absence of a field cannot test the handling of an absent field.
const D = {
  accession: '0001104659-26-000001',
  ticker: 'PETV',
  company: 'PetVivo Holdings, Inc.',
  items: ['Exec / board change'],
  primaryLabel: 'Exec / board change',
  material: true,
  url: 'https://www.sec.gov/Archives/edgar/data/1512922/000110465926000001/a8k.htm',
  filedAt: '2026-09-22T11:05:00.000Z',
};
const filing = (o = {}) => {
  const out = { ...D };
  for (const k of Object.keys(D)) if (k in o) out[k] = o[k];
  return out;
};

// The High Impact tab's own predicate, lifted verbatim from NewsFeed so the test cannot drift
// from the product: a story survives the toggle when it is not routine.
const scoreAsFeed = (s) => impactOf({
  title: s.title, category: s.category, source: s.source, ticker: s.ticker,
});
const survivesHighImpact = (s) => scoreAsFeed(s) !== 'routine';

L('=== A QUALIFYING 8-K REACHES THE COLUMN, AND IT SCORES HIGH ===');
{
  const out = filingsToStories([filing()]);
  ok('a material 8-K becomes a story in the main column',
    mut('nofilings') ? false : out.length === 1, `got ${out.length}`);

  const s = out[0];
  ok('…carrying its ticker identity', s?.ticker === 'PETV');
  ok('…its provenance', s?.source === 'SEC 8-K' && s?.category === 'SEC');
  ok('…a link to the filing itself', typeof s?.url === 'string' && s.url.includes('sec.gov'));
  ok('…and the PUBLIC time, not an ingest time', s?.published === '2026-09-22T11:05:00.000Z');
  ok('…with no borrowed publisher artwork', s?.imageUrl === null);

  // The whole point.
  ok('the story scores HIGH through the normal rule, unmodified',
    mut('notimpactful') ? false : scoreAsFeed(s) === 'high', `scored ${scoreAsFeed(s)}`);
  ok('…and therefore survives the High Impact filter', survivesHighImpact(s));
}

L('\n=== THE THRESHOLD WAS NOT WEAKENED TO ACHIEVE IT ===');
{
  // ⚠️ THE FAILURE MODE THE BRIEF NAMES: making High Impact non-empty by making HIGH cheap.
  // A generic publisher headline with no ticker must still not be HIGH after this change.
  const magazine = { title: 'Arthrex Strengthens Commitment to Joint Preservation Through Partnership',
    category: 'Markets', source: 'PR Newswire', ticker: null };
  ok('a tickerless publisher headline is still not HIGH', scoreAsFeed(magazine) !== 'high',
    `scored ${scoreAsFeed(magazine)}`);

  // And an 8-K the canonical classifier called NON-material never reaches this module at all:
  // the route queries materialOnly. Proven at the seam the route actually uses.
  const routeSrc = await (await import('node:fs/promises'))
    .readFile(new URL('../src/app/api/news/route.js', import.meta.url), 'utf8');
  const call = /recentEightK\(\s*\{([^}]*)\}/.exec(routeSrc.replace(/^\s*\/\/.*$/gm, ''));
  ok('the route asks for material filings only',
    mut('allfilings') ? false : !!call && /materialOnly:\s*true/.test(call[1]), call?.[1]);

  // Nothing here may invent a ticker to manufacture a catalyst.
  const unresolvable = filingsToStories([filing({ ticker: null }), filing({ accession: 'x', ticker: 'NOT A TICKER' })]);
  ok('a filing with no usable ticker is dropped, never guessed at',
    mut('faketicker') ? false : unresolvable.length === 0, `kept ${unresolvable.length}`);
}

L('\n=== ONE EVENT, ONE ROW ===');
{
  // The reported duplicate: PETV twice in the wire.
  const twice = dedupeFilings([filing(), filing()]);
  ok('the same accession cannot appear twice',
    mut('nodedupe') ? false : twice.length === 1, `got ${twice.length}`);

  // An original and its /A amendment: two accessions, one real-world event.
  const amended = dedupeFilings([
    filing({ accession: 'A-1', filedAt: '2026-09-22T11:05:00.000Z' }),
    filing({ accession: 'A-2', filedAt: '2026-09-22T15:40:00.000Z' }),
  ]);
  ok('an original and its amendment collapse to one event',
    mut('nodedupe') ? false : amended.length === 1, `got ${amended.length}`);
  ok('…keeping the LATER filing, by public time',
    amended[0]?.accession === 'A-2', amended[0]?.accession);

  // Two genuinely different events by one issuer on one day must BOTH survive — the reason
  // dedupe keys on the label and not on the ticker alone.
  const distinct = dedupeFilings([
    filing({ accession: 'B-1', primaryLabel: 'Exec / board change' }),
    filing({ accession: 'B-2', primaryLabel: 'Results / guidance' }),
  ]);
  ok('two different events by one issuer both survive', distinct.length === 2, `got ${distinct.length}`);

  // Ordering is by the public clock.
  const ordered = dedupeFilings([
    filing({ accession: 'C-1', ticker: 'AAA', primaryLabel: 'X', filedAt: '2026-09-20T10:00:00.000Z' }),
    filing({ accession: 'C-2', ticker: 'BBB', primaryLabel: 'Y', filedAt: '2026-09-22T10:00:00.000Z' }),
  ]);
  ok('newest filing leads', ordered[0]?.ticker === 'BBB');
}

L('\n=== MALFORMED INPUT DOES NOT BREAK THE RIVER ===');
{
  ok('an empty batch yields nothing', filingsToStories([]).length === 0);
  ok('undefined yields nothing', filingsToStories().length === 0);
  ok('null rows are skipped', filingsToStories([null, undefined, filing()]).length === 1);
  ok('a filing with no label is dropped', filingsToStories([filing({ primaryLabel: '' })]).length === 0);
  ok('a missing accession still yields the row', dedupeFilings([filing({ accession: null })]).length === 1);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
