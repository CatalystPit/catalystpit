// SEC 503 IS "TRY AGAIN", AND THE BACKOFF THAT FOLLOWS FROM THAT.
//
// EDGAR's Archives host sheds load with 503 and an HTML page titled "File Unavailable". Measured on
// live accessions while the crawler was stopped: index.json returned 503, 503, then 200 on the third
// attempt for two separate filers, while other documents inside the SAME accession answered 200
// throughout. Transient, per-request, and nothing to do with rate limits or blocks.
//
// Before the fix the backfill read that as truth. secFetch returned null, secJson turned it into
// null, fetchHoldings turned that into [], and ingestFiler read [] as "this quarter has no positions
// to store" and moved on without a word. A run that processed 38 filers stored 1 quarter and
// reported 18.8 filers/min the whole way.
//
// Run: node scripts/verify-sec-retry.mjs

import { secRetryDelayMs } from '../src/lib/institutions-universe.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };

console.log('\n=== the backoff grows, and starts where a retry is still cheap ===');
{
  ok('first retry waits a second', secRetryDelayMs(1) === 1000);
  ok('second doubles', secRetryDelayMs(2) === 2000);
  ok('third doubles again', secRetryDelayMs(3) === 4000);
  ok('strictly increasing', secRetryDelayMs(1) < secRetryDelayMs(2) && secRetryDelayMs(2) < secRetryDelayMs(3));
}

console.log('\n=== three retries stay well inside a polite budget ===');
{
  // The whole point is to survive a blip without turning one filer into a stall. 1+2+4 = 7s worst
  // case per request, against a 403 cooldown of 15 MINUTES — these are different orders of problem
  // and must stay different orders of wait.
  const worst = secRetryDelayMs(1) + secRetryDelayMs(2) + secRetryDelayMs(3);
  ok('worst-case added wait is 7s', worst === 7000);
  ok('...far below the 15-minute 403 cooldown', worst < 15 * 60 * 1000);
}

console.log('\n=== a nonsense attempt number never yields a negative or zero wait ===');
{
  // A zero would turn a backoff into a hot loop against an endpoint that is already struggling.
  ok('attempt 0 is clamped', secRetryDelayMs(0) === 1000);
  ok('a negative attempt is clamped', secRetryDelayMs(-5) === 1000);
  ok('every value is positive', [0, -1, 1, 2, 3, 4].every((a) => secRetryDelayMs(a) > 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
