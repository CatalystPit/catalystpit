// PIPELINE LIVENESS — do the daily research clocks actually tick, and can we tell?
//
// ── THE FAILURE THIS EXISTS TO CATCH ────────────────────────────────────────
//
// Freshness is not liveness. On a Sunday every SEC-derived dataset is correctly three days old,
// which is indistinguishable from an ingest that has been throwing since Friday. Form 4's cron
// even returns HTTP 200 on failure by design, so a permanently broken insider feed looked healthy
// from outside. The heartbeats in lib/job-heartbeat.js record that a job RAN, separately from what
// it found, and these assertions keep that wiring honest.
//
// Runs offline by default (structure only). With DATABASE_URL it additionally asserts the LIVE
// last-success age of every tracked job:
//
//   node scripts/verify-pipelines.mjs                       # structure
//   node --env-file=.env.local scripts/verify-pipelines.mjs # structure + live heartbeats
//
// Run with --mutate=<mode> to confirm an assertion actually fails when the rule is broken.

import fs from 'node:fs';
import path from 'node:path';
import { isIngestableTicker, isRenderableTicker } from '../src/lib/security-identity.mjs';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const ROOT = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');

// lib/job-heartbeat.js imports ./db, which drags in the Clerk/Next server runtime, so TRACKED_JOBS
// is read out of the source and evaluated on its own — the same approach verify-launch-integrity
// uses for ALERT_TYPES. This asserts against the real table, not a copy that can drift.
function trackedJobs() {
  const src = read('src/lib/job-heartbeat.js');
  const start = src.indexOf('export const TRACKED_JOBS = Object.freeze([');
  if (start < 0) throw new Error('TRACKED_JOBS not found');
  const open = src.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(open, end)}`)();
}

const JOBS = trackedJobs();
const heartbeatLib = read('src/lib/job-heartbeat.js');
const vercel = JSON.parse(read('vercel.json'));

// Every file that could plausibly record a heartbeat.
function allApiSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|jsx)$/.test(e.name)) out.push({ p, s: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(new URL(ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'src/app/api'));
  return out;
}
const API = allApiSources();
const ALL_API_SRC = API.map((f) => f.s).join('\n');

L('=== EVERY TRACKED JOB IS ACTUALLY WIRED ===');
{
  ok('there are tracked jobs at all', JOBS.length >= 8, String(JOBS.length));
  for (const j of JOBS) {
    // A job in the table with no call site is a heartbeat that will read "never" forever and be
    // quietly explained away as "that one just hasn't run yet".
    // ⚠️ THE NAME MAY REACH recordJobRun THROUGH A WRAPPER, AND ONE DOES. screener-technicals routes both
    // its own beat and market-breadth's through a local `beat()` helper whose entire purpose is that
    // telemetry must never throw into a 118-second job — so matching `recordJobRun('screener-technicals'`
    // reported an unwired job that has been reporting ok every night. Production showed
    // {"days":260,"tickers":13135} while this said it had no call site.
    //
    // So: the name must appear as a quoted first argument to SOME heartbeat call, in a file that actually
    // imports recordJobRun. That keeps the assertion honest — a bare mention in a comment or a string
    // elsewhere still does not count — without insisting the call be unwrapped.
    const beatCall = new RegExp(`(recordJobRun|beat|heartbeat|recordRun)\\(\\s*['"\`]${j.name}['"\`]`);
    const wired = API.some((f) => f.s.includes('recordJobRun') && beatCall.test(f.s));
    ok(`${j.name} records a heartbeat somewhere`, mut('unwired') ? false : wired);
  }
  // And the reverse: a call site naming a job that is not tracked never gets read.
  const called = [...ALL_API_SRC.matchAll(/recordJobRun\(\s*['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]);
  const names = new Set(JOBS.map((j) => j.name));
  const orphan = [...new Set(called)].filter((c) => !names.has(c));
  ok('no heartbeat is written under an untracked name',
    mut('orphan') ? false : orphan.length === 0, orphan.join(', '));
}

L('\n=== EVERY TRACKED JOB HAS A CRON THAT COULD TICK IT ===');
{
  const paths = (vercel.crons || []).map((c) => c.path);
  // job name → the cron path(s) that drive it. A job with no schedule cannot have a heartbeat.
  //
  // ⚠️ THIS MAP WENT STALE SILENTLY, WHICH IS THE WORST BEHAVIOUR A HAND-KEPT LIST CAN HAVE. It listed
  // eleven jobs; TRACKED_JOBS has grown to twenty-four. Every job added since — fear-greed,
  // market-breadth, score-conviction, screener, screener-technicals, institutions-ownership, dividends,
  // primary-sources, halts and the two webhooks — fell through to `want = []` and reported "is not on the
  // cron schedule" about jobs that have run on schedule for weeks. Thirteen false alarms, and a suite
  // nobody can read is a suite nobody runs.
  //
  // So the shape changed: a job must be driven by a cron OR declared event-driven, and the LIST is now
  // checked for completeness against TRACKED_JOBS, so the next addition fails loudly here instead of
  // quietly joining the pile.
  const DRIVEN_BY = {
    form4: ['/api/refresh?form4=1'],
    eightk: ['/api/cron/eightk'],
    'congress-sync': ['/api/cron/congress-sync'],
    institutions: ['/api/cron/institutions-universe'],
    'consensus-board': ['/api/cron/consensus-board'],
    quotes: ['/api/refresh'],
    alerts: ['/api/cron/alerts'],
    'insider-alerts': ['/api/cron/insider-alerts'],
    'evidence-alerts': ['/api/cron/evidence-alerts'],
    'refresh-content': ['/api/refresh-content'],
    'heatmap-gate': ['/api/cron/heatmap-gate'],
    'fear-greed': ['/api/cron/fear-greed'],
    'market-breadth': ['/api/cron/market-breadth'],
    'score-conviction': ['/api/cron/score-conviction'],
    screener: ['/api/cron/screener'],
    'screener-technicals': ['/api/cron/screener-technicals'],
    'institutions-ownership': ['/api/cron/institutions-ownership'],
    dividends: ['/api/cron/dividends'],
    'primary-sources': ['/api/cron/primary-sources'],
    // ⚠️ HALTS HAVE NO CRON OF THEIR OWN, BY DESIGN AND BY NECESSITY. vercel.json sits at the Vercel Pro
    // cap of 40, so the halt sweep rides the every-minute wire job while keeping its OWN heartbeat —
    // a shared schedule with a separate health signal. Asserting it must appear in the cron list would
    // demand a 41st cron; asserting it is driven by the wire's path states what is actually true.
    halts: ['/api/cron/primary-sources'],
  };
  // ⚠️ NO CADENCE TO BE LATE AGAINST, so demanding a cron for these is demanding the wrong thing. They
  // fire when a human subscribes or signs up, which at launch may be days apart.
  const EVENT_DRIVEN = new Set(['stripe-webhook', 'clerk-webhook']);

  for (const j of JOBS) {
    if (EVENT_DRIVEN.has(j.name)) {
      ok(`${j.name} is event-driven, and says so in its own definition`,
        j.eventDriven === true, JSON.stringify(j));
      ok(`  …and declares no silence budget it could not meet`, j.maxAgeHours == null,
        String(j.maxAgeHours));
      continue;
    }
    const want = DRIVEN_BY[j.name] || [];
    ok(`${j.name} is on the cron schedule`,
      mut('nocron') ? false : want.length > 0 && want.some((w) => paths.includes(w)),
      want.length ? want.join(',') : 'not listed in DRIVEN_BY — add it');
  }
  // ⚠️ THE COMPLETENESS CHECK IS THE POINT. Without it the map decays again the next time a job is added.
  const unaccounted = JOBS.filter((j) => !EVENT_DRIVEN.has(j.name) && !DRIVEN_BY[j.name]).map((j) => j.name);
  ok('⚠️ every tracked job is accounted for as cron-driven or event-driven',
    unaccounted.length === 0, unaccounted.join(', '));
  // …and nothing is claimed that does not exist: a path in the map must be a real cron.
  const phantom = Object.entries(DRIVEN_BY).filter(([, ps]) => !ps.some((p) => paths.includes(p)));
  ok('⚠️ …and no job claims a cron path that is not in vercel.json',
    phantom.length === 0, phantom.map(([n]) => n).join(', '));
}

L('\n=== THE SILENCE BUDGETS ARE SANE ===');
{
  // ⚠️ AN EVENT-DRIVEN JOB MUST *NOT* DECLARE ONE, so this demanded the opposite of the design for two of
  // them. A silence budget on the Stripe webhook would report a quiet signup week as an outage — calling a
  // quiet source a broken one, which is the mistake this whole file exists to catch elsewhere. They are
  // judged on consecutive failures instead, and that is asserted above.
  for (const j of JOBS) {
    if (j.eventDriven) {
      ok(`${j.name} declares NO window, because it has no cadence`, j.maxAgeHours == null);
      continue;
    }
    ok(`${j.name} declares a positive window`, Number.isFinite(j.maxAgeHours) && j.maxAgeHours > 0);
  }
  // ⚠️ A WINDOW MUST BE LONGER THAN THE CRON INTERVAL, or the job is "late" between every run.
  const perMinute = JOBS.filter((j) => ['form4', 'quotes'].includes(j.name));
  ok('per-minute jobs still get an hour of grace',
    perMinute.every((j) => j.maxAgeHours >= 1), JSON.stringify(perMinute.map((j) => [j.name, j.maxAgeHours])));
  // 13F is quarterly by nature — a tight window here would page every week for nothing.
  const inst = JOBS.find((j) => j.name === 'institutions');
  ok('13F gets a day, because it is quarterly by nature',
    mut('tight13f') ? false : inst.maxAgeHours >= 24, String(inst?.maxAgeHours));
  // Weekday-only crons must be declared, or a Sunday check reports them as broken.
  const weekdayOnly = JOBS.filter((j) => j.weekdaysOnly).map((j) => j.name);
  ok('weekday-only jobs are marked as such',
    mut('unmarked') ? false : weekdayOnly.includes('alerts') && weekdayOnly.includes('refresh-content'),
    weekdayOnly.join(', '));
}

L('\n=== A HEARTBEAT CAN NEVER BREAK THE JOB IT DESCRIBES ===');
{
  // Bookkeeping must not turn a successful ingest into a 500.
  ok('recordJobRun swallows its own errors',
    mut('throws') ? false : /catch \(e\) \{\s*\n\s*console\.log\(`\[heartbeat\]/.test(heartbeatLib));
  ok('…and only a successful run moves the success clock',
    /last_success_at = case when \$\{!!ok\} then now\(\) else feed_state\.last_success_at end/.test(heartbeatLib));
  ok('…while a failure increments the failure count',
    /consecutive_failures = case when \$\{!!ok\} then 0 else feed_state\.consecutive_failures \+ 1 end/.test(heartbeatLib));
  // It reuses the existing table rather than inventing a second source of truth.
  ok('heartbeats live in the existing feed_state table',
    mut('newtable') ? false : /insert into feed_state/.test(heartbeatLib));
  ok('…namespaced so they cannot collide with a feed key',
    /export const jobKey = \(name\) => `job:/.test(heartbeatLib));

  // ⚠️ THE READ MUST NOT BIND A JS ARRAY. Drizzle's sql template does not map a JS array onto a
  // Postgres text[], so `feed_key = any(${keys})` threw instantly in production and /api/health
  // reported `probe_failed` for liveness — the check whose entire purpose is noticing silence
  // was itself silently broken, and it looked like a missing feature rather than a bug.
  ok('the heartbeat read does not bind a JS array into any()',
    mut('anybinding') ? false : !/any\(\$\{/.test(heartbeatLib));
  ok('…it selects the job namespace directly', /like 'job:%'/.test(heartbeatLib));

  // ⚠️ THE FORM 4 CRON RETURNS 200 ON FAILURE BY DESIGN. The heartbeat is the ONLY record of that
  // failure, so it must not be skipped in the catch.
  const refresh = read('src/app/api/refresh/route.js');
  // The 200-on-failure return, and the failure heartbeat that must precede it in the same catch.
  const ret200 = refresh.indexOf("return Response.json({ form4: true, error: e.message }, { status: 200 })");
  const failBeat = refresh.indexOf("recordJobRun('form4', { ok: false");
  ok('a failing Form 4 run records a FAILED heartbeat despite answering 200',
    mut('silentform4') ? false : failBeat > 0 && ret200 > failBeat && (ret200 - failBeat) < 400,
    `beat@${failBeat} return@${ret200}`);
}

L('\n=== /api/health REPORTS LIVENESS SEPARATELY FROM FRESHNESS ===');
{
  const health = read('src/app/api/health/route.js');
  ok('health reads the heartbeats', /readJobHeartbeats\(\)/.test(health));
  // ⚠️ LINE-ENDING AGNOSTIC. This was /\n    jobs,\n/ and passed for days, then failed the moment
  // a git checkout rewrote the file with CRLF — the code was identical, the assertion was not.
  // A test that depends on how the working tree happens to store newlines reports on the checkout,
  // not on the product.
  ok('…and reports them as their own block',
    mut('foldedin') ? false : /^\s*jobs,\s*$/m.test(health));
  // A weekday-only job at the weekend is idle, not late — otherwise the check cries wolf every
  // Saturday and gets ignored by Monday.
  ok('a weekday-only job is idle-by-design at the weekend',
    mut('cryingwolf') ? false : /idle_by_design/.test(health) && /getUTCDay\(\)/.test(health));
  ok('…and a job that has never run is not reported as an outage',
    /state: b == null \? 'never'/.test(health));
}

L('\n=== THE NEWS FEED RANKS BEFORE IT SLICES ===');
{
  // The curated pool expires nightly and all weekend, which silently made the raw PR wire the
  // hero. Signed-out visitors only ever receive the first six elements, so the ranking has to
  // happen server-side — client-side sorting could never reach a story sitting at index 20.
  // The sort itself now lives in lib/impact.js as rankByImpact, so the homepage snapshot cron and
  // this route cannot order the same pool by two different rules — which is exactly what they
  // were doing while the News page led with FOMC minutes and the front door led with a
  // credit-card column. These assert the route still ranks, and still ranks first.
  const news = read('src/app/api/news/route.js');
  const rankAt = news.indexOf('rankByImpact');
  const sliceAt = news.indexOf('raw.slice(0, SIGNED_OUT_VISIBLE)');
  ok('the feed is ranked by impact', mut('noranking') ? false : rankAt > 0);
  ok('…before the signed-out slice', mut('slicefirst') ? false : rankAt > 0 && rankAt < sliceAt);
  ok('…using the same shared desk the High-impact filter uses',
    /from '\.\.\/\.\.\/\.\.\/lib\/impact'/.test(news));
  // Ranking each pool separately and concatenating is what preserves curated-before-wire.
  //
  // ⚠️ PINNED TO THE ORDER, NOT TO THE LITERAL LINE. This read the exact text
  // `[...rankByImpact(raw), ...rankByImpact(wire)]`, so adding a THIRD, more material tier above
  // them — issuer 8-K filings — failed an assertion whose actual subject (curated still beats
  // wire) was never violated. An assertion that breaks when correct code is extended is
  // measuring the spelling of the implementation rather than the guarantee.
  // The concatenation is the assignment that actually ranks — `let raw = []` on line 48 matches a
  // looser pattern first and captures nothing, which made both assertions below fail on correct
  // code. Anchored on rankByImpact so it can only select the real one.
  const concat = /raw\s*=\s*\[([^\]]*rankByImpact[^\]]*)\]/.exec(news)?.[1] || '';
  const posOf = (pool) => concat.indexOf(`rankByImpact(${pool})`);
  ok('curated stories still outrank the wire',
    mut('wirefirst') ? false : posOf('raw') > -1 && posOf('wire') > -1 && posOf('raw') < posOf('wire'),
    concat.trim());
  // …and the material issuer filings lead both, which is what makes High Impact answerable:
  // the publisher pools carry no ticker, so impactOf's rule (A) can never fire on them.
  ok('material 8-K filings lead the column',
    mut('nofilings') ? false : posOf('filings') > -1 && posOf('filings') < posOf('raw'));
  // ⚠️ RANKING, NOT FILTERING. Nothing may be dropped — the routine items stay, lower down.
  ok('nothing is filtered out of the feed',
    mut('drops') ? false : !/\.filter\(\s*\(?a\)?\s*=>\s*impactOf/.test(news));
  ok('the payload says how the feed was composed',
    /curatedCount:/.test(news) && /wireCount:/.test(news));
}

L('\n=== A PLACEHOLDER TICKER CANNOT REACH insider_trades ===');
{
  // Form 4 has an issuerTradingSymbol field and an unlisted issuer's filer types NONE into it.
  // The live parser's only test was `if (!ticker)`, so 1,220 unusable rows accumulated — public
  // surfaces gated them at RENDER, which is downstream of the write and therefore invisible.
  const placeholders = ['NONE', 'N/A', 'NULL', 'UNKNOWN', 'UNDEFINED', 'NIL', 'TBD', '', '   '];
  for (const p of placeholders) {
    ok(`"${p}" is refused at ingest`, mut('acceptsplaceholder') ? false : !isIngestableTicker(p));
  }
  // Not one symbol at all — a filer typing two symbols, an exchange prefix or a parenthetical.
  for (const m of ['Z AND ZG', 'NYSE: VTEX', 'GEF, GEF-B', 'ASX:LNW', '(CALX)', 'MOGA/MOGB', '$FEED', 'ASTS?', '1314152']) {
    ok(`"${m}" is refused at ingest`, mut('acceptsmalformed') ? false : !isIngestableTicker(m));
  }
  ok('a non-string is refused', !isIngestableTicker(null) && !isIngestableTicker(undefined) && !isIngestableTicker(42));

  // ⚠️ AND THE GATE MUST NOT EAT REAL FILINGS. Gating on the CARD rule instead would have deleted
  // 391 rows of AXIA3 plus BRK.A, NYT.A, SBSP3 — measured against the live table before choosing.
  for (const good of ['AAPL', 'A', 'BRK.A', 'BRK-B', 'NYT.A', 'AXIA3', 'SBSP3', 'PHXE.P', 'CFTR-PRA', 'ALLKGUSD']) {
    ok(`"${good}" is still accepted`, mut('toostrict') ? false : isIngestableTicker(good));
  }
  ok('the ingest gate is looser than the card gate',
    isIngestableTicker('AXIA3') && !isRenderableTicker('AXIA3'));

  // Both gates, at both ends of the pipe.
  const refresh = read('src/app/api/refresh/route.js');
  ok('the LIVE Form 4 parser applies the gate',
    mut('ungatedparser') ? false : /if \(!isIngestableTicker\(ticker\)\) return \[\];/.test(refresh));
  ok('…and the insert applies it again, as the last door in',
    mut('ungatedinsert') ? false : /\.filter\(r => isIngestableTicker\(r\.ticker\)\)/.test(refresh));
  ok('…and counts what it refused rather than dropping silently',
    /rejected \$\{lastInsiderReject\}|lastInsiderReject = rejected/.test(refresh));

  // The render-time gates that were the ONLY defence stay exactly where they are.
  for (const [surface, file] of [
    ['homepage', 'src/components/CatalystPit.jsx'],
    ['pit snapshot', 'src/app/api/cron/pit-snapshot/route.js'],
    ['evidence', 'src/app/api/evidence/route.js'],
  ]) {
    ok(`${surface} still gates on render too`, /isRenderableTicker/.test(read(file)));
  }

  // ⚠️ /api/insiders WAS THE HOLE. Every other ticker-facing surface gated; the one list whose
  // whole subject is insider filings did not, and was serving the original defect by accession:
  // "NONE · $9.8M · 5C Lending Partners Corp · LIBERTY MUTUAL HOLDING Co INC.". Rows already in
  // the table outlive an ingest gate, so the READ needs its own guard.
  const ins = read('src/app/api/insiders/route.js');
  ok('the insiders route defines a symbol guard',
    mut('ungatedinsiders') ? false : /const TICKER_IS_A_SYMBOL = sql`/.test(ins));
  ok('…it rejects the placeholder strings in SQL',
    /not in\s*\n?\s*\('NONE','NULL','N\/A'/.test(ins));
  ok('…and requires the symbol shape', /\^\[A-Z\]\[A-Z0-9\]\*\(\[\.-\]\[A-Z0-9\]\+\)\*\$/.test(ins));
  // Applied to every view that returns rows, not just the main one.
  const guards = (ins.match(/TICKER_IS_A_SYMBOL/g) || []).length;
  ok('…and is applied to every insider query, not only the list',
    mut('onequery') ? false : guards >= 5, `${guards} references`);
  // It must be a base condition: a filter a query string can switch off is not a guard.
  ok('…as a base condition no query string can disable',
    mut('optionalguard') ? false : /conds\.push\(TICKER_IS_A_SYMBOL\);/.test(ins));
}

L('\n=== THE WEEKEND NEWS GAP IS CLOSED ===');
{
  const paths = (vercel.crons || []).filter((c) => c.path === '/api/refresh-content').map((c) => c.schedule);
  ok('the weekday enrichment cron is unchanged', paths.includes('0 13-21 * * 1-5'));
  // top_stories carries a 4h TTL; a 4-hourly cron would re-write it exactly as it expires, so any
  // late run leaves the feed with no curated stories — the failure the schedule exists to remove.
  ok('…and a weekend cron exists', mut('noweekend') ? false : paths.some((p) => /\* \* 6,0$/.test(p)));
  const weekend = paths.find((p) => /\* \* 6,0$/.test(p)) || '';
  const everyN = Number((weekend.match(/^0 \*\/(\d+) /) || [])[1] || 99);
  ok('…running more often than the 4-hour TTL expires',
    mut('ttlrace') ? false : everyN > 0 && everyN < 4, `every ${everyN}h`);

  const rc = read('src/app/api/refresh-content/route.js');
  ok('the run budget is written down where vercel.json cannot carry it',
    mut('nobudget') ? false : /runs\/week/.test(rc) && /Haiku calls/.test(rc));
  // A kill switch for the only job here that spends money — unset means ON, so it changes nothing.
  ok('an enrichment kill switch exists', /NEWS_ENRICH_ENABLED/.test(rc));
  ok('…and defaults to ON when unset',
    mut('defaultoff') ? false : /process\.env\.NEWS_ENRICH_ENABLED !== 'false'/.test(rc));
  ok('…and a skipped run is never recorded as a healthy tick',
    mut('skipisok') ? false : /recordJobRun\('refresh-content', \{ ok: false, note: 'disabled/.test(rc));
}

L('\n=== THE CLASSIFICATION ALARM MEASURES WHAT IT CLAIMS ===');
{
  const health = read('src/app/api/health/route.js');
  // ⚠️ THE THRESHOLD MUST NOT MOVE. Making a red light green by lowering the bar is the failure
  // this assertion exists to prevent; the fix was the denominator, not the standard.
  ok('the 8% threshold is unchanged',
    mut('raisedbar') ? false : /ok: pctWeight < 8,/.test(health));
  // ⚠️ THE EXCLUSION THIS ASSERTED WAS ITSELF THE BUG, AND IT WAS REVERSED ON PURPOSE. ADRC was kept out
  // of the denominator on the reasoning that a depositary receipt is not an operating company with a SIC
  // — wrong on the facts (foreign issuers file 20-F and EDGAR assigns them a SIC) and in direct
  // contradiction with the board the probe protects, since TRADEABLE_ASSET_TYPES is ['Stock','ADRC'].
  // The consequence was an alarm that could not ring: 113 of the Top 500 rendered as "Other" — TSM,
  // HSBC, BABA, SAP, BP, NVS, SONY, UBS, ING, BHP — while the probe stayed green, because every one of
  // them was outside its denominator by construction. Demanding that exclusion back would be demanding a
  // decorative check.
  //
  // What must hold now: the denominator is the population the heatmap actually draws, and that
  // population is not hand-listed in the probe but read from the board's own constant, so the two cannot
  // diverge again.
  ok('⚠️ the denominator is the population the board actually draws',
    mut('nodenominator') ? false
      : /coalesce\(m\.asset_type, ''\) = any\(\$\{sql`\$\{`\{\$\{TRADEABLE_ASSET_TYPES\.join\(','\)\}\}`\}::text\[\]`\}\)/.test(health)
        && /import \{ TRADEABLE_ASSET_TYPES \} from '\.\.\/\.\.\/\.\.\/lib\/heatmap\/heatmap-universe\.mjs';/.test(health));
  ok('⚠️ …so ADRs are INSIDE it, not excluded from the alarm that covers them',
    /is_adr/.test(health) && !/'ADRC','FUND','ETF','ETV','WARRANT'/.test(health));
  ok('…and the ADR population is still reported as itself, not averaged away',
    mut('hidesadrs') ? false : /adrs: \{ total: r\.adrs, unclassified: r\.adrs_unclassified \}/.test(health));
  ok('…and the scope is stated in the response', /scope: `heatmap-eligible securities \(/.test(health));
  // No SIC code may be invented for a security that structurally lacks one.
  ok('no SIC code is fabricated',
    !/sector\s*=\s*'|coalesce\(sector,\s*'[A-Za-z]/.test(health));
}

// ── LIVE HEARTBEAT AGES (only with DATABASE_URL) ────────────────────────────
if (process.env.DATABASE_URL) {
  L('\n=== LIVE: EVERY CLOCK TICKED INSIDE ITS WINDOW ===');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql.query(
    `select feed_key, last_success_at, consecutive_failures, note from feed_state where feed_key like 'job:%'`);
  const beats = new Map(rows.map((r) => [String(r.feed_key).replace(/^job:/, ''), r]));
  const weekend = [0, 6].includes(new Date().getUTCDay());

  for (const j of JOBS) {
    const b = beats.get(j.name);
    if (!b) {
      // Not a failure: the heartbeat only exists once the job has run since this shipped.
      L(`  --   ${j.name} has no heartbeat yet (not deployed long enough)`);
      continue;
    }
    const age = (Date.now() - new Date(b.last_success_at).getTime()) / 36e5;
    if (j.weekdaysOnly && weekend) {
      L(`  --   ${j.name} idle by design (weekday-only cron, today is a weekend)`);
      continue;
    }
    ok(`${j.name} succeeded within ${j.maxAgeHours}h`,
      Number.isFinite(age) && age <= j.maxAgeHours, `${age.toFixed(1)}h ago`);
  }
} else {
  L('\n(skipping live heartbeat ages — no DATABASE_URL; run with --env-file=.env.local)');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
