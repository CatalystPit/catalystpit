// The enrichment claim query must actually run against Postgres.
//
// THE BUG. claimPending() compares a smallint column to the result of a CASE whose branches are both
// bind parameters. Postgres has nothing to infer their type from, defaults them to text, and
// `smallint < text` is not an operator — so the query threw on EVERY call. runEnrichment's caller
// swallowed the throw in a bare catch, so ingest kept running, enrich_attempts never moved, and the
// symptom was indistinguishable from an Anthropic outage. 1,640 events stranded in rewrite_pending.
//
// Needs DATABASE_URL: node --env-file=.env.local scripts/verify-enrich-claim.mjs
import { neon } from '@neondatabase/serverless';
import { TRUSTED_SOURCES, TRUSTED_REWRITE_ATTEMPTS } from '../src/lib/trusted-sources.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const src = readFileSync(new URL('../src/lib/primary-events.js', import.meta.url), 'utf8');
// The claim statement moved to enrich-claim.mjs (atomic claim + rewrite tiers); the lesson moved with it.
const claimSrc = readFileSync(new URL('../src/lib/enrich-claim.mjs', import.meta.url), 'utf8').replace(/\s+/g, ' ');

console.log('\n=== the cast that makes the query runnable ===');
// Every branch of the attempt-budget CASE is a bind parameter, so every branch carries its own cast.
const budgetCase = (claimSrc.match(/enrich_attempts < \(case .*? end\)/) || [''])[0];
ok('every attempt-budget CASE branch is cast to int', (budgetCase.match(/\$\{ATTEMPTS_[A-Z]+\}::int/g) || []).length === 3, budgetCase.slice(0, 220));
ok('the trusted array is still cast to text[]', /any\(\$\{TRUSTED\}::text\[\]\)/.test(claimSrc));

console.log('\n=== failures are reported, never swallowed ===');
ok('a claim failure returns claimError instead of throwing', /claimError/.test(src));
ok('...and is logged', /console\.error\('\[enrich\] claimPending failed/.test(src));
const sweep = src.slice(src.indexOf('onNew(sweepWrote)') - 300, src.indexOf('onNew(sweepWrote)') + 300);
ok('the ingest sweep logs an enrichment failure', /catch \(e\) \{ console\.error\('\[primary-sources\] enrichment failed/.test(sweep));
ok('...and still does not block ingest', /never block or fail ingest/.test(src));

if (!process.env.DATABASE_URL) {
  console.log('\n  (live query check skipped — no DATABASE_URL)');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

console.log('\n=== the query runs against the real database ===');
const sql = neon(process.env.DATABASE_URL);
const TRUSTED = `{${[...TRUSTED_SOURCES].join(',')}}`;
const claim = (cast) => sql.query(`
  select seq from primary_events
   where headline_status = 'rewrite_pending' and source_kind <> 'sec'
     and enrich_attempts < (case when source = any($1::text[]) then $2 else $3 end)${cast}
   order by (source = any($1::text[])) desc, seq desc limit 3`, [TRUSTED, TRUSTED_REWRITE_ATTEMPTS, 3]);

let threw = null;
try { await claim('::int'); } catch (e) { threw = e.message; }
ok('the cast version runs', threw === null, threw || '');

// The shape that shipped. Pinned so the regression cannot come back unnoticed.
let uncastThrew = null;
try { await claim(''); } catch (e) { uncastThrew = e.message; }
ok('the UNCAST version still fails, which is the bug this pins', uncastThrew !== null,
  'Postgres now infers this — the cast may no longer be load-bearing');
if (uncastThrew) console.log(`  uncast: ${uncastThrew}`);

const rows = await claim('::int');
console.log(`  claimable rows right now: ${rows.length ? rows.length + '+' : 0}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
