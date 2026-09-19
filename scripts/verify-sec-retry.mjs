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

import { secRetryDelayMs, secThrottleWaitMs, secStatusAction } from '../src/lib/institutions-universe.js';

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

console.log('\n=== which status means what: the policy that actually regressed ===');
{
  // This block exists because a mutant survived without it. Moving 429 back into the fast-retry set
  // changed nothing any assertion could see — the wait-length tests are pure and never consult the
  // sets — so the exact regression that caused the incident was invisible to the suite.
  ok('429 stops the pool', secStatusAction(429) === 'throttle');
  ok('403 stops the pool', secStatusAction(403) === 'throttle');
  ok('503 is a fast retry', secStatusAction(503) === 'retry');
  ok('502 is a fast retry', secStatusAction(502) === 'retry');
  ok('504 is a fast retry', secStatusAction(504) === 'retry');
  ok('429 is NOT a fast retry', secStatusAction(429) !== 'retry');
  ok('200 is taken as the answer', secStatusAction(200) === 'final');
  ok('404 is taken as the answer, not retried forever', secStatusAction(404) === 'final');
  ok('500 is final — a genuine server error is not a queue problem', secStatusAction(500) === 'final');
}

console.log('\n=== 429 is a throttle, not a retryable blip ===');
{
  // Putting 429 in the fast-retry set is what caused the incident this policy exists to prevent:
  // being told "too many requests" triggered three more inside seven seconds, and the three-route
  // fallback multiplied every failing filing from four requests to twelve — at the exact moment SEC
  // was asking for fewer. Measured live: the crawler reached 26.6 filers/min, www.sec.gov/Archives
  // began returning 429 on every request while data.sec.gov still answered 200, quarters and
  // holdings stopped advancing entirely, and unreadable climbed 10 to 27 in under three minutes.
  // A 429 now stops the whole pool, like a 403, because both mean stop asking.
  ok('a bare 429 waits 5 minutes', secThrottleWaitMs(null, 429) === 5 * 60 * 1000);
  ok('a bare 403 keeps its own 15-minute cooldown', secThrottleWaitMs(null, 403) === 15 * 60 * 1000);
  ok('403 waits longer than 429', secThrottleWaitMs(null, 403) > secThrottleWaitMs(null, 429));
  ok('both dwarf any retry backoff', secThrottleWaitMs(null, 429) > secRetryDelayMs(3) * 10);
}

console.log('\n=== Retry-After is honoured, and clamped ===');
{
  ok('a sane Retry-After is used', secThrottleWaitMs('90', 429) === 90_000);
  ok('whitespace is tolerated', secThrottleWaitMs(' 30 ', 429) === 30_000);
  ok('an absurd value is capped at an hour', secThrottleWaitMs('999999', 429) === 60 * 60 * 1000);
  ok('a tiny value still yields a real pause', secThrottleWaitMs('0.2', 429) === 1000);
  ok('zero falls back to the default', secThrottleWaitMs('0', 429) === 5 * 60 * 1000);
  ok('a negative falls back to the default', secThrottleWaitMs('-5', 429) === 5 * 60 * 1000);
  ok('an HTTP-date form falls back rather than becoming NaN',
    secThrottleWaitMs('Wed, 21 Oct 2026 07:28:00 GMT', 429) === 5 * 60 * 1000);
  ok('garbage falls back', secThrottleWaitMs('soon', 429) === 5 * 60 * 1000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
