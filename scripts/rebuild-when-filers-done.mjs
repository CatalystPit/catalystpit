// Waits for the institutions-universe rotation to finish sweeping the untouched filers, then
// rebuilds the institution_heatmap aggregate exactly once.
//
// "Finished" means one of:
//   - every filer has been attempted (untried = 0), or
//   - the rotation has made no progress for STALL_MIN minutes (the cron stopped, or SEC is blocking)
//
// It only ever RUNS the existing build script. It does not ingest, does not touch fund_holdings,
// fund_filings, SEC or dedupe, and writes nothing itself.
//
// Run: node --env-file=.env.local scripts/rebuild-when-filers-done.mjs

import postgres from 'postgres';
import { spawn } from 'node:child_process';

const POLL_MS = 5 * 60 * 1000;      // the rotation is hourly-ish; 5 min is plenty
const STALL_MIN = 90;               // give up waiting if nothing moves for this long
const MAX_HOURS = 12;               // hard ceiling so this can never linger

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const stamp = () => new Date().toISOString().slice(11, 19);

// The target is specifically the filers that have NO filings and have never been attempted — the
// 574 that represent real outstanding work. The much larger "never attempted" pool already has its
// filings ingested; the rotation only revisits those to refresh, which is not what we are waiting on.
const state = async () => (await sql`
  select count(*) filter (where (filing_count = 0 or filing_count is null) and last_attempt_at is null) untried,
         count(*) filter (where filing_count > 0) with_filings,
         max(last_attempt_at) last_attempt
    from institutions`)[0];

const start = Date.now();
let last = await state();
let lastProgressAt = Date.now();
console.log(`${stamp()} watching — untried=${last.untried} with_filings=${last.with_filings}`);

let reason = null;
for (;;) {
  if (Number(last.untried) === 0) { reason = 'all filers attempted'; break; }
  if (Date.now() - start > MAX_HOURS * 3600e3) { reason = `hit the ${MAX_HOURS}h ceiling`; break; }

  await new Promise((r) => setTimeout(r, POLL_MS));
  const now = await state();
  const moved = Number(now.untried) !== Number(last.untried) || Number(now.with_filings) !== Number(last.with_filings);
  if (moved) {
    lastProgressAt = Date.now();
    const rate = Number(last.untried) - Number(now.untried);
    console.log(`${stamp()} untried=${now.untried} (-${rate}) with_filings=${now.with_filings}`);
  } else if (Date.now() - lastProgressAt > STALL_MIN * 60e3) {
    reason = `no progress for ${STALL_MIN} minutes`;
    last = now;
    break;
  }
  last = now;
}

console.log(`\n${stamp()} proceeding: ${reason}`);
console.log(`  final: untried=${last.untried}  with_filings=${last.with_filings}`);

// Snapshot the aggregate before, so the rebuild's effect is measurable.
const before = (await sql`select tickers, sectored_tickers, funds_both, funds_current, covered_value, computed_at
  from institution_heatmap_meta order by quarter desc limit 1`)[0];
console.log('  meta BEFORE:', JSON.stringify(before));
await sql.end();

console.log(`\n${stamp()} rebuilding institution_heatmap…\n`);
const child = spawn(process.execPath, ['--env-file=.env.local', 'scripts/build-institution-heatmap.mjs'],
  { stdio: 'inherit', cwd: process.cwd() });
child.on('exit', async (code) => {
  const s2 = postgres(process.env.DATABASE_URL, { max: 1 });
  const after = (await s2`select tickers, sectored_tickers, funds_both, funds_current, covered_value, computed_at
    from institution_heatmap_meta order by quarter desc limit 1`)[0];
  console.log(`\n${stamp()} rebuild exited ${code}`);
  console.log('  meta AFTER :', JSON.stringify(after));
  if (before && after) {
    console.log(`  funds_both   ${before.funds_both} -> ${after.funds_both}`);
    console.log(`  tickers      ${before.tickers} -> ${after.tickers}`);
    console.log(`  sectored     ${before.sectored_tickers} -> ${after.sectored_tickers}`);
  }
  await s2.end();
  process.exit(code ?? 0);
});
