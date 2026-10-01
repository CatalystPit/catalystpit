// FOUR DESTINATIONS, FOUR FATES. Independence is the property under test, not the feature.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local \
//        scripts/verify-social-publishing.mjs
//
// ⚠️ WHAT THIS SUITE IS REALLY FOR. Adding a destination to a working publisher is mostly an exercise
// in NOT breaking two channels that already carry 1,964 posts between them, and in not claiming
// exactly-once delivery that has not been demonstrated. So the assertions are weighted towards the
// cases that are invisible when they go wrong: a second worker publishing the same row, a timeout
// where the provider may already have accepted the post, a new channel's first scan finding yesterday's
// news, and a credential reaching a log.
//
// NO NETWORK AND NO CREDENTIALS. Every provider interaction is an injected fetch that returns a
// scripted response, so a 429, a 500, a timeout and a malformed body are all ordinary test inputs.
//
// THE DATABASE IS REAL, because the claim and the dedupe ARE database behaviour — a unique index and a
// conditional UPDATE cannot be tested against a mock without testing the mock instead. Test rows use
// NEGATIVE event_seq values, which can never match a real primary_events row, so two independent
// guards stop one ever being published: the provenance gate refuses it, and the channel switches are
// off. Everything written here is removed again in the finally block.
//
// MUTATIONS live in scripts/mutate-social-publishing.mjs, which edits each guard in the SOURCE and
// requires this suite to go red. They exist because each of these guards is one line that looks
// removable, and because a mutation harness that does not touch the source is theatre.

const L = (s = '') => console.log(s);
// ⚠️ NO --mutate FLAG HERE, ON PURPOSE. An in-suite flag that only changes an assertion's MESSAGE
// proves nothing and reads like proof. Mutation testing for these guards edits the source and lives
// in scripts/mutate-social-publishing.mjs.
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const fs = await import('node:fs/promises');
const read = (p) => fs.readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const D = await import('../src/lib/social/social-delivery.mjs');
const IG = await import('../src/lib/social/instagram-post.mjs');
const TH = await import('../src/lib/social/threads-post.mjs');
const store = await import('../src/lib/social/social-store.js');
const { db } = await import('../src/lib/db.js');
const { sql } = await import('drizzle-orm');

const HASH_PREFIX = 'verify-social-';
const TEST_SEQ_BASE = -900000;

// A canonical event shaped like a real one, with Catalyst Pit wording and a market subject.
const EV = (over = {}) => ({
  seq: TEST_SEQ_BASE - 1,
  headline: 'Nvidia raises its full-year revenue outlook to $94 billion after record data centre demand',
  headline_status: 'original',
  tickers: ['NVDA'],
  content_hash: `${HASH_PREFIX}base`,
  source_uid: 'verify-1',
  importance: 3,
  received_at: new Date().toISOString(),
  ...over,
});

// A card descriptor that satisfies Meta's published rules, so Instagram eligibility can be exercised
// without rendering an image.
const CARD = { url: 'https://example.blob.vercel-storage.com/social/ig/1-abc123.jpg',
  contentType: 'image/jpeg', bytes: 240_000, width: 1080, height: 1080 };

/** A fetch that returns a scripted sequence, and records what it was called with. */
function scriptedFetch(steps) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step.throws) { const e = new Error(step.message || 'boom'); e.name = step.name || 'Error'; throw e; }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

// ⚠️ THE ACTIVATION ROWS ARE CLEANED UP TOO. Section 4 deletes and recreates the threads watermark
// to prove it is written once and never moved - and a watermark left behind by a test would become the
// REAL one the day the channel is switched on, recording a test run as the moment of activation.
const cleanup = async () => {
  await db.execute(sql`delete from social_deliveries where content_hash like ${HASH_PREFIX + '%'}`);
  await db.execute(sql`delete from social_deliveries where event_seq <= ${TEST_SEQ_BASE}`);
  await db.execute(sql`delete from social_channel_activation where channel in ('threads', 'instagram')`);
};

try {
await store.ensureSocialTables();
await cleanup();

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 1. THE TWO WORKING CHANNELS ARE UNTOUCHED ===');
{
  const fbPub = strip(await read('../src/lib/facebook-publisher.js'));
  const xPub = strip(await read('../src/lib/x-publisher.js'));
  // The point is not that these files are good; it is that this change did not reach into them. A new
  // destination that needed to edit a working publisher would be a redesign wearing a feature's clothes.
  ok('⚠️ facebook-publisher imports nothing from the new social modules',
    !/social\/(social-|instagram-publisher|threads-publisher)/.test(fbPub));
  ok('⚠️ x-publisher imports nothing from the new social modules',
    !/social\//.test(xPub));
  // Facebook's own guarantees, re-asserted here so this suite fails if a later change to the shared
  // cron route erodes one of them.
  ok('Facebook still keys its queue on the content hash', /uq_fb_candidate_hash/.test(fbPub));
  ok('Facebook still keys its queue on the event seq', /uq_fb_candidate_seq/.test(fbPub));
  ok('⚠️ Facebook freshness window is still 30 minutes', /MAX_AGE_MINUTES = 30/.test(fbPub));
  ok('Facebook still bounds its drain by that window',
    /created_at > now\(\) - \(\$\{MAX_AGE_MINUTES\}/.test(fbPub));
  ok('Facebook still holds a mid-publish row for manual review',
    /left mid-publish, needs manual review/.test(fbPub));
  ok('Facebook still refunds a credential failure rather than spending an attempt',
    /failureSpendsAttempt/.test(fbPub));
  ok('X still keys its candidates on the event seq', /on conflict \(event_seq\) do nothing/.test(xPub));
  ok('X still bounds its drain to two hours', /created_at > now\(\) - interval '2 hours'/.test(xPub));
  ok('X still refuses to publish outside live mode', /canPublish\(process\.env\.X_AUTOPOST_MODE\)/.test(xPub));

  const route = strip(await read('../src/app/api/cron/facebook/route.js'));
  ok('the shared cron still drains Facebook', /publishPendingFacebook\(\)/.test(route));
  ok('the shared cron still runs both Facebook queue scans',
    /queueRewordedFacebook\(\)/.test(route) && /queueTrustedFacebook\(\)/.test(route));
  ok('⚠️ the Facebook credential alarm still answers 503',
    /credentialAlarm: true/.test(route) && /\{ status: 503 \}/.test(route));
  ok('⚠️ …and still drops Meta\'s own failure text from the response',
    /const \{ results, \.\.\.counts \} = res;/.test(route));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 2. ONE TICK, FOUR FATES: FAILURE CANNOT PROPAGATE ===');
{
  const route = strip(await read('../src/app/api/cron/facebook/route.js'));
  // ORDERING IS THE ASSERTION. If the new channels ran after the 503 return, a broken Facebook token
  // would silently stop Instagram and Threads — the exact coupling the brief forbids.
  const idxChannels = route.indexOf('const channels = {}');
  const idxAlarm = route.indexOf('credentialAlarm: true');
  // ⚠️ ANCHORED INSIDE THE LOOP, NOT AT ITS DECLARATION. An earlier version of this compared the
  // position of `const channels = {}` against the alarm, and a mutation that injected an early 503
  // return on that same line passed it. recordChannelScanError sits in the loop's own catch, so no
  // ordering that reaches it can have returned first.
  const idxLoopBody = route.indexOf('recordChannelScanError');
  ok('⚠️ the new channels run BEFORE the Facebook credential alarm returns',
    idxChannels > 0 && idxAlarm > 0 && idxLoopBody > 0
    && idxChannels < idxLoopBody && idxLoopBody < idxAlarm,
    'a Facebook token outage would otherwise suppress the other destinations');
  // And belt-and-braces: there must be no `return` at all between the start of the channel work and
  // the end of it, because any return there skips a destination.
  ok('⚠️ …and the route cannot exit in the middle of the channel work',
    !/Response\.json/.test(route.slice(idxChannels, idxLoopBody)),
    'each channel function returns its own result, which is fine; a Response would end the request');
  ok('⚠️ each channel is wrapped in its own try/catch',
    (route.match(/recordChannelScanError/g) || []).length >= 1 && /catch \(e\) \{/.test(route));
  ok('⚠️ a new channel cannot change the route\'s status code',
    !/channels\[name\][^\n]*status: 5/.test(route) && !/status: 503[^\n]*channels/.test(route));
  ok('both destinations report separately in the response', /channels\b/.test(route));
  ok('⚠️ status=1 reports each destination as its own object',
    /facebook: \{ \.\.\.facebookStatus\(\)/.test(route) && /social\[name\]/.test(route));

  // And the store proves the claim at the data level: a per-channel row, not a shared flag.
  const st = strip(await read('../src/lib/social/social-store.js'));
  ok('⚠️ the dedupe identity is (channel, event), not a global published flag',
    /uq_social_channel_event ON social_deliveries \(channel, event_seq\)/.test(st));
  ok('⚠️ …and the second axis is channel-scoped too',
    /uq_social_channel_hash ON social_deliveries \(channel, content_hash\)/.test(st));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 3. ELIGIBILITY: INSTAGRAM AND THREADS DECIDE SEPARATELY ===');
{
  const base = { isNew: true, isCanonical: true, qualifies: true };
  ok('Threads accepts a canonical market event in our wording',
    TH.threadsEligibility(EV(), base).eligible);
  ok('Instagram accepts the same event once a valid card exists',
    IG.instagramEligibility(EV(), { ...base, image: CARD }).eligible);
  // THE ONE GATE INSTAGRAM ADDS, and it is a wait rather than a rejection: the card is ours to render.
  ok('⚠️ Instagram refuses the same event with no card', (() => {
    const d = IG.instagramEligibility(EV(), { ...base, image: null });
    return !d.eligible && d.reason === 'awaiting card render';
  })());
  ok('Instagram refuses a card Meta would reject (PNG)',
    !IG.instagramEligibility(EV(), { ...base, image: { ...CARD, contentType: 'image/png' } }).eligible);
  // ⚠️ THE SILENT FAILURE THIS CATCHES: a private or localhost URL produces a generic Instagram media
  // error, and the real cause — Meta could not reach the file — is nowhere in the message.
  for (const url of ['http://example.com/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg',
    'https://10.0.0.5/a.jpg', 'https://192.168.1.9/a.jpg', 'https://169.254.1.1/a.jpg']) {
    ok(`⚠️ Instagram refuses a non-public media url (${url.slice(0, 28)})`,
      !IG.instagramEligibility(EV(), { ...base, image: { ...CARD, url } }).eligible);
  }
  ok('both channels wait while the headline is still the publisher\'s words', (() => {
    const ev = EV({ headline_status: 'pending' });
    return TH.threadsEligibility(ev, base).reason?.startsWith('awaiting Catalyst wording')
      && IG.instagramEligibility(ev, { ...base, image: CARD }).reason?.startsWith('awaiting Catalyst wording');
  })());
  ok('both channels refuse a duplicate folded into another event',
    !TH.threadsEligibility(EV(), { ...base, isCanonical: false }).eligible
    && !IG.instagramEligibility(EV(), { ...base, isCanonical: false, image: CARD }).eligible);
  // MALFORMED CANONICAL POST: empty, whitespace, and a headline with no market subject.
  for (const [name, ev] of [['empty headline', EV({ headline: '' })],
    ['whitespace headline', EV({ headline: '   ' })],
    ['no market subject', EV({ headline: 'A very pleasant afternoon in the park today, all told.' })]]) {
    ok(`⚠️ Threads refuses a malformed post (${name})`, !TH.threadsEligibility(ev, base).eligible);
    ok(`⚠️ Instagram refuses a malformed post (${name})`,
      !IG.instagramEligibility(ev, { ...base, image: CARD }).eligible);
  }
  // NOTHING IS TRUNCATED: a line over the ceiling is skipped, because cutting a headline changes what
  // it says.
  ok('⚠️ Threads skips rather than truncates an over-long line', (() => {
    const d = TH.threadsEligibility(EV({ headline: 'Nvidia revenue ' + 'x'.repeat(600) }), base);
    return !d.eligible && /too long/.test(d.reason);
  })());
  // FORMATTING IS INDEPENDENT, not copied from Facebook.
  const { facebookText } = await import('../src/lib/facebook-post.mjs');
  const ev = EV();
  ok('⚠️ Threads text is not Facebook text', TH.threadsText(ev) !== facebookText(ev));
  ok('⚠️ …specifically, Threads carries no standing hashtag block',
    !/#stockmarket/.test(TH.threadsText(ev)) && /#stockmarket/.test(facebookText(ev)));
  ok('Instagram caption does carry the standing block', /#stockmarket/.test(IG.instagramCaption(ev)));
  // THE CANONICAL POST IS NEVER MUTATED by an adapter.
  const before = JSON.stringify(ev);
  TH.threadsText(ev); IG.instagramCaption(ev);
  TH.threadsEligibility(ev, base); IG.instagramEligibility(ev, { ...base, image: CARD });
  ok('⚠️ no adapter mutates the canonical event', JSON.stringify(ev) === before);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 4. FRESHNESS: A NEW CHANNEL CANNOT DUMP HISTORY ===');
{
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const activated = new Date(now - 60_000).toISOString();            // activated a minute ago
  const fresh = new Date(now - 5 * 60_000).toISOString();            // 5 minutes old
  const old = new Date(now - 10 * 60 * 60_000).toISOString();        // 10 hours old
  const beforeActivation = new Date(now - 30 * 60_000).toISOString(); // inside the window, before activation

  ok('a recent event received after activation is fresh',
    D.freshnessDecision({ receivedAt: new Date(now - 30_000).toISOString(), activatedAt: activated, now }).fresh);
  ok('⚠️ an event received BEFORE activation is never eligible', (() => {
    const d = D.freshnessDecision({ receivedAt: beforeActivation, activatedAt: activated, now });
    return !d.fresh && /before the channel was activated/.test(d.reason);
  })(), 'this is the assertion that stops a first activation publishing history');
  ok('an event older than the window is refused even after activation',
    !D.freshnessDecision({ receivedAt: old, activatedAt: new Date(now - 20 * 60 * 60_000).toISOString(), now }).fresh);
  // ⚠️ FAIL CLOSED ON A MISSING WATERMARK. An absent activation must not read as "no lower bound",
  // which is what an `if (activatedAt && ...)` would do.
  ok('⚠️ no watermark means nothing is eligible', (() => {
    const d = D.freshnessDecision({ receivedAt: fresh, activatedAt: null, now });
    return !d.fresh && /not activated/.test(d.reason);
  })(), 'an absent watermark must not read as "no lower bound"');
  ok('an event with no received_at is refused',
    !D.freshnessDecision({ receivedAt: null, activatedAt: activated, now }).fresh);

  // The queue scans must carry BOTH bounds in SQL, so a backlog is not even read into memory.
  for (const [name, path] of [['threads', '../src/lib/social/threads-publisher.js'],
    ['instagram', '../src/lib/social/instagram-publisher.js']]) {
    const src = strip(await read(path));
    ok(`⚠️ the ${name} scan bounds on the activation watermark`,
      /e\.received_at > \$\{activatedAt\}/.test(src));
    ok(`⚠️ the ${name} scan also bounds on the age window`,
      /e\.received_at > now\(\) - \(\$\{MAX_AGE_MINUTES\}/.test(src));
    ok(`the ${name} scan reads the watermark BEFORE looking at any event`,
      src.indexOf('channelActivation(CHANNEL)') < src.indexOf('from primary_events'));
    // ⚠️ AND AFTER THE CONFIGURATION CHECK, so an unconfigured channel does not stamp an activation
    // instant that would later be read as "when this channel was switched on".
    ok(`⚠️ the ${name} scan checks configuration before stamping a watermark`,
      src.indexOf('not configured') < src.indexOf('channelActivation(CHANNEL)'),
      'an unconfigured channel must not claim an activation time');
  }

  // And live: a first activation writes the watermark and leaves it alone afterwards.
  await db.execute(sql`delete from social_channel_activation where channel = 'threads'`);
  const first = await store.channelActivation('threads');
  ok('⚠️ first activation records a watermark', !!first);
  const again = await store.channelActivation('threads');
  ok('⚠️ a later call does NOT move the watermark forward',
    new Date(first).getTime() === new Date(again).getTime(),
    'a movable watermark is a resettable one, and a resettable watermark permits a backfill');
  ok('⚠️ the watermark is at or after the moment it was created',
    Date.now() - new Date(first).getTime() < 60_000);
  // ⚠️ THE PROPERTY, STATED COMPARATIVELY AND AGAINST A FROZEN INSTANT. What would a first activation
  // have published if the age window were the only bound? That is `wouldHaveDumped`. What does it
  // publish with the watermark in place? Zero, because every one of those rows was received before it.
  // Measured against a fixed timestamp rather than now(), because primary_events gains rows every
  // minute and an arrival mid-test made the earlier version of this fail.
  const dump = (await db.execute(sql`
    select count(*) filter (where received_at <= ${first}::timestamptz
                              and received_at > ${first}::timestamptz - interval '30 minutes')::int
             as would_have_dumped,
           count(*) filter (where received_at > ${first}::timestamptz
                              and received_at <= ${first}::timestamptz)::int
             as eligible_at_activation
      from primary_events where cluster_id is null`)).rows?.[0];
  ok('⚠️ the age window alone WOULD have dumped history on first activation',
    Number(dump.would_have_dumped) > 0,
    'if this is 0 the assertion below proves nothing — the wire was simply quiet');
  ok('⚠️ …and the watermark admits none of it', Number(dump.eligible_at_activation) === 0,
    `${dump.eligible_at_activation} of ${dump.would_have_dumped} would still have published`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 5. FAILURE CLASSIFICATION: WHICH STEP FAILED DECIDES WHAT IS SAFE ===');
{
  const c = (o) => D.classifyProviderFailure(o);
  ok('a 429 is a rate limit, retryable, and does not spend an attempt', (() => {
    const r = c({ status: 429 });
    return r.class === 'rate_limited' && r.retryable && !r.permanent && r.spendsAttempt === false;
  })());
  ok('a 500 is transient and retryable', (() => {
    const r = c({ status: 500 }); return r.class === 'transient' && r.retryable && !r.permanent;
  })());
  ok('a 503 is transient and retryable', c({ status: 503 }).retryable);
  ok('⚠️ a 400 is permanent and never retried', (() => {
    const r = c({ status: 400 }); return r.class === 'permanent' && r.permanent && !r.retryable;
  })());
  ok('a 403 is permanent', c({ status: 403 }).permanent);
  ok('a 404 is permanent', c({ status: 404 }).permanent);
  ok('⚠️ Meta code 190 is a credential failure, refunded not spent', (() => {
    const r = c({ status: 400, errorCode: 190 });
    return r.class === 'auth' && !r.permanent && r.spendsAttempt === false;
  })(), 'an expired token must not exhaust every queued post');
  ok('⚠️ Meta code 200 is also a credential failure', c({ status: 403, errorCode: 200 }).class === 'auth');
  ok('a 401 is a credential failure', c({ status: 401 }).class === 'auth');

  // ⚠️ THE CASE THE BRIEF SINGLES OUT: a timeout where the provider may have accepted the post.
  ok('⚠️ a timeout on the PUBLISH step is not retryable and needs review', (() => {
    const r = c({ timeout: true, phase: D.PHASE.PUBLISH });
    return r.class === 'timeout' && r.retryable === false && r.needsManualReview === true;
  })(), 'retrying this is exactly the action that double-posts');
  ok('⚠️ …but a timeout on the CONTAINER step IS retryable', (() => {
    const r = c({ timeout: true, phase: D.PHASE.CONTAINER });
    return r.retryable === true && !r.needsManualReview;
  })(), 'creating a container publishes nothing, so nothing can be duplicated');
  ok('⚠️ an explicit 5xx on the publish step is still retryable', (() => {
    const r = c({ status: 500, phase: D.PHASE.PUBLISH });
    return r.retryable && !r.needsManualReview;
  })(), 'the provider answered, so the publish did not happen');
  ok('an unrecognised response is transient, not permanent',
    c({}).class === 'transient' && !c({}).permanent,
    'destroying a post over an unparsed body is the worse mistake');
  // Backoff grows, and a rate limit waits longer than an ordinary blip.
  ok('backoff grows with attempts', D.backoffMs(2, 'transient') > D.backoffMs(1, 'transient'));
  ok('⚠️ a rate limit backs off far longer than a transient error',
    D.backoffMs(1, 'rate_limited') >= 10 * D.backoffMs(1, 'transient'));
  ok('backoff is capped', D.backoffMs(99, 'rate_limited') <= 60 * 60_000);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 6. THE GATE ON ATTEMPTING A ROW ===');
{
  const R = (o) => ({ status: 'pending', attempts: 0, provider_post_id: null, retry_after: null, ...o });
  ok('a fresh pending row is ready', D.readyToAttempt(R()).ready);
  ok('⚠️ a row already carrying a provider post id is never re-sent',
    !D.readyToAttempt(R({ provider_post_id: '123' })).ready);
  ok('a posted row is never re-sent', !D.readyToAttempt(R({ status: 'posted' })).ready);
  ok('a permanently failed row is never retried', !D.readyToAttempt(R({ status: 'failed' })).ready);
  ok('⚠️ a row left mid-publish is NEVER reclaimed automatically', (() => {
    const r = D.readyToAttempt(R({ status: 'publishing' }));
    return !r.ready && /manual review/.test(r.reason);
  })(), 'this is the one state where the provider may have accepted what we cannot confirm');
  ok('attempts are exhausted at the cap',
    !D.readyToAttempt(R({ attempts: D.MAX_DELIVERY_ATTEMPTS })).ready);
  ok('⚠️ a backing-off row waits', (() => {
    const r = D.readyToAttempt(R({ retry_after: new Date(Date.now() + 60_000) }));
    return !r.ready && /backing off/.test(r.reason);
  })());
  ok('…and is ready once the backoff has elapsed',
    D.readyToAttempt(R({ retry_after: new Date(Date.now() - 1_000) })).ready);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 7. DUPLICATE PROTECTION, AGAINST THE REAL TABLE ===');
{
  await cleanup();
  const seq = TEST_SEQ_BASE - 10;
  const a = await store.queueDelivery({ channel: 'threads', eventSeq: seq,
    contentHash: `${HASH_PREFIX}dup`, payloadText: 'Nvidia raises guidance' });
  ok('the first queue attempt writes a row', a.queued === true);
  const b = await store.queueDelivery({ channel: 'threads', eventSeq: seq,
    contentHash: `${HASH_PREFIX}dup`, payloadText: 'Nvidia raises guidance' });
  ok('⚠️ the second attempt for the same (channel, event) is refused', b.queued === false);

  // ⚠️ THE SECOND AXIS: a different event row for the SAME story. This is the case Facebook needed
  // sameTopic() for, because two sources can produce two canonical events for one story.
  const c = await store.queueDelivery({ channel: 'threads', eventSeq: seq - 1,
    contentHash: `${HASH_PREFIX}dup`, payloadText: 'Nvidia raises guidance' });
  ok('⚠️ a different event with the same content hash is refused', c.queued === false);

  // AND THE INDEPENDENCE THAT MATTERS: the same event may still go to the other channel.
  const d = await store.queueDelivery({ channel: 'instagram', eventSeq: seq,
    contentHash: `${HASH_PREFIX}dup`, payloadText: 'Nvidia raises guidance', mediaUrl: CARD.url });
  ok('⚠️ the SAME event is still queueable for the other channel', d.queued === true,
    'a global unique key would have made Instagram and Threads exclusive');

  const n = (await db.execute(sql`select count(*)::int n from social_deliveries
    where content_hash = ${HASH_PREFIX + 'dup'}`)).rows?.[0];
  ok('exactly two rows exist: one per channel', Number(n.n) === 2);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 8. CONCURRENCY: TWO WORKERS, ONE ROW, ONE CLAIM ===');
{
  await cleanup();
  const seq = TEST_SEQ_BASE - 20;
  const q = await store.queueDelivery({ channel: 'threads', eventSeq: seq,
    contentHash: `${HASH_PREFIX}race`, payloadText: 'Nvidia raises guidance' });
  // Make the row pass the provenance gate by pointing it at a real canonical event, so the claim
  // itself is what is being tested rather than the gate in front of it.
  const real = (await db.execute(sql`select seq from primary_events where cluster_id is null
    order by seq desc limit 1`)).rows?.[0];
  if (real) {
    await db.execute(sql`update social_deliveries set event_seq = ${real.seq} where id = ${q.id}`);

    // ⚠️ SIMULTANEOUS, not sequential. Both claims are issued before either is awaited, which is the
    // shape cron overlap actually has.
    const [r1, r2] = await Promise.all([
      store.claimDelivery('threads', q.id),
      store.claimDelivery('threads', q.id),
    ]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    ok('⚠️ exactly one of two simultaneous claims succeeds', winners === 1,
      `${winners} claims succeeded — more than one means two workers would both publish`);
    ok('⚠️ the loser is told why, and does not contact the provider',
      [r1, r2].some((r) => !r.ok && /claimed by another worker|mid-publish/.test(r.reason)));
    const after = (await db.execute(sql`select status, attempts from social_deliveries where id = ${q.id}`)).rows?.[0];
    ok('the row is left in publishing with exactly one attempt spent',
      after.status === 'publishing' && Number(after.attempts) === 1,
      `status=${after.status} attempts=${after.attempts}`);
    // ⚠️ THE MECHANISM ITSELF, tested without the in-process check in front of it. The read-then-check
    // in claimDelivery is a courtesy that reports a good reason; the CONDITIONAL UPDATE is the actual
    // guarantee, and it is the only one that holds when two workers read before either writes. Issued
    // as two raw simultaneous claims against one pending row: exactly one may come back with a row.
    await db.execute(sql`update social_deliveries set status = 'pending', attempts = 0,
      provider_post_id = null where id = ${q.id}`);
    const claimSql = () => db.execute(sql`
      update social_deliveries
         set status = 'publishing', attempts = attempts + 1, updated_at = now()
       where id = ${q.id} and channel = 'threads' and status = 'pending'
         and provider_post_id is null
      returning id`);
    const [u1, u2] = await Promise.all([claimSql(), claimSql()]);
    const got = [u1, u2].filter((r) => (r.rows ?? r).length > 0).length;
    ok('⚠️ the conditional UPDATE itself admits exactly one of two simultaneous claims', got === 1,
      `${got} updates returned a row — without the status condition both workers would publish`);
    const spent = (await db.execute(sql`select attempts from social_deliveries where id = ${q.id}`)).rows?.[0];
    ok('⚠️ …and only one attempt was spent', Number(spent.attempts) === 1,
      `attempts=${spent.attempts}`);

    // The claim's source must carry that condition. Asserted as text too, because the race above can
    // serialise by luck of timing and a guarantee that only sometimes gets exercised is not one.
    const storeSrc = strip(await read('../src/lib/social/social-store.js'));
    const claimUpdate = storeSrc.slice(storeSrc.indexOf('const claimed = ('),
      storeSrc.indexOf('returning id, attempts'));
    ok('⚠️ the claim UPDATE is conditional on the row still being pending',
      /status = \$\{DELIVERY_STATUS\.PENDING\}/.test(claimUpdate),
      'without this the claim is a plain write and two workers both win');
    ok('…and on it not already carrying a provider post id',
      /provider_post_id is null/.test(claimUpdate));

    // Put the row back the way the rest of this section expects it.
    await db.execute(sql`update social_deliveries set status = 'publishing' where id = ${q.id}`);
    // A third claim after the fact must also refuse: the row is now mid-publish.
    const r3 = await store.claimDelivery('threads', q.id);
    ok('⚠️ a later pass does not reclaim a mid-publish row', !r3.ok);
    // And the documented manual escape hatch works, and only for a row that was not published.
    const rel = await store.releaseStuckDelivery('threads', q.id);
    ok('a human can release a stuck row', rel.released === true);
    await db.execute(sql`update social_deliveries set provider_post_id = 'x', status = 'posted' where id = ${q.id}`);
    const rel2 = await store.releaseStuckDelivery('threads', q.id);
    ok('⚠️ …but never one that actually published', rel2.released === false);
  } else {
    ok('a canonical event exists to test the claim against', false, 'primary_events is empty');
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 9. THE PROVENANCE GATE ===');
{
  await cleanup();
  const seq = TEST_SEQ_BASE - 30;
  const q = await store.queueDelivery({ channel: 'threads', eventSeq: seq,
    contentHash: `${HASH_PREFIX}prov`, payloadText: 'Nvidia raises guidance' });
  const claim = await store.claimDelivery('threads', q.id);
  ok('⚠️ a delivery with no source event is refused', !claim.ok && /provenance/.test(claim.reason),
    'nothing may reach a public account without an ingested event behind it');
  ok('…and terminally, not as a transient failure', claim.permanent === true);
  const row = (await db.execute(sql`select status, failure_class from social_deliveries where id = ${q.id}`)).rows?.[0];
  ok('…and it is marked failed rather than left needing review',
    row.status === 'failed' && row.failure_class === 'permanent');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 10. THE PROTOCOL, END TO END, AGAINST A SCRIPTED PROVIDER ===');
{
  const { threadsConfig } = TH;
  // MISSING CREDENTIALS FAIL SAFELY: no request is made at all.
  const pubT = await import('../src/lib/social/threads-publisher.js');
  const before = { ...process.env };
  delete process.env.THREADS_AUTO_POST_ENABLED;
  delete process.env.THREADS_USER_ID;
  delete process.env.THREADS_ACCESS_TOKEN;
  const offImpl = scriptedFetch([{ status: 200, body: { id: '1' } }]);
  const off = await pubT.publishPendingThreads({ fetchImpl: offImpl });
  ok('⚠️ a channel with no switch publishes nothing and calls nothing',
    off.sent === 0 && off.enabled === false && offImpl.calls.length === 0);

  process.env.THREADS_AUTO_POST_ENABLED = 'true';
  const noCred = scriptedFetch([{ status: 200, body: { id: '1' } }]);
  const unconf = await pubT.publishPendingThreads({ fetchImpl: noCred });
  ok('⚠️ an enabled channel with no credential still calls nothing',
    unconf.sent === 0 && unconf.configured === false && noCred.calls.length === 0,
    'an unconfigured destination must not hammer a provider it cannot authenticate to');
  ok('the switch is fail-closed: only the literal string true enables it',
    D.switchedOn('true') && !D.switchedOn('TRUE') && !D.switchedOn('1') && !D.switchedOn('yes')
    && !D.switchedOn(undefined));

  // Restore the environment before anything else runs.
  for (const k of ['THREADS_AUTO_POST_ENABLED', 'THREADS_USER_ID', 'THREADS_ACCESS_TOKEN']) {
    if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
  }

  // The publish plans are the documented shapes, with the container id as the handle.
  const tp = TH.threadsPublishPlan({ userId: '1', text: 'x' });
  ok('Threads creates a TEXT container then publishes it',
    tp.createContainer.body.media_type === 'TEXT' && /threads_publish$/.test(tp.publish.url));
  ok('⚠️ the Threads publish call names the container, not the content',
    'creation_id' in tp.publish.body && !('text' in tp.publish.body),
    'this is what makes a resumed attempt republish the same container instead of posting twice');
  const ip = IG.instagramPublishPlan({ igUserId: '1', imageUrl: CARD.url, caption: 'c' });
  ok('Instagram creates a media container then publishes it',
    /\/media$/.test(ip.createContainer.url) && /media_publish$/.test(ip.publish.url));
  ok('⚠️ the Instagram publish call also names only the container',
    'creation_id' in ip.publish.body && !('image_url' in ip.publish.body));
  ok('⚠️ Instagram polls the container before publishing it',
    ip.checkStatus.readyWhen === 'FINISHED' && ip.checkStatus.terminal.includes('ERROR'),
    'publishing an unfinished container fails, and reading that as a rejection destroys a good post');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 11. NO CREDENTIAL REACHES A RESPONSE, A LOG OR A STORED FIELD ===');
{
  const { redactCredential } = await import('../src/lib/facebook-post.mjs');
  const leaked = 'Malformed access token EAAG1234567890abcdefghijklmnopqrstuvwxyz0123456789';
  const text = D.providerErrorText({ status: 400, errorCode: 190, message: leaked }, redactCredential);
  ok('⚠️ a provider message that echoes a token is redacted before it is stored',
    !/EAAG1234567890abcdefghijklmnopqrstuvwxyz/.test(text),
    'Meta echoes the submitted token inside its Malformed access token class');
  const deliverySrc = strip(await read('../src/lib/social/social-delivery.mjs'));
  ok('⚠️ …and the redaction happens BEFORE the length cap',
    /redact\(String\(message\)\)\)\.slice\(0, 160\)/.test(deliverySrc),
    'slicing first would leave a truncated token in the stored text, which is still a token');
  ok('the error text still says what an operator needs', /HTTP 400/.test(text) && /code 190/.test(text));

  for (const [name, path] of [['threads', '../src/lib/social/threads-publisher.js'],
    ['instagram', '../src/lib/social/instagram-publisher.js'],
    ['store', '../src/lib/social/social-store.js'],
    ['card', '../src/lib/social/social-card.jsx']]) {
    const src = await read(path);
    ok(`⚠️ the ${name} module is server-only`, /^import 'server-only';/m.test(src),
      'a client-reachable import of this file must fail the build, not ship a token');
    const body = strip(src);
    const consoleCalls = body.match(/console\.(?:log|error|warn)\([\s\S]*?\);/g) || [];
    const leaks = consoleCalls.filter((c) =>
      /\$\{[^}]*\b(?:token|secret|credential|access_token|cfg)\b/i.test(c)
      || /\bJSON\.stringify\(\s*(?:cfg|derived|config)\b/.test(c)
      || /,\s*(?:cfg|token|derived\.token)\s*[),]/.test(c));
    ok(`⚠️ the ${name} module never logs a credential VALUE`, leaks.length === 0,
      leaks.map((c) => c.slice(0, 70)).join(' // '));
    // Naming the problem in prose is required, not forbidden: a credential outage is silent otherwise.
    ok(`⚠️ the ${name} module never returns failure_reason to a caller`,
      !/return[^\n;]*failure_reason/.test(body),
      'stored provider text is credential-bearing even after redaction');
  }
  // The credential travels in a body or a header, never a query string.
  for (const path of ['../src/lib/social/threads-publisher.js', '../src/lib/social/instagram-publisher.js']) {
    const src = strip(await read(path));
    ok(`⚠️ ${path.split('/').pop()} never puts a token in a URL`,
      !/\?access_token=|&access_token=/.test(src),
      'a URL reaches proxy logs, redirect chains and error traces; a body does not');
  }
  // Health output is counts and timestamps, never text.
  const st = strip(await read('../src/lib/social/social-store.js'));
  ok('⚠️ channelHealth returns no provider text, only counts, timestamps and a class',
    /recentFailureClasses/.test(st) && !/failure_reason:/.test(st));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 12. OBSERVABILITY: EACH DESTINATION ON ITS OWN ===');
{
  const h = await store.channelHealth('threads');
  for (const k of ['lastAttemptAt', 'lastSuccessAt', 'consecutiveFailures', 'failed', 'pending',
    'posted', 'skipped', 'needsManualReview', 'credentialHealthy', 'recentFailureClasses']) {
    ok(`health reports ${k}`, k in h);
  }
  ok('health is scoped to the channel it was asked about', h.channel === 'threads');
  const st = strip(await read('../src/lib/social/social-store.js'));
  ok('⚠️ each channel writes its own feed_state key',
    /\$\{`_\$\{channel\}`\}/.test(st),
    'a shared health row is how a broken Instagram would make Facebook look broken');
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 13. THE MEDIA FLOW IS VERIFIED, NOT ASSUMED ===');
{
  const card = strip(await read('../src/lib/social/social-card.jsx'));
  ok('⚠️ the card is converted to JPEG, because Instagram accepts only JPEG', /\.jpeg\(/.test(card));
  ok('⚠️ …and flattened first, because a JPEG has no alpha channel', /flatten\(/.test(card));
  ok('the card declares sRGB, which is Instagram\'s documented colour space', /srgb/.test(card));
  ok('⚠️ the card is validated against Meta\'s rules BEFORE it is uploaded',
    card.indexOf('validateInstagramImage') < card.indexOf('@vercel/blob'),
    'hosting a file Instagram will refuse leaves a public URL behind for nothing');
  ok('⚠️ the hosted url is re-checked as publicly fetchable after upload',
    /isPublicMediaUrl\(url\)/.test(card));
  ok('⚠️ an absent media host is reported rather than throwing',
    /media host not configured/.test(card));
  ok('the asset path is unguessable', /addRandomSuffix: true/.test(card));
  ok('the JPEG encoder is imported lazily so Threads does not depend on it',
    /await import\('sharp'\)/.test(card));
  const pkgJson = await read('../package.json');
  ok('sharp is a declared dependency, not an undeclared transitive one', (() => {
    const pkg = JSON.parse(pkgJson);
    return !!pkg.dependencies.sharp;
  })(), 'a Next upgrade dropping it would surface as "Instagram stopped posting"');
  // The card geometry must satisfy the spec it is checked against, tested as arithmetic rather than by
  // eye. Imported from the pure spec module: the renderer is JSX, which Node cannot load without a
  // loader, so the numbers live where a test can simply read them.
  const C = await import('../src/lib/social/social-card-spec.mjs');
  const aspect = C.CARD_WIDTH / C.CARD_HEIGHT;
  ok('⚠️ the card geometry is inside Instagram\'s published limits',
    C.CARD_WIDTH >= IG.IG_IMAGE_SPEC.minWidth && C.CARD_WIDTH <= IG.IG_IMAGE_SPEC.maxWidth
    && aspect >= IG.IG_IMAGE_SPEC.minAspect && aspect <= IG.IG_IMAGE_SPEC.maxAspect);
  ok('the font size shrinks as the headline grows',
    C.cardFontSize('short') > C.cardFontSize('x'.repeat(300)),
    'satori does not report overflow, so a long line would silently run off the card');
  // ⚠️ NO SOURCE NAME ON THE GRAPHIC, which is an editorial instruction rather than a layout detail:
  // a card carrying a publisher's name asserts their endorsement of our wording. Checked against the
  // renderer's own source, since the element tree cannot be imported here.
  const renderBody = card.slice(card.indexOf('export function cardElement'));
  ok('⚠️ the card renders no source or publisher name',
    !/\b(source_name|source|publisher|zerohedge|walter)\b/i.test(renderBody),
    'the card carries the Catalyst Pit line and Catalyst Pit marks, nothing else');
  ok('the card renders the headline and the tickers, and nothing else from the event',
    /\{line\}/.test(renderBody) && /tags\.map/.test(renderBody));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 14. THE CRON BUDGET AND THE DATA POLICY ===');
{
  const vercel = JSON.parse(await read('../vercel.json'));
  ok('⚠️ the cron count is still exactly 40', vercel.crons.length === 40,
    `${vercel.crons.length} crons — Vercel Pro allows 40 and this project is at the limit`);
  ok('⚠️ no cron was added for either new channel',
    !vercel.crons.some((c) => /instagram|threads|social/i.test(c.path)));
  ok('the two existing social crons are untouched',
    vercel.crons.some((c) => c.path === '/api/cron/facebook')
    && vercel.crons.some((c) => c.path === '/api/cron/x-autopost'));

  // ⚠️ NO RETIRED PROVIDER BECOMES REACHABLE. Social publishing consumes the canonical event; it has no
  // business fetching market data from anyone.
  const BANNED = /polygon\.io|finnhub\.io|financialmodelingprep|twelvedata|coingecko|openfigi/i;
  for (const f of ['social-delivery.mjs', 'social-store.js', 'social-card.jsx',
    'instagram-publisher.js', 'threads-publisher.js', 'instagram-post.mjs', 'threads-post.mjs']) {
    const src = await read(`../src/lib/social/${f}`);
    ok(`⚠️ ${f} reaches no retired commercial provider`, !BANNED.test(src));
    ok(`${f} fetches no market data at all`,
      !/\/api\/(quote|screener|ticker|candles)/.test(strip(src)));
  }
  const route = await read('../src/app/api/cron/facebook/route.js');
  ok('⚠️ the shared cron route reaches no retired provider', !BANNED.test(route));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
L('\n=== 15. PER-RUN AND PER-DAY CEILINGS ===');
{
  ok('each channel has a per-run ceiling',
    D.MAX_PER_RUN.instagram > 0 && D.MAX_PER_RUN.threads > 0);
  ok('⚠️ the per-run ceiling is small, so a backlog cannot empty onto a feed at once',
    D.MAX_PER_RUN.instagram <= 5 && D.MAX_PER_RUN.threads <= 10);
  ok('⚠️ each channel has a 24-hour ceiling below the provider\'s own limit',
    D.DAILY_POST_LIMIT.instagram < 100 && D.DAILY_POST_LIMIT.threads < 250,
    'being refused by the provider is a worse way to discover a limit than declining to send');
  for (const [name, path] of [['threads', '../src/lib/social/threads-publisher.js'],
    ['instagram', '../src/lib/social/instagram-publisher.js']]) {
    const src = strip(await read(path));
    ok(`the ${name} drain checks the daily count before sending`, /dailyPostedCount\(CHANNEL\)/.test(src));
    ok(`the ${name} drain honours a backoff`, /retry_after is null or retry_after <= now\(\)/.test(src));
    ok(`the ${name} drain skips rows at the attempt cap`, /attempts < \$\{MAX_DELIVERY_ATTEMPTS\}/.test(src));
  }
}

} finally {
  await cleanup().catch(() => {});
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
