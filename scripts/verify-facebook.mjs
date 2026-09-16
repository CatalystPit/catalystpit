// WALTER -> FACEBOOK: the gates that stop the wrong thing reaching a public Page.
//
// Run: node scripts/verify-facebook.mjs

import { readFile } from 'node:fs/promises';
import { facebookText, facebookEligibility, facebookConfig, facebookReadiness,
  FB_SOURCE_WHITELIST, FB_MAX_CHARS, isPermanentFailure, META_OAUTH_ERROR_CODE, META_PERMISSION_ERROR_CODE, redactCredential,
  isAuthFailure, failureSpendsAttempt, FB_HASHTAGS, withHashtags, withoutHashtags } from '../src/lib/facebook-post.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

// Every post now ends with the standing hashtag block; assertions about the STORY strip it first.
const story = (t) => withoutHashtags(t);

const WALTER = {
  source: 'WALTERBLOOMBERG', content_hash: 'h1', source_uid: 'WalterBloomberg/35531',
  source_headline: '*KREMLIN: IF SANCTIONS ARE LIFTED, WORLD ENERGY PRICES WILL GO DOWN (@WalterBloomberg)',
  headline: 'Kremlin says lifting sanctions would lower world energy prices',
};
const LIVE = { isNew: true, isCanonical: true };

section('1. Walter only');
ok('Walter is whitelisted', FB_SOURCE_WHITELIST.has('WALTERBLOOMBERG'));
ok('exactly one source', FB_SOURCE_WHITELIST.size === 1);
for (const s of ['FINANCIALJUICE', 'BREAKINGMARKETNEWS', 'GLOBENEWSWIRE', 'NEWSFILE', 'SEC', 'WSJ'])
  ok(`${s} is not`, !facebookEligibility({ ...WALTER, source: s }, LIVE).eligible);

section('2. new unique events only');
ok('a live new canonical event is eligible', facebookEligibility(WALTER, LIVE).eligible,
  facebookEligibility(WALTER, LIVE).reason);
ok('a conflicted re-ingest is not', !facebookEligibility(WALTER, { isNew: false, isCanonical: true }).eligible);
ok('a duplicate folded into a cluster is not',
  !facebookEligibility(WALTER, { isNew: true, isCanonical: false }).eligible);
ok('a backfill is not', !facebookEligibility(WALTER, { ...LIVE, isBackfill: true }).eligible);
ok('the reason names the backfill',
  /backfill|replay/.test(facebookEligibility(WALTER, { ...LIVE, isBackfill: true }).reason));

section('3. the text is Walter\'s FACTS, in Catalyst Pit\'s voice');
{
  const t = facebookText(WALTER);
  // THE POLICY CHANGED HERE, deliberately. It used to be byte-verbatim, which meant the Page
  // published terminal copy: a leading asterisk and the whole line shouted in capitals. Presentation
  // is now Catalyst Pit's; the facts are still Walter's, enforced by facebook-voice's own guard and
  // asserted word by word below. See scripts/verify-facebook-voice.mjs for the full treatment.
  ok('still built from source_headline, not the Catalyst Pit headline',
    /sanctions are lifted/i.test(t) && t !== WALTER.headline);
  ok('the terminal flash marker is gone', !t.startsWith('*'));
  ok('it is no longer shouting', t !== t.toUpperCase());
  ok('every word of the headline survives',
    story(t) === 'Kremlin: if sanctions are lifted, world energy prices will go down.', JSON.stringify(t));
  ok('no word was added or dropped',
    story(t).replace(/[^A-Za-z]/g, '').toUpperCase()
      === '*KREMLIN: IF SANCTIONS ARE LIFTED, WORLD ENERGY PRICES WILL GO DOWN'.replace(/[^A-Za-z]/g, ''));
  // The standing hashtag block is now appended to every post by request. It is fixed text, identical
  // everywhere, so it asserts nothing about this particular story — see section 3c.
  ok('the story itself carries no hashtag', !/#/.test(t.split('\n\n').slice(0, -1).join('\n\n')));
  ok('adds no URL', !/https?:\/\//.test(t));
  ok('adds no Catalyst Pit wording', !/catalyst ?pit/i.test(t));
  ok('adds no ticker', !/\$[A-Z]{1,5}\b/.test(t));
  // Falls back to the canonical headline only when there is no source text at all.
  ok('falls back when source text is missing',
    story(facebookText({ headline: 'X', source_headline: '' })) === 'X.');
  ok('no text at all yields null', facebookText({}) === null);
}

section('3c. every post carries the four hashtags');
{
  const tags = '#stockmarket #investing #daytrading #stocks';
  ok('the block is exactly the four requested tags', FB_HASHTAGS.join(' ') === tags, FB_HASHTAGS.join(' '));
  ok('in the requested order', FB_HASHTAGS[0] === '#stockmarket' && FB_HASHTAGS[3] === '#stocks');

  for (const [label, sh] of [
    ['a one-line flash', '*OIL SURGES 3% (@WalterBloomberg)'],
    ['a multi-paragraph post', 'HEADLINE HERE\n\nA body paragraph.\n\nAnother body paragraph.'],
    ['already-clean prose', 'Michael Burry is joining Minerva as senior adviser.'],
    ['a post ending in a quote', 'HE SAID "WE WILL ACT"'],
  ]) {
    const t = facebookText({ source_headline: sh });
    ok(`${label}: ends with the block`, t.endsWith(tags), JSON.stringify(t.slice(-60)));
    ok(`${label}: separated by a blank line`, t.endsWith('\n\n' + tags));
    ok(`${label}: appears exactly once`, t.split('#stockmarket').length === 2);
    ok(`${label}: the story survives above it`, t.replace(tags, '').trim().length > 0);
  }

  // Appending must be idempotent: running it twice cannot produce the block twice.
  const once = withHashtags('OIL SURGES.');
  ok('idempotent', withHashtags(once) === once, JSON.stringify(withHashtags(once).slice(-70)));
  ok('idempotent regardless of spacing', withHashtags('OIL SURGES.\n\n' + tags + '  ') === once);

  // A POST MUST NEVER BE LOST TO MAKE ROOM FOR HASHTAGS. Eligibility measures the final string, so a
  // story close to the limit ships without the block rather than failing the length gate.
  const huge = 'x'.repeat(FB_MAX_CHARS - 5);
  ok('a near-limit post keeps its story and drops the block', withHashtags(huge) === huge);
  ok('and is still eligible to publish',
    facebookEligibility({ source: 'WALTERBLOOMBERG', content_hash: 'h', source_headline: huge },
      LIVE).eligible);
  ok('a normal post is comfortably inside the limit',
    facebookText({ source_headline: 'OIL SURGES 3%' }).length < FB_MAX_CHARS);
  ok('hashtags do not make an empty post publishable', facebookText({}) === null);

  // The tags are FIXED. They are never derived from the story, so they cannot claim a topic.
  const a = facebookText({ source_headline: 'GOLD FALLS 1%' });
  const b = facebookText({ source_headline: 'FED HOLDS RATES' });
  ok('identical on every post', a.slice(a.indexOf('#')) === b.slice(b.indexOf('#')));
  ok('no ticker is ever turned into a hashtag',
    !/#[A-Z]{2,5}\b/.test(facebookText({ source_headline: 'APPLE $AAPL RISES 3%' })));
}

section('4. transport normalisation');
// The editorial pass also ends a line as a sentence now, so these assert the transport rules — the
// characters are normalised and the line structure is kept — with the terminal full stop expected.
for (const [raw, want, why] of [
  ['A\r\nB', 'A.\nB.', 'CRLF becomes LF'],
  ['A B', 'A B.', 'non-breaking space'],
  ['A​B', 'AB.', 'zero-width space removed'],
  ['  A  ', 'A.', 'trimmed'],
  ['A\n\n\n\n B', 'A.\n\n B.', 'blank-line runs collapsed'],
]) ok(why, story(facebookText({ source_headline: raw })) === want, JSON.stringify(facebookText({ source_headline: raw })));
ok('word order and punctuation untouched',
  story(facebookText({ source_headline: 'WTI climbed 1% to $102.40, holding near recent highs.' }))
  === 'WTI climbed 1% to $102.40, holding near recent highs.');

section('5. length bounds — skip, never truncate');
ok('an overlong post is skipped', !facebookEligibility(
  { ...WALTER, source_headline: 'x'.repeat(FB_MAX_CHARS + 1) }, LIVE).eligible);
ok('it is not truncated instead',
  facebookText({ source_headline: 'x'.repeat(FB_MAX_CHARS + 1) }).length > FB_MAX_CHARS);
ok('an empty post is skipped', !facebookEligibility({ ...WALTER, source_headline: '', headline: '' }, LIVE).eligible);
ok('a two-character post is skipped', !facebookEligibility({ ...WALTER, source_headline: 'ok', headline: '' }, LIVE).eligible);

section('6. kill switch defaults OFF and fails closed');
ok('unset is off', !facebookConfig({}).enabled);
ok('empty is off', !facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: '' }).enabled);
for (const v of ['1', 'TRUE', 'True', 'yes', 'on', 'enabled', ' true'])
  ok(`"${v}" does not enable it`, !facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: v }).enabled);
ok('only exactly "true" enables', facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true' }).enabled);
ok('a current Graph version is the default', /^v2[0-9]\.0$/.test(facebookConfig({}).graphVersion));
ok('the version is overridable',
  facebookConfig({ FACEBOOK_GRAPH_VERSION: 'v25.0' }).graphVersion === 'v25.0');

section('7. readiness reports booleans, never the token');
{
  const cfg = facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true', FACEBOOK_PAGE_ID: '123', FACEBOOK_PAGE_ACCESS_TOKEN: 'SECRET_TOKEN_VALUE' });
  const r = facebookReadiness(cfg);
  ok('ready when all three are set', r.ready === true);
  ok('reports that a token exists', r.hasToken === true);
  const json = JSON.stringify(r);
  ok('the token is not in the readiness object', !json.includes('SECRET_TOKEN_VALUE'), json);
  ok('no field is named like a secret', !/token"\s*:\s*"[^"]{8,}/.test(json));
  ok('not ready without a page id', !facebookReadiness(facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true', FACEBOOK_PAGE_ACCESS_TOKEN: 't' })).ready);
  ok('not ready without a token', !facebookReadiness(facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true', FACEBOOK_PAGE_ID: '1' })).ready);
  ok('not ready when the switch is off', !facebookReadiness(facebookConfig({ FACEBOOK_PAGE_ID: '1', FACEBOOK_PAGE_ACCESS_TOKEN: 't' })).ready);
}

section('8. token handling, asserted on the source');
{
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  ok('publisher is server-only guarded', /^import 'server-only';/m.test(pub));
  // Publishing now uses the token resolved by the System User exchange, not the raw configured one.
  // The property asserted is unchanged: it goes in the BODY, never the query string.
  ok('the token is sent in the body, not the URL',
    /access_token: derived\.token/.test(pub) && !/access_token=\$\{/.test(pub));
  const tok = await readFile(new URL('../src/lib/facebook-page-token.mjs', import.meta.url), 'utf8');
  ok('the System User credential is sent as a header, never in the URL',
    /Authorization: `Bearer \$\{cfg\.systemUserToken\}`/.test(tok) && !/access_token=\$\{/.test(tok));
  ok('the token is never logged', !/console\.(log|error)[^\n]*cfg\.token/.test(pub));
  ok('no NEXT_PUBLIC variable is read', !/NEXT_PUBLIC/.test(pub));
  const pure = await readFile(new URL('../src/lib/facebook-post.mjs', import.meta.url), 'utf8');
  ok('the pure module performs no I/O', !/fetch\(|require\(|from '\.\/db'/.test(pure));
  const route = await readFile(new URL('../src/app/api/cron/facebook/route.js', import.meta.url), 'utf8');
  ok('the route never reads the token', !/FACEBOOK_PAGE_ACCESS_TOKEN/.test(route));
  ok('the route is authenticated', /Unauthorized/.test(route) && /CRON_SECRET/.test(route));
  ok('the route caps its error text', /slice\(0, ?\d+\)/.test(route));
}

section('9. the test path cannot publish real content');
{
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  const fn = pub.slice(pub.indexOf('export async function publishFacebookTest'));
  ok('the test message is a fixed literal', /Catalyst Pit publishing test/.test(fn));
  ok('it accepts no caller text', !/\(\s*\{[^}]*message/.test(fn.split('\n')[0] + fn.split('\n')[1]));
  ok('it never reads the queue', !/fb_post_candidates/.test(fn.slice(0, 900)));
}

section('10. ingestion is never blocked by Facebook');
{
  const pe = await readFile(new URL('../src/lib/primary-events.js', import.meta.url), 'utf8');
  const hook = pe.slice(pe.indexOf('WALTER -> FACEBOOK'), pe.indexOf('WALTER -> FACEBOOK') + 1200);
  ok('the hook is wrapped in try/catch', /try \{[\s\S]*catch/.test(hook));
  ok('it only fires for Walter', /e\.source === 'WALTERBLOOMBERG'/.test(hook));
  ok('it only fires for canonical events', /!e\.cluster_id/.test(hook));
  ok('it queues rather than publishes', /queueFacebookPost/.test(hook) && !/publishFacebookCandidate/.test(hook));
  ok('publishing is not imported into the ingest path', !/publishPendingFacebook/.test(pe));
}

section('11. the schedule is compatible with the queue it drains');
{
  // The drain interval is not a free choice: a queued row older than MAX_AGE_MINUTES is never
  // published, and a transient failure is retried on the NEXT RUN, so three attempts have to fit
  // inside that window with room to spare. At one minute they span three; at five they would span
  // fifteen, leaving half the window gone before a post is abandoned.
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const cron = (vercel.crons || []).filter((c) => c.path === '/api/cron/facebook');
  ok('the drain is scheduled', cron.length === 1, cron.length + ' entries');

  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  const maxAge = Number((pub.match(/MAX_AGE_MINUTES\s*=\s*(\d+)/) || [])[1]);
  const attempts = Number((pub.match(/MAX_FB_ATTEMPTS\s*=\s*(\d+)/) || [])[1]);
  ok('the queue still expires rows', maxAge === 30, 'MAX_AGE_MINUTES is ' + maxAge);
  ok('the queue still caps attempts', attempts === 3, 'MAX_FB_ATTEMPTS is ' + attempts);

  // Minutes between runs, for the only two shapes used in this file: "* * * * *" and "*/N * * * *".
  const min = cron[0]?.schedule === '* * * * *' ? 1
    : Number((String(cron[0]?.schedule).match(/^\*\/(\d+) /) || [])[1] || NaN);
  ok('the interval is a plain minute cadence', Number.isFinite(min), cron[0]?.schedule);
  ok('every attempt fits inside the expiry window with margin', min * attempts * 2 <= maxAge,
    `${min}-minute interval x ${attempts} attempts is not comfortably under ${maxAge} minutes`);
  ok('the drain runs at least as often as the ingest that fills it',
    min <= 1, 'primary-sources queues every minute; a slower drain lets rows age');
}

section('12. a scheduled run is inert while the switch is off');
{
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  const fn = pub.slice(pub.indexOf('export async function publishPendingFacebook'));
  const gate = fn.indexOf("if (!cfg.enabled)");
  ok('the kill switch is checked first', gate > 0 && gate < fn.indexOf('ensureFacebookTable'),
    'a disabled run would still touch the database');
  ok('nothing is read before it', fn.slice(0, gate).indexOf('db.execute') === -1);
  // Only the exact string enables it, so a scheduled cron cannot be switched on by a typo.
  ok('the switch still fails closed', facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'TRUE' }).enabled === false
    && facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: '1' }).enabled === false
    && facebookConfig({ FACEBOOK_AUTO_POST_ENABLED: 'true' }).enabled === true);
}

section('13. nothing publishes without a real source event');
{
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  const fn = pub.slice(pub.indexOf('export async function publishFacebookCandidate'),
                       pub.indexOf('export const MAX_FB_ATTEMPTS'));
  ok('the candidate is joined to its source event', /left join primary_events e on e\.seq = c\.event_seq/.test(fn));
  ok('a null event_seq is rejected', /cur\.event_seq == null/.test(fn));
  ok('an unresolvable event_seq is rejected', /cur\.source_seq == null/.test(fn));
  const gate = fn.indexOf('cur.event_seq == null');
  ok('the gate runs BEFORE the row is marked publishing', gate > 0 && gate < fn.indexOf("status = 'publishing'"),
    'a rejected row would need manual review');
  ok('the gate runs BEFORE any Meta request', gate > 0 && gate < fn.indexOf('postToPage'));
  ok('rejection is terminal, not retried', /status = 'failed', failure_reason = \$\{'provenance: '/.test(fn)
    || /status = 'failed'[\s\S]{0,80}provenance/.test(fn));
  ok('the reason is recorded for an operator', /provenance: /.test(fn));

  // INDEPENDENCE. The safeguard is duplicated in each publisher on purpose; a shared helper is
  // exactly the coupling these two systems must not have.
  ok('facebook-publisher imports nothing from the X side', !/x-publisher|x-autopost/.test(pub));
  ok('it reads only its own table', !/x_post_candidates/.test(pub));
}

section('14. the public attribution never reaches the Page');
{
  // The forms that must be stripped. The first is the real one — all 105 ingested Walter events end
  // with exactly this — and the rest are spacing and casing variants that cost nothing to cover.
  // The editorial pass runs after the strip, so these assert the PROPERTY — the handle is gone and
  // every word of the story survives — rather than a byte-for-byte string that casing now changes.
  for (const [raw, want] of [
    ['*US 20Y BONDS DRAW 5.420% VS 5.400% (@WalterBloomberg)', 'US 20Y bonds draw 5.420% vs 5.400%.'],
    ['SPOT GOLD FALLS NEARLY 1% TO $4,306.19/OZ (@WalterBloomberg)', 'Spot gold falls nearly 1% to $4,306.19/OZ.'],
    ['OIL SURGES (@WalterBloomberg) ', 'Oil surges.'],
    ['OIL SURGES(@WalterBloomberg)', 'Oil surges.'],
    ['OIL SURGES ( @WalterBloomberg )', 'Oil surges.'],
    ['OIL SURGES (@walterbloomberg)', 'Oil surges.'],
    ['OIL SURGES (@WALTERBLOOMBERG)', 'Oil surges.'],
    ['A multi-line post\n\nwith a body and a credit (@WalterBloomberg)', 'A multi-line post.\n\nwith a body and a credit.'],
  ]) ok('stripped: ' + JSON.stringify(raw).slice(0, 52), story(facebookText({ source_headline: raw })) === want,
    JSON.stringify(facebookText({ source_headline: raw })));

  ok('no published text may contain the handle in any casing',
    !/@walterbloomberg/i.test(facebookText(WALTER)));

  // What must NOT be stripped. The rule is anchored to the end AND to this handle, so a mention that
  // is part of the story survives, and another account's handle is never touched.
  // Asserted on WORDS, not bytes: the editorial pass may recase and punctuate, but a mention that is
  // part of the story must still be there afterwards.
  const words = (s) => s.replace(/[^A-Za-z@]/g, '').toUpperCase();
  for (const raw of [
    'Walter Bloomberg reported the figure first',
    '(@WalterBloomberg) said the meeting was postponed',
    'SOURCE SAYS (@SomeoneElse)',
    'ANALYST CITES @WalterBloomberg AS THE SOURCE OF THE LEAK',
  ]) ok('kept: ' + JSON.stringify(raw).slice(0, 50),
    words(story(facebookText({ source_headline: raw }))) === words(raw),
    JSON.stringify(facebookText({ source_headline: raw })));

  // THE CHANGE IS COSMETIC ONLY. Source control lives on ev.source and has never read the text, so
  // removing the visible credit cannot widen what may be published.
  ok('the whitelist still gates on the source field, not the text',
    facebookEligibility({ ...WALTER, source: 'FINANCIALJUICE' }, LIVE).eligible === false
    && facebookEligibility({ ...WALTER, source: 'WALTERBLOOMBERG' }, LIVE).eligible === true);
  ok('a non-Walter event is refused even with the attribution present',
    !facebookEligibility({ ...WALTER, source: 'SEC',
      source_headline: 'ANYTHING (@WalterBloomberg)' }, LIVE).eligible);
  ok('a Walter event is still eligible once the attribution is gone',
    facebookEligibility({ ...WALTER, source_headline: 'SPOT GOLD FALLS NEARLY 1% TO $4,306.19/OZ' }, LIVE).eligible);

  const src = await readFile(new URL('../src/lib/facebook-post.mjs', import.meta.url), 'utf8');
  ok('the strip is anchored to the end of the text', /\)\\s\*\$\/i/.test(src) || /\\s\*\$\/i/.test(src));
  ok('it names the handle rather than any handle', !/\\\(@\[A-Za-z\]\+\\\)/.test(src));
  ok('the whitelist is untouched', /FB_SOURCE_WHITELIST = new Set\(\['WALTERBLOOMBERG'\]\)/.test(src));
}

section('15. a broken credential delays a post, it does not destroy it');
{
  // The exact rejection that lost the 18:04 Walter item on 2026-09-15.
  ok('an expired token is retryable, not terminal', isPermanentFailure(400, 190) === false);
  ok('code 190 is Meta\'s OAuth code', META_OAUTH_ERROR_CODE === 190);
  ok('it is retryable whatever the HTTP status', [400, 403, 401, 500].every((s) => !isPermanentFailure(s, 190)));
  ok('a string code from JSON is handled too', isPermanentFailure(400, '190') === false);

  // CODE 200 IS A CREDENTIAL FAILURE TOO, and used to be classified as a content rejection.
  // Production, 2026-09-16: a replaced token bound on the next deployment was refused with
  // "(#200) ... requires ... pages_manage_posts permission with page token" — a valid token that is
  // not allowed to post as the Page. Every item queued during the 40-minute outage was marked
  // permanently failed within seconds and was unreachable by the drain after the fix. The token was
  // wrong; the posts were not.
  ok('a permission rejection is retryable, not terminal', isPermanentFailure(403, 200) === false);
  ok('code 200 is Meta\'s permission code', META_PERMISSION_ERROR_CODE === 200);
  ok('it is retryable whatever the HTTP status', [400, 403, 401, 500].every((s) => !isPermanentFailure(s, 200)));
  ok('a string code from JSON is handled too', isPermanentFailure(403, '200') === false);
  ok('isAuthFailure covers both credential codes', isAuthFailure(190) && isAuthFailure(200));

  // Everything Meta refuses on the post's own merits is still terminal, unchanged.
  ok('a content rejection is still permanent', isPermanentFailure(400, 100) === true);
  ok('a 400 with no code at all is still permanent', isPermanentFailure(400, undefined) === true);
  ok('a 400 with a null code is still permanent', isPermanentFailure(400, null) === true);
  // Both credential codes must be matched exactly, never as a prefix or a substring of another.
  for (const c of [19, 1900, 1190, 90, 20, 2000, 1200, 2001])
    ok(`code ${c} is not mistaken for a credential code`, isPermanentFailure(400, c) === true);

  // Transient classes were already retryable and must stay that way.
  ok('a rate limit is still retryable', isPermanentFailure(429, 4) === false);
  ok('a server error is still retryable', isPermanentFailure(500, 2) === false);

  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  ok('the publisher uses the shared decision, not its own copy',
    /permanent: isPermanentFailure\(r\.status, err\.code\)/.test(pub)
    && !/permanent: r\.status === 400/.test(pub));
  ok('a retryable failure returns the row to pending', /status = \$\{out\.permanent \? 'failed' : 'pending'\}/.test(pub));

  // THE SAFEGUARDS THIS MUST NOT HAVE LOOSENED.
  ok('the attempt cap is still 3', /MAX_FB_ATTEMPTS = 3/.test(pub));
  // Anchored to the CALL SITE. postToPage is DECLARED earlier in the file, so comparing against the
  // declaration made both of these assertions vacuously false.
  const callSite = pub.indexOf('await postToPage(cfg, cur.message');
  ok('the attempt cap is still enforced before contacting Meta',
    pub.indexOf('attempts exhausted') < callSite);
  ok('the freshness window is still 30 minutes', /MAX_AGE_MINUTES = 30/.test(pub));
  ok('the drain still applies it', /created_at > now\(\) - \(\$\{MAX_AGE_MINUTES\}/.test(pub));
  ok('publishing state is still set before the request',
    pub.indexOf("status = 'publishing'") < callSite);
  ok('a row left mid-publish is still never auto-retried', /left mid-publish, needs manual review/.test(pub));
  ok('the provenance gate is still terminal', /return \{ sent: false, reason: 'provenance: ' \+ why, permanent: true \}/.test(pub));
}

section('16. an auth outage holds posts, it does not spend their budget');
{
  ok('a credential failure does not spend an attempt', failureSpendsAttempt(190) === false);
  ok('a string code from JSON behaves the same', failureSpendsAttempt('190') === false);
  ok('isAuthFailure agrees', isAuthFailure(190) && isAuthFailure('190'));
  // A permission failure is a credential failure: it will fail identically on every attempt until
  // the token is replaced, so spending the budget on it kills the post for a reason that is not
  // about the post.
  ok('a permission failure does not spend one either', failureSpendsAttempt(200) === false);
  ok('a string code from JSON behaves the same', failureSpendsAttempt('200') === false);
  // Everything else still spends one. This is the budget the 3-attempt cap protects.
  for (const c of [100, 4, 2, 1, 368, 506, 1487390, 19, 90, 1190, 1900, 20, 2000, null, undefined])
    ok(`code ${c} still spends an attempt`, failureSpendsAttempt(c) === true);
  ok('a transport failure with no code spends one', failureSpendsAttempt(undefined) === true);

  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  const fn = pub.slice(pub.indexOf('export async function publishFacebookCandidate'),
                       pub.indexOf('export const MAX_FB_ATTEMPTS'));
  ok('the attempt is still taken BEFORE the request',
    fn.indexOf('attempts = attempts + 1') < fn.indexOf('await postToPage(cfg, cur.message'),
    'crash safety depends on this ordering');
  ok('it is given back only after Meta answers',
    fn.indexOf('await postToPage(cfg, cur.message') < fn.indexOf('failureSpendsAttempt(out.code)'));
  ok('the rollback cannot go negative', /greatest\(attempts - 1, 0\)/.test(fn));
  ok('an ordinary failure leaves the count alone', /\? sql`attempts`/.test(fn));
  ok('the publisher asks the shared rule, not its own copy', /failureSpendsAttempt\(out\.code\)/.test(fn));
  ok('Meta\'s error code reaches the caller', /code: err\.code \?\? null/.test(pub));

  // The freshness window is what bounds an auth retry. It must be untouched, and it is the ONLY
  // thing standing between "held" and "retried forever".
  ok('the window still bounds every retry', /MAX_AGE_MINUTES = 30/.test(pub)
    && /created_at > now\(\) - \(\$\{MAX_AGE_MINUTES\}/.test(pub));
  ok('nothing widened the drain selection',
    /status = 'pending' and fb_post_id is null/.test(pub));
  ok('the 3-attempt cap is still checked before Meta is contacted',
    pub.indexOf('attempts exhausted') < pub.indexOf('await postToPage(cfg, cur.message'));
  ok('MAX_FB_ATTEMPTS is still 3', /MAX_FB_ATTEMPTS = 3/.test(pub));
  ok('a row left mid-publish is still never auto-retried', /left mid-publish, needs manual review/.test(pub));
  ok('content rejections are still terminal', isPermanentFailure(400, 100) === true);
  ok('permission rejections are held, not destroyed', isPermanentFailure(403, 200) === false);
}

section('15b. a credential outage is loud, and leaks nothing');
{
  // THE FAILURE THAT HID THIS. The drain answered 200 OK for 40 minutes while every post was being
  // refused, so no run looked failed and nothing alerted.
  const route = await readFile(new URL('../src/app/api/cron/facebook/route.js', import.meta.url), 'utf8');
  ok('an auth outage answers 5xx so the cron run is marked failed',
    /credentialAlarm: true/.test(route) && /status: 503/.test(route));
  ok('the alarm reports health alongside the counts', /facebookAuthHealth\(\)/.test(route));
  ok('per-candidate failure text is dropped from the alarm body',
    /const \{ results, \.\.\.counts \} = res/.test(route));

  // Meta echoes the submitted token inside "Malformed access token" errors, and postToPage stores
  // that string in failure_reason, which is persisted AND returned. Unredacted, one such rejection
  // writes a live credential into the database.
  const TOKEN = 'EAA' + 'b'.repeat(180);
  const echoed = `Malformed access token ${TOKEN} is not valid`;
  ok('an echoed token is stripped', !redactCredential(echoed).includes(TOKEN));
  ok('the surrounding message stays readable', /Malformed access token/.test(redactCredential(echoed)));
  ok('a long credential-like run is stripped too',
    !redactCredential('tok ' + 'A1b2'.repeat(20)).includes('A1b2A1b2'));
  ok('ordinary Meta prose is untouched',
    redactCredential('(#200) If posting to a group, requires pages_manage_posts permission')
      === '(#200) If posting to a group, requires pages_manage_posts permission');
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  ok('the publisher redacts BEFORE storing the reason',
    /redactCredential\(err\.message\)\.slice/.test(pub));
  ok('credential health counts permission failures as well as expiry',
    /code 200/.test(pub) && /code 190/.test(pub));
}

section('17. credential health is observable without exposing anything');
{
  const pub = await readFile(new URL('../src/lib/facebook-publisher.js', import.meta.url), 'utf8');
  const fn = pub.slice(pub.indexOf('export async function facebookAuthHealth'),
                       pub.indexOf('export function facebookStatus'));
  ok('it exists', fn.length > 200);
  ok('it counts auth failures since the last success', /code 190/.test(fn) && /last_ok/.test(fn));
  ok('it reports a single healthy/unhealthy verdict', /credentialHealthy/.test(fn));
  ok('it returns counts and timestamps only, never the failure text',
    !/failure_reason\s*[,:]/.test(fn.split('return {')[1] || ''));
  ok('it reads no credential at all', !/process\.env/.test(fn) && !/cfg\.token/.test(fn));
  ok('it adds no publishing path', !/postToPage|fetchImpl|graph\.facebook/.test(fn));
  ok('it creates no new table', !/CREATE TABLE/i.test(fn));

  const run = pub.slice(pub.indexOf('export async function publishPendingFacebook'));
  ok('a run surfaces auth failures in the log', /CREDENTIAL FAILURE/.test(run));
  ok('the log line carries no credential',
    !/cfg\.token|access_token|process\.env/.test(run.slice(0, run.indexOf('return {'))));
  ok('the run result counts them', /authFailures/.test(run));

  const route = await readFile(new URL('../src/app/api/cron/facebook/route.js', import.meta.url), 'utf8');
  ok('status=1 reports credential health', /facebookAuthHealth\(\)/.test(route));
  ok('the route still returns no token', !/access_token|cfg\.token/.test(route));
  ok('the route is still authenticated', /Unauthorized/.test(route) && /x-vercel-cron/.test(route));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
