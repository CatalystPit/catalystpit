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

import fs from 'node:fs';
import { impactOf, matchesKeyword, IMPACT_RANK, rankByImpact, isHeroWorthy, deskSelection, DESK_SLOTS,
  composeRiver, filingTier, isFilingStory, isNewsDesk, hasDeskSubstance,
  EXCEPTIONAL_FILING_LABELS, ROUTINE_FILING_LABELS, rankCurrentFirst } from '../src/lib/impact.js';

const fsRead = (p) => fs.readFileSync(new URL(p, new URL('..', import.meta.url)), 'utf8');

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

L('\n=== …BUT A BANKRUPTCY AT A LISTED ISSUER STILL IS ===');
{
  // ⚠️ THE TICKER IS NOW HALF THE TEST. The keyword says WHAT happened; the ticker says it
  // happened to a company someone can act on.
  for (const [h, tk] of [
    ['XYZ Corp Files for Chapter 11 Bankruptcy Protection', 'XYZ'],
    ['Management company to acquire bankrupt Neta Auto', 'NETA'],
    ['Bankrupt Popeyes franchisee sues firm over failed deal', 'QSR'],
    ['Rite Aid files for bankruptcy, will close 150 stores', 'RAD'],
  ]) {
    ok(`HIGH with a ticker: ${h.slice(0, 44)}`,
      mut('losescorporate') ? false : impactOf({ title: h, ticker: tk }) === 'high',
      impactOf({ title: h, ticker: tk }));
  }

  // ⚠️ AN ISSUER FILING IS NEVER AN ADVICE COLUMN, WHATEVER ITS TITLE LOOKS LIKE. "My Size, Inc."
  // is a real company whose name begins with "My", and its 8-K must stay eligible for HIGH.
  ok('a material 8-K is exempt from the advice damper',
    mut('dampersfilings') ? false
      : impactOf({ title: 'My Size, Inc. · 8-K — Chapter 11 bankruptcy', material: true, ticker: 'MYSZ' }) === 'high');
  ok('…and so is anything categorised SEC',
    impactOf({ title: 'I have filed for bankruptcy protection', category: 'SEC', ticker: 'ABC' }) === 'high');
  ok('…while the same words with no issuer context are not',
    mut('dampersfilings') ? false
      : impactOf({ title: 'I have filed for bankruptcy protection', category: 'Macro' }) !== 'high');

  // 8-K item classes the ticket named, each with a resolved issuer.
  for (const [label, tk] of [
    ['Delisting / listing-standard notice', 'ABCD'],
    ['Material agreement', 'ABCD'],
    ['Officer / director change', 'ABCD'],
    ['Results of operations', 'ABCD'],
    ['Non-reliance on prior financials', 'ABCD'],
  ]) {
    ok(`8-K "${label}" is HIGH`,
      mut('losesfilings') ? false
        : impactOf({ title: `${tk} · ${label}`, ticker: tk, material: true, category: label }) === 'high');
  }
}

L('\n=== NO TICKER AND NOT A MACRO PRINT IS NOT HIGH IMPACT ===');
{
  // The headline that led the public feed: an M&A-tagged fundraising pitch for a basketball
  // franchise. No listed issuer, no filing, nothing anyone can trade.
  const lakers = { title: 'Lakers Buyers Lay Out Plans to Reach $30 Billion Valuation in Pitch', category: 'M&A', source: 'WSJ' };
  ok('the Lakers valuation pitch is NOT HIGH',
    mut('tickerless') ? false : impactOf(lakers) !== 'high', impactOf(lakers));

  for (const [h, cat, why] of [
    ['Knicks stake sale draws private equity interest', 'M&A', 'franchise stake'],
    ['Premier League club valuation tops $5 billion', 'M&A', 'football club'],
    ['Rosen Law Firm Encourages Barclays PLC Investors to Inquire About Securities Class Action', 'SEC', 'law firm solicitation'],
    ['Le Guide MICHELIN dévoile sa sélection 2026', 'Markets', 'lifestyle'],
    ['Tourism board named best destination of the year', 'Markets', 'tourism award'],
  ]) {
    const got = impactOf({ title: h, category: cat });
    ok(`NOT HIGH (${why})`, mut('tickerless') ? false : got !== 'high', `${got} — ${h.slice(0, 44)}`);
  }

  // ⚠️ SUPPRESSING ONLY `high` IS NOT ENOUGH, AND THIS IS THE ASSERTION THAT PROVES IT.
  //
  // The first attempt left advice and the never-list at NOTABLE. Both the Lakers story and the
  // credit-card column fell to NOTABLE together, and among equals the pool's own order wins — so
  // the live feed simply swapped one piece of junk for another and the column led the page again.
  // They have to land at routine, where they stay visible under All but cannot rank.
  ok('the Lakers story does not merely drop a tier — it drops out of ranking',
    mut('demoteonly') ? false : impactOf(lakers) === 'routine', impactOf(lakers));
  ok('…and neither does the advice column rank',
    mut('demoteonly') ? false
      : tier('I have $125,000 in credit-card debt. Will $17,000 affect my bankruptcy?') === 'routine');
  ok('…while ordinary news with no ticker is still NOTABLE, not suppressed',
    impactOf({ title: 'Nvidia-Backed Cloud Startup Nscale Files for IPO', category: 'IPO' }) === 'notable');

  // The same words WITH a resolved issuer are a real event again.
  ok('…while a real issuer deal with a ticker is HIGH',
    impactOf({ title: 'Acquirer to acquire TargetCo', category: 'M&A', ticker: 'TGTC' }) === 'high');

  // A placeholder is not a resolved ticker — 'NONE' must not unlock HIGH.
  for (const bad of ['NONE', 'N/A', '', '(CALX)', 'NYSE: VTEX']) {
    ok(`ticker "${bad}" does not unlock HIGH`,
      mut('placeholderticker') ? false
        : impactOf({ title: 'Company to acquire rival', category: 'M&A', ticker: bad }) !== 'high');
  }
}

L('\n=== A SCHEDULED MACRO PRINT IS HIGH WITHOUT A TICKER ===');
{
  for (const [h, cat] of [
    ['FOMC holds rates steady, signals one cut in 2026', 'FED'],
    ['FOMC minutes show split over timing of cuts', 'FED'],
    ['CPI rises 0.3% in August, above expectations', 'MACRO'],
    ['Consumer price index cools to 2.4% year over year', 'MACRO'],
    ['NFP: economy adds 180,000 jobs in August', 'MACRO'],
    ['Jobs report shows unemployment rate at 4.1%', 'MACRO'],
  ]) {
    ok(`macro print is HIGH: ${h.slice(0, 40)}`,
      mut('nomacro') ? false : impactOf({ title: h, category: cat }) === 'high',
      impactOf({ title: h, category: cat }));
  }

  // ⚠️ IT MUST BE TAGGED MACRO. The word "inflation" in a lifestyle piece is not a print, and a
  // FED-tagged opinion column is not one either.
  ok('an untagged mention of CPI is not a print',
    mut('anymacro') ? false : impactOf({ title: 'CPI rises 0.3% in August', category: 'Markets' }) !== 'high');
  ok('a FED-tagged feature with no print is not HIGH',
    impactOf({ title: "Don't Count Out Corporate Bonds Just Because the Fed Is Raising Rates", category: 'FED' }) !== 'high');
  ok('…and an advice column about rates is not HIGH',
    impactOf({ title: 'Here\'s how to prepare your portfolio for the Fed\'s next move', category: 'FED' }) !== 'high');
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
    impactOf({ title: 'Perdoceo Education agrees to acquire South University', ticker: 'PRDO' }) === 'high');
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
  ok('an FDA approval is still HIGH',
    impactOf({ title: 'FDA approves new therapy for rare disease', ticker: 'BIIB' }) === 'high');
  ok('a delisting is still HIGH',
    impactOf({ title: 'Exchange begins delisting proceedings', ticker: 'ABCD' }) === 'high');
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
  ok('category M&A reaches HIGH only with an issuer',
    impactOf({ title: 'Deal news', category: 'M&A', ticker: 'ABCD' }) === 'high'
    && impactOf({ title: 'Deal news', category: 'M&A' }) !== 'high');
  ok('category EARNINGS still reaches NOTABLE',
    impactOf({ title: 'Some update', category: 'EARNINGS' }) === 'notable');
  ok('headline is accepted as well as title',
    impactOf({ headline: 'FDA approves drug', ticker: 'BIIB' }) === 'high');
  ok('tag is accepted as well as category',
    impactOf({ title: 'Deal', tag: 'M&A', ticker: 'ABCD' }) === 'high');
  ok('sym and symbol are accepted as the ticker too',
    impactOf({ title: 'FDA approves drug', sym: 'BIIB' }) === 'high'
    && impactOf({ title: 'FDA approves drug', symbol: 'BIIB' }) === 'high');
}

L('\n=== THE FRONT DOOR RANKS BY THE SAME RULE AS THE NEWS PAGE ===');
{
  // The pool the homepage actually had on the day this was written: two pieces of junk, some
  // tickerless features, and real filings underneath.
  const pool = [
    { headline: 'I have $125,000 in credit-card debt. Will $17,000 affect my bankruptcy?', tag: 'MACRO' },
    { headline: 'Lakers Buyers Lay Out Plans to Reach $30 Billion Valuation', tag: 'M&A' },
    { headline: 'Nvidia-Backed Cloud Startup Nscale Files for IPO', tag: 'IPO' },
    { headline: 'INM · Delisting risk', tag: 'SEC', sym: 'INM', material: true },
    { headline: 'Minutes of the Federal Open Market Committee', tag: 'MACRO' },
  ];
  const ranked = rankByImpact(pool);

  // ⚠️ THE TICKET'S CORE REQUIREMENT: neither piece of junk may lead while an 8-K HIGH exists.
  ok('an 8-K HIGH item leads the homepage pool',
    mut('herojunk') ? false : ['INM · Delisting risk', 'Minutes of the Federal Open Market Committee']
      .includes(ranked[0].headline), ranked[0].headline);
  ok('…the advice column is not first',
    mut('herojunk') ? false : !/credit-card/.test(ranked[0].headline));
  ok('…the Lakers feature is not first',
    mut('herojunk') ? false : !/Lakers/.test(ranked[0].headline));
  const posAdvice = ranked.findIndex((r) => /credit-card/.test(r.headline));
  const posLakers = ranked.findIndex((r) => /Lakers/.test(r.headline));
  const posReal = ranked.findIndex((r) => /Nscale/.test(r.headline));
  ok('advice ranks below ordinary market news', posAdvice > posReal, `advice@${posAdvice} news@${posReal}`);
  ok('the Lakers feature ranks below ordinary market news', posLakers > posReal);

  // Stability: equal tiers keep their arrival order, so this is a re-rank and not a re-shuffle.
  const twoNotable = rankByImpact([
    { headline: 'Nscale Files for IPO', tag: 'IPO' },
    { headline: 'Bond Yields Could Come Down', tag: 'FED' },
  ]);
  ok('equal tiers keep their original order',
    mut('unstable') ? false : twoNotable[0].headline === 'Nscale Files for IPO');

  // isHeroWorthy is the gate the homepage uses to decide whether to show a hero at all.
  ok('a routine item is never hero-worthy',
    mut('heroroutine') ? false
      : !isHeroWorthy({ headline: 'I have $125,000 in credit-card debt… my bankruptcy?', tag: 'MACRO' }));
  ok('…nor is a sports-franchise feature',
    mut('heroroutine') ? false
      : !isHeroWorthy({ headline: 'Lakers Buyers Lay Out Plans to Reach $30 Billion Valuation', tag: 'M&A' }));
  ok('an 8-K filing is hero-worthy', isHeroWorthy({ headline: 'INM · Delisting risk', sym: 'INM', material: true }));
  ok('a macro print is hero-worthy',
    isHeroWorthy({ headline: 'Minutes of the Federal Open Market Committee', tag: 'MACRO' }));
  // ⚠️ NOTABLE IS NO LONGER ENOUGH FOR THE FRONT DOOR. A well-reported tickerless feature keeps
  // its place in the news river; the hero is reserved for a material issuer event or a scheduled
  // macro print, because the hero is the page saying "this is what matters today".
  ok('ordinary tickerless market news is NOT hero-worthy',
    mut('heroroutine') ? false
      : !isHeroWorthy({ headline: 'Nvidia-Backed Cloud Startup Nscale Files for IPO', tag: 'IPO' }));
}

L('\n=== THE FOUR-UP IS FOUR CLAIMS, NOT ONE CLAIM AND THREE SPACERS ===');
{
  const JUNK = [
    { headline: 'I have $125,000 in credit-card debt. Will $17,000 affect my bankruptcy?', tag: 'MACRO' },
    { headline: "'My total balance should be $20 million': I invested $1.1 million in crypto", tag: 'CRYPTO' },
    { headline: 'Lakers Buyers Lay Out Plans to Reach $30 Billion Valuation', tag: 'M&A' },
    { headline: "Don't Count Out Corporate Bonds Just Because the Fed Is Raising Rates", tag: 'FED' },
    { headline: 'Le Guide MICHELIN dévoile sa sélection 2026', tag: 'MARKETS' },
  ];
  const FILINGS = [
    { headline: 'INM · Delisting risk', tag: 'SEC', sym: 'INM', material: true, imageUrl: null },
    { headline: 'CACC · Material agreement', tag: 'SEC', sym: 'CACC', material: true, imageUrl: null },
    { headline: 'DAKT · Exec / board change', tag: 'SEC', sym: 'DAKT', material: true, imageUrl: null },
    { headline: 'RIV · Material agreement', tag: 'SEC', sym: 'RIV', material: true, imageUrl: null },
    { headline: 'BCBP · Material agreement', tag: 'SEC', sym: 'BCBP', material: true, imageUrl: null },
  ];

  // ⚠️ THE TICKET'S CORE REQUIREMENT. With filings available, no junk may occupy ANY slot —
  // hero or supporting — and the four-up must not be padded to look full.
  const withFilings = deskSelection(JUNK, FILINGS);
  ok('with an 8-K HIGH available, nothing routine is selected',
    mut('padsjunk') ? false : withFilings.items.every((n) => impactOf(n) === 'high'),
    withFilings.items.map((n) => impactOf(n)).join(','));
  ok('…not in the hero', mut('padsjunk') ? false : !/credit-card|Lakers|crypto/i.test(withFilings.items[0]?.headline || ''));
  ok('…and not in any supporting tile',
    mut('padsjunk') ? false
      : !withFilings.items.slice(1).some((n) => /credit-card|Lakers|crypto|MICHELIN/i.test(n.headline)));
  ok('…the module is labelled as filings', withFilings.leadingWithFilings === true);
  ok('…and it is capped at four', withFilings.items.length <= DESK_SLOTS);
  ok('…with no borrowed photograph on any card',
    mut('borrowsimage') ? false : withFilings.items.every((n) => !n.imageUrl));

  // ⚠️ NEVER PAD. Three real filings and a gap is a true page; four slots of advice is not.
  const thin = deskSelection(JUNK, FILINGS.slice(0, 2));
  ok('two filings produce two cards, not four',
    mut('padsjunk') ? false : thin.items.length === 2, String(thin.items.length));
  ok('…and the gap is never filled with a repeat',
    new Set(thin.items.map((n) => n.headline)).size === thin.items.length);

  // A genuine HIGH story outranks the filings floor and is used directly.
  const withReal = deskSelection([
    ...JUNK,
    { headline: 'Minutes of the Federal Open Market Committee', tag: 'MACRO' },
  ], FILINGS);
  ok('a real macro print is used instead of the filings floor',
    withReal.items[0].headline === 'Minutes of the Federal Open Market Committee');
  ok('…and the module is NOT labelled as filings', withReal.leadingWithFilings === false);
  // ⚠️ THIS ASSERTION USED TO READ `items.length === 1`, AND THAT PROXY IS NOW WRONG — NOT
  // BECAUSE THE OUTPUT MOVED, BUT BECAUSE THE PRODUCT RULE DID.
  //
  // It stood for "nothing junk was added beside the macro print", and measured it by counting: the
  // old waterfall could only ever return the HIGH story tier on its own, so one qualifying story
  // meant one card. A material 8-K may no longer outrank financial reporting, but a GENUINELY
  // EXCEPTIONAL one — a bankruptcy, a delisting, a restatement — still competes for the lead on its
  // own importance, so INM's delisting notice now sits beside the FOMC minutes and the count is two.
  //
  // The intent is asserted directly instead of through the count, which makes it strictly stronger
  // than what it replaces: name the junk and require its absence, name the routine filings and
  // require their absence too, and state the two items that are allowed to be there.
  const realHeads = withReal.items.map((n) => n.headline);
  ok('…while the junk still cannot fill the remaining tiles',
    mut('padsjunk') ? false
      : !realHeads.some((h) => /credit-card|Lakers|crypto|MICHELIN|Corporate Bonds/i.test(h)),
    realHeads.join(' | '));
  ok('…nor can a routine material 8-K take a tile beside real reporting',
    mut('padsjunk') ? false
      : !realHeads.some((h) => /Material agreement|Exec \/ board change/i.test(h)),
    realHeads.join(' | '));
  ok('…and exactly the macro print and the exceptional filing are selected',
    mut('padsjunk') ? false
      : realHeads.length === 2 && /Delisting risk/.test(realHeads[1] || ''),
    realHeads.join(' | '));

  // Nothing at all is a real state, and the module has its own empty copy for it.
  const nothing = deskSelection(JUNK, []);
  ok('all-routine with no filings selects nothing at all',
    mut('padsjunk') ? false : nothing.items.length === 0);
  ok('…and does not claim to be showing filings', nothing.leadingWithFilings === false);

  // The render must honour the cap and never repeat.
  const home = fsRead('src/components/CatalystPit.jsx');
  // ⚠️ THE CAP SURVIVED; THE SLICE GREW AN OFFSET. The hero is now conditional — when nothing in the
  // pool is both high-impact and recent, nothing is promoted and the stories are drawn as equals —
  // so the supporting grid starts at 1 when there IS a hero and at 0 when there is not. The cap of
  // four (DESK_SLOTS) is unchanged, and what this assertion actually protects is that the grid never
  // re-renders the hero to fill space.
  ok('the render takes at most three supporting tiles under a hero',
    mut('rendercap') ? false : /news\.slice\(heroWorthy \? 1 : 0, 4\)/.test(home));
  ok('…and the hero itself is only rendered when one was earned',
    mut('rendercap') ? false : /\{heroWorthy && \(/.test(home));
  ok('…and the old padding expression is gone',
    mut('rendercap') ? false : !/news\[i % Math\.min/.test(home));
  ok('homepage story cards carry no publisher photograph',
    mut('borrowsimage') ? false : !/imageUrl:\s*s\.image_url/.test(home));
}

L('\n=== THE CONSENSUS TEASER READS THE CANONICAL ROW ===');
{
  // It printed "No active families" and a green 0 while /consensus showed the same ticker as a
  // cross-source conflict: it read r.normalised, a V2.1 field the V3.8 payload dropped, and
  // `(r.normalised || [])` turned a missing field into a confident zero.
  const teaser = fsRead('src/components/ConsensusTeaser.jsx');
  // Against the CODE: the file explains the bug in prose, and naming the dropped field in a
  // comment is the explanation, not a read of it.
  const teaserCode = teaser.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the teaser no longer reads the dropped V2.1 field',
    mut('staleschema') ? false : !/r\.normalised/.test(teaserCode));
  ok('…and names the setup the board itself named', /r\?\.setup\?\.label/.test(teaser));

  // ⚠️ "FAMILY" IS OUR WORD AND IT DOES NOT REACH THE HOMEPAGE. The row said "2 of 3 families
  // aligned" beside a large green "3 / FAMILIES" — internal vocabulary, and the least useful thing
  // in the widest part of the row. The MODEL is unchanged and still called families everywhere it
  // is computed, so this checks the rendered strings, not the field names the code reads.
  {
    const literals = [
      ...teaserCode.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g),                         // quoted strings
      ...teaserCode.matchAll(/>\s*([A-Za-z][^<>{}]*?)\s*</g),                     // bare JSX text
    ].map((m) => m[1] ?? m[2] ?? '').filter(Boolean);
    const leaked = literals.filter((s) => /famil/i.test(s));
    ok('⚠️ no rendered string on the teaser says "families"',
      mut('familyleak') ? false : leaked.length === 0, leaked.join(' | '));
    ok('…and the big FAMILIES number is gone from the right of the row',
      !/FAMILIES/.test(teaserCode) && !/familyCount/.test(teaserCode));
    ok('…and the EVIDENCE ALIGNMENT badge is gone from the header',
      !/EVIDENCE ALIGNMENT/.test(teaserCode));
  }

  // ⚠️ THE REASON IS QUOTED FROM THE ROW, NEVER COMPOSED HERE. Four canonical sources in descending
  // specificity, each returning a sentence the engine wrote.
  ok('the reason comes from canonical fields, in precedence order',
    /highSignificance/.test(teaserCode) && /setup\?\.reasons/.test(teaserCode)
    && /_significant/.test(teaserCode) && /driver\?\.headline/.test(teaserCode));
  // ⚠️ AND NOTHING IS CALLED ALIGNED THAT THE ROW DOES NOT SAY IS ALIGNED.
  ok('alignment is measured against the setup\'s own direction',
    mut('assumealigned') ? false
      : /pairs\.filter\(\(\[, d\]\) => d === dir\)/.test(teaserCode)
        && /agreeing\.length >= 3/.test(teaserCode));
  ok('…and a non-directional setup lists its sources without claiming agreement',
    /const active = name\(pairs\)/.test(teaserCode) && /dir === 'positive' \|\| dir === 'negative'/.test(teaserCode));
  // ⚠️ NO SUMMARY IS BETTER THAN A FALSE ONE.
  ok('a row carrying no canonical sentence shows no sentence',
    mut('confidentzero') ? false
      : /reasonFor/.test(teaserCode) && /return typeof headline === 'string' && headline\.trim\(\) \? headline\.trim\(\) : null/.test(teaserCode));
  ok('…and points at the board instead of inventing a count',
    /See the full board for this setup/.test(teaser));
  ok('the teaser still reads ONE board, not a second Consensus',
    (teaser.match(/fetch\('\/api\//g) || []).length === 1 && /api\/consensus-board/.test(teaser));
}

L('\n=== EVERY SURFACE CALLS THE SAME DESK ===');
{
  const read = (p) => fsRead(p);
  const snapshot = read('src/app/api/cron/pit-snapshot/route.js');
  const newsRoute = read('src/app/api/news/route.js');
  const home = read('src/components/CatalystPit.jsx');

  // ⚠️ RANK BEFORE SLICING. The cron kept the first 12 of an unranked list, and the homepage
  // renders element 0 as its hero.
  ok('the snapshot cron ranks before it slices',
    mut('unrankedsnapshot') ? false : /rankByImpact\(storiesRaw\)\.slice\(0, 12\)/.test(snapshot));
  ok('/api/news uses the shared desk', /rankByImpact\(/.test(newsRoute));
  ok('…and no longer carries its own sort',
    mut('twodesks') ? false : !/rankOf\(y\.a\) - rankOf\(x\.a\)/.test(newsRoute));
  ok('the homepage selects through the shared desk',
    mut('unrankedhome') ? false : /deskSelection\(rawNews, filingCards\)/.test(home));

  // The filings floor.
  ok('the homepage fetches canonical filings', /fetchFilings/.test(home));
  ok('…and falls back to them when nothing earns a hero',
    mut('nofloor') ? false : /leadingWithFilings/.test(home) && /fetchFilings/.test(home));
  ok('…labelling the module when it does', /8-K FILINGS/.test(home));
  // No publisher artwork is fetched or stored for a filing card.
  ok('filing cards carry no borrowed image',
    mut('borrowsimage') ? false : /imageUrl: null/.test(home));
  ok('…and every filing card names a renderable ticker',
    /filter\(\(f\) => isRenderableTicker\(f\?\.ticker\)\)/.test(home));
}

// ─── EVERY CONSUMER IMPORTS WHAT IT CALLS ───────────────────────────────────
//
// ⚠️ THIS SUITE HAD 139 GREEN ASSERTIONS WHILE /api/news RETURNED 500 ON EVERY REQUEST.
//
// 1d5ca543 replaced an inline rankOf/.sort() with rankByImpact() and did not update the import
// line, so the route called an identifier that was never bound. The throw sat outside the route's
// try/catch, so Next answered 500; the client did `r.ok ? r.json() : null`, so the page rendered
// "No stories match those filters" and the outage looked like an empty news day. It survived a
// deploy and a full suite run because every test here imports lib/impact DIRECTLY — nothing
// imported the route, so nothing ever evaluated its module scope.
//
// Testing impact.js harder would not have caught it: the bug was in a caller. So this checks the
// seam instead, across every consumer at once — for each file that imports from lib/impact, every
// exported name it USES must also be a name it IMPORTS. Cheap, static, and it fails on the whole
// class rather than on the one line that happened to break this time.
L('\n=== EVERY CONSUMER IMPORTS WHAT IT CALLS ===');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = new URL('../src/', import.meta.url);

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(js|jsx|mjs)$/.test(e.name) ? [p] : [];
  });

  // The exported names a caller could plausibly reference.
  const impactSrc = fs.readFileSync(new URL('lib/impact.js', ROOT), 'utf8');
  const EXPORTS = [...impactSrc.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
  ok('the impact module exports were discovered', EXPORTS.length >= 6, EXPORTS.join(', '));

  const files = walk(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'src'));
  let checked = 0, offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/impact(?:\.js)?['"]/.exec(raw);
    if (!imp) continue;                                   // not a consumer
    checked++;
    const imported = new Set(imp[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    // Strip comments and the import line itself — a name in prose is not a call.
    //
    // ⚠️ AND NORMALISE THE SPREAD. The first version of this check passed while the bug was still
    // in the tree — a false green, caught only by re-breaking the import on purpose. The real call
    // site is `[...rankByImpact(raw)]`, and the `(?<![.\w])` lookbehind below — there to reject
    // member access like `obj.rankByImpact()` — cannot tell the spread's dot from a property dot,
    // so it rejected the one line that mattered. Spreads become a space first.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(imp[0], '')
      .replace(/\.\.\./g, ' ');
    for (const name of EXPORTS) {
      // Used as a value: `name(` or `name` as a bare reference, not `.name` or `name:`.
      if (new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(code) && !imported.has(name)) {
        offenders.push(`${path.relative(process.cwd(), f)} calls ${name}() without importing it`);
      }
    }
  }
  ok('consumers of lib/impact were found to check', checked >= 3, `${checked} files import it`);
  ok('…and every one imports every impact function it calls',
    mut('unimported') ? false : offenders.length === 0, offenders.join(' | '));
}


// ════════════════════════════════════════════════════════════════════════════════════════════
// A MATERIAL 8-K IS NOT AUTOMATICALLY THE DAY'S LEAD
//
// THE REPORTED DEFECT, MEASURED ON PRODUCTION 2026-11-24 against /api/news?limit=200:
//
//   102 items: indices 0-39 were every one an SEC 8-K, and the first published article was
//   index 40. The homepage four-up was four 8-K cards. Composition, not classification:
//   41 of 41 filings scored 'high' while 0 of 61 articles did, and the route then ordered the
//   river by stacking the tiers — [...filings, ...curated, ...wire].
//
//   Filing labels in that sample: 16x Earnings, 10x Exec / board change, 9x Material agreement,
//   2x Delisting risk, 2x Security-holder rights, 1x Agreement terminated. Two of forty were
//   genuinely exceptional events; thirty-eight were material and scheduled or administrative.
// ════════════════════════════════════════════════════════════════════════════════════════════

L('\n=== EXCEPTIONAL VERSUS MERELY MATERIAL ===');
{
  const card = (label, extra = {}) => ({
    title: `ABCD · ${label}`, source: 'SEC 8-K', category: 'SEC', ticker: 'ABCD',
    material: true, secLabel: label, ...extra,
  });

  ok('a scheduled earnings 8-K is material, not exceptional',
    mut('everyfilingexceptional') ? false : filingTier(card('Earnings')) === 'material');
  ok('an officer change is material, not exceptional',
    mut('everyfilingexceptional') ? false : filingTier(card('Exec / board change')) === 'material');
  ok('a new material agreement is material, not exceptional',
    mut('everyfilingexceptional') ? false : filingTier(card('Material agreement')) === 'material');
  ok('a delisting notice IS exceptional', filingTier(card('Delisting risk')) === 'exceptional');
  ok('a bankruptcy IS exceptional', filingTier(card('Bankruptcy')) === 'exceptional');
  ok('a financial restatement IS exceptional', filingTier(card('Financial restatement')) === 'exceptional');

  // ⚠️ AN UNRECOGNISED LABEL MUST NOT PROMOTE ITSELF. A new SEC item code, or one this file has not
  // been taught, reaching the front page on the day it first appears is the failure mode of every
  // allowlist defaulted the wrong way round.
  ok('an unrecognised item label defaults to material, never exceptional',
    mut('unknownisexceptional') ? false : filingTier(card('Item 9.42')) === 'material');
  ok('…and so does a card with no label at all',
    filingTier({ title: 'ABCD', source: 'SEC 8-K', category: 'SEC', ticker: 'ABCD' }) === 'material');

  ok('a published article is not a filing at all',
    filingTier({ title: 'Nvidia rallies', source: 'WSJ' }) === null);
  ok('…and isFilingStory agrees',
    !isFilingStory({ title: 'Nvidia rallies', source: 'WSJ' }) && isFilingStory(card('Earnings')));

  // The label is a FIELD. The title split is the fallback for a card written before it existed.
  ok('the label is read from secLabel when present',
    filingTier({ ...card('Earnings'), secLabel: 'Bankruptcy' }) === 'exceptional');
  ok('…and falls back to the half of the headline after the separator',
    filingTier({ headline: 'ABCD · Delisting risk', tag: 'SEC', sym: 'ABCD', material: true }) === 'exceptional');
}

L('\n=== THE PARTITION IS THE SEC ITEM MAP, NOT A SECOND OPINION ===');
{
  // ⚠️ READ lib/eightk.js AND REQUIRE AGREEMENT. impact.js cannot import it — eightk opens a
  // database connection and impact.js ships in the client bundle — so the two tables are kept by
  // hand, and a hand-kept pair is how one of them becomes wrong. This is the bind.
  const ek = fsRead('src/lib/eightk.js');
  const map = ek.slice(ek.indexOf('const ITEM_MAP'), ek.indexOf('export function classifyItems'));
  const rows = [...map.matchAll(/'([^']+)':\s*\{\s*label:\s*'([^']+)',\s*material:\s*(true|false)\s*\}/g)]
    .map((m) => ({ code: m[1], label: m[2], material: m[3] === 'true' }));
  ok('the SEC item map was found and parsed', rows.length >= 30, `${rows.length} codes`);

  const materialLabels = rows.filter((r) => r.material).map((r) => r.label);
  const known = new Set([...EXCEPTIONAL_FILING_LABELS, ...ROUTINE_FILING_LABELS]);
  const unclassified = materialLabels.filter((l) => !known.has(l));
  ok('every material item label is classified exceptional or routine',
    mut('dropslabel') ? false : unclassified.length === 0, unclassified.join(', '));

  const both = [...EXCEPTIONAL_FILING_LABELS].filter((l) => ROUTINE_FILING_LABELS.has(l));
  ok('…and no label is in both sets', both.length === 0, both.join(', '));

  // An invented label is as bad as a missing one: a classification nothing can ever reach.
  const allLabels = new Set(rows.map((r) => r.label));
  const invented = [...known].filter((l) => !allLabels.has(l));
  ok('…and neither set invents a label the item map does not define',
    mut('inventslabel') ? false : invented.length === 0, invented.join(', '));

  // The one classification that is a product claim rather than bookkeeping: the rare, structural
  // events must be the MINORITY of material items, or "exceptional" means nothing.
  ok('exceptional is the minority of material item types',
    EXCEPTIONAL_FILING_LABELS.size < materialLabels.length,
    `${EXCEPTIONAL_FILING_LABELS.size} of ${materialLabels.length}`);
}

L('\n=== A NEWSROOM IS SUBSTANCE; A PRESS-RELEASE DISTRIBUTOR IS NOT ===');
{
  // ⚠️ THE TICKER TEST ALONE KILLED THE JOURNALISM TIER. Of 61 articles in the live pool, 22
  // reached 'notable' and ZERO of those 22 carried a resolvable ticker, so the tier could never
  // fire and the homepage fell through to filings on every single load.
  const ce = fsRead('src/lib/evidence/company-events.mjs');
  const grab = (name) => {
    const i = ce.indexOf(`export const ${name} = new Set([`);
    return [...ce.slice(i, ce.indexOf(']);', i)).matchAll(/'([A-Z0-9]+)'/g)].map((m) => m[1]);
  };
  const desk = grab('NEWS_DESK');
  const wires = grab('ISSUER_WIRE');
  ok('the repository taxonomy was found', desk.length >= 10 && wires.length >= 6,
    `${desk.length} desks / ${wires.length} wires`);

  const missing = desk.filter((d) => !isNewsDesk({ source: d }));
  ok('every NEWS_DESK source in the taxonomy is a news desk here',
    mut('narrowsdesk') ? false : missing.length === 0, missing.join(', '));

  const leaked = wires.filter((w) => isNewsDesk({ source: w }));
  ok('…and no press-release distributor is',
    mut('widensdesk') ? false : leaked.length === 0, leaked.join(', '));

  // The display names the feed actually carries, not the normalised codes.
  ok('the display names on the live tape resolve',
    ['WSJ', 'MarketWatch', 'Bloomberg'].every((x) => isNewsDesk({ source: x })));
  ok('…and the wire display names do not',
    !['PR Newswire', 'Business Wire', 'GlobeNewswire'].some((x) => isNewsDesk({ source: x })));
  ok('a long-form publisher name still resolves', isNewsDesk({ source: 'The Wall Street Journal' }));

  // Substance is EITHER test, so the ticker rule that existed before is not narrowed by this.
  ok('a resolved ticker is still substance on its own',
    hasDeskSubstance({ title: 'x', source: 'PR Newswire', ticker: 'NVDA' }));
  ok('…and a tickerless press release is not substance',
    mut('widensdesk') ? false : !hasDeskSubstance({ title: 'x', source: 'PR Newswire' }));
}

L('\n=== THE RIVER: REPORTING LEADS, THE FILINGS ARE THEIR OWN BLOCK ===');
{
  const iso = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const art = (n) => ({ title: `Report ${n}`, source: 'WSJ', category: 'MARKETS', published: iso(n) });
  const fil = (n, label, mins = 1) => ({
    title: `SYM${n} · ${label}`, source: 'SEC 8-K', category: 'SEC', ticker: `AB${n}`,
    material: true, secLabel: label, published: iso(mins),
  });

  const curated = [art(1), art(2), art(3)];
  const wire = [{ title: 'Company announces webcast', source: 'PR Newswire', category: 'MARKETS', published: iso(0) }];
  const routineFilings = Array.from({ length: 12 }, (_, i) => fil(i, 'Earnings'));

  const river = composeRiver({ curated, wire, filings: routineFilings });

  // ⚠️ THE EXACT REPORTED SYMPTOM, ASSERTED: the first item must be reporting, not a filing.
  ok('the river leads with reporting, not a filing',
    mut('filingslead') ? false : !isFilingStory(river[0]), String(river[0] && river[0].title));
  const firstFiling = river.findIndex(isFilingStory);
  ok('…and no filing appears before the reporting is exhausted',
    mut('filingslead') ? false : firstFiling >= curated.length, `first filing at ${firstFiling}`);
  ok('…nothing is dropped from any pool',
    river.length === curated.length + wire.length + routineFilings.length, String(river.length));
  ok('…the filings stay contiguous as one block', (() => {
    const idx = river.map((x, i) => (isFilingStory(x) ? i : -1)).filter((i) => i >= 0);
    return idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  })());
  ok('…and the press-release wire is still below the reporting',
    river.findIndex((x) => x.source === 'PR Newswire') > firstFiling);

  // Rule (A)'s carve-out, intact: a genuinely exceptional filing still leads on its own merit.
  const withExceptional = composeRiver({ curated, wire, filings: [...routineFilings, fil(99, 'Bankruptcy')] });
  ok('a genuinely exceptional filing CAN lead the river',
    mut('neverpromotes') ? false : /Bankruptcy/.test(withExceptional[0].title), withExceptional[0].title);
  ok('…while the routine ones stay below the reporting',
    withExceptional.slice(1, 1 + curated.length).every((x) => !isFilingStory(x)));

  // Degenerate pools must not throw — this route runs with any of the three empty.
  ok('an empty pool set composes to an empty river', composeRiver({}).length === 0);
  ok('filings alone still compose', composeRiver({ filings: routineFilings }).length === routineFilings.length);
}

L('\n=== THE FRONT DOOR PREFERS REPORTING TO A ROUTINE FILING ===');
{
  const iso = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  // ⚠️ THE HEADLINES HAVE TO BE REAL, AND MY FIRST FIXTURES WERE NOT. They read
  // "WSJ reports a $41bn biotech deal" — which impactOf correctly scores `routine`, because no
  // event keyword fires on it — so the whole block asserted the filings floor by accident and four
  // assertions failed for a reason that had nothing to do with the code under test. These four are
  // the shapes the curated pool actually carries: a guidance cut, an earnings reaction, an officer
  // change and a buyback, each NOTABLE on the rules as they already stand.
  const desk4 = [
    ['WSJ', 'Target cuts guidance after a weak holiday quarter'],
    ['Bloomberg', 'Analysts raise price target on chipmakers after earnings beat'],
    ['MarketWatch', 'Boeing names new chief financial officer'],
    ['Reuters', 'Shell announces $3.5 billion buyback as cash flow climbs'],
  ].map(([src, headline], i) => ({
    headline, source: src, tag: 'MARKETS', published: iso(10 + i), summary: 'x', imageUrl: null,
  }));
  ok('…the desk fixtures are genuinely notable, as the live pool\u2019s are',
    desk4.every((a) => IMPACT_RANK[impactOf(a)] >= IMPACT_RANK.notable),
    desk4.map((a) => impactOf(a)).join(','));
  const filings40 = Array.from({ length: 40 }, (_, i) => ({
    headline: `SYM${i} · Earnings`, source: 'SEC 8-K', tag: 'SEC', sym: `AB${i}`,
    material: true, secLabel: 'Earnings', published: iso(1), imageUrl: null,
  }));

  // ⚠️ THE REPORTED SYMPTOM: forty material 8-Ks and four fresh desk stories produced four 8-K
  // cards. Every one of those filings scores 'high' and every article scores 'notable', so no
  // amount of re-ranking could have fixed it — the tier was being used as an ordering.
  const d = deskSelection(desk4, filings40);
  ok('forty material 8-Ks do not displace four fresh desk stories',
    mut('filingslead') ? false : d.items.every((n) => !isFilingStory(n)),
    d.items.map((n) => n.source).join(','));
  ok('…the module is NOT labelled as filings', d.leadingWithFilings === false);
  ok('…it is still capped at four', d.items.length === DESK_SLOTS, String(d.items.length));
  ok('…and the big slot is not claimed by a merely-notable story', d.heroWorthy === false);

  // The carve-out again, at the front door this time.
  const exceptional = {
    headline: 'INM · Delisting risk', source: 'SEC 8-K', tag: 'SEC', sym: 'INM',
    material: true, secLabel: 'Delisting risk', published: iso(2), imageUrl: null,
  };
  const withExc = deskSelection(desk4, [...filings40, exceptional]);
  ok('an exceptional filing leads the front door over notable reporting',
    mut('neverpromotes') ? false : /Delisting risk/.test(withExc.items[0].headline),
    withExc.items[0].headline);
  ok('…it earns the hero', withExc.heroWorthy === true);
  ok('…the reporting keeps the remaining tiles',
    withExc.items.slice(1).every((n) => !isFilingStory(n)),
    withExc.items.slice(1).map((n) => n.source).join(','));
  ok('…and no routine filing is beside it',
    !withExc.items.some((n) => /· Earnings/.test(n.headline)));

  // With nothing reported, the module IS the filings floor and must show the filings it has.
  const quiet = deskSelection([], filings40);
  ok('with nothing reported the floor still shows filings',
    quiet.items.length === DESK_SLOTS && quiet.items.every(isFilingStory));
  ok('…and says so', quiet.leadingWithFilings === true);
  const two = deskSelection([], [exceptional, filings40[0]]);
  ok('…two filings still produce two cards, exceptional first',
    two.items.length === 2 && /Delisting risk/.test(two.items[0].headline), String(two.items.length));

  // ⚠️ NEVER PROMOTE AN OLD STORY TO FILL A SLOT, and never a promotional release.
  const stale = desk4.map((a) => ({ ...a, published: new Date(Date.now() - 50 * 3600 * 1000).toISOString() }));
  const staleRun = deskSelection(stale, filings40);
  ok('a two-day-old desk story is not promoted over today’s filings',
    mut('ignoresage') ? false : staleRun.items.every(isFilingStory),
    staleRun.items.map((n) => n.source).join(','));
  const pr = [{
    headline: 'XYZ Corp announces quarterly dividend and conference call',
    source: 'PR Newswire', tag: 'MARKETS', published: iso(5), imageUrl: null,
  }];
  const prRun = deskSelection(pr, filings40);
  ok('a tickerless press release never takes a front-door slot',
    mut('widensdesk') ? false : prRun.items.every(isFilingStory),
    prRun.items.map((n) => n.source).join(','));
}

L('\n=== THE PRODUCERS AND THE ROUTE ARE ACTUALLY WIRED TO IT ===');
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const route = strip(fsRead('src/app/api/news/route.js'));
  ok('the news route composes the river', /composeRiver\(\{/.test(route));
  // ⚠️ ASSERTED BY SHAPE, NOT BY COMMENT TEXT. The explanation above that line still quotes the old
  // expression on purpose, and an unstripped read would match it and pass while the bug was live —
  // the exact false green this suite has produced before.
  ok('…and no longer stacks the filings on top',
    mut('filingslead') ? false : !/rankByImpact\(filings\)/.test(route));
  ok('…and reports curatedCount from the pool, not by subtraction',
    /curatedCount:\s*curated\.length/.test(route));

  const nf = strip(fsRead('src/lib/news-filings.mjs'));
  ok('the river’s filing cards carry the SEC item label',
    mut('dropssec') ? false : /secLabel:\s*f\.primaryLabel/.test(nf));
  const home = strip(fsRead('src/components/CatalystPit.jsx'));
  ok('…and so do the homepage’s filing cards',
    mut('dropssec') ? false : /secLabel:\s*f\.primaryLabel/.test(home));
}


L('\n=== CURRENCY OUTRANKS SIGNIFICANCE IN THE RIVER, AS IT DOES AT THE FRONT DOOR ===');
{
  // ⚠️ MEASURED ON PRODUCTION AFTER composeRiver's FIRST DEPLOY. The river still led:
  //
  //   0  SEC 8-K      2026-11-23T23:42  DRVN · Delisting risk
  //   1  SEC 8-K      2026-11-23T22:20  SAFX · Delisting risk
  //   2  WSJ          2026-11-20T16:59  Citi Undercounted $35 Billion in Assets at U.K. Subsidiary
  //   3  MarketWatch  2026-11-24T12:50  The biggest biotech deal in nearly three years…
  //
  // Index 2 was four days old. rankByImpact sorts by tier first, and that story is the curated
  // pool's lone 'high' — its category is SEC — so every notable article published that morning
  // ranked below it no matter how fresh. It is literally the same story, and the same staleness,
  // that HERO_MAX_AGE_MS was introduced for; the window guarded the homepage and not the river.
  const iso = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const stale = { title: 'Citi Undercounted $35 Billion in Assets at U.K. Subsidiary', source: 'WSJ', category: 'SEC', ticker: 'C', published: iso(96) };
  const today = { title: 'Analysts raise price target on chipmakers after earnings beat', source: 'Bloomberg', category: 'MARKETS', published: iso(2) };
  const undated = { title: 'Minutes of the Federal Open Market Committee', source: 'Reuters', category: 'MACRO' };

  ok('the stale high-impact story is genuinely the higher tier',
    IMPACT_RANK[impactOf(stale)] > IMPACT_RANK[impactOf(today)],
    `${impactOf(stale)} vs ${impactOf(today)}`);

  const river = composeRiver({ curated: [stale, today], wire: [], filings: [] });
  ok('…and today’s reporting still leads the river',
    mut('ignoresage') ? false : river[0] === today, String(river[0].source));
  ok('…while the stale story is kept, not dropped', river.length === 2 && river[1] === stale);

  // It must stay in the journalism block: demoted within its block, never below the filings.
  const fil = { title: 'ABCD · Earnings', source: 'SEC 8-K', category: 'SEC', ticker: 'ABCD', material: true, secLabel: 'Earnings', published: iso(0.2) };
  const withFilings = composeRiver({ curated: [stale, today], wire: [], filings: [fil] });
  ok('…and still above the filings block',
    mut('ignoresage') ? false : withFilings.indexOf(stale) < withFilings.indexOf(fil),
    withFilings.map((x) => x.source).join(' | '));

  // ⚠️ UNDATED IS NOT STALE. A scheduled macro print carries no article timestamp in this
  // pipeline, and demoting on an absence is what isHeroWorthy already refuses to do.
  const withUndated = composeRiver({ curated: [stale, undated], wire: [], filings: [] });
  ok('an undated item is not treated as stale',
    mut('undatedisstale') ? false : withUndated[0] === undated, String(withUndated[0].title).slice(0, 40));

  // The window is the same one the hero uses — one answer to "is this current", not two.
  ok('the river and the hero share one freshness window', (() => {
    const justInside = { title: 'Target cuts guidance after a weak quarter', source: 'WSJ', category: 'SEC', ticker: 'TGT', published: iso(23) };
    const justOutside = { ...justInside, published: iso(25) };
    return composeRiver({ curated: [justInside, today] })[0] === justInside
      && composeRiver({ curated: [justOutside, today] })[0] === today;
  })());
}


L('\n=== A NEWSPAPER ARTICLE ABOUT A FILING IS NOT A FILING ===');
{
  // ⚠️ FOUND BY MEASURING PRODUCTION, NOT BY READING THE CODE. The first version of isFilingStory
  // accepted category 'SEC' as proof of a filing card, and 'SEC' is also a TOPIC the curated
  // enrichment assigns. Live pool, 2026-11-24:
  //
  //   "Citi Undercounted $35 Billion in Assets at U.K. Subsidiary"   source WSJ   category SEC
  //   "Opinion | How to Kill a Bull Market"                          source WSJ   category SEC
  //
  // Each was treated as a filing card, which in deskSelection means band 1 — the filings floor,
  // used only when nothing was reported. The change meant to put reporting back on the front door
  // would have excluded the Wall Street Journal from it.
  const wsjAboutSec = { title: 'Citi Undercounted $35 Billion in Assets at U.K. Subsidiary', source: 'WSJ', category: 'SEC', ticker: 'C' };
  const realCard = { title: 'ABCD · Earnings', source: 'SEC 8-K', category: 'SEC', ticker: 'ABCD', material: true, secLabel: 'Earnings' };

  ok('a WSJ story tagged SEC is not a filing card', mut('categoryisfiling') ? false : !isFilingStory(wsjAboutSec));
  ok('…and the real filing card still is', isFilingStory(realCard));
  ok('…so it is not given a filing tier', mut('categoryisfiling') ? false : filingTier(wsjAboutSec) === null);

  // It must be able to reach the front door on its own merit, which is the whole point.
  const fresh = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const d = deskSelection(
    [{ ...wsjAboutSec, headline: wsjAboutSec.title, sym: 'C', tag: 'SEC', published: fresh(3), imageUrl: null }],
    Array.from({ length: 10 }, (_, i) => ({
      headline: `SYM${i} · Earnings`, source: 'SEC 8-K', tag: 'SEC', sym: `AB${i}`,
      material: true, secLabel: 'Earnings', published: fresh(0.5), imageUrl: null,
    })),
  );
  ok('…and a fresh WSJ story about a filing leads the front door over ten routine 8-Ks',
    mut('categoryisfiling') ? false : d.items[0].source === 'WSJ', String(d.items[0].source));
  ok('…with the module not labelled as filings', d.leadingWithFilings === false);

  // ⚠️ THE CATEGORY IS STILL ACCEPTED WHERE NOTHING CONTRADICTS IT. A card with no publisher at all
  // is not a published article by anyone, and dropping the fallback outright would misclassify a
  // filing card written before the source marker existed.
  ok('a sourceless SEC-tagged row is still treated as a filing',
    isFilingStory({ title: 'ABCD · Delisting risk', category: 'SEC', ticker: 'ABCD', material: true }));

  // impactOf is explicitly NOT changed by any of this — the brief requires the legitimate impact
  // classifications be preserved, and "a story about a filing is an issuer matter" is one of them.
  ok('impactOf still treats an SEC-categorised story as an issuer matter',
    impactOf(wsjAboutSec) === 'high', impactOf(wsjAboutSec));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
