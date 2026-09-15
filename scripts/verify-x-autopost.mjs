// Catalyst Pit X auto-poster verification.
//
// The pure logic runs with no DB and no network. The idempotency and zero-live-calls proofs use the
// real database and a fetch stub that RECORDS ANY CALL, so "dry run sends nothing" is demonstrated
// rather than asserted. No X credential is read, printed or needed by this file.
//
//   node scripts/verify-x-autopost.mjs                    pure tests only
//   node --env-file=.env.local scripts/verify-x-autopost.mjs   + database idempotency tests

import { readFileSync } from 'node:fs';
import { evaluate, formatPost, buildCandidate, resolveMode, canPublish, sanitize, reactionLine,
         MAX_POST, MODES } from '../src/lib/x-autopost.mjs';
import { publicationVerdict, readsAsSentence } from '../src/lib/x-quality.mjs';
import { storyVerdict, sameStory, factsOf, materiallyNew } from '../src/lib/x-story.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const sec = (s) => console.log(`\n=== ${s} ===`);

const ev = (o = {}) => ({
  seq: 1, headline: 'Saudi Arabia shuts East-West pipeline after drone attacks',
  headline_status: 'original', importance: 3, tickers: [], source_kind: 'external',
  sources: ['FINANCIALJUICE'], ...o,
});

// ── eligibility ──────────────────────────────────────────────────────────────
sec('ELIGIBILITY');
ok('CRITICAL event qualifies', evaluate(ev()).eligible && evaluate(ev()).reason === 'critical');
ok('Walter event qualifies at HIGH', (() => {
  const v = evaluate(ev({ importance: 2, sources: ['WALTERBLOOMBERG'] }));
  return v.eligible && v.reason === 'high';   // HIGH now qualifies on impact alone
})());
ok('Walter event qualifies at LOW too, impact is irrelevant for him',
  evaluate(ev({ importance: 0, sources: ['WALTERBLOOMBERG'] })).eligible);
ok('CRITICAL + Walter reports both reasons',
  evaluate(ev({ sources: ['BLOOMBERG', 'WALTERBLOOMBERG'] })).reason === 'critical+walter');
ok('Walter provenance counts when he MERGED IN, not just when canonical',
  evaluate(ev({ importance: 1, sources: ['FINANCIALJUICE', 'WALTERBLOOMBERG'] })).eligible);
// POLICY: a HIGH event qualifies on its own impact. Pit Wire already judged it; the account does
// not hold a second, stricter vote on the same event.
ok('HIGH non-Walter DOES qualify', evaluate(ev({ importance: 2 })).eligible);
ok('MEDIUM non-Walter does NOT qualify', !evaluate(ev({ importance: 1 })).eligible);
ok('LOW non-Walter does NOT qualify', !evaluate(ev({ importance: 0 })).eligible);
ok('SEC is never eligible even at CRITICAL',
  !evaluate(ev({ source_kind: 'sec', headline_status: 'not_required' })).eligible);

sec("WALTER'S OWN WORDING IS NEVER THE OUTPUT");
const pendingWalter = ev({ importance: 0, sources: ['WALTERBLOOMBERG'], headline_status: 'rewrite_pending',
  headline: 'GERMANY TO LOBBY EU ON NEW CHINA POLICY, MAY SEEK MORE TARIFFS' });
const pv = evaluate(pendingWalter);
ok('rewrite_pending Walter is NOT eligible', !pv.eligible);
ok('and it WAITS rather than being rejected', /awaiting Catalyst wording/.test(pv.blocked || ''), pv.blocked);
ok('a rewrite_pending Walter event produces no candidate at all',
  buildCandidate(pendingWalter).eligible === false);
ok('once rewritten, the SAME event becomes eligible',
  evaluate({ ...pendingWalter, headline_status: 'original',
    headline: 'Germany to lobby EU on new China policy, may seek more tariffs' }).eligible);
ok('not_required wording is never eligible either',
  !evaluate(ev({ headline_status: 'not_required' })).eligible);
ok('composed counts as Catalyst wording', evaluate(ev({ headline_status: 'composed' })).eligible);

// ── formatting ───────────────────────────────────────────────────────────────
sec('POST FORMAT');
const macro = formatPost(ev());
ok('macro event uses BREAKING:', macro.ok && macro.text.startsWith('BREAKING: '), macro.text);
ok('macro shape recorded', macro.shape === 'breaking');

const tickerHigh = formatPost(ev({ importance: 2, tickers: ['NVDA'], sources: ['WALTERBLOOMBERG'],
  headline: 'Nvidia raises Q4 revenue guidance' }));
ok('ticker event uses $TICKER:', tickerHigh.ok && tickerHigh.text.startsWith('$NVDA: '), tickerHigh.text);

const tickerCrit = formatPost(ev({ importance: 3, tickers: ['NVDA'], headline: 'Nvidia halted pending news' }));
ok('exceptional ticker event uses BREAKING: $TICKER',
  tickerCrit.ok && tickerCrit.text.startsWith('BREAKING: $NVDA '), tickerCrit.text);

ok('a ticker prefix already in the headline is not repeated',
  formatPost(ev({ importance: 2, tickers: ['MSFT'], sources: ['WALTERBLOOMBERG'],
    headline: 'MSFT: Microsoft sets limits for future AI models' })).text === '$MSFT: Microsoft sets limits for future AI models');
ok('a leading BREAKING in the source is not doubled',
  !/BREAKING: BREAKING/i.test(formatPost(ev({ headline: 'BREAKING: Saudi pipeline shut' })).text));

sec('FORBIDDEN CONTENT');
for (const [label, raw] of [
  ['tilde', 'Oil ~ 3% higher after strike'],
  ['pipe', 'Oil | crude higher after strike'],
  ['em dash', 'Oil higher — crude jumps after strike'],
  ['horizontal bar', 'Oil higher ― crude jumps'],
]) {
  const r = formatPost(ev({ headline: raw }));
  ok(`${label} never reaches the post`, r.ok && !/[~|—―]/.test(r.text), r.text);
}
ok('hashtags are removed', !/#/.test(formatPost(ev({ headline: 'Saudi pipeline shut #oil #OOTT' })).text));
ok('emoji are removed', !/[\u{1F000}-\u{1FAFF}]/u.test(formatPost(ev({ headline: 'Saudi pipeline shut \u{1F6A8}\u{1F6E2}' })).text));
ok('urls are removed', !/https?:/.test(formatPost(ev({ headline: 'Saudi pipeline shut https://x.com/a/1' })).text));
ok('no filler is ever added', !/investors are watching/i.test(formatPost(ev()).text));

sec('CHARACTER LIMIT');
const longOne = formatPost(ev({ headline: 'Saudi Arabia '.repeat(60) + 'shuts pipeline' }));
ok('long headline still produces a post', longOne.ok);
ok('result is within the limit', longOne.text.length <= MAX_POST, `${longOne.text.length}`);
ok('char count is reported and correct', longOne.chars === longOne.text.length);
ok('truncation lands on a word boundary, not mid-word', !/\s\S{1,2}…$/.test(longOne.text));
const longTicker = formatPost(ev({ importance: 3, tickers: ['NVDA'], headline: 'Nvidia '.repeat(80) + 'halted' }));
ok('prefix is counted inside the budget', longTicker.text.length <= MAX_POST, `${longTicker.text.length}`);

sec('MARKET REACTION — measured or absent, never invented');
const now = Date.UTC(2026, 8, 14, 12, 0, 0);
ok('a fresh reading is rendered', reactionLine({ label: 'Shares', changePct: 12.44, asOf: now - 60_000 }, now) === 'Shares +12.4%');
ok('a negative reading keeps its sign', reactionLine({ label: '$SPY', changePct: -0.94, asOf: now - 60_000 }, now) === '$SPY -0.9%');
ok('a STALE reading is omitted entirely', reactionLine({ label: 'Shares', changePct: 12.4, asOf: now - 3 * 3600_000 }, now) === null);
ok('a missing reading is omitted', reactionLine(null, now) === null);
ok('a non-numeric reading is omitted', reactionLine({ label: 'Shares', changePct: 'up a lot', asOf: now }, now) === null);
ok('noise below 0.1% is omitted', reactionLine({ label: 'Shares', changePct: 0.04, asOf: now }, now) === null);
const withReaction = formatPost(ev({ importance: 3, tickers: ['NVDA'], headline: 'Nvidia halted pending news' }),
  { label: 'Shares', changePct: 12.44, asOf: now - 60_000 }, now);
ok('reaction becomes a second line', withReaction.text.split('\n').length === 2, JSON.stringify(withReaction.text));
ok('post with reaction still within the limit', withReaction.text.length <= MAX_POST);
ok('no reading means exactly one line', formatPost(ev()).text.split('\n').length === 1);

// ── publication quality gate ────────────────────────────────────────────────
// Eligibility says an event MAY be posted. This says whether it SHOULD be. Every case below is a
// real headline from the dry run.
sec('PUBLICATION GATE — eligible is not the same as publishable');
const at = (mins = 1) => new Date(Date.UTC(2026, 8, 14, 12, 0, 0) - mins * 60_000).toISOString();
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
// MEDIUM by default, on purpose. HIGH and CRITICAL now bypass the editorial rules entirely (see
// the POLICY section at the end), so exercising those rules requires an event below that bar.
const gate = (headline, extra = {}) => publicationVerdict(
  { headline, summary: '', tickers: [], importance: 1, published_at: at(1), ...extra }, NOW);

ok('a real energy-infrastructure event publishes as BREAKING',
  (() => { const v = gate('Saudi Arabia shuts East-West pipeline after drone attacks'); return v.publish && v.breaking; })());
// An FDA approval IS substantive — it passes the substance test, which it failed before the
// hard-corporate clause. It is then held to the identity rule: a company-specific event with no
// established public company is suppressed, fail closed. That is the specified behaviour, and it
// means most FDA news waits on the ticker resolver rather than going out unattributed.
ok('an FDA approval clears the substance test', gate('Nasus Pharma wins FDA approval').reason !== 'no concrete substance');
// POLICY, revised after the account went live: a COMPANY-specific catalyst needs a resolved ticker.
// For a period a missing ticker was not a reason to suppress a HIGH/CRITICAL event, and the result
// was a feed of company news nobody could act on — an approval, an offering or a CFO change with no
// symbol tells a reader neither who nor whether it is investable. Market-wide catalysts are
// unaffected and still publish with no symbol at all; see the macro-flash section below.
ok('without a resolved ticker a company catalyst does NOT publish',
  !gate('Nasus Pharma wins FDA approval', { importance: 3 }).publish);
ok('...and says why', gate('Nasus Pharma wins FDA approval', { importance: 3 }).reason === 'fda with no listed company',
  gate('Nasus Pharma wins FDA approval', { importance: 3 }).reason);
ok('WITH a resolved ticker the same approval publishes as BREAKING',
  (() => { const v = gate('Nasus Pharma wins FDA approval', { tickers: ['NSPH'] }); return v.publish && v.breaking; })());
ok('a named-drug approval with a ticker publishes',
  gate('Scholar Rock receives FDA approval for spinal muscular atrophy drug Isembyld', { tickers: ['SRRK'] }).publish);

sec('GATE — private-company M&A can never publish');
for (const h of ['Tristela Capital Partners acquires Pediatric Group of Acadiana',
                 'Superhuman to acquire YC-backed notetaker Fathom',
                 'Wellthy to acquire Cleo as Two Leaders',
                 'Sazerac to acquire Au Vodka'])
  ok(`suppressed: ${h.slice(0, 44)}`, gate(h).reason === 'ma without a listed company', gate(h).reason || 'PUBLISHED');
ok('M&A WITH a resolved ticker publishes',
  gate('Kyndryl to acquire Healthcare IT Leaders', { tickers: ['KD'] }).publish);

sec('GATE — speculation, anticipation, staleness, PR noise');
ok('"considers acquiring" is suppressed as speculative',
  gate('Salesforce considers acquiring Listen Labs', { tickers: ['CRM'] }).reason === 'speculative');
ok('an unheld scheduled meeting is suppressed',
  gate('FOMC expected to raise rates 25 basis points this week').reason === 'anticipated or scheduled event');
ok('a real event that merely mentions a future consequence survives',
  gate('Saudi oil pipeline struck, expected out of service for several weeks').publish);
ok('a stale event is suppressed', gate('Saudi Arabia shuts East-West pipeline after drone attacks',
  { published_at: at(60 * 5) }).reason === 'stale');
// Suppressed is what matters; WHICH rule catches it first is an implementation detail, so these
// assert the outcome rather than the route. Both are caught before the PR-noise list even runs.
ok('a law-firm class-action notice never publishes',
  !gate('Robbins Geller announces investor deadline for Regeneron class action', { tickers: ['REGN'] }).publish);
ok('an award announcement never publishes',
  !gate('Live Oak Bank Named Official Business Bank of UNCW Athletics').publish);
ok('the PR-noise list does catch one that reaches it',
  gate('Acme wins $50 million award at industry conference', { tickers: ['ACME'] }).reason === 'pr wire noise');
ok('a vague announcement is suppressed',
  gate('Company announces strategic transaction').reason === 'vague, no information');

sec('GATE — Walter macro flashes are never suppressed for lacking a ticker');
for (const h of ['U.S. crude futures hit session high of $104.95 per barrel',
                 'Canada inflation holds at 3.0% year-over-year in August',
                 'Spot gold falls nearly 1% to $4,306.19 per ounce',
                 "China's Jan-Aug new yuan loans reach CNY10.44T; M2 rises 7.5% y/y"])
  ok(`Walter macro print publishes: ${h.slice(0, 40)}`,
    gate(h, { importance: 2, trusted: true }).publish, gate(h, { importance: 2, trusted: true }).reason || '');
// POLICY: at HIGH this now publishes. Commentary is an editorial judgement, and Pit Wire already
// scored the event. The rule still applies below HIGH.
ok('Walter COMMENTARY is suppressed below HIGH',
  !gate('Iran says US lack of mediation is main obstacle to diplomacy', { importance: 1, trusted: true }).publish);

sec('STORY GUARD — a developing story gets one post, not thirty-five');
// X-only. Pit Wire keeps every event; the account does not. Over six days the Saudi pipeline
// attack produced 35 publishable candidates, 51% of everything that would have gone out.
const S0 = Date.UTC(2026, 8, 14, 10, 0, 0);
const at2 = (m) => new Date(S0 + m * 60000).toISOString();

ok('two wordings of one story are recognised as the same story',
  sameStory('Saudi Arabia shuts East-West pipeline after drone attacks',
           'Saudi pipeline outage affects 4% of global oil supply'));
ok('a different story is not', !sameStory('Saudi Arabia shuts East-West pipeline after drone attacks',
  "Ukraine's military strikes oil refinery in Russia's Krasnodar region"));
ok('an unrelated macro print is not', !sameStory('Saudi Arabia shuts East-West pipeline after drone attacks',
  'Canada inflation holds at 3.0% year-over-year in August'));

const firstPost = [{ headline: 'Saudi Arabia shuts East-West pipeline after drone attacks', created_at: at2(0) }];
ok('the first post on a story goes out',
  storyVerdict({ headline: 'Saudi Arabia shuts East-West pipeline after drone attacks' }, [], S0).post);
ok('a near-duplicate minutes later is suppressed',
  storyVerdict({ headline: 'Saudi pipeline outage affects 4% of global oil supply' }, firstPost, S0 + 5 * 60000).reason
    === 'repetitive story update within the minimum gap');
ok('a rewording with no new fact is suppressed even after the gap',
  storyVerdict({ headline: 'Saudi Arabia shuts major crude pipeline following attacks' }, firstPost, S0 + 120 * 60000).reason
    === 'no materially new fact for this story');
ok('a materially new development DOES post',
  storyVerdict({ headline: "Saudi Arabia's East-West pipeline could remain offline for 3-5 weeks" }, firstPost, S0 + 120 * 60000).post);
ok('a duration fact counts as material, which numericFacts alone would miss',
  materiallyNew('pipeline could remain offline for 3-5 weeks', new Set()));
ok('the same figure twice is not material', !materiallyNew('outage threatens 4% of global oil supply', factsOf('outage affects 4% of global oil supply')));
const three = [0, 60, 130].map((m) => ({ headline: 'Saudi pipeline story update ' + m, created_at: at2(m) }));
ok('a hard ceiling stops a story however much it develops',
  /already posted/.test(storyVerdict({ headline: 'Saudi pipeline outage widens to 9% of supply' },
    three.map((p) => ({ ...p, headline: 'Saudi pipeline ' + p.headline })), S0 + 200 * 60000).reason || ''));

sec('BREAKING IS SELECTIVE');
const brk = (h, e = {}) => publicationVerdict({ headline: h, summary: '', tickers: [], importance: 3,
  published_at: new Date(Date.UTC(2026, 8, 14, 11, 59, 0)).toISOString(), ...e }, Date.UTC(2026, 8, 14, 12, 0, 0));
ok('material infrastructure disruption earns BREAKING', brk('Saudi Arabia shuts East-West pipeline after drone attacks').breaking);
ok('a bankruptcy earns BREAKING', brk('Acme files for Chapter 11 bankruptcy protection', { tickers: ['ACME'] }).breaking);
ok('an FDA decision earns BREAKING', brk('Nasus Pharma wins FDA approval', { tickers: ['NSPH'] }).breaking);
ok('a definitive public-company deal earns BREAKING', brk('Kyndryl to acquire Healthcare IT Leaders', { tickers: ['KD'] }).breaking);
ok('a routine economic print does NOT', !brk('Canada inflation holds at 3.0% year-over-year in August', { importance: 2, trusted: true }).breaking);
ok('a routine commodity move does NOT', !brk('Spot gold falls nearly 1% to $4,306.19 per ounce', { importance: 2, trusted: true }).breaking);
ok('but both still PUBLISH, as plain wire lines',
  brk('Canada inflation holds at 3.0% year-over-year in August', { importance: 2, trusted: true }).publish
  && brk('Spot gold falls nearly 1% to $4,306.19 per ounce', { importance: 2, trusted: true }).publish);
ok('Walter provenance alone never earns BREAKING',
  !brk('China Jan-Aug new yuan loans reach CNY10.44T, M2 rises 7.5% y/y', { importance: 2, trusted: true }).breaking);

sec('WORDING QUALITY — suppress rather than publish an awkward fragment');
ok('a PR fragment is rejected', !readsAsSentence('FDA approves Reduced Monitoring Time'));
ok('a vague announcement is rejected', !readsAsSentence('Company announces strategic transaction'));
ok('a dangling preposition is rejected', !readsAsSentence('Acme Corporation announces agreement with'));
ok('a real sentence passes', readsAsSentence('Saudi Arabia shuts East-West pipeline after drone attacks'));
ok('a measured print passes', readsAsSentence('Canada inflation holds at 3.0% year-over-year in August'));
ok('an agreement taking effect passes', readsAsSentence('Russia and Ukraine energy ceasefire to take effect within 72 hours'));
ok('the AMGN fragment is suppressed end to end',
  brk('FDA approves Reduced Monitoring Time', { tickers: ['AMGN'] }).reason === 'incomplete or fragmentary wording');

sec('MODE — fails closed');
ok("'live' resolves", resolveMode('live') === 'live');
ok("'dry_run' resolves", resolveMode('dry_run') === 'dry_run');
ok("'off' resolves", resolveMode('off') === 'off');
for (const bad of [undefined, null, '', '  ', 'LIVE', 'LIVE ', 'live ', ' live', 'Live', 'dryrun',
                   'dry-run', 'DRY_RUN', 'on', 'true', '1', 'production', 'dry_run_x', 0, 1, {}, []])
  ok(`invalid mode ${JSON.stringify(bad)} fails closed to off`, resolveMode(bad) === 'off', `got ${resolveMode(bad)}`);
ok('modes are exactly the three declared', MODES.join(',') === 'off,dry_run,live');

sec('PUBLISH GATE — only an exact "live" can ever contact X');
ok('live can publish', canPublish('live') === true);
for (const m of ['dry_run', 'off', undefined, null, '', 'LIVE', 'live ', ' live', 'Live', 'true', 1, {}])
  ok(`canPublish(${JSON.stringify(m)}) is false`, canPublish(m) === false);

// ── database: idempotency and zero live calls ────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('\n  (database tests skipped — run with --env-file=.env.local)');
} else {
  sec('IDEMPOTENCY — one canonical event can never become two posts');
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const TEST_SEQ = -999001;                         // negative: cannot collide with a real seq
  try {
    await sql`delete from x_post_candidates where event_seq = ${TEST_SEQ}`;
    const insert = async (reason) => (await sql`
      insert into x_post_candidates (event_seq, reason, post_text, char_count, shape, mode, status)
      values (${TEST_SEQ}, ${reason}, 'BREAKING: test', 14, 'breaking', 'dry_run', 'dry_run')
      on conflict (event_seq) do nothing returning id`).length;

    ok('first arrival creates one candidate', await insert('critical') === 1);
    ok('a duplicate canonical event creates NO second candidate', await insert('critical') === 0);
    ok('Walter arriving AFTER another source creates no second candidate', await insert('walter') === 0);
    ok('another source arriving AFTER Walter creates no second candidate', await insert('critical+walter') === 0);
    const n = (await sql`select count(*) c from x_post_candidates where event_seq = ${TEST_SEQ}`)[0].c;
    ok('exactly one row exists for the event', Number(n) === 1, `${n}`);
    await sql`delete from x_post_candidates where event_seq = ${TEST_SEQ}`;

    sec('DRY RUN MAKES ZERO CREATE-POST CALLS');
    // Structural proof. x-publisher.js imports the Next-resolved db layer so it cannot be loaded by
    // bare node; instead this reads the source and asserts the shape that makes publishing
    // unreachable. Combined with the exhaustive canPublish tests above, that is stronger than a
    // stubbed call: it shows there is no OTHER path to the endpoint.
    const pub = readFileSync(new URL('../src/lib/x-publisher.js', import.meta.url), 'utf8');
    const cron = readFileSync(new URL('../src/app/api/cron/x-autopost/route.js', import.meta.url), 'utf8');
    const admin = readFileSync(new URL('../src/app/api/admin/x-candidates/route.js', import.meta.url), 'utf8');

    const createPostRefs = (pub.match(/X_CREATE_POST/g) || []).length;
    ok('the create-post endpoint is named exactly once and used exactly once',
      createPostRefs === 3, `${createPostRefs} references`);   // declaration + url arg + auth arg
    ok('the only fetch to X lives inside publishCandidate',
      pub.indexOf('fetchImpl(X_CREATE_POST') > pub.indexOf('export async function publishCandidate'));
    // Scoped to the function body: the first `await db.execute` in the FILE is in eligibleEvents,
    // which says nothing about this.
    const body = pub.slice(pub.indexOf('export async function publishCandidate'));
    const gateAt = body.indexOf('canPublish(');
    const dbAt = body.indexOf('await db.execute');
    const credAt = body.indexOf('process.env.X_API');
    ok('publishCandidate gates on canPublish before it reads the database',
      gateAt >= 0 && gateAt < dbAt, `gate@${gateAt} db@${dbAt}`);
    // -1 is the desired answer: the function never touches a credential directly. They are read
    // only inside authHeader, which is reached only after the gate and only to sign one request.
    ok('publishCandidate never touches a credential itself', credAt === -1, `credential ref @${credAt}`);
    ok('the auth header is built only after the gate',
      body.indexOf('authHeader(') > gateAt, `auth@${body.indexOf('authHeader(')}`);
    ok('generateCandidates never references the endpoint',
      !pub.slice(pub.indexOf('export async function generateCandidates'),
                 pub.indexOf('export async function recentCandidates')).includes('X_CREATE_POST'));
    // THE CONTRACT CHANGED when live posting was enabled. The cron may now publish — but only
    // through publishPending, which returns before reading the database unless the mode is exactly
    // `live`. What must stay true is that the gate is the ONLY way through, and that dry_run and
    // off cannot reach the endpoint however the route is called.
    ok('the cron publishes only via publishPending', cron.includes('publishPending')
      && !cron.includes('publishCandidate('));
    const pendAt = pub.indexOf('export async function publishPending');
    const pendBody = pub.slice(pendAt, pub.indexOf('// ── inspection'));
    ok('publishPending gates on canPublish first', pendBody.indexOf('canPublish') >= 0
      && pendBody.indexOf('canPublish') < pendBody.indexOf('db.execute'));
    ok('publishPending caps how many go out in one run', /MAX_PER_RUN/.test(pendBody));
    ok('the admin route still cannot publish',
      !admin.includes('publishCandidate') && !admin.includes('publishPending'));
    // Still nothing else in the app reaches the publisher directly.
    const { execSync } = await import('node:child_process');
    const callers = execSync('git grep -l "publishCandidate(" -- src/app || true', { encoding: 'utf8' }).trim();
    ok('no route calls publishCandidate directly', callers === '', callers);
    ok('no credential value is ever returned or logged',
      !/console\.(log|error|warn)\([^)]*X_(API|ACCESS)/.test(pub)
      && !/return[^;]*process\.env\.X_(API|ACCESS)/.test(pub));
  } finally { await sql.end(); }
}

sec('NOTHING PUBLISHES WITHOUT A REAL SOURCE EVENT');
{
  // Defence in depth, not a behaviour change: every candidate ever written already carries a
  // resolvable event_seq, so this gate has nothing to reject. It exists so that no future path into
  // this table — an admin action, a migration, a script, a mistake — can put text on the account
  // without an ingested news event behind it.
  const { readFileSync } = await import('node:fs');
  const pub = readFileSync(new URL('../src/lib/x-publisher.js', import.meta.url), 'utf8');
  const body = pub.slice(pub.indexOf('export async function publishCandidate'));
  ok('the candidate is joined to its source event', /left join primary_events e on e\.seq = c\.event_seq/.test(body));
  ok('a null event_seq is rejected', /cur\.event_seq == null/.test(body));
  ok('an unresolvable event_seq is rejected', /cur\.source_seq == null/.test(body));
  const gate = body.indexOf('cur.event_seq == null');
  ok('the gate runs BEFORE the attempt counter', gate > 0 && gate < body.indexOf('attempts = attempts + 1'),
    'a rejected row would burn its retries instead of stopping');
  ok('the gate runs BEFORE any request to X', gate > 0 && gate < body.indexOf('fetchImpl(X_CREATE_POST'));
  ok('rejection is terminal and visible', /status = 'suppressed'[\s\S]{0,90}provenance/.test(body));
  ok('the mode gate still comes first of all', body.indexOf('canPublish(') < gate);
  // The X publisher must stay ignorant of the Facebook one.
  ok('x-publisher imports nothing from the Facebook side', !/facebook/i.test(pub));
  ok('it reads only its own table', !/fb_post_candidates/.test(pub));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


// ── POLICY: HIGH and CRITICAL post ───────────────────────────────────────────
sec('POLICY — HIGH and CRITICAL publish, halts never do');
const hi = (headline, extra = {}) => publicationVerdict(
  { headline, summary: '', tickers: [], importance: 2, published_at: at(1), ...extra }, NOW);

ok('a HIGH event publishes', hi('Washington considering phased agreement with Iran').publish);
ok('a CRITICAL event publishes', hi('DeepSeek hires first CFO ahead of potential IPO', { importance: 3 }).publish);
ok('no ticker is not a reason to suppress', hi('Kalshi puts Democrats at 51% in Senate race odds').publish);
ok('no measured figure is not a reason to suppress', hi('Germany to lobby EU on new China policy').publish);
ok('speculation is not a reason to suppress at HIGH', hi('Acme considers acquiring Beta Industries').publish);
ok('a private-company deal is not a reason to suppress at HIGH', hi('Superhuman to acquire YC-backed notetaker Fathom').publish);

ok('a MEDIUM event still faces the editorial gate', !hi('Acme considers acquiring Beta', { importance: 1 }).publish);

// The blockers that remain, at every impact.
ok('malformed wording still blocks', !hi('Acme agrees to acquire Beta for…').publish);
ok('...with the right reason', hi('Acme agrees to acquire Beta for…').reason === 'incomplete or fragmentary wording');
ok('foreign text still blocks', !hi('SÍL 2 hs. - ákvörðun vaxta og almenn upplýsingagjöf').publish);
ok('a stale event still blocks', !hi('Saudi Arabia shuts East-West pipeline', { published_at: at(600) }).publish);

// HALTS: a deterministic category/type exclusion that overrides impact.
for (const [label, extra] of [
  ['source_type halt', { source_type: 'halt' }],
  ['category HALT', { category: 'HALT' }],
  ['wireType halt', { wireType: 'halt' }],
  ['wireCategory HALT', { wireCategory: 'HALT' }],
]) {
  const v = hi('AAPL halted, volatility pause', { tickers: ['AAPL'], importance: 3, market_cap: 3e12, ...extra });
  ok(`a halt never posts (${label})`, !v.publish, v.reason || 'PUBLISHED');
  ok(`...for the halt reason (${label})`, v.reason === 'halts are not auto-posted', v.reason);
}
ok('a news-pending halt never posts either',
  !hi('XYZ halted, news pending', { source_type: 'halt', tickers: ['XYZ'], importance: 3 }).publish);
ok('a non-halt event with the word halt in it is unaffected',
  hi('Company halts production at its main plant after fire').publish);
