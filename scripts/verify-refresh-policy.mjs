// VERIFY THE REFRESH POLICY — the provider-independent half of the scaling fix.
//
// Each assertion targets one of the measured defects:
//   D2  every visitor triggered an upstream fetch because freshness compared against the calendar
//       date, and today's EOD bar does not exist during the session or at a weekend.
//   D3  /api/ticker refetched forever for thin tickers, because the condition that triggered the
//       fetch ("<50 stored candles") was one the fetch could never satisfy.
//   stampede  simultaneous requests for the same missing resource each issued their own fetch.
//
// Run: node scripts/verify-refresh-policy.mjs [--mutate=<mode>]

import {
  lastExpectedSession, isStale, claimRefreshAttempt, coalesce,
  __inflightSize, __resetRefreshState, PUBLISH_HOUR_ET, ATTEMPT_COOLDOWN_SEC,
} from '../src/lib/market/refresh-policy.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// Fixed instants in ET, so the suite does not depend on when it runs.
const at = (iso) => Date.parse(iso);
const SAT_MIDDAY   = at('2026-09-19T16:00:00Z');   // Sat 12:00 ET
const FRI_INTRADAY = at('2026-09-18T17:00:00Z');   // Fri 13:00 ET — session open, EOD not published
const FRI_NIGHT    = at('2026-09-19T01:00:00Z');   // Fri 21:00 ET — after the publish hour
const MON_MORNING  = at('2026-09-21T13:00:00Z');   // Mon 09:00 ET

L('=== D2: freshness is measured against the last PUBLISHED session ===');
{
  ok(`publish hour is after the close (${PUBLISH_HOUR_ET}:00 ET)`, PUBLISH_HOUR_ET >= 17);
  ok('Saturday resolves to Friday', lastExpectedSession(SAT_MIDDAY) === '2026-09-18',
    lastExpectedSession(SAT_MIDDAY));
  ok('Friday intraday resolves to Thursday (today has not published)',
    lastExpectedSession(FRI_INTRADAY) === '2026-09-17', lastExpectedSession(FRI_INTRADAY));
  ok('Friday night resolves to Friday (today has published)',
    lastExpectedSession(FRI_NIGHT) === '2026-09-18', lastExpectedSession(FRI_NIGHT));
  ok('Monday morning resolves to Friday, skipping the weekend',
    lastExpectedSession(MON_MORNING) === '2026-09-18', lastExpectedSession(MON_MORNING));

  // THE DEFECT ITSELF: holding Thursday's bar during Friday's session is CURRENT, not stale.
  const held = mut('stale') ? '1999-01-01' : '2026-09-17';
  ok('holding the last published session is NOT stale during the next session',
    isStale(held, FRI_INTRADAY).stale === false, JSON.stringify(isStale(held, FRI_INTRADAY)));
  ok('holding Friday over the weekend is NOT stale',
    isStale('2026-09-18', SAT_MIDDAY).stale === false);
  ok('genuinely behind IS stale', isStale('2026-09-01', FRI_INTRADAY).stale === true);
  ok('nothing stored is stale (cold)', isStale(null, FRI_INTRADAY).stale === true);
  ok('the old rule would have refetched here, the new one does not',
    '2026-09-17' < '2026-09-18' && isStale('2026-09-17', FRI_INTRADAY).stale === false);
}

L('\n=== D3: an unsatisfiable gap must not re-request forever ===');
{
  __resetRefreshState();
  const key = 'thin-ticker';
  const first = await claimRefreshAttempt(key, mut('cooldown') ? 0 : ATTEMPT_COOLDOWN_SEC);
  const second = await claimRefreshAttempt(key, mut('cooldown') ? 0 : ATTEMPT_COOLDOWN_SEC);
  const third = await claimRefreshAttempt(key, mut('cooldown') ? 0 : ATTEMPT_COOLDOWN_SEC);
  ok('the first attempt is allowed', first === true);
  ok('a second attempt within the cooldown is refused', second === false);
  ok('a third attempt within the cooldown is refused', third === false);
  ok('the cooldown is long enough to bound a holiday', ATTEMPT_COOLDOWN_SEC >= 300, String(ATTEMPT_COOLDOWN_SEC));

  // The attempt is recorded even when the fetch returns nothing usable — which is the whole point,
  // because for a thin ticker it always will.
  __resetRefreshState();
  await claimRefreshAttempt('empty-result');
  ok('an attempt that returned no data still blocks the next attempt',
    (await claimRefreshAttempt('empty-result')) === false);

  // Distinct symbols must not block each other.
  __resetRefreshState();
  await claimRefreshAttempt('AAA');
  ok('a different symbol is unaffected by another symbol\'s cooldown',
    (await claimRefreshAttempt('BBB')) === true);
}

L('\n=== STAMPEDE: simultaneous identical requests share one flight ===');
{
  __resetRefreshState();
  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => { calls++; r('value'); }, 40));
  const key = 'hot-ticker';
  const N = 50;
  const results = await Promise.all(
    Array.from({ length: N }, () => (mut('coalesce') ? slow() : coalesce(key, slow))));
  ok(`${N} simultaneous callers produced exactly 1 upstream call`, calls === 1, `${calls} calls`);
  ok('every caller received the value', results.every((r) => r === 'value'));
  ok('the in-flight entry is released after settling', __inflightSize() === 0, String(__inflightSize()));

  // A later, non-overlapping request must still be allowed through — coalescing is not caching.
  calls = 0;
  await coalesce(key, slow);
  ok('a later non-overlapping request is not suppressed', calls === 1, `${calls} calls`);

  // A rejection must not poison the key.
  __resetRefreshState();
  const boom = () => Promise.reject(new Error('upstream down'));
  await Promise.allSettled([coalesce('k', boom), coalesce('k', boom)]);
  ok('a failed flight is cleared rather than cached', __inflightSize() === 0);
  let after = 0;
  await coalesce('k', async () => { after++; });
  ok('a key recovers after a failure', after === 1);
}

L('\n=== PREWARM: warming must not mean re-fetching ===');
{
  // The cron warms 20 tickers every 15 minutes. With the old rule each warm hit the provider,
  // because maxStored < today was always true: 4 runs/hour x 20 = 80 upstream requests/hour.
  // Under the new rule a warm only reaches the provider when a session has actually published.
  const runsPerHour = 4, tickersPerRun = 20;
  const oldPerHour = runsPerHour * tickersPerRun;
  // After the first run following the publish hour, maxStored equals the last published session,
  // so every later run in that hour resolves to "current".
  let newPerHour = 0;
  for (let run = 0; run < runsPerHour; run++) {
    const held = run === 0 ? '2026-09-17' : '2026-09-18';   // first run backfills, then it is current
    if (isStale(held, FRI_NIGHT).stale) newPerHour += tickersPerRun;
  }
  ok(`prewarm upstream calls/hour fall from ${oldPerHour} to ${newPerHour}`,
    newPerHour < oldPerHour, `${newPerHour}`);
  ok('a fully warm hour costs zero upstream calls',
    [0, 1, 2, 3].every((i) => i === 0 || !isStale('2026-09-18', FRI_NIGHT).stale));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
