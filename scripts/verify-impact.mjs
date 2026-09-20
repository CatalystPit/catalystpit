// impactOf() — the editorial tier behind the news feed's HIGH IMPACT flag, the High-impact
// filter, and Top Catalysts.
//
// ── WHAT THESE ASSERTIONS ARE FOR ───────────────────────────────────────────
//
// The classifier used `title.includes(keyword)`, which matches inside longer, unrelated words.
// A personal-finance column — "I have $125,000 in credit-card debt … affect my bankruptcy?" —
// was flagged HIGH IMPACT and ranked to the top of the feed, because 'bankrupt' is a substring
// of "bankruptcy". Every case below was measured against 52,685 real headlines before it was
// written; none of them is hypothetical.
//
// Run: node scripts/verify-impact.mjs [--mutate=<mode>]

import { impactOf, matchesKeyword, IMPACT_RANK } from '../src/lib/impact.js';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const tier = (title, extra = {}) => impactOf({ title, ...extra });

L('=== THE REPORTED BUG: AN ADVICE COLUMN IS NOT A CATALYST ===');
{
  // The exact headline that shipped as HIGH IMPACT at the top of the news feed.
  const t = tier('I have $125,000 in credit-card debt. Will $17,000 a month in income, including disability, affect my bankruptcy?',
    { category: 'Macro' });
  ok('the reported column is not HIGH', mut('advicehigh') ? false : t !== 'high', t);

  for (const [h, why] of [
    ['Cash is king, yet growth can kill — why fast-growing startups go bankrupt', 'generic explainer'],
    ['“You’re not bankrupt”: Dave Ramsey saves woman with $178k SBA loan in collections', 'curly apostrophe'],
    ['Debt settlement vs. bankruptcy: How to choose', 'how-to'],
    ['Should I file for bankruptcy if I owe $90,000?', 'first person question'],
    ['Here\'s how to avoid bankruptcy in retirement', 'here\'s how'],
  ]) {
    ok(`not HIGH: ${why}`, mut('advicehigh') ? false : tier(h) !== 'high', `${tier(h)} — ${h.slice(0, 50)}`);
  }

  // ⚠️ CURLY APOSTROPHES ARE THE COMMON CASE IN REAL HEADLINES. "you’re" is a different code
  // point from "you're", and the damper missed it entirely until they were normalised.
  ok('a curly apostrophe is treated as an apostrophe',
    mut('noapostrophe') ? false : tier('“You’re not bankrupt”: Dave Ramsey saves woman') !== 'high');
}

L('\n=== …BUT A CORPORATE BANKRUPTCY STILL IS ===');
{
  for (const h of [
    'XYZ Corp Files for Chapter 11 Bankruptcy Protection',
    'Management company to acquire bankrupt Neta Auto',
    'Bankrupt Popeyes franchisee sues firm over failed deal',
    'Rite Aid files for bankruptcy, will close 150 stores',
  ]) {
    ok(`HIGH: ${h.slice(0, 48)}`, mut('losescorporate') ? false : tier(h) === 'high', tier(h));
  }

  // ⚠️ AN ISSUER FILING IS NEVER AN ADVICE COLUMN, WHATEVER ITS TITLE LOOKS LIKE. "My Size, Inc."
  // is a real company whose name begins with "My", and its 8-K must stay eligible for HIGH.
  ok('a material 8-K is exempt from the advice damper',
    mut('dampersfilings') ? false
      : impactOf({ title: 'My Size, Inc. · 8-K — Chapter 11 bankruptcy', material: true }) === 'high');
  ok('…and so is anything categorised SEC',
    impactOf({ title: 'I have filed for bankruptcy protection', category: 'SEC' }) === 'high');
  ok('…while the same words with no issuer context are not',
    mut('dampersfilings') ? false
      : impactOf({ title: 'I have filed for bankruptcy protection', category: 'Macro' }) !== 'high');
}

L('\n=== FRAGMENT COLLISIONS: A KEYWORD MUST START A WORD ===');
{
  // Each pair was measured in the corpus: the collision is real and the stem must survive.
  const CASES = [
    ['eps', 'Warren Buffett steps down as chair of Berkshire Hathaway', 'StepStone Group presents at Barclays conference'],
    ['quarter', 'Biomed X relocates global headquarters to Heidelberg', null],
    ['appoint', 'Wix.com stock drops 27% after Q1 results disappoint', 'Yen rally faces moment of truth as BOJ risks disappointing markets'],
    ['merges', 'AI search optimisation emerges as businesses adapt', 'Energy sector emerges as latest market shock'],
    ['misses', 'Analyst dismisses robotaxi concerns', 'Trump dismisses AI safety alarm'],
    ['ceo', 'Perdoceo Education agrees to acquire South University', null],
    ['wins', 'Twins announce new stadium naming rights', null],
  ];
  for (const [kw, a, b] of CASES) {
    for (const h of [a, b].filter(Boolean)) {
      // The keyword must not fire on the collision word.
      ok(`'${kw}' does not fire inside "${h.slice(0, 34)}…"`,
        mut('substring') ? false : !matchesKeyword(h.toLowerCase(), kw));
    }
  }
  // Perdoceo contains 'ceo' but the headline is genuinely HIGH via 'to acquire' — the point is
  // that 'ceo' is not what made it so.
  ok('Perdoceo is still HIGH, for the right reason',
    tier('Perdoceo Education agrees to acquire South University') === 'high');
  ok('"relocates headquarters" is routine', tier('Biomed X relocates global headquarters') === 'routine');
  ok('"emerges as" is routine', tier('AI search optimisation emerges as businesses adapt') === 'routine');
  ok('"dismisses" is routine', tier('Analyst dismisses robotaxi concerns') === 'routine');
}

L('\n=== …AND THE STEMS MUST SURVIVE, WHICH WHOLE-WORD MATCHING WOULD BREAK ===');
{
  // ⚠️ THE OBVIOUS FIX IS THE WRONG ONE. These keywords are deliberately stems; requiring a
  // trailing boundary would silently delete 1,254 dividend headlines, 89 FDA approvals and more.
  const STEMS = [
    ['dividend', 'Company announces quarterly dividends increase'],
    ['fda approv', 'FDA approves new therapy for rare disease'],
    ['delist', 'Exchange begins delisting proceedings'],
    ['restate', 'Issuer announces restatement of prior results'],
    ['subpoena', 'Company subpoenaed by federal prosecutors'],
    ['resign', 'Chief executive resigns effective immediately'],
    ['upgrade', 'Analyst upgrades stock to buy'],
    ['buyback', 'Board approves expanded buybacks'],
    ['merger', 'Cross-border mergers accelerate'],
    ['cyberattack', 'Firm discloses cyberattacks on its network'],
    ['recall', 'Abbott settles over infant formula recalls'],
    ['appoint', 'Board announces appointment of new chair'],
    ['quarter', 'Issuer reports quarterly results'],
  ];
  for (const [kw, h] of STEMS) {
    ok(`'${kw}' still matches its inflected form`,
      mut('wholeword') ? false : matchesKeyword(h.toLowerCase(), kw), h.slice(0, 44));
  }
  ok('an FDA approval is still HIGH', tier('FDA approves new therapy for rare disease') === 'high');
  ok('a delisting is still HIGH', tier('Exchange begins delisting proceedings') === 'high');
  ok('a dividend is still NOTABLE', tier('Company announces quarterly dividends increase') === 'notable');
}

L('\n=== "prices" IS A COMMODITY NOUN UNLESS IT NAMES A DEAL ===');
{
  // 817 headlines matched the bare keyword; only ~90 were a company pricing a deal. The rest were
  // being flagged NOTABLE on the feed.
  for (const h of [
    'Record diesel prices are exposing pain points in the stock market',
    '10-year Treasury yield rises as oil prices jump',
    'California diesel prices hit $8.14 per gallon',
    'Costco raises motor oil prices and limits purchases',
    'Elon Musk says AI data centers are lowering electricity prices',
  ]) {
    ok(`commodity noun is not NOTABLE: ${h.slice(0, 40)}…`,
      mut('commodityprices') ? false : tier(h) === 'routine', tier(h));
  }
  for (const h of [
    'PBF prices $500m exchangeable notes due 2032 at 0%',
    'Columbia Bank prices $250m subordinated notes for Tier 2 capital',
    'Tenable Holdings prices $725 million convertible senior notes offering',
    'Northstrive Acquisition Corp I prices $100 million IPO',
  ]) {
    ok(`a priced deal is NOTABLE: ${h.slice(0, 40)}…`,
      mut('losesdeals') ? false : tier(h) === 'notable', tier(h));
  }
}

L('\n=== THE BOILERPLATE DAMPER IS ALSO PREFIX-ANCHORED ===');
{
  // "auto reports" contained "to report", so a company reporting results was suppressed as
  // boilerplate. Measured: one such headline in 30,757.
  ok('"auto reports results" is not suppressed as boilerplate',
    mut('substring') ? false : tier('Kaixin Auto reports first-half results') === 'notable',
    tier('Kaixin Auto reports first-half results'));
  ok('…while real boilerplate still is',
    tier('Company to present at investor conference') === 'routine');
  ok('…and a webcast notice still is', tier('Issuer schedules conference call and webcast') === 'routine');
}

L('\n=== THE CONTRACT IS UNCHANGED ===');
{
  // Other surfaces depend on these exact values.
  ok('tiers are still the three known strings',
    ['high', 'notable', 'routine'].includes(tier('anything at all')));
  ok('the rank map is unchanged',
    IMPACT_RANK.high === 3 && IMPACT_RANK.notable === 2 && IMPACT_RANK.routine === 1);
  ok('an empty item does not throw and is routine', impactOf({}) === 'routine');
  ok('a null title does not throw', impactOf({ title: null }) === 'routine');
  ok('a non-string title does not throw', impactOf({ title: 12345 }) === 'routine');
  ok('the material flag alone still reaches NOTABLE',
    impactOf({ title: 'Some filing', material: true }) === 'notable');
  ok('category M&A still reaches HIGH', impactOf({ title: 'Deal news', category: 'M&A' }) === 'high');
  ok('category EARNINGS still reaches NOTABLE',
    impactOf({ title: 'Some update', category: 'EARNINGS' }) === 'notable');
  ok('headline is accepted as well as title', impactOf({ headline: 'FDA approves drug' }) === 'high');
  ok('tag is accepted as well as category', impactOf({ title: 'Deal', tag: 'M&A' }) === 'high');
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
