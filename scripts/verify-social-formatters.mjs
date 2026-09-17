// Instagram and Threads formatting, decided before either account exists.
//
// Pure: no database, no network, no credentials, no Meta configuration. These are the editorial and
// platform-limit rules from the Instagram/Threads investigation, pinned so that when the accounts are
// connected the only new risk is the HTTP call itself.
//
// Run: node scripts/verify-social-formatters.mjs

import {
  threadsText, threadsEligibility, threadsConfig, threadsReadiness, threadsPublishPlan,
  utf8Length, THREADS_MAX_CHARS,
} from '../src/lib/social/threads-post.mjs';
import {
  instagramCaption, instagramEligibility, instagramConfig, instagramReadiness, instagramPublishPlan,
  validateInstagramImage, isPublicMediaUrl, countHashtags, countAtTags,
  IG_HASHTAGS, IG_CAPTION_MAX_CHARS,
} from '../src/lib/social/instagram-post.mjs';
import { normalizeSocialText, hasInvisibleCharacters } from '../src/lib/social/social-text.mjs';
import { facebookText, facebookEligibility } from '../src/lib/facebook-post.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// A canonical event in the shape the publishers see it: Catalyst wording, market subject.
const ev = (over = {}) => ({
  seq: 1,
  headline: 'Fed holds interest rates steady at 4.25% as inflation cools',
  headline_status: 'composed',
  source: 'FINANCIALJUICE',
  tickers: [],
  ...over,
});
const CARD = { url: 'https://blob.catalystpit.com/cards/1.jpg', contentType: 'image/jpeg', bytes: 240_000, width: 1080, height: 1080 };
const NEW_CANON = { isNew: true, isCanonical: true };

console.log('\n=== normalisation strips what renders as nothing and changes no word ===');
{
  const nbsp = String.fromCharCode(0xa0), zwsp = String.fromCharCode(0x200b), bom = String.fromCharCode(0xfeff);
  ok('non-breaking space becomes an ordinary space',
    normalizeSocialText(`Fed${nbsp}holds rates`) === 'Fed holds rates');
  ok('zero-width characters are removed',
    normalizeSocialText(`Fed${zwsp}holds${bom} rates`) === 'Fedholds rates');
  ok('the tripwire sees them', hasInvisibleCharacters(`a${zwsp}b`) && !hasInvisibleCharacters('ab'));
  ok('CRLF collapses to a newline', normalizeSocialText('a\r\nb') === 'a\nb');
  ok('three or more newlines collapse to two', normalizeSocialText('a\n\n\n\nb') === 'a\n\nb');
  ok('runs of spaces collapse', normalizeSocialText('Fed   holds    rates') === 'Fed holds rates');
  ok('leading and trailing whitespace goes', normalizeSocialText('  Fed holds rates \n') === 'Fed holds rates');
  // The one thing normalisation must never do.
  const figures = 'Fed holds rates at 4.25%, down 25 bps from 4.50%';
  ok('figures, units and punctuation survive untouched', normalizeSocialText(figures) === figures);
}

console.log('\n=== Threads: our sentence, nothing added ===');
{
  const t = threadsText(ev());
  ok('the canonical headline is what publishes', /Fed holds interest rates steady at 4\.25%/i.test(t), t);
  ok('no emoji is ever introduced', !/\p{Extended_Pictographic}/u.test(t), t);
  ok('no hashtag block on Threads', !t.includes('#'), t);
  ok('no link in the copy',
    !/https?:\/\//.test(threadsText(ev({ headline: 'Fed holds rates steady https://example.com/story' }))));
  ok('an empty headline yields nothing to post', threadsText(ev({ headline: '   ' })) === null);
  ok('a headline that is only a link yields nothing to post',
    threadsText(ev({ headline: 'https://example.com/story' })) === null);
}

console.log('\n=== Threads: the gates ===');
{
  const cases = [
    ['a new canonical event with our wording publishes', ev(), NEW_CANON, true, null],
    ['a duplicate folded into an existing event does not', ev(), { isNew: true, isCanonical: false }, false, /duplicate/],
    ['a row that is not new does not', ev(), { isNew: false, isCanonical: true }, false, /not a new row/],
    ['an event the scan did not qualify does not', ev(), { ...NEW_CANON, qualifies: false }, false, /does not qualify/],
    ['pending wording WAITS', ev({ headline_status: 'pending' }), NEW_CANON, false, /awaiting Catalyst wording/],
    ['rewrite_pending WAITS', ev({ headline_status: 'rewrite_pending' }), NEW_CANON, false, /awaiting Catalyst wording/],
    // The two statuses that mean "we gave up rewriting": the publisher's own words. Never ours to post.
    ['not_required is not Catalyst wording', ev({ headline_status: 'not_required' }), NEW_CANON, false, /awaiting Catalyst wording/],
    ['source_fallback is not Catalyst wording', ev({ headline_status: 'source_fallback' }), NEW_CANON, false, /awaiting Catalyst wording/],
    ['original wording publishes', ev({ headline_status: 'original' }), NEW_CANON, true, null],
    ['an off-topic story does not', ev({ headline: 'Left-wing parties win narrow Swedish national election victory' }), NEW_CANON, false, /off topic/],
    ['a story with no market subject does not', ev({ headline: 'Man walks dog across the park in the morning' }), NEW_CANON, false, /no market or economic subject/],
    ['a stub is too short to be a story', ev({ headline: 'Fed cut' }), NEW_CANON, false, /too short/],
  ];
  for (const [name, event, opts, want, reasonRe] of cases) {
    const r = threadsEligibility(event, opts);
    ok(name, r.eligible === want && (want || reasonRe.test(r.reason)), JSON.stringify(r));
  }
}

console.log('\n=== Threads: 500 characters, and never a truncated headline ===');
{
  ok('UTF-8 length counts multibyte characters as their bytes', utf8Length('EUR ' + String.fromCharCode(0x20ac)) === 7);
  const long = 'Fed holds interest rates steady as inflation cools further across the economy. '.repeat(7);
  ok('the oversize fixture really is oversize', utf8Length(long) > THREADS_MAX_CHARS, String(utf8Length(long)));
  const r = threadsEligibility(ev({ headline: long }), NEW_CANON);
  ok('an oversize line is SKIPPED, not cut', r.eligible === false && /too long/.test(r.reason), JSON.stringify(r));
  ok('the formatter still returns the whole line, uncut', utf8Length(threadsText(ev({ headline: long }))) > THREADS_MAX_CHARS);
  // Right at the boundary, it publishes.
  const fits = 'Fed holds rates steady. ' + 'Inflation cools across the economy again. '.repeat(10);
  const trimmed = fits.slice(0, 480);
  ok('a line inside the limit publishes',
    threadsEligibility(ev({ headline: trimmed }), NEW_CANON).eligible === true);
}

console.log('\n=== Instagram: caption ===');
{
  const cap = instagramCaption(ev());
  ok('the caption carries the canonical sentence', cap.includes('Fed holds interest rates steady'), cap);
  ok('the standing hashtag block is present and fixed', IG_HASHTAGS.every((h) => cap.includes(h)), cap);
  ok('the block is the same on every post',
    instagramCaption(ev({ headline: 'Oil prices climb as OPEC extends output cut' })).endsWith(IG_HASHTAGS.join(' ')));
  ok('no emoji is ever introduced', !/\p{Extended_Pictographic}/u.test(cap), cap);
  ok('a caption link is stripped',
    !/https?:\/\//.test(instagramCaption(ev({ headline: 'Oil climbs as OPEC extends cuts https://example.com/x' }))));
  ok('hashtags stay far under Meta\'s 30', countHashtags(cap) === 4, String(countHashtags(cap)));
  ok('no @ tags are ever added', countAtTags(cap) === 0);
  // The story outranks the tags when space runs out.
  const huge = 'Fed holds interest rates steady as inflation cools across the economy. '.repeat(32)
    + 'Policymakers signal no further move before the June meeting.';
  const hugeCap = instagramCaption(ev({ headline: huge }));
  ok('the oversize fixture really is over the ceiling', huge.length > IG_CAPTION_MAX_CHARS, String(huge.length));
  ok('the hashtag block is dropped when it will not fit', !hugeCap.includes(IG_HASHTAGS[0]), String(hugeCap.length));
  // THE POINT: dropping tags is allowed, cutting the story is not. The last clause must survive.
  ok('the end of the story is never cut off',
    hugeCap.includes('before the June meeting'), hugeCap.slice(-60));
  ok('and a caption that still cannot fit is skipped, not truncated',
    /caption too long/.test(instagramEligibility(ev({ headline: huge }), { ...NEW_CANON, image: CARD }).reason));
}

console.log('\n=== Instagram: Meta media rules ===');
{
  ok('a square 1080 JPEG card passes', validateInstagramImage(CARD).ok);
  const bad = [
    ['PNG is rejected — the API takes JPEG only', { ...CARD, contentType: 'image/png' }, /JPEG/],
    ['over 8MB is rejected', { ...CARD, bytes: 9 * 1024 * 1024 }, /size/],
    ['zero bytes is rejected', { ...CARD, bytes: 0 }, /size/],
    ['too narrow is rejected', { ...CARD, width: 319, height: 319 }, /width/],
    ['too wide is rejected', { ...CARD, width: 1441, height: 1441 }, /width/],
    ['taller than 4:5 is rejected', { ...CARD, width: 800, height: 1400 }, /aspect/],
    ['wider than 1.91:1 is rejected', { ...CARD, width: 1440, height: 600 }, /aspect/],
    ['missing dimensions are rejected', { ...CARD, width: undefined, height: undefined }, /width and height/],
  ];
  for (const [name, img, re] of bad) {
    const v = validateInstagramImage(img);
    ok(name, !v.ok && v.problems.some((p) => re.test(p)), JSON.stringify(v.problems));
  }
  ok('the boundary sizes are allowed', validateInstagramImage({ ...CARD, width: 320, height: 320 }).ok
    && validateInstagramImage({ ...CARD, width: 1440, height: 1440 }).ok);
  ok('every problem is reported at once, not just the first',
    validateInstagramImage({ contentType: 'image/png', bytes: 0, width: 10, height: 900 }).problems.length >= 3);
}

console.log('\n=== Instagram: the media URL Meta has to fetch ===');
{
  ok('a public https URL is fine', isPublicMediaUrl('https://blob.catalystpit.com/cards/1.jpg'));
  for (const u of ['http://blob.catalystpit.com/1.jpg', 'https://localhost/1.jpg', 'https://127.0.0.1/1.jpg',
    'https://192.168.1.4/1.jpg', 'https://10.0.0.2/1.jpg', 'data:image/jpeg;base64,AAAA', 'not a url', '']) {
    ok(`rejected: ${u || '(empty)'}`, !isPublicMediaUrl(u));
  }
}

console.log('\n=== Instagram: the gates ===');
{
  ok('a new canonical event with our wording and a card publishes',
    instagramEligibility(ev(), { ...NEW_CANON, image: CARD }).eligible === true);
  const cases = [
    ['no card yet is a WAIT, not a rejection', { ...NEW_CANON, image: null }, /awaiting card render/],
    ['a card Meta cannot fetch is refused', { ...NEW_CANON, image: { ...CARD, url: 'http://localhost/1.jpg' } }, /publicly fetchable/],
    ['a card that breaks the media rules is refused', { ...NEW_CANON, image: { ...CARD, contentType: 'image/png' } }, /media rules/],
    ['a duplicate is refused before any render', { isNew: true, isCanonical: false, image: CARD }, /duplicate/],
  ];
  for (const [name, opts, re] of cases) {
    const r = instagramEligibility(ev(), opts);
    ok(name, r.eligible === false && re.test(r.reason), JSON.stringify(r));
  }
  ok('wording is checked BEFORE the card, so no image is rendered for a pending headline',
    /awaiting Catalyst wording/.test(instagramEligibility(ev({ headline_status: 'pending' }), { ...NEW_CANON, image: null }).reason));
  ok('an off-topic story never reaches the renderer',
    /off topic/.test(instagramEligibility(ev({ headline: 'Rep. Mace demands public execution' }), { ...NEW_CANON, image: CARD }).reason));
}

console.log('\n=== configuration fails closed ===');
{
  for (const [name, env, want] of [
    ['absent means off', {}, false],
    ['the literal string true enables', { THREADS_AUTO_POST_ENABLED: 'true' }, true],
    ['TRUE does not enable', { THREADS_AUTO_POST_ENABLED: 'TRUE' }, false],
    ['1 does not enable', { THREADS_AUTO_POST_ENABLED: '1' }, false],
    ['yes does not enable', { THREADS_AUTO_POST_ENABLED: 'yes' }, false],
  ]) ok(`Threads: ${name}`, threadsConfig(env).enabled === want);
  for (const [name, env, want] of [
    ['absent means off', {}, false],
    ['the literal string true enables', { INSTAGRAM_AUTO_POST_ENABLED: 'true' }, true],
    ['TRUE does not enable', { INSTAGRAM_AUTO_POST_ENABLED: 'TRUE' }, false],
  ]) ok(`Instagram: ${name}`, instagramConfig(env).enabled === want);

  ok('Threads is not ready without a user id', !threadsReadiness(threadsConfig({ THREADS_ACCESS_TOKEN: 'x' })).ready);
  ok('Threads is not ready without a token', !threadsReadiness(threadsConfig({ THREADS_USER_ID: '1' })).ready);
  ok('Threads is ready with both', threadsReadiness(threadsConfig({ THREADS_USER_ID: '1', THREADS_ACCESS_TOKEN: 'x' })).ready);
  // Enabled and ready are separate: the kill switch must be able to stop a fully configured account.
  ok('readiness does not imply enabled',
    threadsReadiness(threadsConfig({ THREADS_USER_ID: '1', THREADS_ACCESS_TOKEN: 'x' })).enabled === false);

  const igCfg = instagramConfig({ INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841400000000000', FACEBOOK_SYSTEM_USER_TOKEN: 'sys' });
  ok('Instagram rides the existing Facebook system-user credential',
    instagramReadiness(igCfg).ready && instagramReadiness(igCfg).credentialMode === 'system_user');
  ok('a page token alone also works',
    instagramReadiness(instagramConfig({ INSTAGRAM_BUSINESS_ACCOUNT_ID: '1', FACEBOOK_PAGE_ACCESS_TOKEN: 'p' })).ready);
  ok('no credential is not ready',
    !instagramReadiness(instagramConfig({ INSTAGRAM_BUSINESS_ACCOUNT_ID: '1' })).ready);
  ok('the graph version is inherited from the Facebook setting',
    instagramConfig({ FACEBOOK_GRAPH_VERSION: 'v27.0' }).graphVersion === 'v27.0');
}

console.log('\n=== the call sequences, as data ===');
{
  const t = threadsPublishPlan({ userId: '999', text: 'Fed holds rates steady' });
  ok('Threads creates a container on graph.threads.net',
    t.createContainer.url === 'https://graph.threads.net/v1.0/999/threads', t.createContainer.url);
  ok('a text post declares media_type TEXT', t.createContainer.body.media_type === 'TEXT');
  ok('Threads publishes through threads_publish',
    t.publish.url === 'https://graph.threads.net/v1.0/999/threads_publish', t.publish.url);
  ok('Meta\'s recommended container wait is carried, not guessed', t.recommendedWaitMs === 30_000);

  const i = instagramPublishPlan({ igUserId: '178414', imageUrl: CARD.url, caption: 'x' });
  ok('Instagram creates a media container',
    i.createContainer.url === 'https://graph.facebook.com/v26.0/178414/media', i.createContainer.url);
  ok('the container carries image_url and caption',
    i.createContainer.body.image_url === CARD.url && i.createContainer.body.caption === 'x');
  ok('publishing is a separate call', i.publish.url === 'https://graph.facebook.com/v26.0/178414/media_publish');
  ok('the status poll waits for FINISHED and stops on ERROR or EXPIRED',
    i.checkStatus.readyWhen === 'FINISHED' && i.checkStatus.terminal.includes('EXPIRED'));
  ok('Meta\'s published rate limits are carried',
    i.containerExpiryHours === 24 && i.postsPer24h === 100 && i.containersPer24h === 400);
}

console.log('\n=== one story, one wording: the platforms must not diverge ===');
{
  const e = ev();
  const fb = facebookText(e), th = threadsText(e), ig = instagramCaption(e);
  const core = (s) => String(s).split('\n')[0].trim();
  ok('Facebook, Threads and Instagram publish the SAME sentence',
    core(fb) === core(th) && core(th) === core(ig), JSON.stringify({ fb: core(fb), th: core(th), ig: core(ig) }));
  // The gate that caused the Standard Chartered miss must behave identically everywhere.
  const pending = ev({ headline_status: 'pending' });
  ok('every platform waits for Catalyst wording, none of them publishes the publisher\'s line',
    facebookEligibility(pending, NEW_CANON).eligible === false
    && threadsEligibility(pending, NEW_CANON).eligible === false
    && instagramEligibility(pending, { ...NEW_CANON, image: CARD }).eligible === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
