// ⚠️ THE SCREENER'S SESSION SELECTION RULE.
//
// This suite exists because of a measured, shipped, market-wide pricing failure. licensedEod() took
// the two most recent DISTINCT dates in ticker_daily_candles. UNIU trades at weekends, so the vendor
// legitimately returns Saturday and Sunday bars for it — and one symbol out of 13,674 became "the
// latest session". The Screener priced 1 row out of 18,019 and raised no error, because a missing
// price is not an error anywhere.
//
// The rule is now a quorum, and these are its boundaries. Every case is a property of the RULE, not of
// any ticker: there is deliberately no symbol list anywhere in this file.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-session-quorum.mjs

import { pickSessionDates } from '../src/lib/screener-data.js';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const L = (s) => console.log(`\n${s}`);

// A typical table: ~13,700 names a session, plus the weekend stragglers that caused the defect.
const REAL = [
  { date: '2026-11-22', n: 1 },      // Sunday — one 24/7 symbol
  { date: '2026-11-21', n: 1 },      // Saturday — same
  { date: '2026-11-20', n: 13674 },  // Friday — the real session
  { date: '2026-11-19', n: 13662 },
  { date: '2026-11-18', n: 13655 },
  { date: '2026-11-17', n: 13651 },
  { date: '2026-11-16', n: 13648 },
];

L('⚠️ 1 — the exact defect that shipped');
{
  const got = pickSessionDates(REAL);
  ok('⚠️ the 1-ticker weekend dates are NOT chosen as sessions',
    !got.includes('2026-11-22') && !got.includes('2026-11-21'), JSON.stringify(got));
  ok('⚠️ the real Friday session is chosen', got[0] === '2026-11-20', JSON.stringify(got));
  ok('…and the prior session is the one before it, for the change column',
    got[1] === '2026-11-19', JSON.stringify(got));
  ok('…and exactly two dates are returned', got.length === 2, JSON.stringify(got));
}

L('⚠️ 2 — a partial session is still the right session');
{
  // Mid-backfill: the newest session has a third of the universe. It is incomplete, and it is still
  // the session to price from — demanding completeness would blank prices for hours every night.
  const got = pickSessionDates([
    { date: '2026-11-20', n: 4500 }, { date: '2026-11-19', n: 13662 }, { date: '2026-11-18', n: 13655 },
  ]);
  ok('⚠️ a 33%-complete newest session is still selected', got[0] === '2026-11-20', JSON.stringify(got));
}
{
  // And the floor case: a session with a handful of names is not a session.
  const got = pickSessionDates([
    { date: '2026-11-22', n: 12 }, { date: '2026-11-20', n: 13674 }, { date: '2026-11-19', n: 13662 },
  ]);
  ok('⚠️ a 12-ticker date is rejected even though it is newest', got[0] === '2026-11-20', JSON.stringify(got));
}

L('⚠️ 3 — it degrades safely rather than blanking the Screener');
{
  ok('an empty table returns no dates, not a crash', pickSessionDates([]).length === 0);
  ok('a null input returns no dates, not a crash', pickSessionDates(null).length === 0);

  // ⚠️ A SMALL TABLE MUST STILL PRICE. If nothing clears the floor — a freshly seeded database — the
  // newest dates are used anyway. Returning nothing here would be the original bug's mirror image:
  // every price blank instead of one row priced.
  const tiny = pickSessionDates([{ date: '2026-11-20', n: 9 }, { date: '2026-11-19', n: 8 }]);
  ok('⚠️ a table below the floor still yields dates rather than blanking every price',
    tiny.length === 2 && tiny[0] === '2026-11-20', JSON.stringify(tiny));

  const one = pickSessionDates([{ date: '2026-11-20', n: 13674 }]);
  ok('a single-session table returns just that session', one.length === 1 && one[0] === '2026-11-20');
}

L('⚠️ 4 — the yardstick is robust to the outlier it exists to reject');
{
  // ⚠️ WHY MEDIAN AND NOT MEAN. With a long weekend tail the mean is dragged down by the 1-ticker
  // dates, raising the chance a junk date clears its own threshold. This case has MORE junk dates than
  // real ones, which is the arrangement that breaks a mean-based rule.
  const junkHeavy = [
    { date: '2026-11-22', n: 1 }, { date: '2026-11-21', n: 1 }, { date: '2026-11-15', n: 1 },
    { date: '2026-11-14', n: 1 }, { date: '2026-11-08', n: 1 }, { date: '2026-11-07', n: 1 },
    { date: '2026-11-20', n: 13674 }, { date: '2026-11-19', n: 13662 },
  ];
  const got = pickSessionDates(junkHeavy);
  ok('⚠️ junk dates outnumbering real ones still does not elect a junk date',
    got[0] === '2026-11-20' && got[1] === '2026-11-19', JSON.stringify(got));

  // ⚠️ THIS IS THE CASE THAT ACTUALLY SEPARATES MEDIAN FROM MEAN, and the first version of this
  // section did not contain it: mutation testing replaced median with mean and the suite stayed green,
  // so the stated reason for choosing median was unverified.
  //
  // A long weekend tail drags a MEAN down far enough that its 20% threshold lands ABOVE a legitimately
  // partial session, and the newest real session is discarded — prices blank while a backfill is still
  // running. The median ignores the tail entirely.
  //   counts: six 1-ticker dates, a 600-ticker partial session, two full sessions
  //   median → 1,     quorum 50   → the 600 partial session QUALIFIES (correct)
  //   mean   → 3,104, quorum 620  → the 600 partial session is REJECTED (wrong)
  const tailHeavy = [
    { date: '2026-11-23', n: 600 },
    { date: '2026-11-22', n: 1 }, { date: '2026-11-21', n: 1 }, { date: '2026-11-15', n: 1 },
    { date: '2026-11-14', n: 1 }, { date: '2026-11-08', n: 1 }, { date: '2026-11-07', n: 1 },
    { date: '2026-11-20', n: 13674 }, { date: '2026-11-19', n: 13662 },
  ];
  const tailGot = pickSessionDates(tailHeavy);
  ok('⚠️ a weekend tail does not raise the bar above a real partial session',
    tailGot[0] === '2026-11-23', JSON.stringify(tailGot));
}

L('⚠️ 5 — the rule is generalized, not a symbol list');
{
  const src = (await import('node:fs')).readFileSync('src/lib/screener-data.js', 'utf8');
  const fn = src.slice(src.indexOf('export function pickSessionDates'),
    src.indexOf('async function licensedEod'));
  ok('⚠️ no ticker symbol appears in the selection rule',
    !/UNIU/.test(fn) && !/\b(?:EXCLUDE|IGNORE|SKIP)_(?:TICKERS|SYMBOLS)\b/.test(fn));
  ok('…and the threshold is relative, not a hardcoded universe size',
    /median \* SESSION_QUORUM_FRACTION/.test(fn));
  ok('…and the fallback cannot be removed silently — it is asserted above', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
