// DIVIDENDS — why the job had never once succeeded, and why Microsoft's dividend was six cents.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-dividends-integrity.mjs
//
// ⚠️ THE DEFECT. The Tiingo adapter keyed events on `${ticker}:${exDate}`, and two different
// securities can share a ticker string. Measured on exDate=2026-08-20:
//
//   US000000000042  msft  0.91      <- Microsoft
//   CA000000137368  msft  0.063677  <- a Canadian listing, same ticker
//
// One conflict key, two payloads. A multi-row upsert carrying the same key twice fails the WHOLE
// statement with SQLSTATE 21000, and the batches before it had already committed — which is how
// last_success_at stayed null while dividend_events held 45,475 rows. And whichever row landed last
// won, so production served Microsoft's dividend as $0.063677 against a real $0.91.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { toCanonical } from '../src/lib/dividends/providers/tiingo-dividends.mjs';
import { upsertDividendEvents } from '../src/lib/dividends/dividend-store.js';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '');
const one = async (q) => (await q)[0];

// The exact rows Tiingo returned, so the regression has to reproduce reality to pass.
const MSFT_US = { permaTicker: 'US000000000042', ticker: 'msft', exDate: '2026-08-20T04:00:00.000Z', paymentDate: '2026-09-10T04:00:00.000Z', recordDate: '2026-08-20T04:00:00.000Z', declarationDate: '2026-06-10T08:00:00.000Z', distribution: 0.91, distributionFrequency: 'q' };
const MSFT_CA = { permaTicker: 'CA000000137368', ticker: 'msft', exDate: '2026-08-20T04:00:00.000Z', paymentDate: '2026-09-17T04:00:00.000Z', recordDate: '2026-08-20T04:00:00.000Z', declarationDate: '2026-06-12T08:00:00.000Z', distribution: 0.063677, distributionFrequency: 'q' };

L('⚠️ identity is the security, not the ticker string');
{
  const us = toCanonical(MSFT_US);
  ok('the US listing becomes an event', !!us);
  ok('⚠️ its id carries the permaTicker, not the bare ticker',
    us.sourceEventId === 'US000000000042:2026-08-20', us?.sourceEventId);
  ok('…and the real amount survives', us.cashAmount === 0.91 && us.annualizedAmount === 3.64);

  // ⚠️ THE NON-US LINE IS REFUSED, because keyed correctly it would simply become a SECOND "MSFT"
  // dividend of six cents sitting beside the real ninety-one.
  ok('⚠️ the Canadian listing under a US ticker is refused', toCanonical(MSFT_CA) === null);
  for (const p of ['CA000000137368', 'CH000000600846', 'GB000000000001']) {
    ok(`${p} is refused`, toCanonical({ ...MSFT_US, permaTicker: p }) === null);
  }
  // ⚠️ AND US-LISTED ADRs ARE KEPT. Checked against real permaTickers rather than assumed: every
  // foreign issuer's US listing carries US, including the Canadian banks' (RY, TD).
  for (const [t, p] of [['BABA', 'US000000000197'], ['TSM', 'US000000008070'], ['RY', 'US000000007590'],
    ['TD', 'US000000007931'], ['SHEL', 'US000000102494'], ['SONY', 'US000000000578']]) {
    ok(`the US listing of ${t} is kept`, toCanonical({ ...MSFT_US, ticker: t.toLowerCase(), permaTicker: p })?.sourceEventId === `${p}:2026-08-20`);
  }
  ok('a row with no permaTicker still works, keyed on the ticker',
    toCanonical({ ...MSFT_US, permaTicker: undefined })?.sourceEventId === 'MSFT:2026-08-20');
  ok('the code records the measured evidence for the country filter',
    /RY and TD, the Canadian banks/.test(read('src/lib/dividends/providers/tiingo-dividends.mjs')));
}

L('⚠️ one conflict key may appear once per statement');
{
  const store = code('src/lib/dividends/dividend-store.js');
  ok('⚠️ the batch is deduplicated on its own conflict key before it is sent',
    /for \(const e of incoming\) byKey\.set\(`\$\{e\.source\}\\u0000\$\{e\.sourceEventId\}`, e\);/.test(store));
  ok('…and the collapse is counted rather than hidden', /const collapsed = incoming\.length - rows\.length;/.test(store));
  ok('…and reported out of the sync', /collapsed,/.test(code('src/lib/dividends/dividend-ingest.js')));
  // ⚠️ MATCHED ON A FRAGMENT THAT SITS ON ONE LINE. The comment wraps "a second / time" across a line
  // break, so the obvious search for the full sentence fails against correct code. It did.
  ok('the reason names the Postgres rule',
    /ON CONFLICT DO UPDATE command cannot affect row a second/.test(read('src/lib/dividends/dividend-store.js')));

  // ⚠️ EXERCISED, NOT JUST GREPPED: two events sharing a key must not raise 21000.
  const dupA = { source: 'verify', sourceEventId: 'VERIFY-DUPE-KEY', ticker: 'ZZZZ', exDividendDate: '2030-01-02', cashAmount: 1, announced: false };
  const dupB = { ...dupA, cashAmount: 2 };
  let threw = null;
  try { await upsertDividendEvents([dupA, dupB]); } catch (e) { threw = e.message?.slice(0, 80); }
  ok('⚠️ a colliding pair no longer fails the statement', threw === null, String(threw));
  const kept = await one(sql`select cash_amount from dividend_events where source='verify' and source_event_id='VERIFY-DUPE-KEY'`);
  ok('…and the last occurrence wins, as a separate-statement upsert would have', Number(kept?.cash_amount) === 2, JSON.stringify(kept));
  await sql`delete from dividend_events where source='verify'`;
}

L('⚠️ the corruption is gone from production data');
{
  for (const [t, amt, annual] of [['MSFT', 0.91, 3.64], ['AMAT', 0.53, 2.12]]) {
    const r = await sql`select cash_amount, annualized_amount, source_event_id from dividend_events
       where source='tiingo' and ticker=${t} and ex_dividend_date='2026-08-20'::date`;
    ok(`${t} has exactly one row for 2026-08-20`, r.length === 1, `${r.length} rows`);
    ok(`⚠️ …and it is the real dividend, not the foreign line`,
      Number(r[0]?.cash_amount) === amt && Number(r[0]?.annualized_amount) === annual,
      JSON.stringify(r[0]));
    ok(`…keyed on a US permaTicker`, /^US[0-9]+:/.test(r[0]?.source_event_id || ''), r[0]?.source_event_id);
  }
  const old = await one(sql`select count(*)::int n from dividend_events where source='tiingo' and source_event_id !~ '^US[0-9]+:'`);
  ok('⚠️ no tiingo row is left on the old ambiguous key', old.n === 0, `${old.n}`);
  const foreign = await one(sql`select count(*)::int n from dividend_events where source='tiingo' and source_event_id ~ '^(CA|CH|GB|AU|JP)[0-9]+:'`);
  ok('no non-US listing was stored', foreign.n === 0, `${foreign.n}`);
  const rows = await one(sql`select count(*)::int n from dividend_events where source='tiingo'`);
  ok('the tiingo universe is still populated', rows.n > 20000, `${rows.n}`);
}

L('⚠️ the calendar shows one dividend per security per date');
{
  const store = code('src/lib/dividends/dividend-store.js');
  // Tiingo sometimes holds ONE security under two permaTickers — ONEOK is both US000000002211 and
  // US000000145815 with a byte-identical $1.07. Both are valid by the ingestion key, so this is a
  // display question, collapsed at the read.
  ok('⚠️ the rows are selected distinct on what a reader can see',
    /select distinct on \(\$\{dateCol\}, d\.ticker, d\.cash_amount, d\.payment_date, d\.record_date\)/.test(store));
  // ⚠️ AND THE COUNT MATCHES, or the board contradicts itself in the only two numbers a reader can
  // compare. This file already shipped that bug once in the other direction.
  ok('⚠️ the count uses the same distinct key', (store.match(/count\(distinct \(\$\{dateCol\}, d\.ticker, d\.cash_amount, d\.payment_date, d\.record_date\)\)/g) || []).length === 2);
  ok('…and the ordering leads with the distinct key, as Postgres requires',
    /order by \$\{dateCol\} asc, d\.ticker asc, d\.cash_amount asc, d\.payment_date asc, d\.record_date asc/.test(store));

  const { calendarRange, calendarCount, calendarSectorCounts } = await import('../src/lib/dividends/dividend-store.js');
  for (const d of ['2026-08-20', '2026-08-03']) {
    const rows = await calendarRange({ from: d, to: d, mode: 'ex', limit: 1000 });
    const n = await calendarCount({ from: d, to: d, mode: 'ex' });
    ok(`${d}: the count equals the rows`, n === rows.length, `${n} vs ${rows.length}`);
    const seen = new Map();
    for (const r of rows) {
      const k = `${r.ticker}|${r.cash_amount}|${r.payment_date instanceof Date ? r.payment_date.toISOString().slice(0, 10) : r.payment_date}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    ok(`${d}: no duplicate rendered row`, [...seen.values()].every((v) => v === 1),
      [...seen.entries()].filter(([, v]) => v > 1).map(([k]) => k).join(', '));
    const sum = (await calendarSectorCounts({ from: d, to: d, mode: 'ex' })).reduce((a, x) => a + x.n, 0);
    ok(`${d}: the sector facet still reconciles to the total`, sum === n, `${sum} vs ${n}`);
  }
}

L('⚠️ a broken source is never an empty calendar');
{
  const route = code('src/app/api/dividends/calendar/route.js');
  ok('⚠️ a failed read answers 503, not 200 with no events', /status: 503/.test(route));
  ok('…and no longer returns an empty event list on failure', !/events: \[\], total: 0, error/.test(route));
  ok('…with an opaque code', /error: 'calendar_unavailable'/.test(route));
  const client = code('src/app/dividends/DividendsClient.jsx');
  ok('the board throws on a non-ok response', /if \(!r\.ok\) throw new Error/.test(client));
  ok('…and names the state rather than blanking the table', /setStatus\('error'\)/.test(client));
  ok('…which the client already said was the point',
    /an empty table and a broken request look identical and mean opposite things/.test(read('src/app/dividends/DividendsClient.jsx')));

  // The cron's own reporting.
  const cron = code('src/app/api/cron/dividends/route.js');
  ok('⚠️ the heartbeat records the field the sync actually returns', /out\?\.written/.test(cron));
  ok('…and never publishes an exception as a note', /beat\(false, 0, 'sync threw'\)/.test(cron));
  ok('…and the route body carries no exception text', !/error: e\.message/.test(cron));
  ok('the sync reports its own verdict rather than "we reached this line"',
    /beat\(!!out\?\.ok/.test(cron));
}

L('the job now succeeds, and says so where /api/health reads it');
{
  const hb = await one(sql`select last_success_at, last_status, consecutive_failures, events_seen, note
    from feed_state where feed_key='job:dividends'`);
  ok('⚠️ last_success_at is no longer null', hb?.last_success_at != null, JSON.stringify(hb));
  ok('…and the status is 200', Number(hb?.last_status) === 200, String(hb?.last_status));
  ok('…with no consecutive failures', Number(hb?.consecutive_failures) === 0, String(hb?.consecutive_failures));
  ok('⚠️ …and events_seen is no longer stuck at zero', Number(hb?.events_seen) > 0, String(hb?.events_seen));
  ok('…and the note is not a dumped query', !/insert into|failed query/i.test(String(hb?.note)), String(hb?.note));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
