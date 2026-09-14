// The six structural defects the first editorial review of the dry run exposed. Each one is pinned
// with the real example that exposed it.
// Run: node scripts/verify-x-editorial.mjs

import { buildCandidate, evaluate, supportingClause, tooVagueToPost } from '../src/lib/x-autopost.mjs';
import { publicationVerdict } from '../src/lib/x-quality.mjs';
import { storyVerdict, isPricePrint, instrumentOf, printLevel } from '../src/lib/x-story.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const AT = '2026-09-14T05:00:00Z';
const NOW = Date.parse('2026-09-14T05:10:00Z');
const base = (o = {}) => ({ headline_status: 'composed', sources: ['FINANCIALJUICE'], published_at: AT,
  tickers: [], importance: 3, ...o });
const build = (o, priors = []) => buildCandidate(base(o), null, NOW, priors);

console.log('\n=== 1. not_required is not a permanent exile ===');
// 46 of 233 events over 72h were exchange halts, every one permanently ineligible.
const halt = { headline: 'XYZ halted, news pending', headline_status: 'not_required', source_type: 'halt', tickers: ['XYZ'] };
ok('an exchange halt is eligible', evaluate(base(halt)).eligible);
ok('...with its own reason', evaluate(base(halt)).reason === 'exchange halt');
ok('a publisher fragment is still NOT eligible',
  !evaluate(base({ headline_status: 'rewrite_pending' })).eligible);
ok('SEC is still never eligible', !evaluate(base({ source_kind: 'sec' })).eligible);

console.log('\n=== 2. halts are judged, not flooded ===');
ok('a routine LULD pause on a micro-cap is suppressed',
  build({ ...halt, headline: 'RFAI halted, volatility pause (LULD)', tickers: ['RFAI'] }).suppressed === 'routine volatility pause');
ok('...but the same pause on a large cap publishes',
  build({ ...halt, headline: 'AAPL halted, volatility pause (LULD)', tickers: ['AAPL'], market_cap: 3.2e12 }).publishable);
ok('a news-pending halt publishes', build(halt).publishable);
ok('...and is BREAKING, because news is pending', build(halt).breaking === true);
ok('a routine pause is never BREAKING',
  build({ ...halt, headline: 'AAPL halted, volatility pause (LULD)', tickers: ['AAPL'], market_cap: 3.2e12 }).breaking === false);
ok('the exchange separator and reason code are cleaned up',
  build({ ...halt, headline: 'AAPL halted · Volatility pause (LULD)', tickers: ['AAPL'], market_cap: 3.2e12 }).text
    === '$AAPL: halted, volatility pause');
ok('a halt with no symbol cannot post',
  build({ ...halt, tickers: [] }).suppressed === 'halt with no resolved symbol');

console.log('\n=== 3. facts the event holds are not thrown away ===');
const saudi = { headline: 'Saudi Arabia shuts East-West pipeline after drone damage',
  summary: 'The kingdom said drones fired from Iraq damaged the East-West pipeline, which can carry up to 7 million barrels of oil a day.' };
ok('the capacity figure is carried into the post', /7 million barrels/.test(build(saudi).text), build(saudi).text);
ok('...verbatim from the source, not paraphrased',
  saudi.summary.toLowerCase().includes(supportingClause(saudi.headline, saudi.summary)));
ok('a figure already in the headline is not repeated',
  supportingClause('Brent rises to $108', 'Brent rose to $108 on supply fears') === null);
ok('attribution and opinion are never appended',
  supportingClause('X happens', 'Analysts said the move could add 5% to prices') === null);
// A clause WITH its own subject is safe to append: it cannot re-attach to the headline's noun.
ok('a self-standing clause is appended',
  supportingClause('Houthis seize islands', 'Rebels hold an artery carrying 12 million barrels a day')
    === 'rebels hold an artery carrying 12 million barrels a day');
// A bare participle would attach to the wrong noun — "islands; carrying 12 million barrels" says
// the islands carry the barrels, which is not what the source said.
ok('an appended clause never starts on a bare participle',
  !/^(?:carrying|affecting|covering|supplying|handling|representing)\b/i.test(
    supportingClause('Houthis seize islands', 'The rebels advanced; carrying 12 million barrels a day matters') || ''));

console.log('\n=== 4. a price print is one story per instrument ===');
ok('a price print is recognised', isPricePrint('Brent crude reaches $108 after Saudi pipeline shutdown'));
ok('an event that merely names a price is not',
  !isPricePrint('Saudi Arabia shuts East-West pipeline after drone damage'));
ok('brent and crude are one instrument',
  instrumentOf('Brent crude rises 3.5%') === instrumentOf('Crude rises 3% following shutdown'));
ok('the level is read, not the percentage', printLevel('Brent crude rises 3.5% to $108.23') === 108.23);
const priorOil = [{ headline: 'Brent crude rises 3.5% to $108.23 on Middle East strike concerns',
  created_at: '2026-09-13T23:03:00Z', story_key: 'price:oil' }];
const same = storyVerdict({ headline: 'Brent crude reaches $108 after Saudi pipeline shutdown' }, priorOil, NOW);
ok('the same level six hours later does NOT post', !same.post, same.reason);
ok('...for the right reason', /price unchanged/.test(same.reason || ''), same.reason);
const moved = storyVerdict({ headline: 'Brent crude jumps to $119.40 after refinery strike' }, priorOil, NOW);
ok('a real move DOES post', moved.post);
ok('both are keyed on the instrument', same.storyKey === 'price:oil' && moved.storyKey === 'price:oil');

console.log('\n=== 5. BREAKING means new ===');
ok('a consequence piece is not BREAKING',
  build({ headline: 'Saudi pipeline outage threatens to raise gas prices further' }).breaking === false);
ok('a restatement is not BREAKING',
  build({ headline: 'NextEra Energy reaffirms 2026 earnings guidance and merger timeline', tickers: ['NEE'] }).breaking === false);
ok('a price update is not BREAKING',
  build({ headline: 'Brent crude reaches $112.40 after refinery strike' }).breaking === false);
// A follow-up carrying a genuinely new figure still publishes — it just is not "BREAKING".
ok('a follow-up on a told story is not BREAKING',
  build({ headline: 'Saudi Arabia halts a second pipeline, cutting 12% of exports' },
    [{ headline: 'Saudi Arabia shuts East-West pipeline after drone damage', created_at: '2026-09-13T20:00:00Z' }]).breaking === false);
ok('a genuinely new event IS BREAKING', build(saudi).breaking === true);
ok('a definitive public-company deal IS BREAKING',
  build({ headline: 'Kyndryl to acquire Healthcare IT Leaders', tickers: ['KD'] }).breaking === true);

console.log('\n=== 6. never the weaker sentence ===');
// When the figure CAN be attached the post is enriched rather than dropped — that is the better
// outcome and the first thing to check.
ok('a figure the event holds is carried instead of dropped',
  /12 million barrels/.test(build({ headline: 'Houthis seize Red Sea islands in offensive',
    summary: 'Rebels now hold an artery carrying 12 million barrels a day' }).text || ''));
// When it cannot be attached safely, publishing the bare headline would be the weaker sentence.
ok('a featureless post is suppressed when the event held a figure it could not carry',
  build({ headline: 'Houthis seize Red Sea islands in offensive',
    summary: 'Analysts said the seizure could affect 12 million barrels a day, according to sources' }).suppressed
    === 'less informative than the event it came from');
ok('...but the same headline publishes when nothing more exists',
  build({ headline: 'Houthis seize Red Sea islands in offensive' }).publishable);
ok('a named security is never called featureless', !tooVagueToPost('$KD Kyndryl to acquire X', { hasTicker: true, unusedContext: true }));
ok('a halt is never called featureless', !tooVagueToPost('$XYZ halted', { isHalt: true, unusedContext: true }));

console.log('\n=== gates that must NOT have loosened ===');
ok('speculation still suppressed', !build({ headline: 'Acme considers acquiring Beta', tickers: ['ACM'] }).publishable);
ok('truncated wording still suppressed', !build({ headline: 'Acme agrees to acquire Beta for…', tickers: ['ACM'] }).publishable);
ok('non-English still suppressed', !build({ headline: 'SÍL 2 hs. - ákvörðun vaxta og almenn upplýsingagjöf' }).publishable);
ok('a taxonomy label is never a cashtag',
  !/\$MACRO/.test(build({ headline: 'US 6-Month Bill High Yield: 4.06% vs 3.97% previous', tickers: ['MACRO'] }).text || ''));
ok('stale events still suppressed',
  buildCandidate(base(saudi), null, Date.parse('2026-09-14T09:00:00Z'), []).suppressed === 'stale');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
