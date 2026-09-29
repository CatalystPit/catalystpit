// FREE vs PRO: the EOD boundary and the chart-interval gate.
//
//   node --import ./scripts/lib/node-resolve-hook.mjs --env-file=.env.local scripts/verify-free-pro-freshness.mjs
//
// ⚠️ THE CUTOFF IS THE PART WORTH TESTING. "Older than 24 hours" is the wrong rule in both
// directions — on a Monday it hides Friday's completed session, and after a holiday it exposes work
// no completed session has covered. Every case below is a real calendar moment, so a regression to
// an age-based rule fails here rather than in a customer's account.
import { eodCutoffIso, chartIntervalAllowed, FREE_CHART_INTERVALS, INTRADAY_INTERVALS, isProTier } from '../src/lib/entitlement-rules.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
// A moment expressed in ET, as a UTC instant. EDT (-4) for the dates used below.
const et = (iso) => Date.parse(`${iso}-04:00`);
const cut = (at) => eodCutoffIso('free', et(at));

L('⚠️ the boundary is a completed session close, not an age');
{
  // Wednesday 2026-09-30, mid-session. The last COMPLETED session is Tuesday the 29th.
  ok('mid-session Wednesday cuts at Tuesday\'s close',
    cut('2026-09-30T11:00:00') === '2026-09-29T20:00:00.000Z', cut('2026-09-30T11:00:00'));
  // Same day after the close: today is now complete.
  ok('⚠️ after the close, today becomes the snapshot',
    cut('2026-09-30T16:30:00') === '2026-09-30T20:00:00.000Z', cut('2026-09-30T16:30:00'));
  ok('…and one minute BEFORE the close it is still yesterday',
    cut('2026-09-30T15:59:00') === '2026-09-29T20:00:00.000Z', cut('2026-09-30T15:59:00'));

  // ⚠️ THE WEEKEND CASE AN AGE RULE GETS WRONG. Saturday and Sunday must both resolve to Friday —
  // a 24-hour rule would move the boundary each day and a 48-hour rule would skip Friday entirely.
  ok('⚠️ Saturday resolves to Friday\'s close',
    cut('2026-10-03T10:00:00') === '2026-10-02T20:00:00.000Z', cut('2026-10-03T10:00:00'));
  ok('⚠️ Sunday resolves to the same Friday, not to Saturday',
    cut('2026-10-04T10:00:00') === '2026-10-02T20:00:00.000Z', cut('2026-10-04T10:00:00'));
  ok('Monday before the close still resolves to Friday',
    cut('2026-10-05T09:45:00') === '2026-10-02T20:00:00.000Z', cut('2026-10-05T09:45:00'));

  // ⚠️ A HOLIDAY IS NOT A SESSION. 2026-01-01 is New Year's Day; the last completed session is
  // 2025-12-31. An age rule would treat the 1st as tradeable and expose a day that never closed.
  ok('⚠️ a market holiday is skipped, not counted',
    cut('2026-01-01T12:00:00') === '2025-12-31T21:00:00.000Z', cut('2026-01-01T12:00:00'));

  // Overnight: 2am Thursday is before Thursday's open, so Wednesday is the last completed session.
  ok('overnight resolves to the previous close, not to "yesterday"',
    cut('2026-10-01T02:00:00') === '2026-09-30T20:00:00.000Z', cut('2026-10-01T02:00:00'));
}

L('⚠️ Pro has no cutoff at all');
{
  for (const t of ['pro', 'elite']) {
    ok(`${t} gets null, meaning no freshness filter is applied`, eodCutoffIso(t) === null);
    ok(`…and ${t} is recognised as Pro`, isProTier(t) === true);
  }
  ok('free is not Pro', isProTier('free') === false);
  ok('⚠️ an unknown tier is treated as Free, not as Pro',
    isProTier('enterprise') === false && typeof eodCutoffIso('enterprise') === 'string');
}

L('⚠️ timezone handling is verified, not assumed');
{
  // ⚠️ THE DST BOUNDARY. 2026-11-01 is the US fallback. A hard-coded -4 or -5 offset is wrong on one
  // side of it; the cutoff must land on 21:00Z (EST) after the change and 20:00Z (EDT) before.
  const beforeFallback = eodCutoffIso('free', Date.parse('2026-10-30T21:00:00-04:00'));
  const afterFallback = eodCutoffIso('free', Date.parse('2026-11-03T21:00:00-05:00'));
  ok('⚠️ a close in EDT is 20:00Z', beforeFallback === '2026-10-30T20:00:00.000Z', beforeFallback);
  ok('⚠️ …and a close in EST is 21:00Z', afterFallback === '2026-11-03T21:00:00.000Z', afterFallback);
  ok('every cutoff is a valid instant', !Number.isNaN(Date.parse(beforeFallback)));
}

L('⚠️ chart intervals: Free is every non-intraday timeframe, Pro is everything');
{
  ok('the intraday set is the twelve the registry marks intraday',
    INTRADAY_INTERVALS.length === 12, INTRADAY_INTERVALS.join(','));
  for (const id of ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m', '1h', '2h', '3h', '4h']) {
    ok(`⚠️ Free is refused ${id}`, chartIntervalAllowed('free', id) === false);
    ok(`…and Pro may use ${id}`, chartIntervalAllowed('pro', id) === true);
  }
  // Daily / Weekly / Monthly / Yearly, the four named in the rule, plus the other EOD views.
  for (const id of ['1D', '1W', '1M', '1Y']) {
    ok(`Free may use ${id}`, chartIntervalAllowed('free', id) === true);
  }
  ok('…as well as the remaining end-of-day views, which are the same candles',
    ['3M', '6M', 'YTD', 'All'].every((id) => chartIntervalAllowed('free', id)));
  ok('⚠️ the two sets do not overlap',
    !FREE_CHART_INTERVALS.some((id) => INTRADAY_INTERVALS.includes(id)));
  ok('⚠️ an unknown interval is not silently allowed to Free as intraday',
    chartIntervalAllowed('free', 'nonsense') === true && chartIntervalAllowed('pro', 'nonsense') === true,
    'unknown ids are not intraday, so they fall through to the route\'s own validation');
  ok('elite gets the full set like pro', chartIntervalAllowed('elite', '1m') === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
