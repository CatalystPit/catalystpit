// A stored Catalyst canonical headline must never end mid-word, mid-number, mid-date or mid-phrase.
//
// THE BUG. canonicalHeadline() shortened anything over 140 characters with
//     s.slice(0, 140).replace(/\s+\S*$/, '') + '…'
// a character slice that knows nothing about where a sentence can stop. Live Pit Wire therefore
// carried "...(outside the liquidity agreement) from 7…" — the STORED headline was broken, not
// merely clipped by the UI. 81 stored headlines ended in an ellipsis, 18 of them HIGH or CRITICAL.
//
// Run: node scripts/verify-headline-complete.mjs

import { shortenHeadline, isCompletePhrase, canonicalHeadline, MAX_DISPLAY } from '../src/lib/news-normalize.mjs';
import { publicationVerdict, readsAsSentence } from '../src/lib/x-quality.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };

// The exact headline from the report.
const BUYBACK = 'Information regarding executed transactions within the framework of a share buyback programme (outside the liquidity agreement) from 7 September 2026 to 11 September 2026';

console.log('\n=== the reported headline ===');
const short = shortenHeadline(BUYBACK);
ok('is shortened to a complete sentence', isCompletePhrase(short), short);
ok('...within the display budget', short.length <= MAX_DISPLAY, `${short.length}`);
ok('...by dropping the parenthetical qualifier, not by slicing',
  short === 'Information regarding executed transactions within the framework of a share buyback programme from 7 September 2026 to 11 September 2026', short);
ok('...so it no longer ends "from 7"', !/\bfrom 7\s*…?$/.test(short));
ok('...and keeps BOTH dates, which are the fact', /7 September 2026/.test(short) && /11 September 2026/.test(short));
console.log(`  ${short}`);

console.log('\n=== nothing may end mid-thought ===');
const BROKEN = [
  'Company announces transactions in own shares from 7…',
  'Acme Corp to acquire Beta Industries for…',
  'Regulator opens consultation on the',
  'Bank raises guidance for the',
  'Issuer completes placement as part of',
  'Alerts investors to September 21',            // month + day, year lost
  'Buyback runs from 7',                         // range opener, one number
  'Firm closes round (Series C',                 // unbalanced bracket
  'Chief executive says "we are confident',      // unbalanced quote
  'Board approves dividend and',
  'Company files for',
];
for (const b of BROKEN) ok(`rejected: "${b.slice(0, 44)}"`, !isCompletePhrase(b));

console.log('\n=== complete headlines are untouched ===');
const GOOD = [
  'Apple beats Q3 estimates on iPhone strength',
  'Pfizer wins FDA approval for its RSV vaccine in adults aged 18 to 59',
  'Fed cuts rates by 25 basis points',
  'Saudi Arabia shuts East-West pipeline after drone attacks',
  'Brent crude reaches $108 after Saudi pipeline shutdown',
  'UWM Holdings Corporation (UWMC) Alert: October 13, 2026 Lead Plaintiff Deadline in Class Action Lawsuit',
  'Spot gold falls nearly 1% to $4,306.19 per ounce',
];
for (const g of GOOD) {
  ok(`accepted: "${g.slice(0, 40)}"`, isCompletePhrase(g));
  ok(`unchanged: "${g.slice(0, 28)}"`, shortenHeadline(g) === g);
}

console.log('\n=== long headlines that cannot be cut safely keep ALL their words ===');
const UNCUTTABLE = [
  'CCOI 1-WEEK DEADLINE ALERT: Cogent Communications Holdings, Inc. Investors Alerted to September 21, 2026 Lead Plaintiff Deadline in Securities Fraud Class Action',
  'REGN DEADLINE ALERT: Hagens Berman Alerts Regeneron Pharmaceuticals, Inc. Investors to Today\'s September 14, 2026 Lead Plaintiff Deadline in Securities Class Action',
];
for (const u of UNCUTTABLE) {
  const r = shortenHeadline(u);
  ok(`kept whole: "${u.slice(0, 34)}"`, r === u, `became ${r.length} chars`);
  ok('...and is complete', isCompletePhrase(r));
}
// When a clause boundary DOES yield a complete, substantial sentence, taking it beats keeping a
// 147-character line: the lead clause carries the event and the trailing clause is elaboration.
const PFIZER = 'Pfizer wins FDA approval for its RSV vaccine in adults aged 18 to 59, expanding the label beyond the previous 60-plus indication approved last year';
const pf = shortenHeadline(PFIZER);
ok('a trailing elaboration clause is dropped', pf === 'Pfizer wins FDA approval for its RSV vaccine in adults aged 18 to 59', pf);
ok('...leaving a complete sentence', isCompletePhrase(pf));
ok('...that still carries the actor, the action and the range', /Pfizer/.test(pf) && /approval/.test(pf) && /18 to 59/.test(pf));

ok('no shortening ever appends an ellipsis',
  [...GOOD, ...UNCUTTABLE, BUYBACK].every((h) => !/…$/.test(shortenHeadline(h))));
ok('canonicalHeadline never stores an ellipsis either',
  [...GOOD, ...UNCUTTABLE, BUYBACK].every((h) => !/…$/.test(canonicalHeadline(h, []))));

console.log('\n=== a cut must keep the event, not a scrap of it ===');
const longSubjectFirst = 'Nordic issuer publishes its regularly scheduled notification concerning the total number of voting rights and shares outstanding, as required under the Transparency Directive';
const cut = shortenHeadline(longSubjectFirst);
ok('a shortening keeps at least 45% of the original', cut.length >= longSubjectFirst.length * 0.45);
ok('...and is a complete sentence', isCompletePhrase(cut));

console.log('\n=== X fails closed on incomplete wording ===');
const now = Date.parse('2026-09-14T16:00:00Z');
const base = { published_at: '2026-09-14T15:30:00Z', tickers: ['ABC'], importance: 3 };
ok('a truncated headline is never publishable',
  publicationVerdict({ ...base, headline: 'Acme Corp agrees to acquire Beta Industries for…' }, now).publish === false);
ok('...with the fragmentary-wording reason',
  publicationVerdict({ ...base, headline: 'Acme Corp agrees to acquire Beta Industries for…' }, now).reason
    === 'incomplete or fragmentary wording');
ok('a dangling connector is never publishable',
  !readsAsSentence('Acme Corp agrees to acquire Beta Industries as part of'));
ok('an unfinished date is never publishable',
  !readsAsSentence('Acme Corp completes its buyback programme from 7'));
ok('a complete headline still publishes',
  publicationVerdict({ ...base, headline: 'Acme Corp agrees to acquire Beta Industries for $1.2 billion' }, now).reason
    !== 'incomplete or fragmentary wording');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
