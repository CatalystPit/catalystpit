// REATTACH USER-OWNED ROWS AFTER THE CLERK PRODUCTION SWITCH.
//
//   node --env-file=.env.local scripts/remap-clerk-user-ids.mjs old=user_A,new=user_B [more pairs] [--apply]
//
// A new Clerk instance issues new user ids, so every row keyed by the old one is orphaned. Measured
// on production before the switch: 13 tables, 65 rows, 4 distinct ids — small enough that this is
// 13 UPDATEs in a transaction rather than anything that deserves the word "migration".
//
// ⚠️ DRY RUN BY DEFAULT, and it reports per-table counts before and after so the move is checkable
// rather than assumed. --apply runs all tables in ONE transaction: a half-remapped user whose
// watchlist moved but whose alerts did not is worse than one who has not been moved at all.
//
// ⚠️ IT REFUSES TO OVERWRITE. If rows already exist under the NEW id the script stops, because that
// means the remap already ran (or the pair is wrong) and running again would merge two people.

import { neon } from '@neondatabase/serverless';

const APPLY = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

// Every table holding a Clerk user id, from information_schema at the time of the inventory.
const TABLES = [
  'watchlist', 'watchlist_lists', 'alerts', 'screener_saved', 'terminal_stations',
  'pit_messages', 'pit_message_reactions', 'pit_notifications', 'pit_posts',
  'pit_post_likes', 'pit_post_comments', 'pit_profiles', 'evidence_alerts_sent',
];

const pairs = process.argv
  .filter((a) => a.startsWith('old='))
  .map((a) => {
    const m = a.match(/^old=([^,]+),new=(.+)$/);
    if (!m) { console.error(`bad pair: ${a}  (expected old=user_A,new=user_B)`); process.exit(1); }
    return { old: m[1], nu: m[2] };
  });

if (!pairs.length) {
  console.log('usage: old=user_OLD,new=user_NEW [old=...,new=...] [--apply]');
  console.log('\ncurrent distinct owner ids in the database:');
  for (const t of TABLES) {
    const r = await sql.query(`select distinct user_id from ${t} where user_id is not null`);
    for (const x of r) console.log(`  ${x.user_id}  (${t})`);
  }
  process.exit(0);
}

console.log(`${pairs.length} pair(s), apply=${APPLY}\n`);
let blocked = false;
for (const p of pairs) {
  let from = 0, collide = 0;
  for (const t of TABLES) {
    const a = await sql.query(`select count(*)::int n from ${t} where user_id = $1`, [p.old]);
    const b = await sql.query(`select count(*)::int n from ${t} where user_id = $1`, [p.nu]);
    from += a[0].n; collide += b[0].n;
    if (a[0].n || b[0].n) console.log(`  ${t.padEnd(24)} old ${String(a[0].n).padStart(3)}   new ${b[0].n}`);
  }
  console.log(`  → ${p.old} : ${from} rows to move; ${collide} already under the new id`);
  if (collide > 0) { console.log('  ⚠️ REFUSING — rows already exist under the new id. Already remapped, or wrong pair.'); blocked = true; }
  if (from === 0) console.log('  (nothing to move)');
  console.log('');
}
if (blocked) process.exit(1);
if (!APPLY) { console.log('dry run — pass --apply to write'); process.exit(0); }

// One transaction for all tables and all pairs.
const stmts = [];
for (const p of pairs) for (const t of TABLES) stmts.push(sql.query(`update ${t} set user_id = $1 where user_id = $2`, [p.nu, p.old]));
await sql.transaction(stmts);

console.log('applied. verifying:');
for (const p of pairs) {
  let left = 0, moved = 0;
  for (const t of TABLES) {
    left += (await sql.query(`select count(*)::int n from ${t} where user_id = $1`, [p.old]))[0].n;
    moved += (await sql.query(`select count(*)::int n from ${t} where user_id = $1`, [p.nu]))[0].n;
  }
  console.log(`  ${p.old} → ${p.nu}   moved ${moved}, remaining under old id ${left}${left ? '  ⚠️' : ' ✓'}`);
}
