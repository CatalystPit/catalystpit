// END-TO-END: the real runEnrichment(), real SQL, synthetic rows, stubbed model.
//
//   node --env-file=.env.local --import ./scripts/verify-enrich-e2e-register.mjs scripts/verify-enrich-e2e.mjs
//
// Everything runs in an isolated scratch SCHEMA on the DIRECT (non-pooled) endpoint, reached through
// a reserved connection whose search_path puts the scratch tables first. src/lib/db.js is swapped for
// a double that executes on that connection. No real row, feed state or usage record is touched, no
// model is called, and the schema is dropped in finally.

import postgres from 'postgres';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const section = (s) => console.log(`\n=== ${s} ===`);

if (!process.env.DATABASE_URL) { console.log('needs DATABASE_URL'); process.exit(1); }
const directUrl = process.env.DATABASE_URL.replace(/-pooler(?=[.])/, '');
if (/-pooler[.]/.test(directUrl)) { console.error('refusing to run through the pooler'); process.exit(1); }

const pg = postgres(directUrl, { max: 2, onnotice: () => {} });
const schema = `zz_verify_e2e_${process.pid}_${Date.now()}`;
const conn = await pg.reserve();
globalThis.__ENRICH_E2E_CONN = conn;

try {
  await conn.unsafe(`create schema ${schema}`);
  for (const t of ['primary_events', 'feed_state', 'anthropic_usage']) {
    await conn.unsafe(`create table ${schema}.${t} (like public.${t} including defaults including constraints including indexes)`);
  }
  await conn.unsafe(`set search_path = ${schema}, public`);

  const { runEnrichment, rewriteHealth } = await import('../src/lib/primary-events.js');

  let seq = 700000000;
  const ins = async (o) => {
    const s = ++seq;
    await conn.unsafe(`insert into primary_events (seq, source, source_name, source_kind, source_type, source_uid, headline, source_headline, summary,
        original_url, tickers, importance, content_hash, headline_status, pipeline_status, display_ready, cluster_id, published_at, received_at)
      values ($1, $2, $2, 'external', 'news', $3, $4, $4, null, 'u', $5::text[], $6, $3, $7, 'pending', true, $8, now(), now())`,
      [s, o.source || 'PRNEWSWIRE', `uid${s}`, o.headline, `{${(o.tickers || ['ACME']).join(',')}}`, o.importance ?? 1, o.status || 'rewrite_pending', o.cluster_id ?? null]);
    return s;
  };
  const row = async (s) => (await conn.unsafe(`select headline, headline_status, enrich_attempts, enrich_next_at, enrich_next_at::text as next_at_text, enrich_last_error, enrich_claimed_at, enrich_claim_token from primary_events where seq = $1`, [s]))[0];

  const S = {};
  S.good = await ins({ headline: 'Acme Corp raises quarterly dividend to $0.50 per share', importance: 2 });
  S.hype = await ins({ headline: 'Acme Corp opens new plant in Ohio with 200 jobs', importance: 1 });
  S.ungrounded = await ins({ headline: 'Acme Corp raises annual revenue outlook to $4 billion', importance: 1 });
  S.highUngrounded = await ins({ headline: 'Acme Corp raises full-year profit outlook to $3 billion', importance: 3 });
  S.imp0 = await ins({ headline: 'Acme Corp names new chief marketing officer', importance: 0 });
  S.head = await ins({ headline: 'Acme Corp completes merger with Beta Inc', importance: 2, status: 'original' });
  S.member = await ins({ headline: 'Acme and Beta close merger deal', importance: 2, cluster_id: S.head });

  // The model double: answers by the row's headline, and counts how often it is called and with what.
  const calls = [];
  const replies = {
    'Acme Corp raises quarterly dividend to $0.50 per share': 'Acme lifts quarterly dividend to $0.50 a share',
    'Acme Corp opens new plant in Ohio with 200 jobs': 'Acme soars with new Ohio plant and 200 jobs',
    'Acme Corp raises annual revenue outlook to $4 billion': 'Acme lifts annual revenue outlook to $9 billion',
    'Acme Corp raises full-year profit outlook to $3 billion': 'Acme lifts full-year profit outlook to $7 billion',
  };
  const good = (items) => {
    calls.push(items.map((i) => i.source_headline));
    return { results: new Map(items.map((it, i) => [i, { headline: replies[it.source_headline] || '', facts: null }])),
      available: true, errorClass: null, status: 200, model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 400 + 60 * items.length, output_tokens: 50 * items.length }, ms: 7 };
  };

  section('1. one pass: claim, rewrite, validate, schedule, record');
  const r1 = await runEnrichment({ generate: good, scope: 'fresh', feature: 'news-headline-rewrite' });
  const sent = calls.flat();
  ok('exactly one model call for the four eligible rows', calls.length === 1 && sent.length === 4, JSON.stringify(calls));
  ok('importance 0 was not sent', !sent.includes('Acme Corp names new chief marketing officer'));
  ok('the duplicate member was not sent', !sent.includes('Acme and Beta close merger deal'));
  ok('the CRITICAL row went first', sent[0] === 'Acme Corp raises full-year profit outlook to $3 billion', JSON.stringify(sent));

  const g = await row(S.good);
  ok('a valid rewrite becomes original', g.headline_status === 'original' && g.headline === 'Acme lifts quarterly dividend to $0.50 a share', JSON.stringify(g));
  ok('...with no retry scheduled and no error', g.enrich_next_at === null && g.enrich_last_error === null && g.enrich_attempts === 1);
  ok('...and its claim released', g.enrich_claimed_at === null && g.enrich_claim_token === null);

  const h = await row(S.hype);
  ok('a hype rewrite stays rewrite_pending with its reason recorded', h.headline_status === 'rewrite_pending' && h.enrich_last_error === 'hype', JSON.stringify(h));
  const hypeDelay = (new Date(h.enrich_next_at).getTime() - Date.now()) / 1000;
  ok('...and ONE delayed resample is scheduled (~10 min), not the next pass', hypeDelay > 500 && hypeDelay <= 600, String(hypeDelay));

  const u = await row(S.ungrounded);
  ok('an ordinary ungrounded rewrite is final: no resample', u.enrich_last_error === 'number (final)' && u.next_at_text === 'infinity', JSON.stringify(u));

  const c = await row(S.highUngrounded);
  const cDelay = (new Date(c.enrich_next_at).getTime() - Date.now()) / 1000;
  ok('a CRITICAL ungrounded rewrite retries immediately', c.enrich_last_error === 'number' && cDelay <= 1, JSON.stringify({ ...c, cDelay }));

  const z = await row(S.imp0);
  ok('importance 0 keeps its source wording, untouched', z.headline === 'Acme Corp names new chief marketing officer' && z.enrich_attempts === 0 && z.headline_status === 'rewrite_pending');

  const usage = await conn.unsafe(`select feature, model, ok, status, input_tokens, output_tokens, items from anthropic_usage`);
  ok('one usage row for the one call, with tokens and item count', usage.length === 1 && usage[0].input_tokens === 640 && usage[0].output_tokens === 200 && usage[0].items === 4 && usage[0].ok === true, JSON.stringify(usage));
  const cols = (await conn.unsafe(`select column_name from information_schema.columns where table_schema = $1 and table_name = 'anthropic_usage'`, [schema])).map((x) => x.column_name);
  ok('the usage table has no place for prompt or response text', !cols.some((x) => /prompt|content|text|headline|body/.test(x)), cols.join(','));
  ok('run stats report the outcome', r1.original === 1 && r1.retryScheduled === 2 && r1.final === 1 && r1.calls === 1, JSON.stringify(r1));

  section('2. the next pass does not re-send what is scheduled or final');
  calls.length = 0;
  await runEnrichment({ generate: good, scope: 'fresh' });
  const second = calls.flat();
  ok('only the CRITICAL immediate retry is sent again', second.length === 1 && second[0] === 'Acme Corp raises full-year profit outlook to $3 billion', JSON.stringify(second));
  const c2 = await row(S.highUngrounded);
  const c2Delay = (new Date(c2.enrich_next_at).getTime() - Date.now()) / 1000;
  ok('...and its second failure backs off (~2 min)', c2.enrich_attempts === 2 && c2Delay > 100, JSON.stringify({ ...c2, c2Delay }));
  calls.length = 0;
  await runEnrichment({ generate: good, scope: 'fresh' });
  ok('a third pass straight away sends nothing', calls.length === 0, JSON.stringify(calls));

  section('3. importance 0 enters the rewrite path when it becomes important');
  await conn.unsafe(`update primary_events set importance = 2 where seq = $1`, [S.imp0]);
  calls.length = 0;
  await runEnrichment({ generate: good, scope: 'fresh' });
  ok('the promoted event is sent', calls.flat().includes('Acme Corp names new chief marketing officer'), JSON.stringify(calls));

  section('4. outage: classified, recorded, claims returned, attempts untouched, circuit holds');
  const promo = await ins({ headline: 'Acme Corp wins $120 million Navy contract', importance: 2 });
  let outageCalls = 0;
  const credit = (items) => { outageCalls++; return { results: new Map(), available: false, errorClass: 'insufficient_credits', status: 400,
    error: 'insufficient_credits (HTTP 400): Your credit balance is too low to access the Anthropic API.', model: 'claude-haiku-4-5-20251001', usage: null, ms: 3 }; };
  const o1 = await runEnrichment({ generate: credit, scope: 'fresh' });
  const p = await row(promo);
  ok('the outage is reported as insufficient_credits', o1.unavailable === 'insufficient_credits', JSON.stringify(o1));
  ok('the row is untouched: no attempt consumed, claim returned', p.enrich_attempts === 0 && p.enrich_claimed_at === null && p.headline_status === 'rewrite_pending', JSON.stringify(p));
  const st = (await conn.unsafe(`select last_status, consecutive_failures, note from feed_state where feed_key = '_anthropic'`))[0];
  ok('_anthropic state records the class', st && st.consecutive_failures >= 1 && /^insufficient_credits/.test(st.note) && st.last_status === 400, JSON.stringify(st));
  const failedUsage = await conn.unsafe(`select ok, status, error_class from anthropic_usage where ok = false`);
  ok('the refused call is accounted as a failure with its class', failedUsage.length === 1 && failedUsage[0].error_class === 'insufficient_credits', JSON.stringify(failedUsage));
  const o2 = await runEnrichment({ generate: credit, scope: 'fresh' });
  ok('the next pass does not call the model while the circuit is open', o2.circuitOpen === true && outageCalls === 1, JSON.stringify({ o2, outageCalls }));
  await conn.unsafe(`update feed_state set last_polled_at = now() - interval '2 minutes' where feed_key = '_anthropic'`);
  calls.length = 0;
  const o3 = await runEnrichment({ generate: good, scope: 'fresh' });
  const healed = (await conn.unsafe(`select consecutive_failures, note from feed_state where feed_key = '_anthropic'`))[0];
  ok('after the circuit window one probe goes through and recovery is recorded', calls.length === 1 && healed.consecutive_failures === 0 && healed.note === 'healthy', JSON.stringify({ o3, healed }));

  section('5. a worker whose claim was taken over cannot overwrite');
  const raced = await ins({ headline: 'Acme Corp raises quarterly dividend to $0.50 per share', importance: 2, tickers: ['ACME'] });
  let stolen = false;
  const thief = async (items) => {
    // While this worker waits on the model, its claim goes stale and another worker takes the row.
    await conn.unsafe(`update primary_events set enrich_claim_token = 'another-worker', enrich_claimed_at = now() where seq = $1`, [raced]);
    stolen = true;
    return good(items);
  };
  const r5 = await runEnrichment({ generate: thief, scope: 'fresh' });
  const rr = await row(raced);
  ok('the late result is discarded, not written over the new owner', stolen && rr.headline_status === 'rewrite_pending' && rr.enrich_claim_token === 'another-worker' && (r5.lostClaim || 0) >= 1, JSON.stringify({ rr, r5 }));

  section('6. health: ingestion running + rewrites stalled');
  await conn.unsafe(`update primary_events set enriched_at = now() - interval '1 hour' where enriched_at is not null`);
  await conn.unsafe(`update primary_events set enrich_claimed_at = null, enrich_claim_token = null, enrich_next_at = null, received_at = now() - interval '20 minutes' where seq = $1`, [raced]);
  await ins({ headline: 'Acme Corp fresh arrival keeps ingestion alive today', importance: 0 });
  const hs = await rewriteHealth();
  ok('stalled is detected when ingestion is live, a due row has waited, and nothing was rewritten recently', hs.stalled === true && hs.verdict === 'INGESTION RUNNING + REWRITES STALLED', JSON.stringify(hs));
  const hrow = (await conn.unsafe(`select last_status from feed_state where feed_key = '_rewrite_health'`))[0];
  ok('...and persisted as 503', hrow?.last_status === 503);
  await conn.unsafe(`update primary_events set enriched_at = now(), headline_status = 'original' where seq = $1`, [S.good]);
  const hs2 = await rewriteHealth();
  ok('a recent rewrite clears it', hs2.stalled === false, JSON.stringify(hs2));
  ok('...persisted as 200', (await conn.unsafe(`select last_status from feed_state where feed_key = '_rewrite_health'`))[0]?.last_status === 200);
} catch (e) {
  ok('the end-to-end run completed', false, e.stack || e.message);
} finally {
  try { await conn.unsafe(`set search_path = public`); } catch {}
  await conn.unsafe(`drop schema if exists ${schema} cascade`).catch((e) => ok('scratch schema dropped', false, e.message));
  const left = await conn.unsafe(`select count(*)::int n from pg_namespace where nspname like 'zz_verify_e2e_%'`);
  ok('no scratch schema left behind', Number(left[0].n) === 0);
  conn.release();
  await pg.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
