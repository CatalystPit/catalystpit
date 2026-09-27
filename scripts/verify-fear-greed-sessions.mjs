// IS THE INDEX REALLY ONE OBSERVATION PER COMPLETED U.S. EQUITY SESSION?
//
//   node scripts/verify-fear-greed-sessions.mjs
//
// The page publishes this claim: "Daily, after the U.S. equity close. Every component is derived from
// completed daily sessions, so the index is a daily measure and is never presented as intraday."
// The cron, however, runs at 09:20 UTC SEVEN DAYS A WEEK — so on a Saturday it recomputes from
// unchanged data. That is harmless only if a weekend run cannot produce a weekend observation, and
// until now nothing asserted it: the protection was incidental, resting on the candle store happening
// to hold no weekend bars and on the panel-fraction gate happening to reject the two holiday tapes it
// does hold (2022-06-20 with 2 bars, 2026-02-16 with 1). A FULL tape stamped with a Saturday would
// have sailed through, and the index would have minted a session for a day the market never opened.
//
// So this suite pins the guarantee itself, and the comparison semantics that depend on it.

import fs from 'node:fs';
import path from 'node:path';
import { validPanelSessions, rawSeries, indexHistory, buildPayload } from '../src/lib/fear-greed/compute.mjs';
import { COMPARISON_OFFSETS, comparisonsFrom, METHODOLOGY, COMPONENTS } from '../src/lib/fear-greed/model.mjs';
import { isTradingDay, previousTradingDay, marketHolidays } from '../src/lib/market/market-session.mjs';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const dow = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T12:00:00Z`).getUTCDay()];

// ── 1. what counts as a session ────────────────────────────────────────────────────────────────
console.log('\n1. what counts as a session');

// A FULL tape, so the panel-fraction gate has no opinion and only the calendar can reject it. This is
// the exact case the old code let through.
const fullPanel = (dates) => dates.map((date) => ({ date, eligible: 12000, breadth: 0.5, strength: 0.1 }));

// Ten weekdays of reference so the fraction gate is armed, then the date under test.
const REF = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14',
  '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21'];

const keptWith = (extra) => validPanelSessions(fullPanel([...REF, extra])).map((p) => p.date);

ok('a normal weekday session is kept', keptWith('2026-09-22').includes('2026-09-22'));
// ⚠️ THE CASE THAT WAS OPEN. A full tape on a Saturday used to become a session.
ok('⚠️ a Saturday with a FULL tape is rejected', !keptWith('2026-09-26').includes('2026-09-26'));
ok('⚠️ a Sunday with a FULL tape is rejected', !keptWith('2026-09-27').includes('2026-09-27'));

// HOLIDAYS, from the exchange's own rules — a weekday test would have accepted every one of these.
const HOLIDAYS_2026 = [...marketHolidays(2026)].sort();
ok('the calendar knows the 2026 NYSE holidays', HOLIDAYS_2026.length >= 9, HOLIDAYS_2026.join(','));
for (const h of ['2026-11-26', '2026-04-03', '2026-06-19', '2026-02-16', '2026-12-25']) {
  ok(`⚠️ ${h} (${dow(h)}) is a holiday and is rejected even with a full tape`,
    !isTradingDay(h) && !keptWith(h).includes(h));
}
// Thanksgiving is the fourth Thursday and Good Friday moves with Easter: both are weekdays, so this
// is the part a `getDay()` check could never have done.
ok('⚠️ Thanksgiving and Good Friday are WEEKDAYS, so only a real calendar catches them',
  dow('2026-11-26') === 'Thu' && dow('2026-04-03') === 'Fri');

// A rejected date must not join the reference median either, or a run of bad days lowers the bar
// until they qualify.
{
  const withWeekend = validPanelSessions(fullPanel([...REF, '2026-09-26', '2026-09-27', '2026-09-28']));
  ok('a rejected date is not kept', withWeekend.map((p) => p.date).join(',') === [...REF, '2026-09-28'].join(','),
    withWeekend.map((p) => p.date).join(','));
}

// ⚠️ AND IT MUST NOT ENTER THE REFERENCE MEDIAN, which "is it kept" cannot show: with every tape the
// same size, pushing a rejected count into the reference changes the median not at all, so that
// mutation passed. This fixture makes the reference the ONLY thing that can decide the outcome —
// eleven weekend days carrying a tiny tape would, if counted, drag the median down far enough that a
// genuinely broken weekday tape clears the 50% bar.
{
  const weekends = [];
  for (let d = 3; d <= 27; d += 1) {          // every Sat/Sun in September 2026
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    if (!isTradingDay(date)) weekends.push({ date, eligible: 100, breadth: 0.5, strength: 0.1 });
  }
  ok('the fixture has enough weekend days to move a median', weekends.length >= 8, `${weekends.length}`);
  // FIVE weekdays, which is exactly PANEL_REFERENCE_MIN, against nine non-sessions. Polluted, the
  // reference is then majority-100 and its median is 100, so a 500-bar tape clears the 50% bar;
  // clean, the reference is five 12000s and 500 is correctly rejected. That gap is the whole test.
  const fewRef = REF.slice(0, 5);
  const panel = [
    ...fewRef.map((date) => ({ date, eligible: 12000, breadth: 0.5, strength: 0.1 })),
    ...weekends,
    { date: '2026-09-29', eligible: 500, breadth: 0.5, strength: 0.1 },   // a broken weekday tape
  ].sort((a, b) => a.date.localeCompare(b.date));
  const kept = validPanelSessions(panel).map((p) => p.date);
  ok('⚠️ a rejected date never enters the reference, so a run of them cannot lower the bar',
    !kept.includes('2026-09-29'),
    `2026-09-29 carries 500 against a real median of 12000 and must be rejected; kept: ${kept.join(',')}`);
  ok('...while the legitimate sessions are all still kept',
    fewRef.every((d) => kept.includes(d)), kept.join(','));
}

// And a thin weekday tape is still rejected — the fraction gate keeps working alongside the calendar.
{
  const thin = validPanelSessions([...fullPanel(REF), { date: '2026-09-22', eligible: 3, breadth: 0, strength: 0 }]);
  ok('a weekday with an incomplete tape is still rejected', !thin.some((p) => p.date === '2026-09-22'));
}

// ── 2. a rejected date leaves EVERY series, not just the panel's two ──────────────────────────
console.log('\n2. a rejected date leaves every series');

// ⚠️ THE DERIVED SERIES NEED REAL DEPTH OR THIS SECTION PROVES NOTHING. momentumSeries needs a
// 125-session average and volatilitySeries a 21-session window, so a twelve-bar fixture produced
// EMPTY series — and "the Saturday is absent" passed for every one of them because everything was
// absent. A mutation that stopped dropping rejected dates altogether went unnoticed. Each assertion
// below is now paired with a positive control: the series must contain the legitimate sessions.
{
  // 200 real sessions, then a full-tape Saturday spliced in.
  const weekdays = [];
  let cursor = '2026-09-25';
  while (weekdays.length < 200) { weekdays.push(cursor); cursor = previousTradingDay(cursor); }
  weekdays.reverse();
  const SAT = '2026-09-26';
  const dates = [...weekdays, SAT];
  const bars = dates.map((date, i) => ({ date, close: 100 + (i % 17), open: 100, high: 101, low: 99 }));
  const s = rawSeries({
    panel: fullPanel(dates),
    spy: bars,
    volMarket: bars.map((b) => ({ ...b })),
    credit: { risk: bars.map((b) => ({ ...b })), safe: bars.map((b) => ({ ...b })) },
    // ⚠️ `defensive` IS AN ARRAY OF LEGS (IEF, GLD), not a flat bar list — safeHavenSeries checks
    // `d?.length` on each entry, so a flat array of bar objects makes it return nothing and the
    // component silently vanishes from the fixture.
    safeHaven: {
      equity: bars.map((b) => ({ ...b })),
      defensive: [bars.map((b) => ({ ...b, close: b.close * 0.9 })), bars.map((b) => ({ ...b, close: b.close * 1.1 }))],
    },
  });
  for (const key of ['momentum', 'volatility', 'marketvol', 'breadth', 'strength', 'credit', 'safehaven']) {
    const list = s[key] || [];
    // The control first — without it the absence below is meaningless.
    ok(`the ${key} series actually has points to speak about`, list.length > 0, `${list.length}`);
    ok(`...and contains the real sessions around it`,
      list.some((p) => String(p.date) === '2026-09-25') || list.some((p) => String(p.date) === '2026-09-24'),
      `last: ${list.at(-1)?.date}`);
    ok(`⚠️ the rejected Saturday is absent from the ${key} series`,
      !list.some((p) => String(p.date) === SAT));
  }
}

// ── 3. no weekend run can produce a weekend observation ───────────────────────────────────────
console.log('\n3. no weekend run can produce a weekend observation');

// ⚠️ LONG ENOUGH TO ACTUALLY PUBLISH. scoreComponent refuses a component with fewer than
// MIN_WINDOW (504) observations behind it, and it reads that CONSTANT rather than the `window`
// argument — so a short fixture with a small window publishes nothing at all, and every assertion
// about the result then passes or fails against an empty array. The first version of this suite had
// 40 sessions and reported "0 rows" for exactly that reason.
const PUBLISHABLE = 560;

/** A synthetic series long enough to publish: `n` consecutive NYSE sessions ending at `last`. */
function sessionsEndingAt(last, n) {
  const out = [];
  let d = last;
  while (out.length < n && d) {
    out.push(d);
    d = previousTradingDay(d);
  }
  return out.reverse();
}

{
  // A Friday close, with a long enough history for the normalisation window to be satisfied.
  const dates = sessionsEndingAt('2026-09-25', PUBLISHABLE);
  ok('the synthetic calendar contains only trading days', dates.every(isTradingDay));
  ok('...and ends on the Friday', dates.at(-1) === '2026-09-25' && dow('2026-09-25') === 'Fri');

  const mk = (i) => ({ date: dates[i], value: 50 + ((i * 7) % 23) });
  const series = {
    momentum: dates.map((_, i) => mk(i)),
    volatility: dates.map((_, i) => mk(i)),
    marketvol: dates.map((_, i) => mk(i)),
    breadth: dates.map((_, i) => mk(i)),
    strength: dates.map((_, i) => mk(i)),
    credit: dates.map((_, i) => mk(i)),
    safehaven: dates.map((_, i) => mk(i)),
    options: [],
  };
  const history = indexHistory(series);
  ok('the index publishes a row per session', history.length > 0, `${history.length}`);
  // ⚠️ THE CORE CLAIM: no observation falls on a non-session, however often the build runs.
  ok('⚠️ every published observation falls on an NYSE trading day',
    history.every((r) => isTradingDay(r.date)),
    history.filter((r) => !isTradingDay(r.date)).map((r) => r.date).join(','));
  ok('⚠️ the latest observation is the Friday, not the Saturday or Sunday after it',
    history.at(-1).date === '2026-09-25');

  const payload = buildPayload(series);
  // SATURDAY, SUNDAY and MONDAY-BEFORE-THE-NEXT-BUILD are the same payload: nothing about asOf reads
  // a clock, so re-running the build on any of those days yields the same answer.
  ok('⚠️ asOf is the last completed session', payload.asOf === '2026-09-25');
  const again = buildPayload(series);
  ok('⚠️ ...and rebuilding from unchanged data changes nothing',
    again.asOf === payload.asOf && again.score === payload.score);
  // asOf must be derived from the data, never from today's date.
  const compute = read('src/lib/fear-greed/compute.mjs');
  ok('⚠️ asOf comes from the series, never from the clock',
    /asOf: current\?\.date \?\? null/.test(compute));
  ok('...and the only clock reading in the payload is the build timestamp',
    (compute.match(/new Date\(\)/g) || []).length === 1
    && /calculatedAt: new Date\(\)\.toISOString\(\)/.test(compute));

  // MONDAY AFTER the next session: the new observation is Monday's, and Friday becomes previous close.
  const mondayDates = [...dates, '2026-09-28'];
  const extend = (s) => [...s, { date: '2026-09-28', value: 61 }];
  const mondaySeries = Object.fromEntries(Object.entries(series)
    .map(([k, v]) => [k, v.length ? extend(v) : v]));
  const mondayPayload = buildPayload(mondaySeries);
  ok('Monday after its close becomes the new observation', mondayPayload.asOf === '2026-09-28');
  ok('...and the Friday becomes previous close',
    mondayPayload.comparisons.previousClose?.date === '2026-09-25');
  ok('...with no weekend row minted in between',
    !mondayPayload.history.some((p) => ['2026-09-26', '2026-09-27'].includes(p.date)));
  void mondayDates;
}

// ── 4. the comparison points are observation offsets ───────────────────────────────────────────
console.log('\n4. the comparison points are observation offsets');

ok('the offsets are one session, one week and one month of sessions',
  COMPARISON_OFFSETS.previousClose === 1 && COMPARISON_OFFSETS.weekAgo === 5
  && COMPARISON_OFFSETS.monthAgo === 21);

{
  // 30 sessions, each tagged with its own index so the selection is unambiguous.
  const dates = sessionsEndingAt('2026-09-25', 30);
  const obs = dates.map((date, i) => ({ date, score: i, zone: 'FEAR' }));
  const c = comparisonsFrom(obs, (r) => ({ date: r.date, score: r.score, zone: r.zone }));
  const lastIdx = obs.length - 1;
  ok('previous close is the immediately preceding observation', c.previousClose.score === lastIdx - 1);
  ok('a week ago is five observations back', c.weekAgo.score === lastIdx - 5);
  ok('a month ago is twenty-one observations back', c.monthAgo.score === lastIdx - 21);
  // And they are REAL sessions, which is what an offset guarantees and a date subtraction does not.
  for (const [k, v] of Object.entries(c)) ok(`${k} lands on a trading day`, isTradingDay(v.date));

  // ⚠️ A CALENDAR SUBTRACTION WOULD HAVE MISSED. Sep 25 minus 7 days is Sep 18 here, but the point is
  // that the offset holds across a holiday week too — where minus-7 lands on a day with no row.
  const across = sessionsEndingAt('2026-11-30', 30);   // Thanksgiving week: Thu 26th is shut
  const obs2 = across.map((date, i) => ({ date, score: i }));
  const c2 = comparisonsFrom(obs2, (r) => ({ date: r.date, score: r.score }));
  ok('⚠️ across a holiday week, "a week ago" is still five SESSIONS back',
    c2.weekAgo.score === obs2.length - 1 - 5 && isTradingDay(c2.weekAgo.date));
  const gapDays = Math.round(
    (Date.parse(`${across.at(-1)}T12:00:00Z`) - Date.parse(`${c2.weekAgo.date}T12:00:00Z`)) / 86400000);
  ok('⚠️ ...so its CALENDAR gap stretches past seven days rather than landing on a closed market',
    gapDays > 7, `${gapDays} days back to ${c2.weekAgo.date} (${dow(c2.weekAgo.date)})`);
  ok('...and Thanksgiving itself is not in the series', !across.includes('2026-11-26'));

  // A short history yields nulls, never a wrong row.
  const shortC = comparisonsFrom(obs.slice(-3), (r) => ({ date: r.date, score: r.score }));
  ok('too little history yields null rather than the oldest row',
    shortC.previousClose !== null && shortC.weekAgo === null && shortC.monthAgo === null);
  ok('an empty series yields nulls throughout',
    Object.values(comparisonsFrom([], (r) => r)).every((v) => v === null));
}

// ── 5. one selection rule, and the chart shares the series ────────────────────────────────────
console.log('\n5. one selection rule, and the chart shares the series');

const computeSrc = read('src/lib/fear-greed/compute.mjs');
const storeSrc = read('src/lib/fear-greed/store.mjs');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ⚠️ NEITHER PATH MAY CARRY ITS OWN OFFSETS. Both published these three numbers and each had a
// private at(1)/at(5)/at(21); they agreed, but nothing made them agree, so a reader could have seen a
// different "1 week ago" depending on whether the KV cache happened to be warm.
for (const [name, src] of [['compute.mjs', computeSrc], ['store.mjs', storeSrc]]) {
  const code = stripComments(src);
  ok(`${name} selects the comparison points through the shared rule`,
    /comparisonsFrom\(/.test(code));
  ok(`${name} keeps no private offsets`,
    !/at\(1\)/.test(code) && !/at\(5\)/.test(code) && !/at\(21\)/.test(code));
}

{
  const dates = sessionsEndingAt('2026-09-25', PUBLISHABLE);
  const mk = (i) => ({ date: dates[i], value: 40 + ((i * 11) % 31) });
  const series = Object.fromEntries(['momentum', 'volatility', 'marketvol', 'breadth', 'strength',
    'credit', 'safehaven'].map((k) => [k, dates.map((_, i) => mk(i))]));
  series.options = [];
  const p = buildPayload(series);
  // THE CARDS AND THE CHART CANNOT DISAGREE because they are the same array.
  const byDate = new Map(p.history.map((h) => [h.date, h.score]));
  for (const [k, v] of Object.entries(p.comparisons)) {
    if (!v) continue;
    ok(`${k} appears in the history series the chart draws`, byDate.has(v.date));
    ok(`...at the same score`, byDate.get(v.date) === v.score,
      `${k}: card ${v.score} vs chart ${byDate.get(v.date)}`);
  }
  ok('the current observation is the last point of the chart series',
    p.history.at(-1).date === p.asOf && p.history.at(-1).score === p.score);
  ok('the chart series contains no non-session', p.history.every((h) => isTradingDay(h.date)));
}

// ── 6. dates are strings, so no timezone can shift an observation ─────────────────────────────
console.log('\n6. dates are strings, so no timezone can shift an observation');

// ⚠️ THE CLASS OF BUG THIS RULES OUT. `new Date('2026-09-25')` parses as UTC midnight; formatting it
// in any timezone behind UTC prints the 24th. Any date that round-trips through a Date object can
// therefore move by a day. The index never converts one: an observation date is the bar's own string.
ok('isTradingDay takes a string and needs no timezone',
  isTradingDay('2026-09-25') === true && isTradingDay('2026-09-26') === false);
ok('...and is unaffected by the process timezone',
  ['2026-09-25', '2026-11-26', '2026-01-01'].every((d) => isTradingDay(d) === isTradingDay(String(d))));
{
  const dates = sessionsEndingAt('2026-09-25', PUBLISHABLE);
  const mk = (i) => ({ date: dates[i], value: 50 + i });
  const series = Object.fromEntries(['momentum', 'volatility', 'marketvol', 'breadth', 'strength',
    'credit', 'safehaven'].map((k) => [k, dates.map((_, i) => mk(i))]));
  series.options = [];
  const p = buildPayload(series);
  ok('asOf is a plain YYYY-MM-DD string', typeof p.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf));
  ok('every history date is a plain string', p.history.every((h) => typeof h.date === 'string'));
  ok('every comparison date is a plain string',
    Object.values(p.comparisons).filter(Boolean).every((v) => typeof v.date === 'string'));
}
// The renderer prints it verbatim — no Date, no locale, nothing that could add a day.
const meter = read('src/components/FearGreedMeter.jsx');
ok('the gauge prints the session date verbatim', /AS OF \{asOf\} · DAILY/.test(meter));
ok('...with no date arithmetic or locale conversion in the meter',
  !/new Date\(/.test(meter) && !/toLocaleDate/.test(meter));

// ── 7. the withdrawn disclosure is not published ──────────────────────────────────────────────
console.log('\n7. the withdrawn disclosure is not published');

const client = read('src/app/fear-greed/FearGreedClient.jsx');
const route = read('src/app/api/fear-greed/route.js');
ok('the page gates the block on the feature flag',
  /featureEnabled\('fearGreedExclusions'\)/.test(stripComments(client)));
ok('the API stops serving the text while it is off',
  /delete publicMethodology\.excluded/.test(stripComments(route)));
// ⚠️ NOT DELETED. The text stays in the registry, which code comments elsewhere point to.
ok('⚠️ the text is preserved in the methodology registry',
  /excluded: \[/.test(read('src/lib/fear-greed/model.mjs')));
for (const name of ['Implied volatility (VIX)', 'Put/call ratio (options sentiment)',
  'Credit spreads (option-adjusted)']) {
  ok(`...including "${name}"`, read('src/lib/fear-greed/model.mjs').includes(name));
}
// The sections that must survive.
for (const keep of ['updateFrequency', 'normalization', 'composite']) {
  ok(`the ${keep} methodology is still rendered`, client.includes(`m.${keep}`));
}
ok('the component descriptions are still rendered',
  /c\.calculation/.test(client) && /c\.source/.test(client));

// ⚠️ ASSERTED AGAINST THE LIVE REGISTRY, NOT THE FIXTURE. The rendered-page section below reads a
// payload captured from production, so a change to model.mjs cannot move it — two mutations that
// deleted these disclaimers passed there for exactly that reason. The honesty of the methodology has
// to be checked where it is actually defined.
{
  const byLabel = new Map(COMPONENTS.map((c) => [c.label, c]));
  // The two are worded differently — Realized Volatility says "not implied volatility and not the
  // VIX", Market Volatility says "is NOT the VIX and is not implied volatility" — so the shared part
  // is what is matched. An `is not implied volatility` regex found only one of them.
  const vixDisclaimers = COMPONENTS.filter((c) => /not implied volatility/i.test(c.meaning || ''));
  ok('⚠️ both volatility components still say they are not implied volatility or the VIX',
    vixDisclaimers.length === 2 && vixDisclaimers.every((c) => /VIX/.test(c.meaning)),
    vixDisclaimers.map((c) => c.label).join(', '));
  const credit = byLabel.get('Credit Risk Appetite');
  ok('⚠️ Credit Risk Appetite still says it is not a credit-spread measurement',
    /direct measurement of high-yield credit spreads/i.test(credit?.meaning || ''));
  // These four names are the fingerprint the rendered test uses; they must stay unique to the block.
  const renderedSurfaces = [METHODOLOGY.updateFrequency, METHODOLOGY.normalization, METHODOLOGY.composite,
    ...COMPONENTS.flatMap((c) => [c.label, c.calculation, c.source, c.meaning])].join('\n');
  for (const x of METHODOLOGY.excluded) {
    ok(`"${x.name}" appears in no rendered surface, so it is a sound fingerprint`,
      !renderedSurfaces.includes(x.name));
  }
}
ok('the comparison cards are still rendered',
  /previousClose/.test(client) && /weekAgo/.test(client) && /monthAgo/.test(client));

// ── 8. and it is absent from the RENDERED page, not merely gated in source ─────────────────────
console.log('\n8. and it is absent from the rendered page');

// ⚠️ THE FIXTURE STILL CARRIES `excluded`, DELIBERATELY. It was captured from the live API before the
// change, so the methodology object handed to the page DOES contain all four entries. That is the only
// way this proves the PAGE hides them: with the text stripped from the payload as well, the assertion
// would pass because there was nothing to render, and would keep passing if the page gate were
// removed. Both ends are switched off in production; only one of them is under test here.
{
  const { build } = await import('esbuild');
  const { JSDOM } = await import('jsdom');
  const React = (await import('react')).default;
  const { pathToFileURL } = await import('node:url');

  const PAYLOAD = JSON.parse(read('scripts/fixtures/fear-greed-payload.json'));
  ok('the fixture still contains the withdrawn text, so the page gate is what is under test',
    Array.isArray(PAYLOAD.methodology?.excluded) && PAYLOAD.methodology.excluded.length >= 4,
    `${PAYLOAD.methodology?.excluded?.length} entries`);

  const TMP = path.join(ROOT, 'node_modules', '.cache', 'cp-fg');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const stub = (n, body) => { const f = path.join(TMP, n); fs.writeFileSync(f, body); return f; };
  const NAV = stub('nav.mjs', `
export const useRouter = () => ({ push() {}, replace() {}, prefetch() {}, back() {}, refresh() {} });
export const useSearchParams = () => new URLSearchParams();
export const usePathname = () => '/fear-greed';
export const useParams = () => ({});
export const redirect = () => {}; export const permanentRedirect = () => {}; export const notFound = () => {};
export default {};`);
  const CLERK = stub('clerk.mjs', `
export const SignedIn = () => null; export const SignedOut = ({ children }) => children ?? null;
export const UserButton = () => null;
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ isLoaded: true, isSignedIn: false, user: null });
export const useClerk = () => ({ signOut: async () => {}, openUserProfile: () => {} });
export const ClerkProvider = ({ children }) => children ?? null;
export default {};`);

  const out = path.join(TMP, 'FearGreedClient.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/app/fear-greed/FearGreedClient.jsx')],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    logLevel: 'silent', absWorkingDir: ROOT,
    alias: { 'next/navigation': NAV, '@clerk/nextjs': CLERK },
  });

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://catalystpit.test/fear-greed', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillRect() {}, setLineDash() {}, fillText() {}, arc() {}, closePath() {},
    measureText: () => ({ width: 20 }), roundRect() {}, rect() {}, clip() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  window.fetch = async (u) => (String(u).includes('/api/fear-greed')
    ? { ok: true, status: 200, json: async () => PAYLOAD }
    : { ok: true, status: 200, json: async () => ({}) });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
    'Event', 'SVGElement', 'devicePixelRatio', 'fetch', 'localStorage']) {
    try { globalThis[k] = window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { act } = await import('react');
  const ReactDOMClient = await import('react-dom/client');
  const Client = (await import(pathToFileURL(out).href)).default;
  const container = window.document.getElementById('root');
  let mountError = null;
  const root = ReactDOMClient.createRoot(container, { onUncaughtError: (e) => { mountError = mountError || e; } });
  await act(async () => { root.render(React.createElement(Client)); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

  ok('the Fear & Greed page mounts', !mountError,
    mountError ? `${mountError.name}: ${mountError.message}` : '');

  // The methodology panel is collapsed behind a toggle on this page, so it is opened first — a
  // collapsed panel would make every absence below pass without the flag doing anything.
  const buttons = [...container.querySelectorAll('button')];
  const toggle = buttons.find((b) => /methodolog/i.test(b.textContent || ''));
  if (toggle) await act(async () => { toggle.click(); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });

  const text = container.textContent || '';
  const html = container.innerHTML || '';

  // ⚠️ THE POSITIVE CONTROL. Every assertion below is an absence, and an absence passes trivially
  // against a page that rendered nothing or never opened the panel.
  ok('...and reached its loaded state', /FEAR/.test(text) && text.length > 400, `${text.length} chars`);
  ok('...with the methodology panel actually open (the sections that must stay are present)',
    /Update frequency/i.test(text) && /Normalisation/i.test(text) && /Composite/i.test(text),
    'the panel did not open, so the absences below would be vacuous');

  ok('⚠️ the heading is absent from the rendered page', !/DELIBERATELY DO NOT INCLUDE/i.test(text));

  // ⚠️ THE EXACT ENTRY NAMES, NOT LOOSE PHRASES. An earlier version of this asserted that "Implied
  // volatility", "Credit spreads" and "Safe-haven demand" appeared nowhere, and failed — on text that
  // must stay. Two component descriptions say the component is NOT the VIX and NOT implied
  // volatility, Credit Risk Appetite says it is NOT a credit-spread measurement, and Safe-Haven
  // Demand is a live component with that name on its own card. Those disclaimers are the honest part
  // of the methodology and the brief keeps them. The parenthesised entry names are unique to the
  // withdrawn block, which is what makes them the right fingerprint — asserted below to appear in no
  // other rendered surface, so this cannot quietly become vacuous.
  const EXCLUDED_NAMES = (PAYLOAD.methodology.excluded || []).map((x) => x.name);
  ok('the fixture names all four withdrawn entries', EXCLUDED_NAMES.length === 4, EXCLUDED_NAMES.join(' | '));
  for (const name of EXCLUDED_NAMES) {
    ok(`⚠️ "${name}" is absent from the rendered page`, !text.includes(name));
  }
  // The distinctive prose of each entry, in case an entry is ever renamed.
  for (const x of (PAYLOAD.methodology.excluded || [])) {
    const snippet = String(x.why).split('.')[0].slice(0, 60);
    ok(`⚠️ ...and so is its explanation ("${snippet.slice(0, 34)}…")`, !text.includes(snippet), snippet);
  }
  // ⚠️ AND THE COMPONENT DISCLAIMERS ARE STILL THERE. If the flag were implemented by stripping these
  // phrases from the page wholesale, the absences above would pass and the methodology would have
  // quietly lost its most important honesty.
  // ⚠️ THE SENTENCE, NOT A PHRASE THAT RECURS. "credit spreads" alone also appears in neighbouring
  // wording, so removing this disclaimer left the loose assertion green.
  ok('the "not the VIX / not implied volatility" disclaimer survives',
    /is not implied volatility/i.test(text) && /no entitled source for the/i.test(text));
  ok('the "not a direct measurement of high-yield credit spreads" disclaimer survives',
    /direct measurement of high-yield credit spreads/i.test(text));
  ok('the Safe-Haven Demand component is still on the page', /Safe-Haven Demand/i.test(text));
  // NOT RENDERED, not hidden: no element carrying the text exists at all, so there is nothing for a
  // stylesheet to reveal and nothing in the accessibility tree.
  ok('⚠️ it is not merely hidden with CSS',
    !/display:\s*none/i.test(html) && !/visibility:\s*hidden/i.test(html));
  ok('...and no element in the DOM carries the withdrawn text',
    ![...container.querySelectorAll('*')].some((n) => /DELIBERATELY DO NOT INCLUDE/i.test(n.textContent || '')));

  // WHAT MUST SURVIVE, asserted on the same render.
  for (const keep of ['PREVIOUS CLOSE', '1 WEEK AGO', '1 MONTH AGO']) {
    ok(`"${keep}" still renders`, text.includes(keep));
  }
  ok('the component methodology still renders', /Calculation\./.test(text) && /Source\./.test(text));
  ok('the AS OF session date still renders', new RegExp(`AS OF ${PAYLOAD.asOf}`).test(text),
    PAYLOAD.asOf);
  ok('...and it is the Friday session, not a weekend date', isTradingDay(PAYLOAD.asOf));
  ok('every component card still renders',
    (PAYLOAD.components || []).every((c) => text.includes(c.label)));
}

console.log(`\n${pass} passed, ${fail} failed`);
void METHODOLOGY;
process.exit(fail ? 1 : 0);
