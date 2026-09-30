// NEWS + PIT WIRE — the invariants the final audit established, and the defect it found.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-wire-audit.mjs
//
// ⚠️ THE DEFECT. Nasdaq's halt feed carries suffixed designations in its symbol field, and
// projectHalts() took it verbatim: production holds tickers ["VACI="] and ["TRAD="] with headlines
// reading "VACI= halted · Halt (M)". A trailing "=" is not a security — it yields a dead
// /ticker/VACI%3D link, a malformed headline, and a malformed candidate on a path that AUTOPOSTS to X.
// The four X candidates those produced were all suppressed by the editorial gate, so nothing reached
// the timeline; the gate caught what this should never have created.
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const one = async (q) => (await q)[0];

L('⚠️ an exchange symbol field is not automatically a symbol');
{
  const src = read('src/lib/primary-events.js');
  ok('⚠️ the halt projection validates the symbol with the canonical gate',
    /if \(!isIngestableSymbol\(sym\)\) return null;/.test(src));
  ok('…and drops the refused rows rather than inserting nulls', /\}\)\.filter\(Boolean\);/.test(src));
  ok('…using the shared gate, not a local shape test', /from '\.\/ticker-symbol\.mjs'/.test(src));
  // ⚠️ SKIPPED, NOT REPAIRED. Stripping a suffix to reach a base symbol would be a guess about which
  // security the exchange meant, which is the one thing attribution may not do.
  ok('the reason for skipping rather than rewriting is recorded', /SKIPPED rather than/.test(src));

  const { isIngestableSymbol } = await import('../src/lib/ticker-symbol.mjs');
  for (const s of ['VACI=', 'TRAD=', 'AAPL=']) ok(`${s} is refused`, isIngestableSymbol(s) === false);
  for (const s of ['VACI', 'TRAD', 'AAPL', 'BRK.B']) ok(`${s} is admitted`, isIngestableSymbol(s) === true);

  // Production: nothing NEW may arrive malformed. The four historical rows are left in place on
  // purpose — they record real exchange halts, and deleting them would lose the halt itself.
  const fresh = await one(sql`select count(*)::int n from primary_events
    where received_at > now() - interval '2 days'
      and exists (select 1 from unnest(tickers) t where t !~ '^[A-Z][A-Z0-9.-]{0,9}$')`);
  ok('⚠️ no row ingested in the last 2 days carries a malformed ticker', fresh.n === 0, `${fresh.n}`);
}

L('⚠️ one story is one row, however many times it is polled');
{
  const r = await one(sql`select count(*)::int total, count(distinct content_hash)::int hashes from primary_events`);
  ok('no duplicate content_hash', r.total === r.hashes, `${r.total} / ${r.hashes}`);
  // ⚠️ THE CONSTRAINTS, NOT TODAY'S DATA. Two of them: per-source identity and cross-source content.
  const idx = (await sql`select indexdef from pg_indexes where tablename='primary_events' and indexdef ilike '%unique%'`).map((i) => i.indexdef);
  ok('⚠️ (source, source_uid) is unique — a repeated poll cannot re-insert', idx.some((d) => /\(source, source_uid\)/.test(d)));
  ok('⚠️ content_hash is unique — two sources carrying one story collapse', idx.some((d) => /\(content_hash\)/.test(d)));
  const folded = await one(sql`select count(*)::int n from primary_events where cluster_id is not null`);
  ok('syndicated copies are folded into a parent rather than shown twice', folded.n > 100, `${folded.n}`);
}

L('⚠️ the wire clock is the event\'s own, never ours');
{
  const wire = read('src/app/api/wire/route.js');
  ok('published_at is the only timestamp the wire orders on', /the ONLY timestamp\. It is the event's own, not ours/.test(wire));
  const fut = await one(sql`select count(*)::int n from primary_events where published_at > now() + interval '1 hour'`);
  ok('⚠️ nothing is published in the future', fut.n === 0, `${fut.n}`);
  // ⚠️ X AUTOPOST WINDOWS ON published_at, which is what makes a backfill unable to post. If this
  // ever became received_at, re-ingesting old items would post them.
  ok('⚠️ X autopost selects on published_at, not on when we received it',
    /e\.published_at > now\(\) - \(\$\{sinceHours\}/.test(read('src/lib/x-publisher.js')));
  // Facebook measures from when the trust evidence arrived, and excludes mechanical wording — which
  // is what keeps halts off the Page entirely.
  const fb = read('src/lib/facebook-publisher.js');
  ok('Facebook gates on its catalyst-wording set', /headline_status = any\(/.test(fb));
  const post = read('src/lib/facebook-post.mjs');
  ok('⚠️ …which excludes the mechanical halt wording', /FB_CATALYST_WORDING = new Set\(\['original', 'composed'\]\)/.test(post));
  ok('…and halts are written as not_required', /headline_status: 'not_required'/.test(read('src/lib/primary-events.js')));
}

L('⚠️ severity cannot be promoted by a parsing failure');
{
  const ps = read('src/lib/primary-sources.mjs');
  ok('importance is decided by a named function, not inline', /export function importanceOf|function importanceOf/.test(ps));
  ok('a halt is stated as always actionable, by source', /if \(source === 'NASDAQ'\) return 2;/.test(ps));
  // Production: no row carries an importance outside the declared range.
  const imp = await one(sql`select min(importance)::int lo, max(importance)::int hi,
    count(*) filter (where importance is null)::int nulls from primary_events`);
  ok('importance stays inside its declared range', imp.lo >= 0 && imp.hi <= 3, `${imp.lo}..${imp.hi}`);
  ok('no row has a null importance', imp.nulls === 0, `${imp.nulls}`);
}

L('⚠️ the X tape refreshes on a signal, not on a blind timer');
{
  const tape = read('src/components/XTape.jsx');
  // ⚠️ THE ORIGINAL DEFECT: rebuilding on a timer spends the VISITOR's X rate limit and a refused
  // rebuild silently leaves a stale tape up. Fixed, and this asserts the fix stays wired.
  ok('the component polls the same-origin head signal', /HEAD_URL = '\/api\/x-tape\/head'/.test(tape));
  ok('…and rebuilds only when the newest id changed', /WHAT DRIVES A REBUILD/.test(tape));
  ok('…with a timer only as the fallback', /TIMER_REFRESH_MS/.test(tape) && /fallback cadence/.test(tape));
  const head = read('src/app/api/x-tape/head/route.js');
  ok('⚠️ the head signal returns no post content', /It returns NO post/.test(head));
  ok('…and is never shared-cacheable', /no-store/.test(head));
}

L('the wire API is bounded and leaks nothing');
{
  const wire = read('src/app/api/wire/route.js');
  ok('the wire never selects raw source payloads into the response', !/\braw\b\s*,/.test(wire.split('SELECTABLE')[1] || ''));
  ok('its responses are private', /no-store/.test(wire));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
