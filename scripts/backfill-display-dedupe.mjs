// Backfill display_hash on existing rows, then collapse the canonical events that were already
// showing the same headline twice on the tape.
//
// Two production duplicates motivated this and both are covered:
//   * one press release published in four languages, each with its own GlobeNewswire release id,
//     all four rewritten into the same English sentence
//   * two outlets whose different phrasings were rewritten into identical Catalyst Pit wording
//
// SAFETY, in order of importance:
//   * nothing is ever deleted. A duplicate is ATTACHED to the older event via cluster_id, exactly
//     as every folded record already is, and keeps its own headline, url, uid, raw and timestamps.
//   * the OLDEST row in a duplicate set always becomes the head, so the row a trader has already
//     seen keeps its position and its timestamp.
//   * the 36-hour proximity gate applies. The Fed publishes "Federal Reserve issues FOMC statement"
//     verbatim eight times a year; those are eight events and must stay eight events.
//   * SEC is excluded entirely.
//   * --apply is required. Without it this only reports what it would do.
//
// Run: node --env-file=.env.local scripts/backfill-display-dedupe.mjs [--apply]

import postgres from 'postgres';
import { normHash, PROXIMITY_MS, RELAY_WINDOW_MS, wordContainment, citedOutlet, sharedCore, actionClass } from '../src/lib/event-cluster.mjs';

const APPLY = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const PROX_SEC = PROXIMITY_MS / 1000;

// ── 1. backfill display_hash ────────────────────────────────────────────────
// normHash lives in JS, so this is computed here rather than approximated in SQL.
let scanned = 0, written = 0;
for (;;) {
  const rows = await sql`select seq, headline from primary_events
    where display_hash is null and headline is not null limit 2000`;
  if (!rows.length) break;
  scanned += rows.length;
  const pairs = rows.map((r) => ({ seq: r.seq, h: normHash(r.headline) || '' }));
  // Empty string rather than null so a short headline is not rescanned forever.
  await sql`update primary_events p set display_hash = v.h
    from (values ${sql(pairs.map((p) => [p.seq, p.h]))}) as v(seq, h)
    where p.seq = v.seq::bigint`;
  written += rows.length;
  process.stdout.write(`\r  display_hash backfilled: ${written}`);
}
console.log(`\n  backfill complete — ${written} rows`);

// ── 2. find canonical events that would render identically ──────────────────
const dupes = await sql`
  select display_hash,
         array_agg(seq order by seq) seqs,
         array_agg(coalesce(published_at, received_at) order by seq) times,
         array_agg(distinct source) sources,
         min(headline) headline
    from primary_events
   where cluster_id is null
     and source_kind <> 'sec'
     and display_hash is not null and display_hash <> ''
   group by display_hash
  having count(*) > 1`;

console.log(`\n  display-headline collisions among canonical events: ${dupes.length}`);

// Within a collision, only rows inside the proximity window of the head collapse. A recurring
// notice published months apart is a different event that happens to share a sentence.
const plan = [];
for (const d of dupes) {
  const head = { seq: d.seqs[0], at: new Date(d.times[0]).getTime() };
  const members = [];
  for (let i = 1; i < d.seqs.length; i++) {
    const t = new Date(d.times[i]).getTime();
    if (Math.abs(t - head.at) <= PROXIMITY_MS) members.push(d.seqs[i]);
  }
  if (members.length) plan.push({ head: head.seq, members, sources: d.sources, headline: d.headline });
}

const totalMerges = plan.reduce((n, p) => n + p.members.length, 0);
console.log(`  within the 36h window: ${plan.length} events to collapse, ${totalMerges} rows to attach`);
console.log(`  outside the window (left alone, recurring notices): ${dupes.length - plan.length}\n`);

for (const p of plan.slice(0, 15)) {
  console.log(`   head ${p.head} <- ${p.members.join(', ')}  [${p.sources.join('/')}]`);
  console.log(`     ${JSON.stringify(p.headline).slice(0, 96)}`);
}
if (plan.length > 15) console.log(`   … and ${plan.length - 15} more`);

// ── 3. attach ───────────────────────────────────────────────────────────────
let merged = 0;
for (const p of (APPLY ? plan : [])) {
  // Any row already pointing at a member must be re-pointed at the head, so clusters stay exactly
  // one level deep and no row is orphaned behind a row that is no longer canonical.
  await sql`update primary_events set cluster_id = ${p.head} where cluster_id = any(${p.members})`;
  await sql`update primary_events set cluster_id = ${p.head} where seq = any(${p.members})`;
  await sql`update primary_events
     set source_count = (select count(*) + 1 from primary_events where cluster_id = ${p.head}),
         last_seen_at = greatest(last_seen_at, now())
   where seq = ${p.head}`;
  merged += p.members.length;
}
console.log(`\n  attached ${merged} duplicate rows to ${plan.length} canonical events`);

// ── 3b. same wire release, different language edition ───────────────────────
// The other half of the multilingual problem. When the publisher reuses ONE release id across
// languages, the rewrites do not converge — "Jyske Realkredit opens new fixed rate bonds" and
// "...new fixed rate convertible bonds" are the same Danish/English release 3361074 — so the
// display-headline pass above cannot see it. A shared release id is definitional: reduce the URL
// to it and merge. canonicalUrl() now does this at ingest; this catches what was stored before.
const rel = await sql`
  with ids as (
    select seq, coalesce(published_at, received_at) at,
           (regexp_match(original_url, '/news-release/[0-9]{4}/[0-9]{2}/[0-9]{2}/([0-9]{4,})/'))[1] rid
      from primary_events
     where cluster_id is null and source_kind <> 'sec' and original_url ~ '/news-release/')
  select rid, array_agg(seq order by seq) seqs, array_agg(at order by seq) times
    from ids where rid is not null group by rid having count(*) > 1`;

let relMerged = 0, relSets = 0;
for (const g of rel) {
  const headAt = new Date(g.times[0]).getTime();
  const members = g.seqs.filter((_, i) => i > 0
    && Math.abs(new Date(g.times[i]).getTime() - headAt) <= PROXIMITY_MS);
  if (!members.length) continue;
  relSets++;
  if (!APPLY) { console.log(`   release ${g.rid}: head ${g.seqs[0]} <- ${members.join(', ')}`); continue; }
  await sql`update primary_events set cluster_id = ${g.seqs[0]} where cluster_id = any(${members})`;
  await sql`update primary_events set cluster_id = ${g.seqs[0]} where seq = any(${members})`;
  await sql`update primary_events
     set source_count = (select count(*) + 1 from primary_events where cluster_id = ${g.seqs[0]})
   where seq = ${g.seqs[0]}`;
  relMerged += members.length;
}
console.log(`  shared wire release id: ${relSets} sets, ${relMerged} rows attached`);

// ── 3c. relay re-wordings ───────────────────────────────────────────────────
// A wire re-sending one upstream story with the wording evolving. Neither the display headline nor
// the release id can see these — the text genuinely differs each time. Applies the same two
// deterministic tests findCluster now uses at ingest, over the same 30-minute window.
const recent = await sql`select seq, source, tickers, entity, headline, source_headline, fact_sig,
    coalesce(published_at, received_at) at
  from primary_events
 where cluster_id is null and source_kind <> 'sec'
   and coalesce(published_at, received_at) > now() - interval '7 days'
 order by coalesce(published_at, received_at)`;

const relayPlan = new Map();   // member seq -> head seq
const headOf = (s) => { let h = s; while (relayPlan.has(h)) h = relayPlan.get(h); return h; };
for (let i = 0; i < recent.length; i++) {
  for (let j = i + 1; j < recent.length; j++) {
    const a = recent[i], b = recent[j];
    if (new Date(b.at) - new Date(a.at) > RELAY_WINDOW_MS) break;
    if (relayPlan.has(b.seq)) continue;
    if (a.fact_sig && b.fact_sig && a.fact_sig !== b.fact_sig) continue;
    let hit = wordContainment(a.headline, b.headline);
    if (!hit) {
      const oa = citedOutlet(`${a.source_headline || ''} ${a.headline || ''}`);
      const ob = citedOutlet(`${b.source_headline || ''} ${b.headline || ''}`);
      const ta = new Set(a.tickers || []), tb = new Set(b.tickers || []);
      const sameCo = [...ta].some((t) => tb.has(t)) || (a.entity && a.entity === b.entity);
      const ca = actionClass(a.headline), cb = actionClass(b.headline);
      hit = !!oa && oa === ob && sameCo && !(ca && cb && ca !== cb)
        && sharedCore(a.headline, b.headline, [...ta, a.entity]) >= 2;
    }
    if (hit) relayPlan.set(b.seq, headOf(a.seq));
  }
}
console.log(`\n  relay re-wordings to collapse: ${relayPlan.size}`);
const byHead = new Map();
for (const [m, h] of relayPlan) { if (!byHead.has(h)) byHead.set(h, []); byHead.get(h).push(m); }
const title = (s) => recent.find((r) => Number(r.seq) === Number(s))?.headline || '?';
for (const [h, ms] of [...byHead].slice(0, 12)) {
  console.log(`   head ${h}: ${JSON.stringify(title(h)).slice(0, 78)}`);
  for (const m of ms) console.log(`      <- ${m}: ${JSON.stringify(title(m)).slice(0, 74)}`);
}
if (byHead.size > 12) console.log(`   … and ${byHead.size - 12} more`);

if (APPLY) {
  let n = 0;
  for (const [h, ms] of byHead) {
    await sql`update primary_events set cluster_id = ${h} where cluster_id = any(${ms})`;
    await sql`update primary_events set cluster_id = ${h} where seq = any(${ms})`;
    await sql`update primary_events
       set source_count = (select count(*) + 1 from primary_events where cluster_id = ${h})
     where seq = ${h}`;
    n += ms.length;
  }
  console.log(`  attached ${n} relay re-wordings to ${byHead.size} canonical events`);
}

// ── 4. prove it ─────────────────────────────────────────────────────────────
const left = await sql`
  select count(*) n from (
    select display_hash from primary_events
     where cluster_id is null and source_kind <> 'sec'
       and display_hash is not null and display_hash <> ''
     group by display_hash having count(*) > 1) t`;
const kept = await sql`select count(*) n from primary_events where cluster_id is not null`;
const sec = await sql`select count(*) n,
    count(*) filter (where headline <> source_headline) altered,
    count(*) filter (where cluster_id is not null) clustered
  from primary_events where source_kind = 'sec'`;
console.log(`  canonical display-headline collisions remaining: ${left[0].n} (recurring notices outside 36h)`);
console.log(`  folded source records preserved in total        : ${kept[0].n}`);
console.log(`  SEC: ${sec[0].n} rows, ${sec[0].altered} altered, ${sec[0].clustered} clustered`);
await sql.end();

if (!APPLY) console.log('\n  DRY RUN — nothing written. Re-run with --apply to collapse these.');
