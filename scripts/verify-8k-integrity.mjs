// 8-K / CORPORATE EVENTS — ingestion and evidence integrity.
//
//   node --import ./scripts/lib/node-resolve-hook.mjs --env-file=.env.local scripts/verify-8k-integrity.mjs
//
// ⚠️ WHAT THIS GUARDS. Three defects were found by auditing production, and each one looked like
// working code: a race that stored filings with no item codes and never revisited them, a browse-edgar
// `type=` prefix match that pulled Regulation A offering circulars into the delisting path, and an
// evidence model whose safety depends entirely on which timestamp is treated as public. All three are
// the kind that produce a plausible page rather than an error.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { classifyItems } from '../src/lib/eightk.js';
import { form25Code } from '../src/lib/form25.js';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const one = async (q) => (await q)[0];

L('⚠️ one accession is one filing');
{
  const r = await one(sql`select count(*)::int total, count(distinct accession)::int acc from eightk_filings`);
  ok('no duplicate accessions', r.total === r.acc, `${r.total} rows / ${r.acc} accessions`);
  // ⚠️ THE CONSTRAINT, NOT JUST TODAY'S DATA. A unique index is what makes a retry, a feed overlap
  // and a backfill idempotent; without it the count above is luck.
  const idx = await sql`select indexdef from pg_indexes where tablename='eightk_filings' and indexdef ilike '%unique%'`;
  ok('⚠️ …enforced by a unique index on accession',
    idx.some((i) => /unique/i.test(i.indexdef) && /\(accession\)/.test(i.indexdef)), JSON.stringify(idx.map((i) => i.indexdef)));
  const src = read('../src/lib/eightk.js');
  ok('…and the insert is idempotent at the application level too',
    /onConflictDoNothing\(\{\s*target:\s*eightkFilings\.accession\s*\}\)/.test(src));
}

L('⚠️ multi-item filings stay ONE filing');
{
  // An 8-K routinely carries several items. They are one disclosure, stored as a CSV on one row —
  // so the count of evidence records cannot inflate with the number of items.
  const r = await one(sql`select count(*)::int multi from eightk_filings where items like '%,%'`);
  ok('multi-item filings exist in production', r.multi > 0, `${r.multi}`);
  const dup = await one(sql`select count(*)::int n from (
    select accession from eightk_filings group by accession having count(*) > 1) z`);
  ok('⚠️ …and none of them produced a second row', dup.n === 0, `${dup.n}`);
  const c = classifyItems('2.02,9.01,7.01');
  ok('the classifier reads every code', c.codes.length === 3);
  ok('⚠️ …and one filing yields ONE verdict, not one per item',
    typeof c.material === 'boolean' && typeof c.primaryLabel === 'string');
  ok('a repeated code is not counted twice', classifyItems('5.02,5.02').codes.length === 2
    && classifyItems('5.02,5.02').labels.length === 1);
}

L('⚠️ item codes come from SEC, and every row has them');
{
  const r = await one(sql`select count(*)::int n from eightk_filings where items is null`);
  // ⚠️ THE RACE THAT LOST 86 FILINGS. getcurrent publishes an accession before submissions.json
  // lists it; the lookup missed, items stayed null, and the ingest never revisited a known
  // accession — so those filings were permanently non-material with no item code.
  ok('⚠️ no filing is stored without its item codes', r.n === 0, `${r.n} rows with items null`);
  const src = read('../src/lib/eightk.js');
  ok('⚠️ …and a filing that arrives before SEC lists it is retried',
    /export async function repairMissingItems/.test(src) && /repairMissingItems\(\)/.test(src));
  ok('…the retry writes items but never the public clock',
    !/repairMissingItems[\s\S]{0,1400}filedAt:/.test(src));

  // Codes must look like SEC item numbers or the two documented Form 25 pseudo-codes.
  const codes = await sql`select distinct unnest(string_to_array(items, ','))::text code from eightk_filings where items is not null`;
  const bad = codes.map((c) => c.code.trim()).filter((c) => !/^\d\.\d{2}$/.test(c) && c !== '25' && c !== '25-NSE');
  ok('⚠️ every stored code is a real SEC item number', bad.length === 0, bad.join(','));
}

L('⚠️ the delisting path accepts only Form 25');
{
  // ⚠️ browse-edgar's type= IS A PREFIX MATCH. type=25 returns 253G1/253G2/253G3 — Regulation A
  // offering circulars — and the old code defaulted anything that was not 25-NSE to '25', so two
  // offering circulars were published as "Withdrawal from listing", material: true.
  ok('⚠️ a Regulation A offering circular is refused', form25Code('253G2 - ACME (0001) (Filer)') === null);
  ok('…as is any other 25-prefixed form', form25Code('253G1 - X (1) (Filer)') === null
    && form25Code('25A - X (1) (Filer)') === null);
  ok('the exchange filing is still recognised', form25Code('25-NSE - ACME (0001) (Filer)') === '25-NSE');
  ok('…and the issuer filing', form25Code('25 - ACME (0001) (Filer)') === '25');
  ok('…including amended ones', form25Code('25-NSE/A - X (1) (Filer)') === '25-NSE'
    && form25Code('25/A - X (1) (Filer)') === '25');
  ok('⚠️ an unrecognised form is skipped rather than guessed',
    /if \(!code\) continue;/.test(read('../src/lib/form25.js')));
}

L('⚠️ two clocks: publicTime is when it became knowable');
{
  const src = read('../src/lib/consensus/evidence.js');
  const ctx = read('../src/lib/consensus/build-context.mjs');
  const board = read('../src/lib/consensus/board.mjs');
  // ⚠️ THE ONE SUBSTITUTION THAT WOULD BACKDATE EVIDENCE. report_date is the event; filed_at is the
  // disclosure. Windowing or ordering on report_date would show an event before anyone could know it.
  for (const [n, s] of [['consensus evidence', src], ['build-context', ctx], ['board', board]]) {
    ok(`${n} windows on filed_at, not report_date`,
      /filed_at >= \(now\(\)/.test(s) && !/report_date >= \(now\(\)/.test(s));
  }
  ok('⚠️ …and orders by filed_at', /order by filed_at desc/.test(ctx));
  const model = read('../src/lib/evidence/model.mjs');
  ok('⚠️ changedSince gates on publicTime, which is what makes a backfill safe',
    /const pub = toEpoch\(e\?\.publicTime\);/.test(model) && /pub > t/.test(model));
  ok('…and never on an ingestion timestamp', !/inserted_at|insertedAt/.test(model));

  // Production: no event can be dated after its own disclosure by more than a scheduled-date margin.
  const r = await one(sql`select count(*)::int n from eightk_filings
    where report_date is not null and report_date > (filed_at at time zone 'UTC')::date + 7`);
  ok('no filing reports an event more than a week after it was filed', r.n === 0, `${r.n}`);
  const f = await one(sql`select count(*)::int n from eightk_filings where filed_at > now() + interval '1 hour'`);
  ok('⚠️ nothing is filed in the future', f.n === 0, `${f.n}`);
}

L('⚠️ issuer identity is CIK-based and does not cross issuers');
{
  const cross = await one(sql`select count(*)::int n from (
    select ticker from eightk_filings group by ticker having count(distinct cik) > 1) z`);
  ok('⚠️ no ticker carries filings from two different CIKs', cross.n === 0, `${cross.n}`);
  const src = read('../src/lib/eightk.js');
  ok('⚠️ a filing with no resolvable ticker is skipped, never forced',
    /if \(!d \|\| !d\.ticker\) continue;/.test(src));
  ok('…and the ticker comes from SEC submissions, not the feed headline',
    /sub\.tickers && sub\.tickers\[0\]/.test(src));
  const empty = await one(sql`select count(*)::int n from eightk_filings where ticker is null or ticker = ''`);
  ok('no row has an empty ticker', empty.n === 0, `${empty.n}`);
}

L('⚠️ source links point at the filing');
{
  const bad = await one(sql`select count(*)::int n from eightk_filings
    where primary_doc_url is not null and primary_doc_url not like 'https://www.sec.gov/Archives/edgar/data/%'`);
  ok('every primary document URL is an SEC Archives path', bad.n === 0, `${bad.n}`);
  const nul = await one(sql`select count(*)::int n from eightk_filings where primary_doc_url is null`);
  ok('⚠️ …and no filing is missing its document link', nul.n === 0, `${nul.n} null`);
  // ⚠️ THE ACCESSION IN THE PATH MUST BE THE ROW'S OWN, or the card opens someone else's filing.
  const mism = await one(sql`select count(*)::int n from eightk_filings
    where primary_doc_url is not null
      and position(replace(accession, '-', '') in primary_doc_url) = 0`);
  ok('⚠️ the URL carries the row\'s own accession', mism.n === 0, `${mism.n} mismatched`);
  const cikm = await one(sql`select count(*)::int n from eightk_filings
    where primary_doc_url is not null
      and primary_doc_url not like '%/data/' || ltrim(cik, '0') || '/%'`);
  ok('…and the row\'s own CIK', cikm.n === 0, `${cikm.n} mismatched`);
}

L('⚠️ a repair cannot manufacture an alert');
{
  const worker = read('../src/lib/alerts/evidence-alert-worker.mjs');
  const alerts = read('../src/lib/alerts/evidence-alerts.mjs');
  ok('alerts are selected by changedSince against a subscriber watermark',
    /alertsFor\(evidence, since/.test(worker) && /changedSince\(/.test(alerts));
  // ⚠️ THE PROOF IS THAT publicTime IS NOT WRITABLE BY THE REPAIR. filed_at is the public clock for
  // an 8-K and the repair sets items / material / report_date / primary_doc_url only, so no repaired
  // row can cross a watermark however many times it is re-run.
  const repair = read('../src/lib/eightk.js').match(/export async function repairMissingItems[\s\S]*?\n}/)?.[0] || '';
  // ⚠️ THE SET BLOCK, NOT THE WHOLE FUNCTION. This first forbade filedAt anywhere in the repair and
  // failed on `gte(eightkFilings.filedAt, …)` — the clause that SELECTS recent rows. Reading the
  // public clock to choose what to repair is fine and necessary; writing it is what would move a
  // filing across a watermark. So the assertion is on what the update actually sets.
  const setBlock = repair.match(/\.set\(\{[\s\S]*?\n\s*\}\)/)?.[0] || '';
  ok('the repair has an update with a set block', setBlock.length > 0);
  ok('⚠️ …which never writes filed_at', !/filedAt|filed_at/.test(setBlock), setBlock.slice(0, 120));
  ok('…nor inserted_at', !/insertedAt|inserted_at/.test(setBlock));
  ok('…and it updates rather than re-inserting', /db\.update\(eightkFilings\)/.test(repair) && !/db\.insert/.test(repair));
}

L('⚠️ downstream consumers read the canonical row');
{
  const ctx = read('../src/lib/consensus/build-context.mjs');
  ok('consensus selects by accession, so one filing is one record', /accession/.test(ctx));
  ok('⚠️ …and bounds its read, so no consumer scans the whole history',
    /rn <= \d+/.test(ctx) && /make_interval\(days =>/.test(ctx));
  // Index coverage for the two access patterns the consumers actually use.
  const idx = (await sql`select indexname from pg_indexes where tablename='eightk_filings'`).map((r) => r.indexname);
  ok('filed_at is indexed (every consumer windows on it)', idx.some((i) => /filed_at/.test(i)), idx.join(','));
  ok('ticker is indexed (per-issuer reads)', idx.some((i) => /ticker/.test(i)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
