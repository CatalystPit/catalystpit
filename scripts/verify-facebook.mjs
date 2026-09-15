// WALTER -> FACEBOOK: the gates that stop the wrong thing reaching a public Page.
//
// Run: node scripts/verify-facebook.mjs

import { readFile } from 'node:fs/promises';
import { facebookText, facebookEligibility, facebookConfig, facebookReadiness,
  FB_SOURCE_WHITELIST, FB_MAX_CHARS } from '../src/lib/facebook-post.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

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

section('3. the text is Walter verbatim, never our rewrite');
{
  const t = facebookText(WALTER);
  ok('uses source_headline, not the Catalyst Pit headline', t === WALTER.source_headline);
  ok('does NOT use the rewritten display headline', t !== WALTER.headline);
  ok('keeps the leading asterisk', t.startsWith('*'));
  ok('keeps the channel watermark', /\(@WalterBloomberg\)/.test(t));
  ok('adds no hashtag', !/#/.test(t));
  ok('adds no URL', !/https?:\/\//.test(t));
  ok('adds no Catalyst Pit wording', !/catalyst ?pit/i.test(t));
  ok('adds no ticker', !/\$[A-Z]{1,5}\b/.test(t));
  // Falls back to the canonical headline only when there is no source text at all.
  ok('falls back when source text is missing',
    facebookText({ headline: 'X', source_headline: '' }) === 'X');
  ok('no text at all yields null', facebookText({}) === null);
}

section('4. transport normalisation only');
for (const [raw, want, why] of [
  ['A\r\nB', 'A\nB', 'CRLF becomes LF'],
  ['A B', 'A B', 'non-breaking space'],
  ['A​B', 'AB', 'zero-width space removed'],
  ['  A  ', 'A', 'trimmed'],
  ['A\n\n\n\n B', 'A\n\n B', 'blank-line runs collapsed'],
]) ok(why, facebookText({ source_headline: raw }) === want, JSON.stringify(facebookText({ source_headline: raw })));
ok('word order and punctuation untouched',
  facebookText({ source_headline: 'WTI climbed 1% to $102.40, holding near recent highs.' })
  === 'WTI climbed 1% to $102.40, holding near recent highs.');

section('5. length bounds — skip, never truncate');
ok('an overlong post is skipped', !facebookEligibility(
  { ...WALTER, source_headline: 'x'.repeat(FB_MAX_CHARS + 1) }, LIVE).eligible);
ok('it is not truncated instead',
  facebookText({ source_headline: 'x'.repeat(FB_MAX_CHARS + 1) }).length === FB_MAX_CHARS + 1);
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
  ok('the token is sent in the body, not the URL', /access_token: cfg\.token/.test(pub) && !/access_token=\$\{/.test(pub));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
