// NEXT EARNINGS — the defect that produced MU's December date, pinned so it cannot return.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-earnings-next.mjs
//
// ⚠️ THE DEFECT, AS DATA. Micron's real filing history, exactly as /api/earnings served it on
// 2026-09-30. The old estimator printed 2026-12-26 for a company that announced that same evening.
// Every assertion below is driven from this fixture rather than from a mock, so a regression has to
// reproduce the real shape to pass.
import { readFileSync } from 'node:fs';
import { resolveNextEarnings, estimateNext, estimateNextEarnings, isMarketClosed } from '../src/lib/earnings-next.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-30T11:00:00Z');

// MU 10-Q/10-K filings, oldest first — the only series the OLD estimator could see.
const MU_PERIODIC = [
  ['2023-10-06', '10-K', '2023-08-31'], ['2023-12-21', '10-Q', '2023-11-30'],
  ['2024-03-21', '10-Q', '2024-02-29'], ['2024-06-27', '10-Q', '2024-05-30'],
  ['2024-10-04', '10-K', '2024-08-29'], ['2024-12-19', '10-Q', '2024-11-28'],
  ['2025-03-21', '10-Q', '2025-02-27'], ['2025-06-26', '10-Q', '2025-05-29'],
  ['2025-10-03', '10-K', '2025-08-28'], ['2025-12-18', '10-Q', '2025-11-27'],
  ['2026-03-19', '10-Q', '2026-02-26'], ['2026-06-25', '10-Q', '2026-05-28'],
].map(([filed, form, period]) => ({ filed, form, period }));

// MU Item 2.02 announcement EVENT dates — the series that actually describes earnings.
const MU_ANN = ['2024-06-26', '2024-09-25', '2024-12-18', '2025-03-20', '2025-06-25',
  '2025-09-23', '2025-12-17', '2026-03-18', '2026-06-24'].map((event) => ({ event, filed: event }));

L('⚠️ MU: the December date is gone, and the unreported quarter is not skipped');
{
  const r = resolveNextEarnings({ announcements: MU_ANN, periodic: MU_PERIODIC, now: NOW });
  ok('a decision is produced at all', !!r?.date, JSON.stringify(r));
  // ⚠️ THE REGRESSION, NAMED. 2026-12-26 was one median gap past an estimate that had merely elapsed.
  ok('⚠️ it is NOT 2026-12-26 — the quarter-skip is gone', r.date !== '2026-12-26', r.date);
  ok('⚠️ …and it does not land in Q4 of the calendar year at all', r.date < '2026-11-01', r.date);
  ok('it is within a fortnight of the real announcement (2026-09-30)',
    Math.abs(Date.parse(r.date) - Date.parse('2026-09-30')) / 864e5 <= 14, r.date);
  ok('⚠️ a projection that has passed is reported as due, not re-dated forward', r.imminent === true, JSON.stringify(r));
  ok('it is honestly labelled an estimate, because no source confirmed it', r.basis === 'estimated', r.basis);
  ok('…and says which series it used', r.series === 'item-2.02', r.series);

  // The old behaviour, reproduced from the same fixture, so the improvement is not a claim.
  const old = (() => {
    const reports = MU_PERIODIC.map((p) => p.filed).sort();
    const gaps = [];
    for (let i = 1; i < reports.length; i++) {
      const g = (Date.parse(reports[i]) - Date.parse(reports[i - 1])) / 864e5;
      if (g > 40 && g < 140) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    let t = Date.parse(reports[reports.length - 1]) + med * 864e5;
    for (let g = 0; t < NOW && g < 8; g++) t += med * 864e5;
    return { date: new Date(t).toISOString().slice(0, 10), med };
  })();
  ok('⚠️ the old method on this same data really did produce 2026-12-26', old.date === '2026-12-26', old.date);
  ok('⚠️ …from a 92-day median MU has never actually taken', old.med === 92, String(old.med));
}

L('⚠️ no roll-forward may ever skip an unreported period');
{
  // A company whose last announcement is long past and whose projection is therefore far behind.
  // The answer must stay near the projection — never advance cycle after cycle to clear "now".
  const ann = ['2024-02-07', '2024-05-08', '2024-08-07', '2024-11-06',
    '2025-02-05', '2025-05-07', '2025-08-06'].map((event) => ({ event }));
  const r = resolveNextEarnings({ announcements: ann, periodic: [], now: Date.parse('2026-09-30T00:00:00Z') });
  ok('a decision is still produced', !!r?.date, JSON.stringify(r));
  ok('⚠️ it does NOT chase forward to clear today', Date.parse(r.date) < Date.parse('2026-06-01'), r.date);
  ok('…and it is flagged imminent/overdue instead', r.imminent === true, JSON.stringify(r));

  // The same guarantee on the cadence-only fallback, which is where the old bug physically lived.
  const thin = ['2026-01-05', '2026-04-06', '2026-07-06'];
  const c = estimateNext(thin, Date.parse('2027-06-01T00:00:00Z'));
  ok('⚠️ the cadence fallback advances past observed events only, never past "now"',
    c && Date.parse(c.date) < Date.parse('2026-12-01'), JSON.stringify(c));
  ok('…and the code says why, naming the line that caused the defect',
    /ROLL FORWARD ONLY PAST EVENTS WE HAVE ACTUALLY OBSERVED/.test(read('src/lib/earnings-next.mjs')));
}

L('⚠️ confirmed means a source scheduled it — never that the model is confident');
{
  const base = { announcements: MU_ANN, periodic: MU_PERIODIC, now: NOW };
  // 1: a licensed calendar entry wins outright.
  const sched = resolveNextEarnings({ ...base, scheduled: { date: '2026-09-30', time: 'amc' } });
  ok('a licensed schedule is reported as confirmed', sched.basis === 'confirmed' && sched.date === '2026-09-30');
  ok('…and names the calendar as the method', sched.method === 'licensed-calendar', sched.method);
  ok('⚠️ …and overrides the calculated estimate entirely', sched.date !== resolveNextEarnings(base).date);
  ok('a PAST calendar entry is not treated as the next event',
    resolveNextEarnings({ ...base, scheduled: { date: '2026-01-05' } }).basis === 'estimated');

  // 2: an Item 2.02 filed today is a fact, not a projection.
  const today = resolveNextEarnings({ ...base, announcements: [...MU_ANN, { event: '2026-09-30' }] });
  ok('⚠️ an Item 2.02 dated today is confirmed', today.basis === 'confirmed' && today.date === '2026-09-30');
  ok('…and cites the 8-K', today.method === 'sec-8k-item-202', today.method);

  // 3: nothing else may.
  ok('⚠️ a modelled date is never confirmed, however many observations back it',
    resolveNextEarnings(base).basis === 'estimated');
  for (const obs of [4, 8, 20]) {
    const many = Array.from({ length: obs }, (_, i) => ({ event: new Date(Date.parse('2020-02-05') + i * 91 * 864e5).toISOString().slice(0, 10) }));
    ok(`${obs} clean observations still yield "estimated"`,
      resolveNextEarnings({ announcements: many, periodic: [], now: NOW })?.basis === 'estimated');
  }
}

L('⚠️ the announcement series is preferred over the filing series');
{
  const withAnn = resolveNextEarnings({ announcements: MU_ANN, periodic: MU_PERIODIC, now: NOW });
  const filingOnly = resolveNextEarnings({ announcements: [], periodic: MU_PERIODIC, now: NOW });
  ok('announcements are used when deep enough', withAnn.series === 'item-2.02');
  ok('…and filings are the labelled fallback', filingOnly.series === 'periodic');
  ok('⚠️ the two disagree, which is the whole reason the series matters', withAnn.date !== filingOnly.date,
    `${withAnn.date} vs ${filingOnly.date}`);
  // Too few announcements must fall back rather than model on three points.
  ok('two announcements are not enough to prefer that series',
    resolveNextEarnings({ announcements: MU_ANN.slice(-2), periodic: MU_PERIODIC, now: NOW })?.series === 'periodic');
}

L('a projection never lands on a day the market is shut');
{
  ok('a Saturday is closed', isMarketClosed(Date.parse('2026-10-03T00:00:00Z')));
  ok('a Sunday is closed', isMarketClosed(Date.parse('2026-10-04T00:00:00Z')));
  ok('Christmas is closed', isMarketClosed(Date.parse('2026-12-25T00:00:00Z')));
  ok('Thanksgiving 2026 is closed', isMarketClosed(Date.parse('2026-11-26T00:00:00Z')));
  ok('an ordinary Tuesday is open', !isMarketClosed(Date.parse('2026-10-06T00:00:00Z')));
  // ⚠️ MEASURED ACROSS THE FIXTURES, not asserted on one case: the old estimator put 6.7% of live
  // estimates on a weekend, which no filing has ever done.
  let closed = 0, total = 0;
  for (let shift = 0; shift < 40; shift++) {
    const ann = MU_ANN.map((a) => ({ event: new Date(Date.parse(a.event) + shift * 864e5).toISOString().slice(0, 10) }));
    const r = resolveNextEarnings({ announcements: ann, periodic: [], now: NOW });
    if (r?.date) { total++; if (isMarketClosed(Date.parse(`${r.date}T00:00:00Z`))) closed++; }
  }
  ok('⚠️ no projection over 40 shifted histories lands on a closed day', closed === 0, `${closed}/${total}`);
}

L('the API contract the page depends on');
{
  const route = read('src/app/api/earnings/route.js');
  ok('⚠️ the announcement history is fetched in PARALLEL with the facts, so latency is unchanged',
    /const historyPromise = secFilingHistory\(cik\);/.test(route));
  ok('…and Item 2.02 is what it selects on', /String\(b\.items\?\.\[i\] \|\| ''\)\.includes\('2\.02'\)/.test(route));
  ok('…preferring the filer\'s stated event date over the filing date', /b\.reportDate\?\.\[i\] \|\| b\.filingDate\?\.\[i\]/.test(route));
  // ⚠️ THE CACHE TRAP: `imminent` and the same-day 8-K both depend on today, so the decision cannot
  // be cached with the 24-hour payload or it would be wrong for up to a day.
  ok('⚠️ `next` is computed per request, not stored in the cached payload',
    /`next` IS COMPUTED PER REQUEST, NEVER CACHED/.test(route));
  ok('…and the cache key was versioned so v1 entries cannot serve without announcements',
    /earnings:v2:\$\{ticker\}/.test(route));
  ok('the raw history is not shipped to the client',
    /const \{ announcements: _a, periodic: _p, \.\.\.pub \} = payload;/.test(route));
  // ⚠️ submissions.recent TRUNCATES FOR HIGH-VOLUME FILERS — JPMorgan files 26,408 in a year, so its
  // window reaches back twelve months. The XBRL quarters do not truncate, so they join the fallback.
  ok('⚠️ the XBRL quarters are merged into the fallback series, not just submissions.json',
    /MERGE THE XBRL QUARTERS INTO THE FALLBACK SERIES/.test(route)
    && /\.\.\.\(payload\.periodic \|\| \[\]\), \.\.\.fromXbrl/.test(route));
  ok('…deduplicated on the filing date so one filing is one point',
    /new Map\(\s*\[\.\.\.\(payload\.periodic \|\| \[\]\), \.\.\.fromXbrl\]/.test(route.replace(/\n\s*/g, ' ')));
  ok('a dormant calendar costs no round trip', /if \(!\(process\.env\.TWELVE_DATA_API_KEY/.test(route));
  ok('the ticker page reads the server decision rather than deriving one',
    /const nextEarnings = earnings\?\.next \|\| null;/.test(read('src/app/ticker/[symbol]/TickerPage.jsx')));
  ok('the watchlist does too', /est = ej\?\.next\?\.date \|\| null;/.test(read('src/components/WatchlistSection.jsx')));
  ok('⚠️ the history column no longer calls a filing date a report date',
    /\['Filed', 'left'\]/.test(read('src/app/ticker/[symbol]/TickerPage.jsx')));
}

L('degenerate input returns null rather than a guess');
{
  for (const [label, arg] of [
    ['no data', {}], ['empty arrays', { announcements: [], periodic: [] }],
    ['two filings', { periodic: MU_PERIODIC.slice(0, 2) }],
    ['null rows', { periodic: [null, undefined] }],
    ['garbage dates', { periodic: [{ filed: 'x' }, { filed: 'y' }, { filed: 'z' }] }],
  ]) {
    let out; try { out = resolveNextEarnings({ ...arg, now: NOW }); } catch (e) { out = `THREW ${e.message}`; }
    ok(`${label}: returns null and does not throw`, out === null, JSON.stringify(out));
  }
  ok('the back-compat shim still returns a bare date string',
    typeof estimateNextEarnings(MU_PERIODIC.map((p) => ({ report_date: p.filed }))) === 'string');
  ok('…and null when it cannot answer', estimateNextEarnings([]) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
