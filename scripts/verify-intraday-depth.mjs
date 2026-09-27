// HOW MUCH INTRADAY HISTORY EACH INTERVAL GETS.
//
//   node scripts/verify-intraday-depth.mjs                                  (arithmetic only)
//   CP_DEPTH_LIVE=http://localhost:3000 node scripts/verify-intraday-depth.mjs GOOGL   (+ real routes)
//
// ⚠️ THE DEFECT THIS PINS. Intraday depth was declared per interval as a count of SESSIONS, and a
// session is a wildly different number of bars depending on the bar size — 390 one-minute bars, or one
// four-hour bar. So "60 sessions" meant 1,950 bars at 1m and 60 at 4h, from the same idea of generous.
// Eight of the twelve intervals could not compute a 200-period average at all, and scrolling back hit a
// wall that had nothing to do with the data: measured against the upstream feed, 1h had 4,692 bars
// available and we served 120.
//
// So the unit is BARS now, and one formula covers all twelve. What this suite defends is that property
// — that no interval is special-cased, and that depth does not collapse as the bar grows — because the
// old shape would pass any test written per interval.

import fs from 'node:fs';
import path from 'node:path';
import {
  TIMEFRAMES, timeframe, isIntraday, barsUrl, normalizeBars, sessionKeyFor,
  intradayHistory, barsPerSession, TARGET_BARS, MIN_SESSIONS, UPSTREAM_MAX_BARS, ADAPTER,
} from '../src/lib/chart/chart-source.mjs';
import { computeIndicator, indicatorAvailability } from '../src/lib/chart/chart-indicators.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const INTRA = TIMEFRAMES.filter((t) => t.kind === 'intraday');
const LIVE = process.env.CP_DEPTH_LIVE || null;
const SYM = process.argv[2] || 'GOOGL';

// ── 1. depth is derived, not declared per interval ────────────────────────────────────────────
console.log('\n1. depth is derived, not declared per interval');

ok('there are twelve intraday intervals', INTRA.length === 12, `${INTRA.length}`);
// ⚠️ THE REGISTRY CARRIES ONLY THE BAR SIZE. A hand-picked session count per interval is exactly what
// produced the collapse, and a suite that only checked the resulting numbers would let it come back.
const src = read('src/lib/chart/chart-source.mjs');
const calls = [...src.matchAll(/^\s*intra\('([^']+)',[^)]*\),$/gm)].map((m) => m[0]);
ok('every intraday entry is declared the same way', calls.length === 12, `${calls.length} entries`);
// ⚠️ COMMAS INSIDE THE PARENTHESES. Counting them across the whole matched line includes the trailing
// comma that separates registry entries, so a correct five-argument call read as six and this failed on
// working code.
const argsOf = (c) => c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).split(',').length;
ok('⚠️ no intraday entry carries its own history numbers',
  calls.every((c) => argsOf(c) === 5),
  calls.map((c) => `${c.trim().slice(0, 12)}=${argsOf(c)}`).filter((x) => !x.endsWith('=5')).join(' '));
ok('...so a sixth argument (a hand-picked session count) would be caught',
  argsOf("intra('1m', 'x', '1m', 'minutes', 1, 60),") === 6);

// The formula itself, independent of the registry.
for (const barMin of [1, 5, 60, 240]) {
  const h = intradayHistory(barMin);
  ok(`the formula answers for a ${barMin}-minute bar`,
    h.sessions > 0 && h.lookbackDays > h.sessions && h.barsWanted > 0);
}
ok('bars per session shrinks as the bar grows',
  barsPerSession(1) === 390 && barsPerSession(5) === 78 && barsPerSession(60) === 6
  && barsPerSession(240) === 1);
ok('...and never reaches zero, so a bar larger than a session still asks for history',
  barsPerSession(600) === 1 && barsPerSession(1440) === 1);

// ── 2. depth does NOT collapse as the bar grows ───────────────────────────────────────────────
console.log('\n2. depth does not collapse as the bar grows');

const wanted = INTRA.map((t) => ({ id: t.id, ...t.request }));
for (const w of wanted) {
  // ⚠️ THE FLOOR THAT MATTERS. 200 bars is not enough for a 200-period average — it yields exactly one
  // value, with no context before it — so the target is comfortably above that on every interval.
  ok(`${w.id} asks for enough bars for a 200-period indicator plus context`, w.barsWanted >= 500,
    `${w.barsWanted}`);
  ok(`${w.id} stays within one upstream response`, w.barsWanted <= UPSTREAM_MAX_BARS,
    `${w.barsWanted} vs ${UPSTREAM_MAX_BARS}`);
}
// ⚠️ THE COLLAPSE, MEASURED. Before, the finest interval asked for 32x the bars of the coarsest
// (1,950 against 60). Bars are the unit now, so every interval lands in the same band.
const counts = wanted.map((w) => w.barsWanted);
const spread = Math.max(...counts) / Math.min(...counts);
ok('⚠️ every interval asks for a comparable number of bars', spread <= 2.5,
  `spread ${spread.toFixed(2)}x — min ${Math.min(...counts)}, max ${Math.max(...counts)}`);
ok('...and the old 32x collapse could not pass that', 1950 / 60 > 2.5);

// Calendar span must GROW with the bar, which is the behaviour being replicated: a bigger bar reaches
// further back for the same number of bars.
const byBar = [...wanted].sort((a, b) => a.barMinutes - b.barMinutes);
for (let i = 1; i < byBar.length; i += 1) {
  ok(`${byBar[i].id} reaches at least as far back as ${byBar[i - 1].id}`,
    byBar[i].lookbackDays >= byBar[i - 1].lookbackDays,
    `${byBar[i].lookbackDays} vs ${byBar[i - 1].lookbackDays}`);
}
ok('⚠️ the coarsest interval reaches back much further than the finest',
  byBar.at(-1).lookbackDays > byBar[0].lookbackDays * 20,
  `${byBar.at(-1).lookbackDays} vs ${byBar[0].lookbackDays}`);
// The finest intervals keep a session floor so a chart is never one stub of a day.
ok('the finest interval keeps a session floor rather than a bar count alone',
  timeframe('1m').request.sessions === MIN_SESSIONS, `${timeframe('1m').request.sessions}`);
ok('the target bar count is in the intended band', TARGET_BARS >= 500 && TARGET_BARS <= 1500,
  `${TARGET_BARS}`);

// ── 3. the ceiling is expressed in the unit the provider actually limits ───────────────────────
console.log('\n3. the ceiling is expressed in the unit the provider actually limits');

ok('the adapter declares a bar-per-request ceiling',
  ADAPTER.intraday.maxBarsPerRequest === UPSTREAM_MAX_BARS);
// ⚠️ AND NOT A SESSION CEILING. `maxSessions: 60` described no real provider limit and was the number
// that made 4h shallow; a suite that still allowed it would allow the bug.
ok('⚠️ the old session ceiling is gone', !('maxSessions' in ADAPTER.intraday),
  Object.keys(ADAPTER.intraday).join(','));
ok('no intraday interval is refused by the adapter', INTRA.every((t) => t.request.barsWanted <= UPSTREAM_MAX_BARS));
// The clamp is real: asking for more than a response can carry is capped rather than requested.
const huge = intradayHistory(1, { targetBars: 50_000 });
ok('a target beyond one response is clamped to it', huge.barsWanted <= UPSTREAM_MAX_BARS,
  `${huge.barsWanted}`);

// ── 4. daily and longer timeframes are untouched ───────────────────────────────────────────────
console.log('\n4. daily and longer timeframes are untouched');

for (const id of ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'All']) {
  const tf = timeframe(id);
  ok(`${id} still exists`, !!tf);
  ok(`${id} is not intraday and carries no intraday history fields`,
    tf && !isIntraday(id) && tf.request.sessions === undefined);
}
ok('the daily ranges the route understands are unchanged',
  ['1M', '3M', '6M', 'YTD', '1Y', '5Y', 'all'].every((r) => ADAPTER.daily.ranges.has(r)));

// ── 5. a 200-period indicator is now possible on every intraday interval ───────────────────────
console.log('\n5. a 200-period indicator is now possible on every intraday interval');

for (const t of INTRA) {
  ok(`${t.id} can support a 200-period average`, t.request.barsWanted > 200, `${t.request.barsWanted}`);
  // ⚠️ AND WITH ROOM TO READ IT. Exactly 200 bars yields one value at the last bar, which is useless;
  // the point of the target is that the indicator is valid across a visible stretch.
  ok(`...with at least 300 values of it visible`, t.request.barsWanted - 199 >= 300,
    `${t.request.barsWanted - 199} values`);
}

// ── 6. against the real routes ────────────────────────────────────────────────────────────────
console.log(`\n6. against the real routes ${LIVE ? `(LIVE ${SYM})` : '(skipped — set CP_DEPTH_LIVE)'}`);

if (LIVE) {
  // What each interval served BEFORE this change, measured. Kept so the improvement is a fact in the
  // suite rather than a claim in a commit message.
  const BEFORE = { '1m': 1950, '2m': 975, '3m': 650, '5m': 390, '10m': 78, '15m': 130,
    '30m': 130, '45m': 80, '1h': 120, '2h': 120, '3h': 120, '4h': 60 };
  const rows = [];
  for (const t of INTRA) {
    const url = barsUrl(SYM, t.id);
    let bars = [];
    try {
      const r = await fetch(LIVE + url);
      const j = r.ok ? await r.json() : null;
      bars = j ? (normalizeBars(j, t.id).bars || []) : [];
    } catch { bars = []; }
    const times = bars.map((b) => b.time);
    const dupes = times.length - new Set(times).size;
    const ordered = times.every((x, i) => i === 0 || x > times[i - 1]);
    const span = bars.length > 1 ? Math.round((bars.at(-1).time - bars[0].time) / 86400) : 0;
    rows.push({ id: t.id, n: bars.length, dupes, ordered, span, bars });

    ok(`${t.id} returns bars`, bars.length > 0, `${bars.length}`);
    ok(`${t.id} returns no duplicate timestamps`, dupes === 0, `${dupes} duplicates`);
    ok(`${t.id} is in chronological order`, ordered);
    ok(`${t.id} timestamps are UNIX seconds`, bars.every((b) => typeof b.time === 'number'));
    // ⚠️ DEEPER THAN BEFORE, per interval, with the previous number named.
    ok(`⚠️ ${t.id} is at least as deep as before (${BEFORE[t.id]} bars)`, bars.length >= BEFORE[t.id],
      `now ${bars.length}`);
    ok(`${t.id} clears 500 bars`, bars.length >= 500, `${bars.length}`);

    // The indicator that could not compute before.
    const ctx = { intraday: true, sessionKey: sessionKeyFor(t.id) };
    const un = indicatorAvailability('sma', bars, { length: 200 }, ctx);
    ok(`⚠️ a 200-period SMA is available on ${t.id}`, un === null, un ? un.reason : '');
    const { plots } = computeIndicator('sma', bars, { length: 200 }, ctx);
    ok(`...and produces values on ${t.id}`, (plots[0]?.data?.length || 0) >= 300,
      `${plots[0]?.data?.length || 0} values`);
    // Every indicator value must sit on a real bar, not between them.
    ok(`...each stamped on one of that interval's own bars`,
      plots[0].data.every((d) => times.includes(d.time)));
  }

  // Calendar span grows with the bar size on REAL data too.
  const live = [...rows].sort((a, b) => timeframe(a.id).request.barMinutes - timeframe(b.id).request.barMinutes);
  ok('⚠️ the coarsest interval reaches back much further than the finest, on real data',
    live.at(-1).span > live[0].span * 20, `${live.at(-1).span}d vs ${live[0].span}d`);

  console.log('\n=== INTRADAY DEPTH — before vs after (real routes) ===');
  console.log('tf     before    after   spanDays   SMA200 values');
  for (const r of rows) {
    const ctx = { intraday: true, sessionKey: sessionKeyFor(r.id) };
    const { plots } = computeIndicator('sma', r.bars, { length: 200 }, ctx);
    console.log(`${String(r.id).padEnd(5)} ${String(BEFORE[r.id]).padStart(7)} ${String(r.n).padStart(8)} `
      + `${String(r.span).padStart(10)}   ${String(plots[0]?.data?.length || 0).padStart(6)}`);
  }
}

// ── 7. what is NOT built ──────────────────────────────────────────────────────────────────────
console.log('\n7. what is not built');

// ⚠️ HONEST ABOUT THE GAP. Backward pagination — fetching an older batch as the user scrolls past the
// oldest loaded bar — is NOT implemented. The initial window is now ~1,000 bars and up to 3.8 years on
// 4h, so the wall is much further out, but it is still a wall. This asserts the absence so the claim in
// the report cannot drift from the code: if pagination is added, this fails and gets rewritten.
const cp = read('src/components/chart/CPChart.jsx');
ok('backward pagination is not implemented (stated, not implied)',
  !/prependBars|loadOlder|fetchOlderBars/.test(cp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
