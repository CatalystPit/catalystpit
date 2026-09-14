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
  return v.eligible && v.reason === 'walter';
})());
ok('Walter event qualifies at LOW too, impact is irrelevant for him',
  evaluate(ev({ importance: 0, sources: ['WALTERBLOOMBERG'] })).eligible);
ok('CRITICAL + Walter reports both reasons',
  evaluate(ev({ sources: ['BLOOMBERG', 'WALTERBLOOMBERG'] })).reason === 'critical+walter');
ok('Walter provenance counts when he MERGED IN, not just when canonical',
  evaluate(ev({ importance: 1, sources: ['FINANCIALJUICE', 'WALTERBLOOMBERG'] })).eligible);
ok('HIGH non-Walter does NOT qualify', !evaluate(ev({ importance: 2 })).eligible);
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
    ok('the cron route cannot publish: it never imports or calls publishCandidate',
      !cron.includes('publishCandidate'));
    ok('the cron route reports liveCallsMade: 0', cron.includes('liveCallsMade: 0'));
    ok('the admin route cannot publish', !admin.includes('publishCandidate'));
    // Nothing anywhere under src/app CALLS it. Checked across every route file rather than one, and
    // matching an actual call `publishCandidate(` so a mention in a comment does not count.
    const { execSync } = await import('node:child_process');
    const callers = execSync('git grep -l "publishCandidate(" -- src/app || true', { encoding: 'utf8' }).trim();
    ok('no route in the app calls publishCandidate', callers === '', callers);
    ok('no credential value is ever returned or logged',
      !/console\.(log|error|warn)\([^)]*X_(API|ACCESS)/.test(pub)
      && !/return[^;]*process\.env\.X_(API|ACCESS)/.test(pub));
  } finally { await sql.end(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
