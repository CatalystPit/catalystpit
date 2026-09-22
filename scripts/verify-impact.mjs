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
import { impactOf, matchesKeyword, IMPACT_RANK, rankByImpact, isHeroWorthy, deskSelection, DESK_SLOTS } from '../src/lib/impact.js';

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
  ok('…while the junk still cannot fill the remaining tiles',
    mut('padsjunk') ? false : withReal.items.length === 1, String(withReal.items.length));

  // Nothing at all is a real state, and the module has its own empty copy for it.
  const nothing = deskSelection(JUNK, []);
  ok('all-routine with no filings selects nothing at all',
    mut('padsjunk') ? false : nothing.items.length === 0);
  ok('…and does not claim to be showing filings', nothing.leadingWithFilings === false);

  // The render must honour the cap and never repeat.
  const home = fsRead('src/components/CatalystPit.jsx');
  ok('the render takes at most three supporting tiles',
    mut('rendercap') ? false : /news\.slice\(1, 4\)/.test(home));
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
  ok('…it reads activeCount from the canonical row',
    /evidence_layer\?\.activeCount/.test(teaser));
  ok('…and names the setup the board itself named', /r\?\.setup\?\.label/.test(teaser));
  // ⚠️ NO SUMMARY IS BETTER THAN A FALSE ONE.
  ok('an unreadable row shows an em dash, never a confident 0',
    mut('confidentzero') ? false : /familyCount\(r\) \?\? '—'/.test(teaser));
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

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
