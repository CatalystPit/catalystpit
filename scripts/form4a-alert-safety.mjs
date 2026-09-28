// PROOF THAT THE LINEAGE BACKFILL CANNOT FIRE AN EVIDENCE ALERT.
//
//   node scripts/form4a-alert-safety.mjs --snapshot   # before the backfill
//   node scripts/form4a-alert-safety.mjs --compare    # after it
//
// ⚠️ THE ONLY THING AN ALERT LOOKS AT IS publicTime. evidence/model.mjs:changedSince filters on
// publicTime and nothing else, and for the insider family evidence/resolve.js sets
// publicTime = newest.filing_date over the rows that survive the superseded filter. insider-alerts
// keys on inserted_at instead. The backfill writes neither column — only amends_accession,
// amend_link_basis, orig_submission_date and superseded_by.
//
// That is the argument. This is the measurement: the newest visible filing per ticker, before and
// after. Excluding a superseded row can only move that date BACKWARD (a filing leaves the set), and
// a date moving backward can never cross a subscriber's watermark upward. An increase anywhere would
// falsify the argument, so an increase is the failure condition.
//
// ⚠️ THE ONE OPERATION THAT CAN RAISE A DATE IS CLEARING AN EXCLUSION, and the backfill clears only
// links whose chronology is impossible — two of them, IONQ 0000950170-25-039065 (2025-03-13) and
// CET 0001209992-26-000002 (2026-01-06). Both restored filings are far older than their ticker's
// newest visible filing (2026-09-15 and 2026-06-30), so neither moves a publicTime.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());
const SNAP = path.join(process.cwd(), 'node_modules', '.cache', 'form4a-alert-snapshot.json');

// The newest filing each ticker can currently show — exactly what becomes publicTime — plus the
// count behind it, so a silently emptied ticker is visible too.
//
// ⚠️ PINNED TO THE SNAPSHOT INSTANT. The per-minute refresh cron keeps ingesting while this runs,
// and a genuinely new Form 4 arriving mid-measurement looks exactly like the backfill moving a date
// forward — it did, twice, on the first attempt. Both sides therefore see only rows that existed
// when the snapshot was taken, which is the population the backfill could have affected.
const take = async (asOf) => {
  const rows = await sql`
    SELECT ticker,
           max(filing_date)::text AS newest,
           count(*)::int          AS rows
      FROM insider_trades
     WHERE coalesce(superseded_by, '') = ''
       AND inserted_at <= ${asOf}::timestamptz
     GROUP BY ticker`;
  return Object.fromEntries(rows.map((r) => [r.ticker, [r.newest, r.rows]]));
};

if (process.argv.includes('--snapshot')) {
  const asOf = new Date().toISOString();
  const snap = await take(asOf);
  fs.writeFileSync(SNAP, JSON.stringify({ asOf, snap }));
  console.log(`snapshot as of ${asOf}: ${Object.keys(snap).length} tickers -> ${SNAP}`);
  process.exit(0);
}

const saved = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
const before = saved.snap;
console.log(`comparing against the corpus as it stood at ${saved.asOf}\n`);
const after = await take(saved.asOf);
let moved = 0, back = 0, same = 0, gone = 0, added = 0;
const forward = [];
for (const [t, [bNew, bRows]] of Object.entries(before)) {
  const a = after[t];
  if (!a) { gone++; continue; }
  const [aNew, aRows] = a;
  if (aNew === bNew) { same++; }
  else if (aNew < bNew) { back++; if (forward.length < 0) { /* noop */ } }
  else { moved++; forward.push({ ticker: t, before: bNew, after: aNew, rowsBefore: bRows, rowsAfter: aRows }); }
}
for (const t of Object.keys(after)) if (!(t in before)) added++;

console.log(`tickers compared:                    ${Object.keys(before).length}`);
console.log(`newest visible filing UNCHANGED:     ${same}`);
console.log(`moved BACKWARD (a filing excluded):  ${back}`);
console.log(`⚠️ moved FORWARD (would alert):      ${moved}`);
console.log(`tickers that lost every row:         ${gone}`);
console.log(`tickers that appeared:               ${added}`);
if (forward.length) { console.log('\nforward movement:'); for (const f of forward.slice(0, 20)) console.log(' ', JSON.stringify(f)); }
console.log(moved || added ? '\nFAIL — an alert could fire' : '\nPASS — no ticker can present a newer filing than it did before');
process.exit(moved || added ? 1 : 0);
