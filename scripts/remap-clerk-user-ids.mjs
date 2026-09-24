// REATTACH USER-OWNED ROWS AFTER THE CLERK PRODUCTION SWITCH.
//
//   node --env-file=.env.local scripts/remap-clerk-user-ids.mjs old=user_A,new=user_B [--absorb-empty] [--apply]
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
const ABSORB = process.argv.includes('--absorb-empty');
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

  // ⚠️ THE ONE BENIGN COLLISION, AND IT IS VERIFIED RATHER THAN ASSUMED.
  //
  // Signing up creates an empty default watchlist list, so a freshly recreated account already
  // owns one row before any remap. That is not the merge-two-people case the refusal exists to
  // prevent, but the count alone cannot tell them apart. --absorb-empty permits it ONLY when every
  // row under the new id is an empty default list: any list carrying items, or a row in any other
  // table, still blocks. The empty list is deleted so the incoming lists do not arrive beside a
  // stray duplicate.
  if (collide > 0 && ABSORB) {
    const lists = await sql.query('select id, name from watchlist_lists where user_id = $1', [p.nu]);
    let benign = lists.length > 0;
    for (const t of TABLES) {
      if (t === 'watchlist_lists') continue;
      const n = (await sql.query(`select count(*)::int n from ${t} where user_id = $1`, [p.nu]))[0].n;
      if (n) { benign = false; console.log(`  ⚠️ not absorbable: ${n} row(s) in ${t}`); }
    }
    for (const l of lists) {
      const items = (await sql.query('select count(*)::int n from watchlist where list_id = $1', [l.id]))[0].n;
      if (items) { benign = false; console.log(`  ⚠️ not absorbable: list "${l.name}" holds ${items} item(s)`); }
    }
    if (benign) {
      console.log(`  absorbing ${lists.length} empty default list(s) on the new id`);
      if (APPLY) for (const l of lists) await sql.query('delete from watchlist_lists where id = $1', [l.id]);
      collide = 0;
    }
  }

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
