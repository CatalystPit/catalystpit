// FACEBOOK TRUSTED-SOURCE EVIDENCE: arrival order must not decide whether an event can qualify.
//
//   node --env-file=.env.local --import ./scripts/verify-facebook-trust-register.mjs scripts/verify-facebook-trust.mjs
//
// THE FAILURE THIS PINS. On 2026-09-17 FinancialJuice filed the Standard Chartered Fed story at
// 12:58:32 and Walter Bloomberg filed the same story at 12:58:53. Walter's copy folded into
// FinancialJuice's canonical event, insertEvents only queues Facebook for a trusted source's OWN
// canonical row, and the story never reached the Page. Nothing recorded why.
//
// Everything below runs the REAL ingestion and queueing code against synthetic rows in an isolated
// scratch SCHEMA on the DIRECT (non-pooled) endpoint — never a temp table on a pooled connection,
// and never the real tables. The schema is dropped in finally. No model call and no network call.

import postgres from 'postgres';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const section = (s) => console.log(`\n=== ${s} ===`);

if (!process.env.DATABASE_URL) { console.log('needs DATABASE_URL'); process.exit(1); }
const directUrl = process.env.DATABASE_URL.replace(/-pooler(?=[.])/, '');
if (/-pooler[.]/.test(directUrl)) { console.error('refusing to run through the pooler'); process.exit(1); }

const pg = postgres(directUrl, { max: 2, onnotice: () => {} });
const schema = `zz_verify_fbtrust_${process.pid}_${Date.now()}`;
const conn = await pg.reserve();
globalThis.__ENRICH_E2E_CONN = conn;

const STORY = 'STANDARD CHARTERED EXPECTS US FED TO DELIVER A 25 BPS RATE HIKE IN DECEMBER 2026';
const CATALYST = 'Standard Chartered expects Fed to raise rates 25 basis points in December 2026';

try {
  await conn.unsafe(`create schema ${schema}`);
  for (const t of ['primary_events', 'feed_state', 'fb_post_candidates']) {
    await conn.unsafe(`create table ${schema}.${t} (like public.${t} including defaults including constraints including indexes)`);
  }
  await conn.unsafe(`set search_path = ${schema}, public`);

  const { insertEvents, dedupeAndInsert, foldOnDisplayHeadline } = await import('../src/lib/primary-events.js');
  const { queueTrustedFacebook, queueRewordedFacebook } = await import('../src/lib/facebook-publisher.js');
  const { facebookEligibility, facebookText, qualifiesByEvidence } = await import('../src/lib/facebook-post.mjs');
  const { claimSql } = await import('../src/lib/enrich-claim.mjs');
  const { normHash } = await import('../src/lib/event-cluster.mjs');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();

  let n = 0;
  const event = (source, text = STORY) => {
    const uid = `uid-${source}-${++n}`;
    return {
      source, source_name: source, source_kind: 'external', source_type: 'news', source_uid: uid,
      headline: text, source_headline: text, summary: null,
      published_at: new Date().toISOString(), original_url: `https://example.test/${uid}`,
      tickers: [], category: 'MARKETS', importance: 3, content_hash: `hash-${uid}`,
      // Same normalised words for every copy, so the real dedupe folds them into one event.
      norm_hash: 'standard chartered fed 25 bps rate hike december', display_hash: 'standard chartered fed 25 bps rate hike december',
      entity: 'standard-chartered', fact_sig: 'b25', headline_status: 'rewrite_pending', pipeline_status: 'pending',
      display_ready: true, raw: {},
    };
  };
  const reset = async () => {
    await conn.unsafe(`truncate ${schema}.primary_events, ${schema}.fb_post_candidates, ${schema}.feed_state`);
  };
  const canonical = async () => (await conn.unsafe(`select * from primary_events where cluster_id is null order by seq limit 1`))[0];
  const candidates = async () => await conn.unsafe(`select * from fb_post_candidates order by id`);
  const giveCatalystWording = async (seq) =>
    conn.unsafe(`update primary_events set headline = $1, headline_status = 'original' where seq = $2`, [CATALYST, seq]);

  section('1. pure: evidence qualifies the event, corroboration does not');
  {
    const head = { source: 'FINANCIALJUICE', headline: CATALYST, source_headline: STORY, headline_status: 'original', trusted_source: 'WALTERBLOOMBERG', tickers: [] };
    ok('a canonical event with trusted evidence qualifies', facebookEligibility(head, { isNew: true, isCanonical: true }).eligible);
    ok('...and publishes CATALYST wording, not the trusted source\'s copy',
      (facebookText(head) || '').includes('raise rates 25 basis points') && !(facebookText(head) || '').toUpperCase().includes('DELIVER A 25 BPS'));
    const pending = { ...head, headline_status: 'rewrite_pending', headline: STORY };
    const d = facebookEligibility(pending, { isNew: true, isCanonical: true });
    ok('...but waits while the rewrite is pending, rather than publishing the publisher\'s line',
      !d.eligible && /awaiting Catalyst wording/.test(d.reason), JSON.stringify(d));
    const corroborated = { ...head, trusted_source: null };
    ok('an ordinary second source is NOT evidence', !facebookEligibility(corroborated, { isNew: true, isCanonical: true }).eligible);
    // Only a TRUSTED source counts. A value in the field that is not on the trusted list is not
    // evidence, so corroboration by ordinary wires can never qualify an event.
    const notTrusted = { ...head, trusted_source: 'FINANCIALJUICE' };
    ok('a non-trusted source recorded in the field is not evidence',
      !facebookEligibility(notTrusted, { isNew: true, isCanonical: true }).eligible
      && !qualifiesByEvidence(notTrusted), JSON.stringify(facebookEligibility(notTrusted, { isNew: true, isCanonical: true })));
    ok('qualifiesByEvidence is false for a whitelisted source\'s own row',
      !qualifiesByEvidence({ source: 'WALTERBLOOMBERG', trusted_source: 'WALTERBLOOMBERG' }));
  }

  section('2. CASE A — trusted source arrives FIRST, another source follows');
  await reset();
  {
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    const afterFirst = await candidates();
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    const c = await canonical();
    const after = await candidates();
    ok('queued at ingest, as before', afterFirst.length === 1);
    ok('the later duplicate adds no second candidate', after.length === 1, JSON.stringify(after.map((x) => x.event_seq)));
    ok('the event records the trusted source', c.trusted_source === 'WALTERBLOOMBERG' && !!c.trusted_seen_at);
    ok('the post is the trusted source\'s own line (unchanged behaviour)', /DELIVER A 25 BPS|deliver a 25 bps/i.test(after[0].message));
    const scan = await queueTrustedFacebook();
    ok('the evidence scan does not queue it again', (await candidates()).length === 1 && scan.queued === 0, JSON.stringify(scan));
  }

  section('3. CASE B — the Standard Chartered pattern: another source first, trusted source after');
  await reset();
  {
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    const head = await canonical();
    ok('the ordinary source creates the canonical event', head.source === 'FINANCIALJUICE');
    ok('...and queues nothing at ingest', (await candidates()).length === 0);
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    const merged = await conn.unsafe(`select seq, cluster_id, source from primary_events where source = 'WALTERBLOOMBERG'`);
    const head2 = await canonical();
    ok('the trusted copy folds into the existing event', Number(merged[0].cluster_id) === Number(head.seq));
    ok('the canonical event GAINS the trusted evidence', head2.trusted_source === 'WALTERBLOOMBERG' && !!head2.trusted_seen_at);
    const early = await queueTrustedFacebook();
    const stillEvidenced = await canonical();
    // The scan filters on wording in SQL, so a pending event is not even examined. What matters is
    // that nothing is queued and the evidence survives for the next pass.
    ok('CASE E: while the rewrite is pending nothing is queued',
      (await candidates()).length === 0 && early.queued === 0, JSON.stringify(early));
    ok('...and the evidence is preserved for the next pass',
      stillEvidenced.trusted_source === 'WALTERBLOOMBERG' && stillEvidenced.headline_status === 'rewrite_pending');
    await giveCatalystWording(head.seq);
    const scan = await queueTrustedFacebook();
    const c = await candidates();
    ok('once Catalyst wording exists the event is queued', c.length === 1 && scan.queued === 1, JSON.stringify(scan));
    ok('the queued post uses CATALYST wording, not the trusted source\'s copy',
      c[0].message.includes('raise rates 25 basis points') && !/DELIVER A 25 BPS/i.test(c[0].message), c[0].message.slice(0, 120));
    ok('the candidate is attached to the canonical event', Number(c[0].event_seq) === Number(head.seq));
    const again = await queueTrustedFacebook();
    ok('CASE G: the scan is idempotent', (await candidates()).length === 1 && again.queued === 0);
  }

  section('4. CASE C — two ordinary sources, no trusted evidence');
  await reset();
  {
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    await dedupeAndInsert([event('BREAKINGMARKETNEWS')]);
    const head = await canonical();
    await giveCatalystWording(head.seq);
    const scan = await queueTrustedFacebook();
    ok('no trusted evidence is recorded', head.trusted_source === null);
    ok('nothing is queued', (await candidates()).length === 0 && scan.examined === 0, JSON.stringify(scan));
  }

  section('5. CASE D — the event already posted, then the trusted source reports it');
  await reset();
  {
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    const head = await canonical();
    await giveCatalystWording(head.seq);
    await conn.unsafe(`insert into fb_post_candidates (event_seq, source_uid, content_hash, message, status, posted_at)
                       values ($1, 'x', 'already-posted', $2, 'posted', now())`, [head.seq, CATALYST]);
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    const scan = await queueTrustedFacebook();
    ok('it is not posted again', (await candidates()).length === 1 && scan.queued === 0, JSON.stringify(scan));
  }

  section('6. CASE F — several trusted copies of the same event');
  await reset();
  {
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    const head = await canonical();
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    const firstSeen = (await canonical()).trusted_seen_at;
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    const head2 = await canonical();
    ok('the FIRST sighting is kept', String(head2.trusted_seen_at) === String(firstSeen));
    ok('source_count counts every copy', Number(head2.source_count) >= 2, String(head2.source_count));
    await giveCatalystWording(head.seq);
    await queueTrustedFacebook();
    await queueTrustedFacebook();
    ok('at most one post', (await candidates()).length === 1);
  }

  section('7. a candidate on ANY copy blocks a second post (post-rewrite fold)');
  await reset();
  {
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    const walter = await canonical();
    ok('queued on the trusted row', (await candidates()).length === 1);
    // The trusted row later folds into an older canonical event, as foldOnDisplayHeadline can do.
    await conn.unsafe(`insert into primary_events (seq, source, source_name, source_kind, source_type, source_uid, headline, source_headline,
        original_url, tickers, importance, content_hash, headline_status, pipeline_status, display_ready, cluster_id, published_at, received_at, trusted_source, trusted_seen_at)
        values (999000001, 'BLOOMBERG', 'BLOOMBERG', 'external', 'news', 'older-uid', $1, $1, 'u', '{}', 3, 'older-hash', 'original', 'ready', true, null, now(), now(), 'WALTERBLOOMBERG', now())`, [CATALYST]);
    await conn.unsafe(`update primary_events set cluster_id = 999000001 where seq = $1`, [walter.seq]);
    const scan = await queueTrustedFacebook();
    // The SQL itself must exclude it. sameTopic would also stop the post, but relying on that alone
    // would mean a story whose wording diverged could still publish twice.
    ok('the older event is not even examined while a copy already has a candidate',
      scan.examined === 0 && scan.queued === 0, JSON.stringify(scan));
    ok('...and no second candidate exists', (await candidates()).length === 1);
  }

  section('7b. a trusted row that folds AFTER its rewrite carries its evidence to the event');
  await reset();
  {
    // The fold matches on normHash of the DISPLAY headline, and the older event must have the lower
    // seq — that is what makes the row already on screen win.
    await dedupeAndInsert([{ ...event('WALTERBLOOMBERG'), norm_hash: 'unrelated words entirely here' }]);
    const walter = (await conn.unsafe(`select seq from primary_events where source = 'WALTERBLOOMBERG'`))[0];
    const older = Number(walter.seq) - 1;
    await conn.unsafe(`insert into primary_events (seq, source, source_name, source_kind, source_type, source_uid, headline, source_headline,
        original_url, tickers, importance, content_hash, headline_status, pipeline_status, display_ready, cluster_id, display_hash, published_at, received_at)
        values ($1, 'BLOOMBERG', 'BLOOMBERG', 'external', 'news', 'older-2', $2, $2, 'u', '{}', 3, 'older-hash-2', 'original', 'ready', true, null, $3, now(), now())`,
      [older, CATALYST, normHash(CATALYST)]);
    await conn.unsafe(`delete from fb_post_candidates`);          // ignore the ingest-time candidate
    const folded = await foldOnDisplayHeadline(walter.seq, CATALYST, new Date().toISOString());
    const head = (await conn.unsafe(`select trusted_source, trusted_seen_at from primary_events where seq = $1`, [older]))[0];
    ok('the row folded', folded === 1, String(folded));
    ok('the event it joined now carries the trusted evidence', head.trusted_source === 'WALTERBLOOMBERG' && !!head.trusted_seen_at, JSON.stringify(head));
    const scan = await queueTrustedFacebook();
    ok('...and that event can then be queued once, in Catalyst wording',
      scan.queued === 1 && (await candidates()).length === 1 && (await candidates())[0].message.includes('raise rates 25 basis points'));
  }

  section('7c. stale evidence never posts (nothing historical is resurrected)');
  await reset();
  {
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    const head = await canonical();
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    await giveCatalystWording(head.seq);
    await conn.unsafe(`update primary_events set trusted_seen_at = now() - interval '6 hours', received_at = now() - interval '6 hours' where seq = $1`, [head.seq]);
    const scan = await queueTrustedFacebook();
    ok('an event whose evidence arrived long ago is not queued', scan.queued === 0 && (await candidates()).length === 0, JSON.stringify(scan));
  }

  section('8. arrival order does not change the outcome');
  const outcome = async (order) => {
    await reset();
    for (const s of order) await dedupeAndInsert([event(s)]);
    const head = await canonical();
    await giveCatalystWording(head.seq);
    await queueTrustedFacebook();
    const c = await candidates();
    return { count: c.length, trusted: head.trusted_source, qualified: c.length === 1 };
  };
  {
    const a = await outcome(['WALTERBLOOMBERG', 'FINANCIALJUICE']);
    const b = await outcome(['FINANCIALJUICE', 'WALTERBLOOMBERG']);
    ok('both orders record the trusted evidence', a.trusted === 'WALTERBLOOMBERG' && b.trusted === 'WALTERBLOOMBERG', JSON.stringify({ a, b }));
    ok('both orders qualify', a.qualified && b.qualified, JSON.stringify({ a, b }));
    ok('both orders publish exactly one post', a.count === 1 && b.count === 1, JSON.stringify({ a, b }));
  }

  section('9. cost: merged copies never become separate paid rewrites');
  await reset();
  {
    await dedupeAndInsert([event('FINANCIALJUICE')]);
    const head = await canonical();
    await dedupeAndInsert([event('WALTERBLOOMBERG')]);
    await dedupeAndInsert([event('BREAKINGMARKETNEWS')]);
    const q = dialect.sqlToQuery(claimSql({ limit: 60, token: 'verify-fb', scope: 'all' }));
    const claimed = await conn.unsafe(q.sql, q.params);
    const heads = claimed.filter((r) => Number(r.seq) === Number(head.seq)).length;
    const ordinaryMembers = claimed.filter((r) => r.source === 'BREAKINGMARKETNEWS').length;
    ok('the ordinary duplicate is never sent to the model', ordinaryMembers === 0, JSON.stringify(claimed.map((r) => r.source)));
    ok('the canonical event is rewritten once', heads === 1);
    ok('at most one extra claim for the whole cluster (the trusted member, until the head has wording)',
      claimed.length <= 2, JSON.stringify(claimed.map((r) => `${r.source}:${r.seq}`)));
    await conn.unsafe(`update primary_events set enrich_claimed_at = null, enrich_claim_token = null where true`);
    await giveCatalystWording(head.seq);
    const q2 = dialect.sqlToQuery(claimSql({ limit: 60, token: 'verify-fb2', scope: 'all' }));
    const after = await conn.unsafe(q2.sql, q2.params);
    ok('once the event has Catalyst wording, nothing in the cluster is claimable', after.length === 0, JSON.stringify(after.map((r) => r.source)));
  }
} catch (e) {
  ok('the run completed', false, e.stack || e.message);
} finally {
  try { await conn.unsafe(`set search_path = public`); } catch {}
  await conn.unsafe(`drop schema if exists ${schema} cascade`).catch((e) => ok('scratch schema dropped', false, e.message));
  const left = await conn.unsafe(`select count(*)::int n from pg_namespace where nspname like 'zz_verify_fbtrust_%'`);
  ok('no scratch schema left behind', Number(left[0].n) === 0);
  conn.release();
  await pg.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
