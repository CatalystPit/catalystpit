// THE 13F BACKFILL'S "ALREADY HAVE THIS QUARTER" RULE.
//
// The historical backfill walks filers that are missing OLD quarters, but ingestFiler re-walks every
// quarter at or after the cutoff — including the recent ones the filer already has. Measured on the
// live registry mid-run: 33,163 such quarters across the 9,729 remaining filers, ~3.4 per filer out
// of ~8. Each was downloaded and parsed in full before storeFilingSuperseded looked at it and
// returned `{ skipped: true }`. The download is the cost; the skip came too late to avoid it.
//
// `quarterUnchanged` moves that decision BEFORE the fetch. It is deliberately narrower than the
// store-time check, and these assertions are what "narrower" has to mean:
//
//   storeFilingSuperseded ALSO rewrites when `existing.holdingsCount !== agg.length`. That is how a
//   quarter written by the old restatement-only logic heals itself — same head accession, far fewer
//   positions, because an additive amendment was treated as a restatement. The count cannot be known
//   without fetching, so the pre-fetch rule must only skip quarters where there is provably nothing
//   to heal: exactly one filing, not an amendment, and the accession we already stored.
//
// If any of these loosen, the backfill starts skipping quarters that needed rebuilding, and the
// damage is invisible — a stale quarter looks exactly like a correct one.
//
// Run: node scripts/verify-13f-skip.mjs

import { quarterUnchanged } from '../src/lib/institutions-quarter.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };

const hr = (accession, form = '13F-HR') => ({ quarter: '2025-03-31', form, accession, filedDate: '2025-05-12' });
const A = '0001234567-25-000111';
const B = '0001234567-25-000222';

console.log('\n=== the one case that may be skipped ===');
{
  ok('single 13F-HR whose accession is the stored one', quarterUnchanged([hr(A)], A) === true);
}

console.log('\n=== a different accession is a different filing ===');
{
  ok('stored accession differs — must refetch', quarterUnchanged([hr(B)], A) === false);
  ok('nothing stored — must fetch', quarterUnchanged([hr(A)], null) === false);
  ok('undefined stored — must fetch', quarterUnchanged([hr(A)], undefined) === false);
  ok('empty-string stored is not a match', quarterUnchanged([hr('')], '') === false);
}

console.log('\n=== more than one filing always takes the full path ===');
{
  // This is the case storeFilingSuperseded's count check exists for: a base plus an additive
  // amendment. Skipping it on a head-accession match is exactly the old bug.
  ok('base + amendment, stored head matches — still refetch',
    quarterUnchanged([hr(A), hr(B, '13F-HR/A')], B) === false);
  ok('base + amendment, stored base matches — still refetch',
    quarterUnchanged([hr(A), hr(B, '13F-HR/A')], A) === false);
  ok('two originals — still refetch', quarterUnchanged([hr(A), hr(B)], A) === false);
}

console.log('\n=== a lone amendment is never a complete quarter ===');
{
  // If the only filing at or after the cutoff is an amendment, the base it amends was filed earlier
  // and is not in the list. Storing the amendment alone would be the ExodusPoint failure (1,454
  // positions down to 41), so it must never be skipped on an accession match.
  ok('lone 13F-HR/A matching the stored accession — refetch', quarterUnchanged([hr(A, '13F-HR/A')], A) === false);
}

console.log('\n=== malformed input never skips ===');
{
  ok('empty list', quarterUnchanged([], A) === false);
  ok('not a list', quarterUnchanged(null, A) === false);
  ok('undefined list', quarterUnchanged(undefined, A) === false);
  ok('entry with no accession', quarterUnchanged([{ form: '13F-HR' }], A) === false);
  // The sharpest one. Either nullish guard looks redundant on its own — a real accession never
  // equals undefined — but drop BOTH and `undefined === undefined` is true, so a filing with no
  // accession against a filer with nothing stored would be silently skipped as "unchanged".
  ok('no accession AND nothing stored — two undefineds must not match',
    quarterUnchanged([{ form: '13F-HR' }], undefined) === false);
  ok('entry with no form', quarterUnchanged([{ accession: A }], A) === false);
  ok('null entry', quarterUnchanged([null], A) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
