// X AUTO-REPLY: the gates that keep Catalyst Pit's name off the wrong post and out of bot territory.
//
// Run: node scripts/verify-x-reply.mjs

import { replyEligibility, validateReply, replyConfig, selectForReply,
  REPLY_WHITELIST, MIN_REPLY_CHARS, HARD_MAX_CHARS } from '../src/lib/x-reply.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

const FACTS = { tickers: ['NVDA'], lastClose: { date: '2026-09-12', close: 180.25 }, priorEvents: [{ headline: 'x', d: '1' }] };
const EV = { source: 'WALTERBLOOMBERG', x_post_id: '1', tickers: ['NVDA'],
  source_headline: 'NVIDIA SHARES FALL 4% PREMARKET AFTER GUIDANCE', importance: 3 };

section('1. whitelist — Walter only, for now');
ok('Walter is whitelisted', REPLY_WHITELIST.has('WALTERBLOOMBERG'));
ok('only one account', REPLY_WHITELIST.size === 1);
for (const s of ['FINANCIALJUICE', 'BREAKINGMARKETNEWS', 'GLOBENEWSWIRE', 'SEC', 'NEWSFILE'])
  ok(`${s} is not`, !replyEligibility({ ...EV, source: s }, FACTS).eligible);

section('2. the original X post id is mandatory');
ok('no id -> no reply', !replyEligibility({ ...EV, x_post_id: null }, FACTS).eligible);
ok('reason names it', /X post id/.test(replyEligibility({ ...EV, x_post_id: null }, FACTS).reason));
ok('a Catalyst Pit event id is not an X id',
  !replyEligibility({ ...EV, x_post_id: null, seq: 12345 }, FACTS).eligible);
ok('with an id it passes', replyEligibility(EV, FACTS).eligible);

section('3. selectivity');
ok('no internal facts -> skip', !replyEligibility(EV, { tickers: [] }).eligible);
ok('agenda post -> skip',
  !replyEligibility({ ...EV, source_headline: 'WHAT TO WATCH TODAY: 8:15 AM ET ADP, 8:30 AM ET Empire State, 11:30 AM ET auction' }, FACTS).eligible);
ok('three clock times is an agenda whatever it is called',
  !replyEligibility({ ...EV, source_headline: 'US MARKETS 8:15 AM ADP 8:30 AM Empire 11:30 AM auction reopening today' }, FACTS).eligible);
ok('attributed opinion -> skip',
  !replyEligibility({ ...EV, source_headline: "KREMLIN: WE THINK TRUMP'S PROPOSAL IS A GOOD IDEA" }, FACTS).eligible);
ok('a short fragment -> skip', !replyEligibility({ ...EV, source_headline: 'OIL UP' }, FACTS).eligible);

section('4. validation — style');
const V = (t) => validateReply(t, EV, FACTS);
const GOOD = 'NVDA last closed at 180.25 and the move retraces most of the post-guidance gain from the prior session.';
ok('a grounded factual reply passes', V(GOOD).valid, V(GOOD).reason);
for (const [t, why] of [
  ['Great point, NVDA is definitely one to watch here as the semis move lower today.', 'engagement'],
  ['Interesting move. Investors will be watching how the semis trade into the close today.', 'engagement'],
  ['NVDA closed at 180.25 yesterday 🚀 and the move retraces the post-guidance gain entirely.', 'emoji'],
  ['NVDA closed at 180.25 yesterday #semis and the move retraces the post-guidance gain here.', 'hashtag'],
  ['NVDA closed at 180.25 yesterday — the move retraces the post-guidance gain from last session.', 'em dash'],
  ['NVDA closed at 180.25 yesterday, see catalystpit.com for the full breakdown of the move today.', 'url'],
  ['According to Bloomberg, NVDA closed at 180.25 and the move retraces the post-guidance gain.', 'attribution'],
  ['NVDA closed at 180.25 yesterday. Does this change the setup into earnings for the group?', 'question'],
  ['NVDA closed at 180.25 and looks like a buy here with a price target well above that level.', 'advice'],
]) ok(`rejects ${why}`, !V(t).valid, 'accepted: ' + t.slice(0, 40));

section('5. validation — grounding');
ok('rejects an invented number',
  !V('NVDA fell 3.9% since Friday, extending the slide from its 180.25 close.').valid);
ok('accepts a number from the facts', V(GOOD).valid);
ok('accepts a number from the post itself',
  V('The 4% premarket move puts NVDA below its 180.25 close from the prior session by a wide margin.').valid);
ok('rejects an unsupported ticker',
  !V('NVDA and $AMD both closed lower, with NVDA last at 180.25 in the prior session.').valid);
ok('rejects a malformed cashtag',
  !V('$NVDA1234567 last closed at 180.25, retracing the post-guidance gain from the prior day.').valid);
ok('rejects restating the post',
  !V('NVIDIA shares fall 4% premarket after guidance, a notable premarket decline for NVIDIA shares.').valid);

section('6. validation — length');
ok('too short is rejected', !V('NVDA closed at 180.25.').valid);
ok('too long is rejected', !V('NVDA last closed at 180.25. '.repeat(20)).valid);
ok(`hard max is under X's limit`, HARD_MAX_CHARS <= 260 && MIN_REPLY_CHARS >= 40);

section('7. no repetition across recent replies');
ok('a near-duplicate of a recent reply is rejected',
  !validateReply(GOOD, EV, FACTS, [GOOD]).valid);
ok('an unrelated reply is fine',
  validateReply('Insider selling at NVDA totalled three disposals in the last ninety days of filings.',
    EV, { ...FACTS, insider: [1, 2, 3] }, [GOOD]).valid);

section('8. kill switch and rate control');
const base = { lastReplyAt: null, sentToday: 0, config: replyConfig({ X_AUTO_REPLY_ENABLED: 'true', X_AUTO_REPLY_WALTER_ENABLED: 'true' }) };
ok('defaults are conservative', base.config.minIntervalMs === 300000 && base.config.dailyCap === 20);
ok('unset master switch disables', !replyConfig({}).enabled);
ok('an empty value disables', !replyConfig({ X_AUTO_REPLY_ENABLED: '' }).enabled);
ok('"1" does not enable it', !replyConfig({ X_AUTO_REPLY_ENABLED: '1' }).enabled);
ok('"TRUE" does not enable it', !replyConfig({ X_AUTO_REPLY_ENABLED: 'TRUE' }).enabled);
ok('only exactly "true" enables', replyConfig({ X_AUTO_REPLY_ENABLED: 'true' }).enabled);
const cands = [{ seq: 1, importance: 1, tickers: [], published_at: '2026-01-01' },
                { seq: 2, importance: 3, tickers: ['NVDA'], published_at: '2026-01-01' }];
ok('kill switch stops everything',
  selectForReply(cands, { ...base, config: replyConfig({}) }).pick === null);
ok('Walter switch is separate',
  selectForReply(cands, { ...base, config: replyConfig({ X_AUTO_REPLY_ENABLED: 'true' }) }).pick === null);
ok('daily cap stops it', selectForReply(cands, { ...base, sentToday: 20 }).pick === null);
ok('cooldown stops it',
  selectForReply(cands, { ...base, lastReplyAt: new Date(Date.now() - 60000) }).pick === null);
ok('inside a burst it picks the highest value, not the first',
  selectForReply(cands, base).pick?.seq === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
