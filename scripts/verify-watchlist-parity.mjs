// THE OPTIMISED READ PATH MUST ANSWER EXACTLY WHAT THE ENGINE WOULD HAVE.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/verify-watchlist-parity.mjs [n]
//
// ⚠️ AN OPTIMISATION THAT CHANGES THE ANSWER IS A BUG WITH BETTER LATENCY. The badge used to resolve
// every nominated ticker on every request — ~1,350ms and seven queries each — and was capped at 60
// to survive it, which reported 21 unchecked securities as "nothing happened". The expensive half
// now runs once per event and the read is one indexed query.
//
// This compares the two, security by security, against production: the ENGINE path (tickerEvidence
// + the eligibility contract, the behaviour that was verified correct) and the MATERIALISED path.
// Any security where they disagree is printed in full.
//
// Reads production; writes nothing.
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const N = Number(process.argv[2] || 150);
const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());
const { watchlistChanges, watchlistChangesFast } = await import('../src/lib/watchlist-changes.js');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A sample that is NOT chosen for having events: the common case is silence, and an optimisation
// that quietly turns silence into noise (or noise into silence) must be caught on both sides.
const busy = await sql`SELECT DISTINCT ticker FROM watchlist_events ORDER BY ticker LIMIT ${Math.floor(N / 2)}`;
const random = await sql`SELECT ticker FROM screener_stocks WHERE company IS NOT NULL ORDER BY random() LIMIT ${Math.ceil(N / 2)}`;
const tickers = [...new Set([...busy, ...random].map((r) => String(r.ticker).toUpperCase()))];
const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

console.log(`comparing ${tickers.length} securities (${busy.length} with known events, ${random.length} random)\n`);

const norm = (rows) => (rows || [])
  .map((r) => `${r.type}@${String(r.publicTime).slice(0, 19)}`)
  .sort()
  .join(',');

let agree = 0, differ = 0, engineOnly = 0, fastOnly = 0;
const t0 = Date.now();
// The engine path is slow by nature, so it is walked in slices below its own per-request cap.
for (let i = 0; i < tickers.length; i += 25) {
  const slice = tickers.slice(i, i + 25);
  const [engine, fast] = await Promise.all([
    watchlistChanges(slice, { since }),
    watchlistChangesFast(slice, { since }),
  ]);
  for (const t of slice) {
    const a = norm(engine.byTicker[t]);
    const b = norm(fast.byTicker[t]);
    if (a === b) { agree++; continue; }
    differ++;
    if (a && !b) engineOnly++;
    if (b && !a) fastOnly++;
    console.error(`  DIFFER ${t}\n     engine: ${a || '(none)'}\n     fast:   ${b || '(none)'}`);
  }
}
console.log(`\nagree           : ${agree}`);
console.log(`differ          : ${differ}`);
console.log(`engine-only     : ${engineOnly}   (a materialised MISS — the serious direction)`);
console.log(`materialised-only: ${fastOnly}   (usually an event older than the engine's own since-cut)`);
console.log(`elapsed         : ${Date.now() - t0}ms`);

ok('⚠️ the optimised path introduces no false negatives', engineOnly === 0,
  `${engineOnly} securities where the engine found an event and the materialised view did not`);
ok('⚠️ the two paths agree on every security sampled', differ === 0, `${differ} disagreements`);

// ── COVERAGE IS REPORTED, NOT ASSUMED ────────────────────────────────────────
{
  const r = await watchlistChangesFast(tickers.slice(0, 5), { since });
  ok('the read reports whether the view is current', typeof r.coverage?.fresh === 'boolean');
  ok('...and says how old it is', r.coverage.builtThrough !== undefined && r.coverage.ageMs !== undefined);
  ok('⚠️ nothing is ever truncated on the read path', r.truncated === false && r.resolved === 5);
  console.log(`\ncoverage: fresh=${r.coverage.fresh} builtThrough=${r.coverage.builtThrough} age=${Math.round((r.coverage.ageMs ?? 0) / 1000)}s`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
