// A HIGHER-AUTHORITY COMPANY NAME MUST SURVIVE A LOWER-AUTHORITY REFRESH.
//
// Two individually reasonable decisions combined to lose data:
//
//   1. secTickerNames() fails SOFT — an SEC outage returns an empty map rather than aborting the
//      nightly rebuild, so one bad night does not cost every company name.
//   2. The upsert wrote `name = excluded.name` unconditionally.
//
// With sec_ticker (rank 3) missing for a night, any ticker named by BOTH SEC and the vendor falls
// through to `provider` (rank 4), and the vendor's name is written over the SEC name already stored.
// The run reports ok:true, because from its point of view nothing failed. The next night SEC returns
// and the SEC name wins again — so the product displayed a vendor's name in between and nothing
// anywhere records that it happened. A company name is exactly the kind of fact users notice and we
// do not.
//
// THE RULE: replace on EQUAL or HIGHER authority, refuse LOWER. Equal must still replace, or the
// table freezes at whatever it first learned and a corrected name can never land.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/verify-identity-rank.mjs
//   (DATABASE_URL optional — the SQL section is skipped without it, the rule section always runs.)

import { shouldReplaceIdentity, sourceRank, IDENTITY_SOURCES } from '../src/lib/security-identity.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };

console.log('\n=== the precedence itself ===');
{
  ok('form4 outranks registrant', sourceRank('form4') < sourceRank('registrant'));
  ok('registrant outranks sec_ticker', sourceRank('registrant') < sourceRank('sec_ticker'));
  ok('sec_ticker outranks provider', sourceRank('sec_ticker') < sourceRank('provider'));
  ok('an unknown source ranks below every known one',
    IDENTITY_SOURCES.every((s) => sourceRank(s) < sourceRank('mystery')));
}

console.log('\n=== THE OUTAGE CASE: provider must not overwrite sec_ticker ===');
{
  ok('sec_ticker → provider is REFUSED', !shouldReplaceIdentity('sec_ticker', 'provider'));
  ok('form4 → provider is REFUSED', !shouldReplaceIdentity('form4', 'provider'));
  ok('registrant → provider is REFUSED', !shouldReplaceIdentity('registrant', 'provider'));
  ok('form4 → sec_ticker is REFUSED', !shouldReplaceIdentity('form4', 'sec_ticker'));
}

console.log('\n=== legitimate corrections must NOT be blocked ===');
{
  ok('provider → sec_ticker is allowed (a promotion)', shouldReplaceIdentity('provider', 'sec_ticker'));
  ok('provider → form4 is allowed', shouldReplaceIdentity('provider', 'form4'));
  ok('sec_ticker → form4 is allowed', shouldReplaceIdentity('sec_ticker', 'form4'));
  // Equal rank MUST replace, or the table freezes at the first name it ever learned.
  ok('form4 → form4 replaces (a corrected name lands)', shouldReplaceIdentity('form4', 'form4'));
  ok('provider → provider replaces', shouldReplaceIdentity('provider', 'provider'));
  ok('sec_ticker → sec_ticker replaces', shouldReplaceIdentity('sec_ticker', 'sec_ticker'));
}

console.log('\n=== rows written before this rule existed ===');
{
  // An unknown/absent stored source ranks lowest, so anything can correct it — otherwise legacy rows
  // would be permanently frozen.
  ok('unknown stored source can be corrected by provider', shouldReplaceIdentity('legacy', 'provider'));
  ok('null stored source can be corrected', shouldReplaceIdentity(null, 'provider'));
  ok('undefined stored source can be corrected', shouldReplaceIdentity(undefined, 'sec_ticker'));
  // …but an unknown INCOMING source cannot displace a known one.
  ok('an unknown incoming source cannot displace sec_ticker', !shouldReplaceIdentity('sec_ticker', 'mystery'));
  ok('unknown → unknown is permitted (equal, lowest)', shouldReplaceIdentity('mystery', 'other'));
}

// ── THE SQL MUST AGREE WITH THE RULE ────────────────────────────────────────
// A guard that does not match the helper it mirrors is worse than no guard: the tests would pass and
// production would still overwrite. Run against a TEMP table so nothing real is touched.
if (!process.env.DATABASE_URL) {
  console.log('\n(SQL section skipped — no DATABASE_URL)');
} else {
  console.log('\n=== the same rule, executed as SQL against a scratch table ===');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const RANK = `ARRAY['${IDENTITY_SOURCES.join("','")}']::text[]`;

  // NOT a TEMP table. The neon HTTP driver opens a new connection per statement, so a temp table
  // would vanish between calls and every assertion below would silently pass against an empty
  // database — a test that proves nothing while looking green. A named scratch table is created and
  // dropped instead; it touches no production data.
  await sql.query(`drop table if exists _verify_ident_rank`);
  await sql.query(`create table _verify_ident_rank (ticker text primary key, name text, source text, updated_at timestamptz)`);
  const upsert = async (ticker, name, source) => {
    await sql.query(`
      insert into _verify_ident_rank (ticker, name, source, updated_at) values ($1, $2, $3, now())
      on conflict (ticker) do update set
        name = excluded.name, source = excluded.source, updated_at = excluded.updated_at
      where coalesce(array_position(${RANK}, excluded.source), 99)
         <= coalesce(array_position(${RANK}, _verify_ident_rank.source), 99)`, [ticker, name, source]);
  };
  const nameOf = async (t) => (await sql.query(`select name, source from _verify_ident_rank where ticker = $1`, [t]))[0];

  await upsert('ZTS', 'Zoetis Inc.', 'sec_ticker');
  await upsert('ZTS', 'ZOETIS INC COMMON STOCK', 'provider');          // the outage
  const a = await nameOf('ZTS');
  ok('SQL: provider did NOT overwrite the sec_ticker name', a.name === 'Zoetis Inc.' && a.source === 'sec_ticker');

  await upsert('ZTS', 'Zoetis Inc', 'form4');                          // a real promotion
  const b = await nameOf('ZTS');
  ok('SQL: form4 DID replace sec_ticker', b.name === 'Zoetis Inc' && b.source === 'form4');

  await upsert('ZTS', 'Zoetis Incorporated', 'form4');                 // same-rank correction
  ok('SQL: a same-rank correction lands', (await nameOf('ZTS')).name === 'Zoetis Incorporated');

  await upsert('NEW', 'Vendor Name', 'provider');
  ok('SQL: a first insert always lands', (await nameOf('NEW')).name === 'Vendor Name');
  await upsert('NEW', 'SEC Registrant Name', 'sec_ticker');
  ok('SQL: provider is then promoted to sec_ticker', (await nameOf('NEW')).source === 'sec_ticker');

  await sql.query(`insert into _verify_ident_rank (ticker, name, source, updated_at) values ('OLD', 'Legacy', null, now())`);
  await upsert('OLD', 'Vendor Name', 'provider');
  ok('SQL: a legacy row with no source can still be corrected', (await nameOf('OLD')).name === 'Vendor Name');

  // The helper and the SQL must agree on every ordered pair, not just the ones above.
  const srcs = [...IDENTITY_SOURCES, 'mystery'];
  let agree = true;
  for (const stored of srcs) {
    for (const incoming of srcs) {
      await sql.query(`delete from _verify_ident_rank where ticker = 'PAIR'`);
      await sql.query(`insert into _verify_ident_rank (ticker, name, source, updated_at) values ('PAIR', 'stored', $1, now())`, [stored]);
      await upsert('PAIR', 'incoming', incoming);
      const got = (await nameOf('PAIR')).name === 'incoming';
      if (got !== shouldReplaceIdentity(stored, incoming)) {
        agree = false;
        console.error(`    disagreement: stored=${stored} incoming=${incoming} sql=${got} helper=${shouldReplaceIdentity(stored, incoming)}`);
      }
    }
  }
  ok(`SQL and helper agree on all ${srcs.length * srcs.length} ordered source pairs`, agree);

  await sql.query(`drop table if exists _verify_ident_rank`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
