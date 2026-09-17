// HEADLINE REWRITE COST CONTROLS — tiers, retries, claiming, outage classification, usage accounting.
//
//   node scripts/verify-enrich-policy.mjs                                  pure sections only
//   node --env-file=.env.local scripts/verify-enrich-policy.mjs            + live SQL sections
//
// The live sections run the PRODUCTION claim statement (rendered from enrich-claim.mjs) against
// Postgres, and every one of them is rolled back or confined to a session TEMP table: nothing is
// written to real data. Concurrency is proven with two real connections holding row locks at once.

import fs from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  rewriteTier, retryDecision, attemptBudget, RESAMPLE_REASONS, ATTEMPTS_TRUSTED, ATTEMPTS_HIGH,
  ATTEMPTS_ORDINARY, ORDINARY_RETRY_DELAY_S, CLAIM_STALE_SECONDS, FRESH_MINUTES,
} from '../src/lib/enrich-policy.mjs';
import { classifyAnthropicFailure, usageOf, costOf, BLOCKING_CLASSES } from '../src/lib/anthropic-errors.mjs';
import { generateBatch, CALL_TIMEOUT_MS } from '../src/lib/headline-writer.mjs';
import { claimSql, releaseSql, backlogSql, eligibleWhere } from '../src/lib/enrich-claim.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const section = (s) => console.log(`\n=== ${s} ===`);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

section('1. tiers: who is rewritten in real time');
{
  ok('importance 0 is deferred', rewriteTier({ importance: 0, source: 'YAHOO' }) === 'deferred');
  ok('importance 1 is immediate', rewriteTier({ importance: 1, source: 'YAHOO' }) === 'immediate');
  ok('importance 2 is immediate', rewriteTier({ importance: 2, source: 'YAHOO' }) === 'immediate');
  ok('importance 3 is immediate', rewriteTier({ importance: 3, source: 'BLOOMBERG' }) === 'immediate');
  ok('a trusted source is immediate at importance 0', rewriteTier({ importance: 0, source: 'WALTERBLOOMBERG' }) === 'immediate');
  ok('a cluster containing a trusted source is immediate', rewriteTier({ importance: 0, source: 'YAHOO', clusterTrusted: true }) === 'immediate');
  ok('ZeroHedge stays immediate (Facebook only posts it in Catalyst wording)', rewriteTier({ importance: 0, source: 'ZEROHEDGE' }) === 'immediate');
  ok('a missing importance is treated as 0', rewriteTier({ source: 'YAHOO' }) === 'deferred');
}

section('2. retries: record, delay, and do not resample what would fail the same way');
{
  ok('budgets: trusted / high / ordinary', attemptBudget({ trusted: true }) === ATTEMPTS_TRUSTED && attemptBudget({ importance: 2 }) === ATTEMPTS_HIGH && attemptBudget({ importance: 1 }) === ATTEMPTS_ORDINARY);
  ok('...ordinary gets exactly one retry', ATTEMPTS_ORDINARY === 2);
  ok('...high keeps its three attempts', ATTEMPTS_HIGH === 3);

  const hi1 = retryDecision({ importance: 3, attempts: 1, reason: 'number' });
  ok('CRITICAL first failure retries IMMEDIATELY, whatever the reason', hi1.retry && hi1.delaySeconds === 0, JSON.stringify(hi1));
  const hi2 = retryDecision({ importance: 2, attempts: 2, reason: 'too_long' });
  ok('HIGH second failure backs off instead of firing again at once', hi2.retry && hi2.delaySeconds >= 60, JSON.stringify(hi2));
  const hi3 = retryDecision({ importance: 2, attempts: 3, reason: 'too_long' });
  ok('HIGH third failure is final', !hi3.retry && hi3.final, JSON.stringify(hi3));

  const tr = retryDecision({ importance: 2, trusted: true, attempts: 5, reason: 'name' });
  ok('trusted keeps retrying past the ordinary budget, with a growing delay', tr.retry && tr.delaySeconds >= 600, JSON.stringify(tr));
  const trEnd = retryDecision({ importance: 2, trusted: true, attempts: ATTEMPTS_TRUSTED, reason: 'name' });
  ok('trusted stops at its own budget', !trEnd.retry && trEnd.final);
  const trBackoff = [1, 2, 3, 4, 5, 6].map((a) => retryDecision({ trusted: true, attempts: a, reason: 'x' }).delaySeconds);
  ok('trusted backoff never shrinks', trBackoff.every((d, i) => i === 0 || d >= trBackoff[i - 1]), JSON.stringify(trBackoff));

  for (const reason of ['number', 'name', 'unresolved_ticker', 'anticipated', 'direction', 'event_type', 'cause', 'source']) {
    const d = retryDecision({ importance: 1, attempts: 1, reason });
    ok(`ordinary grounding failure '${reason}' is NOT resampled`, !d.retry && d.final, JSON.stringify(d));
  }
  for (const reason of ['too_long', 'hype', 'multiline', 'empty', 'verbatim_copy', 'no_output', 'unparseable']) {
    const d = retryDecision({ importance: 1, attempts: 1, reason });
    ok(`ordinary shape failure '${reason}' gets one DELAYED resample`, d.retry && d.delaySeconds === ORDINARY_RETRY_DELAY_S && d.delaySeconds >= 300, JSON.stringify(d));
    ok(`...and only one`, !retryDecision({ importance: 1, attempts: 2, reason }).retry);
  }
  ok('the resample set is exactly the shape reasons', [...RESAMPLE_REASONS].sort().join() === ['empty', 'hype', 'multiline', 'no_output', 'too_long', 'unparseable', 'verbatim_copy'].sort().join());
}

section('3. Anthropic failure classification');
{
  const credit = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
  ok('the exact production credit error is insufficient_credits', classifyAnthropicFailure({ status: 400, body: credit }) === 'insufficient_credits');
  ok('...and is blocking', BLOCKING_CLASSES.has('insufficient_credits'));
  ok('401 → authentication', classifyAnthropicFailure({ status: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }) === 'authentication');
  ok('403 → permission', classifyAnthropicFailure({ status: 403, body: { error: { type: 'permission_error' } } }) === 'permission');
  ok('429 → rate_limit', classifyAnthropicFailure({ status: 429, body: { error: { type: 'rate_limit_error' } } }) === 'rate_limit');
  ok('529 → overloaded', classifyAnthropicFailure({ status: 529, body: { error: { type: 'overloaded_error' } } }) === 'overloaded');
  ok('500 → server_error', classifyAnthropicFailure({ status: 500, body: { error: { type: 'api_error' } } }) === 'server_error');
  ok('502 with no body → server_error', classifyAnthropicFailure({ status: 502, body: null }) === 'server_error');
  ok('a TimeoutError → timeout', classifyAnthropicFailure({ error: Object.assign(new Error('t'), { name: 'TimeoutError' }) }) === 'timeout');
  ok('a connection failure → network', classifyAnthropicFailure({ error: Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }) }) === 'network');
  ok('an ordinary 400 → invalid_request (not credits)', classifyAnthropicFailure({ status: 400, body: { error: { type: 'invalid_request_error', message: 'max_tokens: too large' } } }) === 'invalid_request');
  const u = usageOf({ usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 } });
  ok('usage is read from the response', u.input_tokens === 1200 && u.output_tokens === 300 && u.cache_write_tokens === null, JSON.stringify(u));
  ok('Haiku 4.5 cost: 1M in + 1M out = $6', Math.abs(costOf('claude-haiku-4-5-20251001', { input_tokens: 1e6, output_tokens: 1e6 }) - 6) < 1e-9);
}

section('4. generateBatch reports outcome, usage and class — never content');
{
  const items = [{ source: 'X', source_headline: 'Acme raises dividend 10%', headline: 'Acme raises dividend 10%' }];
  const resp = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const credit = await generateBatch(items, { apiKey: 'k', fetchImpl: resp(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) });
  ok('credit exhaustion: unavailable, classified, no usage', credit.available === false && credit.errorClass === 'insufficient_credits' && credit.status === 400 && credit.usage === null, JSON.stringify({ ...credit, results: undefined }));
  const good = await generateBatch(items, { apiKey: 'k', fetchImpl: resp(200, { content: [{ type: 'text', text: '{"i":0,"headline":"Acme lifts dividend 10%","facts":null}]' }], usage: { input_tokens: 500, output_tokens: 40 } }) });
  ok('success: available, parsed, usage carried', good.available === true && good.errorClass === null && good.results.get(0)?.headline === 'Acme lifts dividend 10%' && good.usage.input_tokens === 500, JSON.stringify({ ...good, results: [...good.results] }));
  const junk = await generateBatch(items, { apiKey: 'k', fetchImpl: resp(200, { content: [{ type: 'text', text: 'I cannot help with that' }], usage: { input_tokens: 500, output_tokens: 9 } }) });
  ok('a billed but unparseable reply is NOT an outage (it would be re-sent and re-billed forever)', junk.available === true && junk.errorClass === 'unparseable' && junk.results.size === 0 && junk.usage.output_tokens === 9, JSON.stringify({ ...junk, results: undefined }));
  const hung = await generateBatch(items, { apiKey: 'k', fetchImpl: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } });
  ok('a timeout is unavailable/timeout', hung.available === false && hung.errorClass === 'timeout');
  ok('calls carry a timeout', CALL_TIMEOUT_MS > 0 && CALL_TIMEOUT_MS <= 60000);
  // A call that never answers must be abandoned by the timeout, not hold the ingest sweep.
  const never = (url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
  const hungReal = await Promise.race([
    generateBatch(items, { apiKey: 'k', fetchImpl: never, timeoutMs: 50 }),
    new Promise((r) => setTimeout(() => r({ stillHanging: true }), 3000)),
  ]);
  ok('a call that never answers is aborted by the timeout', hungReal.available === false && hungReal.errorClass === 'timeout', JSON.stringify({ ...hungReal, results: undefined }));
  const nokey = await generateBatch(items, { apiKey: '' });
  ok('no key is authentication, unavailable', nokey.available === false && nokey.errorClass === 'authentication');
}

section('5. wiring');
{
  const pe = read('src/lib/primary-events.js');
  const ps = read('src/app/api/cron/primary-sources/route.js');
  const ne = read('src/app/api/cron/news-enrich/route.js');
  ok('the ingest sweep rewrites FRESH rows inline (breaking news is not batched)', /runEnrichment\(\{ scope: 'fresh' \}\)/.test(ps));
  ok('the enrichment cron owns the batched backlog', /scope: 'backlog', minBatch: MIN_BATCH/.test(ne));
  ok('...and computes the stalled-rewrites health signal each minute', /rewriteHealth\(\)/.test(ne));
  ok('rows are claimed through the atomic claim', /db\.execute\(claimSql\(/.test(pe) && !/async function claimPending/.test(pe));
  ok('the result write is guarded on the claim token', /where seq = \$\{r\.seq\} and enrich_claim_token = \$\{token\}/.test(pe));
  ok('claims are released on every exit path', /finally \{[\s\S]{0,300}await release\(\)/.test(pe));
  ok('usage is recorded for every real model call', /recordUsage\(\{ feature, model: res\.model/.test(pe));
  ok('model state is recorded (transition-logged)', /recordModelState\(\{ feature, reachable:/.test(pe));
  ok('a known outage short-circuits via the circuit', /modelCircuit\(\)/.test(pe));
  ok('the failure reason is persisted', /enrich_last_error = \$\{lastError\}/.test(pe));
  ok('the retry time is persisted (cast via text so "infinity" binds on every driver)', /enrich_next_at = \$\{nextAt\}::text::timestamptz/.test(pe));
  for (const f of ['src/app/api/bulls-bears/route.js', 'src/app/api/refresh-content/route.js']) {
    const s = read(f);
    ok(`${f}: usage recorded on success and failure`, (s.match(/recordUsage\(/g) || []).length >= 2 && /usageOf\(data\)/.test(s));
    ok(`${f}: no prompt or response text is recorded`, !/recordUsage\(\{[^}]*(prompt|text|content|userMessage)/.test(s));
  }
  const mig = read('drizzle/0025_enrich_claims_and_usage.sql');
  ok('migration is additive (no DROP, no NOT NULL on existing table, no default rewrite)', !/\bDROP\b/i.test(mig) && !/ALTER TABLE primary_events[^;]*(NOT NULL|DEFAULT)/i.test(mig));
  ok('migration sets a lock timeout', /lock_timeout/.test(mig));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  (live SQL sections skipped — no DATABASE_URL)');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { default: postgres } = await import('postgres');
const dialect = new PgDialect();
const render = (q) => dialect.sqlToQuery(q);
// SESSION STATE MUST NEVER REACH A POOLED BACKEND. The first version of section 6 created its TEMP copy
// over the -pooler endpoint; a failed run skipped the drop, and the copy survived inside a PgBouncer
// backend shared with other clients, shadowing public.primary_events for anything routed there. So:
// the direct endpoint is used, and the temp table only ever exists INSIDE a transaction that is always
// rolled back — a transaction is pinned to one backend even under pooling, and ROLLBACK (or a dropped
// connection) removes the table whatever else happens.
const directUrl = process.env.DATABASE_URL.replace(/-pooler(?=[.])/, '');
if (/-pooler[.]/.test(directUrl)) { console.error('refusing to run session-state tests through the pooler'); process.exit(1); }
const pg = postgres(directUrl, { max: 3, onnotice: () => {} });

section('6. eligibility and claiming, on a session TEMP copy of primary_events');
try {
  const c = await pg.reserve();
  try {
    // pg_temp precedes public on the search path, so the unqualified name in the production
    // statement resolves to this session-only copy. Nothing here touches real rows.
    await c.unsafe('begin');
    await c.unsafe(`create temp table primary_events (like public.primary_events including defaults) on commit drop`);
    let n = 0;
    const ins = async (o) => {
      const seq = 900000000 + (++n);
      await c.unsafe(`insert into primary_events (seq, source, source_name, source_kind, source_type, source_uid, headline, source_headline,
        original_url, tickers, importance, content_hash, headline_status, pipeline_status, display_ready, cluster_id, enrich_attempts,
        enrich_next_at, enrich_claimed_at, enrich_claim_token, received_at)
        values ($1, $2, $2, 'external', 'news', $3, 'h', 'h', 'u', '{}', $4, $3, $5, 'pending', true, $6, $7, $8::text::timestamptz, $9::text::timestamptz, $10, $11::text::timestamptz)`,
        [seq, o.source || 'YAHOO', `uid${seq}`, o.importance ?? 0, o.status || 'rewrite_pending', o.cluster_id ?? null,
          o.attempts ?? 0, o.next_at ?? null, o.claimed_at ?? null, o.claim_token ?? null, o.received_at || new Date().toISOString()]);
      return seq;
    };
    const S = {};
    S.imp0 = await ins({ importance: 0 });
    S.imp1 = await ins({ importance: 1 });
    S.imp2 = await ins({ importance: 2 });
    S.imp3 = await ins({ importance: 3 });
    S.zh0 = await ins({ importance: 0, source: 'ZEROHEDGE' });
    S.walter0 = await ins({ importance: 0, source: 'WALTERBLOOMBERG' });
    S.headWithTrustedMember = await ins({ importance: 0 });
    S.trustedMember = await ins({ importance: 0, source: 'WALTERBLOOMBERG', cluster_id: S.headWithTrustedMember });
    S.wordedHead = await ins({ importance: 2, status: 'original' });
    S.memberOfWorded = await ins({ importance: 2, cluster_id: S.wordedHead });
    S.trustedMemberOfWorded = await ins({ importance: 2, source: 'WALTERBLOOMBERG', cluster_id: S.wordedHead });
    S.plainHead = await ins({ importance: 1 });
    S.memberOfPlain = await ins({ importance: 1, cluster_id: S.plainHead });
    S.notDue = await ins({ importance: 2, next_at: new Date(Date.now() + 60 * 60000).toISOString() });
    S.final = await ins({ importance: 1, next_at: 'infinity' });
    // Clearly past/future relative to BOTH clocks: inside a transaction now() is frozen at BEGIN.
    S.dueNow = await ins({ importance: 1, next_at: new Date(Date.now() - 30 * 60000).toISOString() });
    S.liveClaim = await ins({ importance: 2, claimed_at: new Date().toISOString(), claim_token: 'other-worker' });
    S.staleClaim = await ins({ importance: 2, claimed_at: new Date(Date.now() - (CLAIM_STALE_SECONDS + 1800) * 1000).toISOString(), claim_token: 'dead-worker' });
    S.ordinarySpent = await ins({ importance: 1, attempts: ATTEMPTS_ORDINARY });
    S.highSpent = await ins({ importance: 2, attempts: ATTEMPTS_HIGH });
    S.highLeft = await ins({ importance: 2, attempts: ATTEMPTS_HIGH - 1 });
    S.trustedLeft = await ins({ importance: 2, source: 'WALTERBLOOMBERG', attempts: ATTEMPTS_TRUSTED - 1 });
    S.sec = await ins({ importance: 2, source: 'SEC' });
    await c.unsafe(`update primary_events set source_kind = 'sec' where seq = $1`, [S.sec]);
    S.old1 = await ins({ importance: 1, received_at: new Date(Date.now() - (FRESH_MINUTES + 30) * 60000).toISOString() });
    S.composed = await ins({ importance: 3, status: 'composed' });

    const claim = async (token, scope, limit = 60) => {
      const q = render(claimSql({ limit, token, scope }));
      return new Set((await c.unsafe(q.sql, q.params)).map((r) => Number(r.seq)));
    };
    const all = await claim('tok-all', 'all');
    const expectIn = ['imp1', 'imp2', 'imp3', 'zh0', 'walter0', 'headWithTrustedMember', 'trustedMember', 'plainHead', 'dueNow', 'staleClaim', 'highLeft', 'trustedLeft', 'old1'];
    const expectOut = ['imp0', 'wordedHead', 'memberOfWorded', 'trustedMemberOfWorded', 'memberOfPlain', 'notDue', 'final', 'liveClaim', 'ordinarySpent', 'highSpent', 'sec', 'composed'];
    for (const k of expectIn) ok(`claimed: ${k}`, all.has(S[k]));
    for (const k of expectOut) ok(`NOT claimed: ${k}`, !all.has(S[k]));

    const stolen = (await c.unsafe(`select enrich_claim_token t from primary_events where seq = $1`, [S.staleClaim]))[0]?.t;
    ok('a stale claim is taken over by the new worker', stolen === 'tok-all', stolen);
    const kept = (await c.unsafe(`select enrich_claim_token t from primary_events where seq = $1`, [S.liveClaim]))[0]?.t;
    ok('a live claim is left with its owner', kept === 'other-worker', kept);

    const again = await claim('tok-second', 'all');
    ok('a second worker cannot claim what the first holds', [...again].every((s) => !all.has(s)), JSON.stringify([...again]));

    const relQ = render(releaseSql('tok-all'));
    const released = await c.unsafe(relQ.sql, relQ.params);
    ok('release gives back every row the worker held', released.length === all.size, `${released.length} vs ${all.size}`);
    const fresh = await claim('tok-fresh', 'fresh');
    ok('scope fresh takes new rows', fresh.has(S.imp2) && fresh.has(S.imp1));
    ok('scope fresh leaves older backlog to the cron', !fresh.has(S.old1));
    await c.unsafe(render(releaseSql('tok-fresh')).sql, render(releaseSql('tok-fresh')).params);

    // The claim returns rows in the order the pipeline needs: trusted flag present for the policy.
    const rq = render(claimSql({ limit: 60, token: 'tok-order', scope: 'all' }));
    const rows = await c.unsafe(rq.sql, rq.params);
    const byseq = new Map(rows.map((r) => [Number(r.seq), r]));
    ok('cluster_trusted is returned for a trusted member', byseq.get(S.trustedMember)?.cluster_trusted === true);
    ok('cluster_trusted is returned for a head whose cluster holds a trusted source', byseq.get(S.headWithTrustedMember)?.cluster_trusted === true);
    ok('...and false for an ordinary row', byseq.get(S.imp2)?.cluster_trusted === false);
    await c.unsafe(render(releaseSql('tok-order')).sql, render(releaseSql('tok-order')).params);

    // Limit ordering: with room for two, a trusted row and the most important row go first.
    const top2 = [...(await claim('tok-top', 'all', 2))];
    ok('priority: trusted first, then importance', top2.length === 2 && top2.every((s) => [S.walter0, S.trustedMember, S.trustedLeft].includes(s)), JSON.stringify(top2));
    await c.unsafe(render(releaseSql('tok-top')).sql, render(releaseSql('tok-top')).params);

    // Backlog pre-check: counts due rows and flags urgency.
    // Urgency from importance alone: with an enormous wait threshold nothing is overdue, so only a
    // due HIGH or trusted row can make the pass skip the batching wait.
    const bqHigh = render(backlogSql({ maxWaitSeconds: 9999999 }));
    ok('a due HIGH or trusted row alone makes the backlog urgent', (await c.unsafe(bqHigh.sql, bqHigh.params))[0].urgent === true);
    await c.unsafe('savepoint only_ordinary');
    await c.unsafe(`update primary_events set importance = least(importance, 1), source = 'YAHOO' where source <> 'SEC'`);
    ok('...and ordinary rows that are not overdue do not', (await c.unsafe(bqHigh.sql, bqHigh.params))[0].urgent === false);
    await c.unsafe('rollback to savepoint only_ordinary');
    const bq = render(backlogSql({ maxWaitSeconds: 180 }));
    const b = (await c.unsafe(bq.sql, bq.params))[0];
    ok('backlog count matches the claimable set', Number(b.n) === all.size, `${b.n} vs ${all.size}`);
    ok('a due HIGH row makes the backlog urgent', b.urgent === true);

    // Importance-0 transition: a merge raising importance makes the canonical row claimable.
    await c.unsafe(`update primary_events set importance = 2 where seq = $1`, [S.imp0]);
    ok('importance 0 → 2 (e.g. corroborated by a merge) enters the rewrite path', (await claim('tok-promote', 'all')).has(S.imp0));
    await c.unsafe(render(releaseSql('tok-promote')).sql, render(releaseSql('tok-promote')).params);
    await c.unsafe(`update primary_events set importance = 0 where seq = $1`, [S.headWithTrustedMember]);
    ok('a trusted source joining an importance-0 cluster enters the rewrite path', (await claim('tok-trusted', 'all')).has(S.headWithTrustedMember));

    const hq = render(sqlCount(eligibleWhere));
    ok('eligibleWhere renders and runs on its own', Number((await c.unsafe(hq.sql, hq.params))[0].n) >= 1);
  } finally {
    await c.unsafe('rollback').catch(() => {});
    const leftover = await c.unsafe(`select count(*)::int n from pg_class where relname = 'primary_events' and relpersistence = 't' and relnamespace = pg_my_temp_schema()`).catch(() => [{ n: -1 }]);
    ok('no temp copy survives the section', Number(leftover[0].n) === 0, JSON.stringify(leftover));
    c.release();
  }
} catch (e) {
  ok('section 6 ran', false, e.message);
}

function sqlCount(where) {
  // A standalone use of the shared predicate, exactly as the health check uses it.
  return sql`select count(*)::int n from primary_events p where ${where('p')}`;
}

section('7. concurrency: two real connections, row locks held at once, on committed rows');
// Locks only exist between sessions, so this cannot use a temp table. It uses an isolated scratch
// SCHEMA on the direct endpoint: committed synthetic rows in scratch.primary_events, and each
// transaction sets its own search_path so the unqualified name in the production statement resolves
// there. Nothing on the real queue is touched, and the schema is dropped in finally.
{
  const schema = `zz_verify_enrich_${process.pid}_${Date.now()}`;
  const admin = await pg.reserve();
  let a = null, b = null;
  try {
    await admin.unsafe(`create schema ${schema}`);
    await admin.unsafe(`create table ${schema}.primary_events (like public.primary_events including defaults)`);
    for (let i = 0; i < 8; i++) {
      await admin.unsafe(`insert into ${schema}.primary_events (seq, source, source_name, source_kind, source_type, source_uid, headline, source_headline, original_url, tickers, importance, content_hash, headline_status, pipeline_status, display_ready)
        values ($1, 'YAHOO', 'YAHOO', 'external', 'news', $2, 'h', 'h', 'u', '{}', 2, $2, 'rewrite_pending', 'pending', true)`, [800000000 + i, `c${i}`]);
    }
    a = await pg.reserve(); b = await pg.reserve();
    await a.unsafe('begin'); await a.unsafe(`set local search_path = ${schema}, public`);
    await b.unsafe('begin'); await b.unsafe(`set local search_path = ${schema}, public`);
    // Without SKIP LOCKED, B would wait on A's locks; the timeout turns that wait into a failure.
    await b.unsafe(`set local lock_timeout = '3s'`);
    const qa = render(claimSql({ limit: 3, token: 'verify-a', scope: 'all' }));
    const qb = render(claimSql({ limit: 8, token: 'verify-b', scope: 'all' }));
    const ra = (await a.unsafe(qa.sql, qa.params)).map((r) => Number(r.seq));
    let rb = [], bError = null;
    try { rb = (await b.unsafe(qb.sql, qb.params)).map((r) => Number(r.seq)); } catch (e) { bError = e.message; }
    console.log(`  worker A claimed ${ra.length} and holds them; worker B claimed ${rb.length}${bError ? ' (error: ' + bError + ')' : ''}`);
    ok('worker A claims its limit', ra.length === 3, String(ra.length));
    ok("worker B is not blocked by A's locks", bError === null, bError || '');
    ok('worker B takes the OTHER rows', rb.length === 5, String(rb.length));
    ok('no row is claimed by both workers', ra.every((x) => !rb.includes(x)), JSON.stringify({ ra, rb }));
  } catch (e) {
    ok('section 7 ran', false, e.message);
  } finally {
    if (a) { await a.unsafe('rollback').catch(() => {}); a.release(); }
    if (b) { await b.unsafe('rollback').catch(() => {}); b.release(); }
    await admin.unsafe(`drop schema if exists ${schema} cascade`).catch((e) => ok('scratch schema dropped', false, e.message));
    const left = await admin.unsafe(`select count(*)::int n from pg_namespace where nspname like 'zz_verify_enrich_%'`);
    ok('no scratch schema is left behind', Number(left[0].n) === 0, JSON.stringify(left));
    admin.release();
  }
}

await pg.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
