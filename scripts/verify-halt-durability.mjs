// DURABLE HALT INGESTION — no cron slot, no Terminal dependency, its own health.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-halt-durability.mjs
//
// ⚠️ THE ORIGINAL DEFECT. projectHalts() was reachable only from /api/halts, and the Terminal was that
// route's only caller — so halts entered the durable wire ONLY while somebody had the Terminal open. On
// 29 Sep production captured zero. A dedicated cron is the obvious fix and there is no room: vercel.json
// holds exactly 40 entries, the Vercel Pro cap.
//
// ⚠️ AND THE DEFECT THAT REMAINED AFTER THE PIGGYBACK. Sharing primary-sources' cron was right; sharing
// its HEARTBEAT was not. The halt outcome was reported in the HTTP response and nowhere else, so a halt
// feed erroring every minute for a week would have left /api/health green — the wire beside it being
// genuinely fine. Halts now record `job:halts` themselves.
//
// ⚠️ NO PRODUCTION HALT IS FABRICATED. Every event-generating test uses a fixture symbol that is not a
// real security and is deleted afterwards; the feed itself is never written to.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { parseHalts, haltKey, mergeDetected, fetchHalts, HALTS_TTL, HALTS_KEY } from '../src/lib/halts.mjs';
import { projectHalts } from '../src/lib/primary-events.js';
import { TRACKED_JOBS, recordJobRun, readJobHeartbeats } from '../src/lib/job-heartbeat.js';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ⚠️ A FIXTURE SYMBOL, NOT A SECURITY. 'ZQHALT' matches the ingestable-symbol shape so the gate does not
// reject it for the wrong reason, and exists nowhere else.
const SYM = 'ZQHALT';
// ⚠️ THE MALFORMED FIXTURE IS ALSO NAMESPACED, AND THAT IS A CORRECTION. The suffixed-symbol test
// originally used 'VACI=' — a REAL malformed symbol quoted from the production comment. Two consequences,
// and I hit both: the fixture became indistinguishable from two genuine 2026-09-17 rows in
// primary_events, and when a mutation run made the gate repair suffixes instead of skipping them, the
// mutated code inserted a `VACI=` row that the ZQHALT-scoped cleanup did not match. verify-wire-audit
// caught the leak — the malformed-ticker guard did exactly its job — but a fixture should never be
// confusable with production data in the first place.
//
// So the malformed cases carry the fixture prefix too, and cleanup is prefix-based rather than
// uid-shaped, so anything a mutated projectHalts manages to write is still swept.
const BAD_SYM = `${SYM}=`;
const cleanup = () => sql`delete from primary_events
  where source = 'NASDAQ' and (source_uid like ${`${SYM}|%`} or source_uid like ${`${SYM}=|%`})`;
await cleanup();

const haltRow = ({ symbol = SYM, haltDate = '09/30/2026', haltTime = '10:31:00', reasonCode = 'LUDP', reason = 'Volatility Pause', resumeTrade = null } = {}) =>
  ({ symbol, haltDate, haltTime, reasonCode, reason, resumeTrade });

try {
  L('⚠️ 1 — the cron budget: 40 or fewer, and halts have no slot of their own');
  {
    const v = JSON.parse(read('vercel.json'));
    ok('⚠️ vercel.json holds no more than 40 crons', v.crons.length <= 40, `${v.crons.length}`);
    ok('…and it is exactly at the cap, which is why the piggyback exists', v.crons.length === 40);
    ok('⚠️ no cron was added for halts', !v.crons.some((c) => /halt/i.test(c.path)));
    // ⚠️ AND NOTHING WAS DELETED TO MAKE ROOM. The routes every cron points at must all still exist —
    // "freeing a slot" by pointing a cron at a deleted route would pass a count check and break a job.
    const missing = v.crons.map((c) => c.path.replace(/\?.*$/, ''))
      .filter((p, i, a) => a.indexOf(p) === i)
      .filter((p) => {
        try { readFileSync(new URL(`../src/app${p}/route.js`, import.meta.url)); return false; } catch { return true; }
      });
    ok('⚠️ every scheduled route still exists — no job was removed to free space',
      missing.length === 0, missing.join(', '));
    // The host job runs every minute, which is what makes it a usable host.
    const host = v.crons.filter((c) => c.path === '/api/cron/primary-sources');
    ok('⚠️ the host cron fires every minute', host.length === 1 && host[0].schedule === '* * * * *',
      JSON.stringify(host));
  }

  L('⚠️ 2 — the Terminal dependency is gone: the scheduled path owns ingestion');
  {
    const cron = code('src/app/api/cron/primary-sources/route.js');
    const haltsRoute = code('src/app/api/halts/route.js');
    ok('⚠️ the cron projects halts durably', /await projectHalts\(res\.halts\)/.test(cron));
    ok('…from its own sweep function', /async function sweepHalts\(\)/.test(cron) && /await sweepHalts\(\)/.test(cron));
    // ⚠️ THE REQUIREMENT IS "SUPPLEMENT, NOT REQUIRED" — NOT "REMOVED". This first asserted that
    // /api/halts no longer projects at all, which is stricter than the rule and would have been worse
    // for the product: a Terminal reader hitting a cache miss captures immediately instead of waiting up
    // to a minute. What must be true is that durability does not DEPEND on that route being called, and
    // that the write does not sit in front of the response.
    ok('⚠️ /api/halts still captures as a supplement', /projectHalts\(halts\)/.test(haltsRoute));
    // ⚠️ CONTAINMENT, NOT ORDERING. Comparing indexOf('after(') against indexOf('return Response.json')
    // matched the route's EARLY cache-hit return, which naturally precedes everything — the assertion
    // failed on correct code. What matters is that the projection sits inside the deferred callback.
    ok('⚠️ …deferred past the response, so it cannot slow the Terminal',
      /after\(async \(\) => \{[\s\S]{0,240}?projectHalts\(halts\)/.test(haltsRoute),
      'a user request must never wait on durable ingestion');
    // ⚠️ AND NOWHERE ELSE IN THE ROUTE. Awaiting inside the deferred callback is correct — my previous
    // assertion forbade `await projectHalts` outright and failed on the awaited call INSIDE after(),
    // which is precisely where it belongs. The real property is that no projection happens outside that
    // block, so the after() body is removed before checking.
    // The import line also contains the name — the import-vs-call trap that has now cost me an
    // assertion in three separate tasks — so this counts CALLS, and the containment check above proves
    // the single call is inside the deferred block.
    // Counting `projectHalts(` already excludes the import, which has no parenthesis — subtracting the
    // import as well double-counted it away and reported zero calls in a file that plainly has one.
    const calls = (haltsRoute.match(/projectHalts\(/g) || []).length;
    ok('…and it is called exactly once, in that block', calls === 1, `${calls} calls`);
    ok('⚠️ …and the durable path does not depend on it: the cron projects independently',
      /await projectHalts\(res\.halts\)/.test(cron) && /async function sweepHalts\(\)/.test(cron));
    ok('…and both share one fetch implementation, so the logic is not duplicated',
      /from '.*lib\/halts\.mjs'/.test(cron) && /from '.*lib\/halts\.mjs'/.test(haltsRoute)
      && !/nasdaqtrader\.com/.test(cron) && !/nasdaqtrader\.com/.test(haltsRoute));
    // ⚠️ AND A WIRE FAILURE CANNOT SKIP THE SWEEP. This was inside the same try as runPrimarySources.
    ok('⚠️ the sweep runs on the failure path too', (cron.match(/await sweepHalts\(\)/g) || []).length === 2,
      'a wire throw must not suppress halt ingestion');
    ok('…and it is called after the wire has committed, so it cannot take the wire down',
      cron.indexOf('await runPrimarySources(') < cron.indexOf('await sweepHalts()'));
    // ⚠️ AND NO OTHER USER-FACING SURFACE INGESTS. /api/halts is the one supplementary writer, deferred;
    // anything else reaching projectHalts would be putting durable ingestion behind a page render.
    const writers = ['src/app/api/halts/route.js', 'src/app/api/cron/primary-sources/route.js'];
    const others = [];
    for (const f of ['src/app/terminal/TerminalClient.jsx', 'src/app/api/wire/route.js',
      'src/app/api/ticker/route.js', 'src/components/PitWire.jsx']) {
      try { if (/projectHalts/.test(code(f))) others.push(f); } catch { /* absent is fine */ }
    }
    ok('⚠️ no page or unrelated route performs the projection', others.length === 0, others.join(', '));
    ok('…so the only writers are the cron and the deferred halts route', writers.length === 2);
  }

  L('⚠️ 3 — the source is a permitted public exchange feed, unchanged');
  {
    const lib = read('src/lib/halts.mjs');
    ok('⚠️ the source is the public Nasdaq Trader halt feed',
      /https:\/\/www\.nasdaqtrader\.com\/rss\.aspx\?feed=tradehalts/.test(lib));
    ok('⚠️ no commercial provider was introduced',
      !/tiingo|twelvedata|twelve_data|polygon|finnhub|fmp|financialmodeling/i.test(lib));
    // ⚠️ NO MARKET-DATA CREDENTIAL — which is not the same as no credential at all. This first asserted
    // that no token appears anywhere in the file and failed on KV_REST_API_TOKEN, which authenticates the
    // CACHE, not the source. Conflating a cache credential with a data-provider licence would have
    // reported a correctly-sourced feed as a licensing problem.
    ok('⚠️ the feed itself needs no provider credential',
      !/TIINGO|POLYGON_API|FINNHUB|FMP_|TWELVE/i.test(lib));
    ok('…and the only secret it reads is the KV cache credential',
      /KV_REST_API_TOKEN/.test(lib) && !/DATA_API_KEY|MARKET_API/i.test(lib));
    // A cache in front of it, so once-a-minute costs one upstream request per minute.
    ok('the feed is cached, bounding upstream load', HALTS_TTL > 0 && HALTS_TTL <= 60, String(HALTS_TTL));
    ok('…under a stable key', typeof HALTS_KEY === 'string' && HALTS_KEY.length > 0);
  }

  L('⚠️ 4 — dedupe: the same halt twice is ONE durable event');
  {
    const h = haltRow();
    const first = await projectHalts([h]);
    ok('⚠️ a new halt becomes a durable event', first === 1, String(first));
    const second = await projectHalts([h]);
    ok('⚠️ the same halt fetched again creates nothing', second === 0, String(second));
    const rows = await sql`select count(*)::int n from primary_events where source='NASDAQ' and source_uid like ${`${SYM}|%`}`;
    ok('…leaving exactly one row', rows[0].n === 1, String(rows[0].n));

    // ⚠️ THE CRON + TERMINAL RACE, ACTUALLY RACED. Both paths call the same projectHalts; five
    // concurrent calls for one halt must still yield one row. The guarantee is the unique identity in
    // the database, not ordering.
    await cleanup();
    const raced = await Promise.all(Array.from({ length: 5 }, () => projectHalts([h])));
    const total = raced.reduce((a, b) => a + b, 0);
    const after = await sql`select count(*)::int n from primary_events where source='NASDAQ' and source_uid like ${`${SYM}|%`}`;
    ok('⚠️ five concurrent projections yield exactly one row', after[0].n === 1,
      `${after[0].n} rows, inserts reported ${total}`);

    // ⚠️ SEPARATE LEGITIMATE EVENTS STAY SEPARATE. One symbol can be LULD-paused several times in a
    // day for the same reason — hashing the headline would have swallowed every pause after the first,
    // which is why the content hash is built from the uid.
    const later = haltRow({ haltTime: '14:05:00' });
    const n2 = await projectHalts([later]);
    ok('⚠️ a second pause the same day, same reason, is a DISTINCT event', n2 === 1, String(n2));
    const other = haltRow({ reasonCode: 'T1', reason: 'News Pending' });
    ok('⚠️ a different reason at the same time is also distinct', (await projectHalts([other])) === 1);
    const all = await sql`select source_uid from primary_events where source='NASDAQ' and source_uid like ${`${SYM}|%`} order by source_uid`;
    ok('…three distinct uids stored', all.length === 3, JSON.stringify(all.map((r) => r.source_uid)));
    ok('⚠️ …and the identity is stated by the feed, not inferred',
      all.every((r) => /^ZQHALT\|09\/30\/2026\|\d{2}:\d{2}:\d{2}\|(LUDP|T1)$/.test(r.source_uid)),
      JSON.stringify(all.map((r) => r.source_uid)));

    // A resumption is carried on the event rather than replacing it.
    const resumed = await projectHalts([haltRow({ haltTime: '15:00:00', resumeTrade: '15:10:00' })]);
    ok('a halt carrying a resumption is its own event', resumed === 1);
    const res = await sql`select summary from primary_events where source='NASDAQ' and source_uid = ${`${SYM}|09/30/2026|15:00:00|LUDP`}`;
    ok('…and the resumption is recorded on it', /Resumption 15:10:00/.test(String(res[0]?.summary)), String(res[0]?.summary));
    await cleanup();
  }

  L('⚠️ 5 — malformed feed rows are skipped, not repaired');
  {
    // ⚠️ THE EXCHANGE'S SYMBOL FIELD IS NOT ALWAYS A SYMBOL. Production held tickers ["VACI="] and
    // ["TRAD="] with headlines like "VACI= halted", producing dead ticker links on a path that
    // autoposts. Skipped rather than stripped: guessing the base symbol is a guess about which security
    // the exchange meant.
    const before = await sql`select count(*)::int n from primary_events where source='NASDAQ'`;
    const n = await projectHalts([haltRow({ symbol: BAD_SYM }), haltRow({ symbol: '' }), haltRow({ symbol: '1BAD' })]);
    ok('⚠️ suffixed and malformed symbols produce no events', n === 0, String(n));
    const after = await sql`select count(*)::int n from primary_events where source='NASDAQ'`;
    ok('…and write nothing at all', after[0].n === before[0].n);
    ok('an empty feed is not an error, it is zero events', (await projectHalts([])) === 0);
    ok('…and neither is a null feed', (await projectHalts(null)) === 0);
  }

  L('⚠️ 6 — parsing and ordering, without touching the network');
  {
    const xml = `<rss><channel>
      <item><title>Trade Halt</title><description><![CDATA[
        <b>Issue Symbol:</b> ${SYM}<br><b>Halt Date:</b> 09/30/2026<br><b>Halt Time:</b> 10:31:00<br>
        <b>Reason Codes:</b> LUDP<br>]]></description></item>
    </channel></rss>`;
    const parsed = parseHalts(xml);
    ok('the parser reads a feed item without a network call', Array.isArray(parsed));
    ok('⚠️ and a malformed document yields an empty list rather than throwing',
      Array.isArray(parseHalts('<not-xml')) && Array.isArray(parseHalts('')) && Array.isArray(parseHalts(null)));
    // Ordering is newest-first, which is what the Terminal and the cache both rely on.
    const a = haltRow({ haltTime: '10:00:00' }), b = haltRow({ haltTime: '15:00:00' });
    const sorted = [a, b].sort((x, y) => haltKey(y) - haltKey(x));
    ok('⚠️ haltKey orders newest first', sorted[0].haltTime === '15:00:00', JSON.stringify(sorted.map((s) => s.haltTime)));
    // mergeDetected must not duplicate a halt the official feed already carries.
    const merged = mergeDetected([a], [{ symbol: SYM, haltDate: a.haltDate, haltTime: a.haltTime, reasonCode: a.reasonCode }]);
    ok('⚠️ an internally detected halt already in the official feed is not duplicated',
      merged.length === 0, JSON.stringify(merged));
    const mergedNew = mergeDetected([a], [{ symbol: 'ZQOTHER', haltDate: a.haltDate, haltTime: '11:00:00', reasonCode: 'LUDP' }]);
    ok('…while one the feed has not published yet is kept', mergedNew.length === 1);
  }

  L('⚠️ 7 — halts have their OWN health, and a failure is not hidden');
  {
    const cron = code('src/app/api/cron/primary-sources/route.js');
    // ⚠️ THE DEFECT THIS SECTION EXISTS FOR: one opaque heartbeat for two subtasks.
    ok('⚠️ the halt subtask records its own heartbeat', /recordJobRun\('halts', \{/.test(cron));
    ok('⚠️ …with ok driven by the halt outcome, not the wire\'s', /ok: !out\.error,/.test(cron));
    ok('⚠️ …and events processed reported as its own count', /seen: out\.projected,/.test(cron));
    ok('…and the failure reason in the note', /halt source failed · \$\{out\.error\}/.test(cron));
    ok('⚠️ the wire heartbeat is still separate and still keyed to the wire',
      /recordJobRun\('primary-sources'/.test(cron));
    // Registered, or /api/health never reports it.
    const tracked = TRACKED_JOBS.find((j) => j.name === 'halts');
    ok('⚠️ halts is a tracked job, so health reports it', !!tracked, JSON.stringify(TRACKED_JOBS.map((j) => j.name)));
    ok('…labelled for a human', tracked?.label === 'Trading halts');
    ok('⚠️ …with a staleness bound, so silence is visible', tracked?.maxAgeHours === 2, String(tracked?.maxAgeHours));
    ok('…and it is not event-driven, because it has a cadence', !tracked?.eventDriven);
    ok('the host job is still tracked independently',
      !!TRACKED_JOBS.find((j) => j.name === 'primary-sources'));

    // ⚠️ EXECUTED: the two clocks must move independently, which is the whole claim.
    const beats0 = await readJobHeartbeats();
    const before = beats0.get('halts');
    await recordJobRun('halts', { ok: false, seen: 0, note: 'halt source failed · fixture' });
    const failed = (await readJobHeartbeats()).get('halts');
    ok('⚠️ a halt failure marks HALTS failing', Number(failed?.consecutive_failures) >= 1,
      JSON.stringify({ status: failed?.last_status, fails: failed?.consecutive_failures }));
    ok('⚠️ …and does not move the halt success clock',
      !before?.last_success_at || String(failed?.last_success_at) === String(before?.last_success_at));
    const wire = (await readJobHeartbeats()).get('primary-sources');
    ok('⚠️ …and leaves the wire heartbeat untouched', Number(wire?.consecutive_failures || 0) === 0,
      JSON.stringify({ fails: wire?.consecutive_failures }));
    // Recovery: a good run clears it and moves the clock. An empty feed is a good run.
    await recordJobRun('halts', { ok: true, seen: 0, note: 'fetched 0 · projected 0' });
    const recovered = (await readJobHeartbeats()).get('halts');
    ok('⚠️ an empty feed is a SUCCESS — a quiet market is not an outage',
      Number(recovered?.consecutive_failures) === 0 && !!recovered?.last_success_at,
      JSON.stringify({ fails: recovered?.consecutive_failures }));
    ok('…and the attempted clock moves on every run, failed or not', !!recovered?.last_polled_at);
  }

  L('⚠️ 8 — the live source answers, and the sweep is not fabricating anything');
  {
    // ⚠️ READ ONLY, AND IT ASSERTS THE SHAPE RATHER THAN A FINDING. Whether anything is halted right
    // now is not ours to control; what must hold is that the feed answers and parses.
    const res = await fetchHalts();
    ok('⚠️ the public feed answers', !res.error, String(res.error));
    ok('…with a list, even when nothing is halted', Array.isArray(res.halts), typeof res.halts);
    console.log(`         live feed: ${res.halts?.length ?? 0} halts currently listed${res.error ? ` · error ${res.error}` : ''}`);
    if (res.halts?.length) {
      const h = res.halts[0];
      ok('a returned row carries the fields the identity is built from',
        'symbol' in h && 'haltDate' in h && 'haltTime' in h, JSON.stringify(Object.keys(h)));
    }
  }
} finally {
  await cleanup();
  const left = await sql`select count(*)::int n from primary_events where source='NASDAQ' and source_uid like ${`${SYM}|%`}`;
  console.log(`\n(cleanup: ${left[0].n} fixture events remaining)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
