// SCALE, AFTER THE READ PATH STOPPED RE-RESOLVING EVERYTHING.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/audit-watchlist-scale.mjs
//
// ⚠️ THE NUMBER THAT MATTERS IS "EVALUATED", NOT "FAST". The old path resolved every nominated
// ticker per request (~1,350ms and seven queries each), capped the work at 60 names, and reported
// the rest as though nothing had happened. A capped answer is a WRONG answer, not a slow one — so
// this test asserts that every security on the list is evaluated, and only then reports the cost.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());
const { watchlistChangesFast, watchlistChanges } = await import('../src/lib/watchlist-changes.js');
const { db } = await import('../src/lib/db.js');

const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
const big = await sql`SELECT ticker FROM screener_stocks WHERE market_cap > 0 ORDER BY market_cap DESC LIMIT 500`;
const mega = big.map((r) => String(r.ticker).toUpperCase());
const mixed = [...new Set([
  ...mega.slice(0, 60),
  ...(await sql`SELECT ticker FROM screener_stocks WHERE company IS NOT NULL ORDER BY random() LIMIT 460`).map((r) => String(r.ticker).toUpperCase()),
])];

// Count queries by wrapping the driver, so "DB queries" is measured rather than assumed.
let queries = 0;
const orig = db.execute.bind(db);
db.execute = (...a) => { queries += 1; return orig(...a); };

const run = async (label, list) => {
  queries = 0;
  const t0 = Date.now();
  const r = await watchlistChangesFast(list, { since });
  const ms = Date.now() - t0;
  const bytes = JSON.stringify({ changes: r.changes, byTicker: r.byTicker, coverage: r.coverage }).length;
  const evaluated = r.resolved;
  const okAll = evaluated === list.length && r.truncated === false;
  console.log(`${String(list.length).padStart(5)} ${String(evaluated).padStart(10)} `
    + `${String(r.changes.length).padStart(7)} ${String(queries).padStart(8)} ${String(1).padStart(6)} `
    + `${String(bytes).padStart(8)} ${String(ms + 'ms').padStart(8)}   ${okAll ? 'all evaluated' : '*** TRUNCATED ***'}`);
  return okAll;
};

console.log('── the optimised read path ──');
console.log(' size  evaluated  events  queries  reqs    bytes      time');
let allOk = true;
for (const n of [1, 10, 25, 50, 60, 75, 100, 250, 500]) {
  if (mixed.length < n) continue;
  allOk = (await run('mixed', mixed.slice(0, n))) && allOk;
}
console.log('\n── the 100-largest-cap stress test, the one that used to truncate ──');
console.log(' size  evaluated  events  queries  reqs    bytes      time');
allOk = (await run('mega100', mega.slice(0, 100))) && allOk;
console.log('\n── the product maximum: a full 500-name watchlist of the largest issuers ──');
console.log(' size  evaluated  events  queries  reqs    bytes      time');
allOk = (await run('mega500', mega.slice(0, 500))) && allOk;

// The old path, for contrast, on the case that exposed the bug.
console.log('\n── for contrast: the engine path on the same 100 names ──');
queries = 0;
const t0 = Date.now();
const old = await watchlistChanges(mega.slice(0, 100), { since });
console.log(`  evaluated ${old.resolved} of 100, truncated=${old.truncated}, `
  + `${queries} queries, ${Date.now() - t0}ms`);

console.log(`\n${allOk ? 'PASS' : 'FAIL'} — every list size evaluated in full, no truncation`);
process.exit(allOk ? 0 : 1);
