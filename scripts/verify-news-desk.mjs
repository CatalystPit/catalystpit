// ⚠️ DOES THE FRONT PAGE LEAD WITH SOMETHING THAT HAPPENED TODAY?
//
//   node --env-file=.env.local scripts/verify-news-desk.mjs
//
// ── THE TWO DEFECTS ──────────────────────────────────────────────────────────────────────────────
//
// 1. rankByImpact sorted by impact and then by ORIGINAL ARRAY INDEX, so among equally-ranked HIGH
//    stories whichever sat first in the pool led — permanently, because its position never changed.
//    Measured on production: "Citi Undercounted $35 Billion in Assets at U.K. Subsidiary" held the
//    hero at 73.9 hours old while Nvidia's CEO returning, 1.3 hours old and also HIGH, sat second.
//    The snapshot itself was 0.2 hours old; the cron was never the problem.
//
// 2. NewsPhotoCard reserved photoH (340px in hero) and filled it with a gradient even though
//    photoSrc is hard-coded null and the homepage sets imageUrl: null — we hold no usage rights to
//    publishers' photography. The lead rendered as an enormous empty green panel.
//
// These assertions run against the REAL production pool, because a fixture would have let the
// index-order tie-break look correct.

import { rankByImpact, isHeroWorthy, publishedMs, deskSelection, impactOf, HERO_MAX_AGE_MS } from '../src/lib/impact.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); }
};
const L = (s) => console.log(`\n${s}`);
const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const hrs = (ms) => `${(ms / 3_600_000).toFixed(1)}h`;

// ── the real pool ────────────────────────────────────────────────────────────
const URL_ = process.env.KV_REST_API_URL;
const TOK = process.env.KV_REST_API_TOKEN;
let stories = [];
if (URL_ && TOK) {
  const r = await fetch(`${URL_}/get/${encodeURIComponent('catalystpit:pit_snapshot')}`, {
    headers: { Authorization: `Bearer ${TOK}` }, cache: 'no-store',
  });
  let v = (await r.json().catch(() => null))?.result ?? null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* raw */ } }
  stories = v?.stories || [];
}

L('⚠️ 1 — the lead is recent, against the live production pool');
if (!stories.length) {
  console.log('  (no KV access or empty snapshot — section skipped, not silently passed)');
  ok('production pool was readable', false, 'set KV_REST_API_URL / KV_REST_API_TOKEN to run this');
} else {
  const now = Date.now();
  const { items } = deskSelection(stories, []);
  console.log(`      pool: ${stories.length} stories, ${stories.filter((s) => impactOf(s) === 'high').length} HIGH`);
  items.slice(0, 5).forEach((s, i) => {
    const t = publishedMs(s);
    console.log(`      ${i + 1}. age=${t ? hrs(now - t) : '?'}  ${String(s.source || '').padEnd(13)} ${String(s.title || s.headline || '').slice(0, 62)}`);
  });

  const { heroWorthy } = deskSelection(stories, []);
  console.log(`      heroWorthy: ${heroWorthy}`);
  // ⚠️ THE SECTION MUST SHOW SOMETHING WHEN THERE IS NEWS. On the measured pool the only HIGH story
  // is 74 hours old, so the hero window excludes it and nothing is promoted — but five notable
  // stories from the last few hours remain, and "Markets are quiet" would be false.
  ok('⚠️ the section is not empty while fresh market news exists', items.length > 0,
    `${items.length} items for ${stories.length} stories`);
  const lead = items[0];
  if (lead) {
    const age = now - (publishedMs(lead) ?? 0);
    // ⚠️ THE ASSERTION THAT WOULD HAVE CAUGHT THIS. 73.9 hours fails it by a factor of three.
    ok(`⚠️ the lead is younger than the hero window (${hrs(age)} < ${hrs(HERO_MAX_AGE_MS)})`,
      age <= HERO_MAX_AGE_MS, hrs(age));
    // ⚠️ HIGH *ONLY WHEN THE BIG SLOT IS IN USE*. When heroWorthy is false nothing was promoted, so
    // demanding HIGH here would be demanding the defect back: on this pool the only HIGH story is 74
    // hours old, and the right answer is a compact list of fresh notable stories. What must never
    // happen is `routine` reaching the section at all — advice columns and promotional wire copy.
    ok(`⚠️ the lead's impact suits the slot it occupies (${impactOf(lead)}, heroWorthy=${heroWorthy})`,
      heroWorthy ? impactOf(lead) === 'high' : impactOf(lead) === 'notable');
    ok('⚠️ no routine story reached the section',
      items.every((s) => impactOf(s) !== 'routine'),
      items.filter((s) => impactOf(s) === 'routine').map((s) => String(s.title).slice(0, 30)).join(' | '));
  }

  // ⚠️ ORDERED BY RECENCY WITHIN THE BAND. The old sort could satisfy "lead is recent" by accident
  // while still leaving the rest in pool order.
  const ages = items.map((s) => publishedMs(s)).filter((t) => t != null);
  const descending = ages.every((t, i) => i === 0 || ages[i - 1] >= t);
  ok('⚠️ equally-ranked stories are ordered newest first', descending,
    ages.map((t) => hrs(now - t)).join(' '));
}

L('⚠️ 2 — the ranking rule itself');
{
  const now = Date.UTC(2026, 10, 23, 18, 0, 0);
  const mk = (title, hoursAgo, extra = {}) => ({
    title, publishedAt: new Date(now - hoursAgo * 3_600_000).toISOString(), ...extra,
  });
  // ⚠️ THE FIXTURES CARRY A CATEGORY, because impactOf reads it and my first attempt did not supply
  // one — so "two HIGH stories" were not HIGH at all and three assertions failed on a premise I had
  // invented rather than measured. On production the Citi story is high precisely BECAUSE its
  // category is SEC: an issuer filing is exempt from the advice-voice damper.
  // Two genuinely HIGH stories, the stale one deliberately FIRST in the array — the exact shape that
  // produced the defect.
  const pool = [
    mk('Citi undercounted $35 billion in assets at U.K. subsidiary', 73.9, { category: 'SEC', ticker: 'C' }),
    mk('Nvidia surges as Jensen Huang returns as CEO', 1.3, { category: 'SEC', ticker: 'NVDA' }),
  ];
  const ranked = rankByImpact(pool);
  ok('⚠️ the newer of two equally-ranked stories leads',
    /Nvidia/.test(ranked[0].title), ranked.map((r) => r.title.slice(0, 24)).join(' | '));
  ok('⚠️ …and the stale one is kept, not dropped', ranked.length === 2);

  // ⚠️ IMPACT STILL OUTRANKS RECENCY, which is the guarantee that keeps an advice column off the
  // front page however freshly it was published. The older item is the HIGH one here on purpose.
  const mixed = rankByImpact([
    mk('Citi undercounted $35 billion in assets at U.K. subsidiary', 5, { category: 'SEC', ticker: 'C' }),
    mk('3 dividend stocks to buy and hold forever', 0.1, { category: 'Markets' }),
  ]);
  ok('⚠️ impact still decides before recency — a fresh advice column cannot outrank a HIGH story',
    /Citi/.test(mixed[0].title),
    `${impactOf(mixed[0])} "${mixed[0].title.slice(0, 30)}" vs ${impactOf(mixed[1])}`);

  ok('⚠️ an undated item sorts after dated ones, not ahead of them',
    rankByImpact([{ title: 'Nvidia surges as Jensen Huang returns as CEO' },
      mk('Nvidia surges as Jensen Huang returns as CEO', 2)])[0].publishedAt != null);

  // publishedMs across every shape the pipeline really produces.
  ok('publishedMs reads ISO strings', publishedMs({ publishedAt: '2026-11-23T12:00:00Z' }) === Date.parse('2026-11-23T12:00:00Z'));
  ok('publishedMs reads epoch seconds', publishedMs({ datetime: 1763900000 }) === 1763900000000);
  ok('publishedMs reads epoch milliseconds', publishedMs({ date: 1763900000000 }) === 1763900000000);
  ok('publishedMs reads the homepage mins field', Math.abs(publishedMs({ mins: 60 }) - (Date.now() - 3_600_000)) < 2000);
  ok('publishedMs returns null when there is nothing to read', publishedMs({}) === null);
}

L('⚠️ 3 — a stale story cannot hold the hero');
{
  // category: 'SEC' is what makes this HIGH on production — the title alone is not enough.
  const old = { title: 'Citi undercounted $35 billion in assets at U.K. subsidiary', category: 'SEC', ticker: 'C',
    publishedAt: new Date(Date.now() - 73.9 * 3_600_000).toISOString() };
  ok('⚠️ a 73.9h HIGH story is NOT hero-worthy', isHeroWorthy(old) === false);
  ok('⚠️ …even though its impact is still high', impactOf(old) === 'high');
  const fresh = { ...old, publishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  ok('⚠️ the same story two hours old IS hero-worthy', isHeroWorthy(fresh) === true);
  // ⚠️ AND THE FALLBACK STILL REACHES FILINGS. Filing cards are current by construction and may
  // carry no timestamp; excluding them would break the very path the window exists to reach.
  ok('⚠️ an undated ISSUER FILING is still hero-worthy',
    isHeroWorthy({ title: 'My Size, Inc. 8-K', material: true, ticker: 'MYSZ' }) === true);
  // ⚠️ AND SO IS AN UNDATED MACRO PRINT, which is why the window excludes only what it can PROVE is
  // stale. I first demoted every undated item, reasoning that an article's age is the thing in
  // question — and verify-impact caught it immediately: "Minutes of the Federal Open Market
  // Committee" carries no article timestamp in this pipeline, so the FOMC stopped being front-page
  // news and the module fell through to the filings floor. Staleness is a claim about a known date.
  ok('⚠️ an undated MACRO PRINT is still hero-worthy',
    isHeroWorthy({ headline: 'Minutes of the Federal Open Market Committee', tag: 'MACRO' }) === true);
  ok('⚠️ …and a DATED stale story is still excluded, which is the case that mattered',
    isHeroWorthy(old) === false);
  // With no fresh HIGH story and no filings, the section must say it is quiet rather than fill the hero.
  const quiet = deskSelection([old], []);
  ok('⚠️ no fresh story and no filings → empty, so the quiet state renders', quiet.items.length === 0);

  // ⚠️ THE THIRD TIER MUST NOT BECOME A JUNK DRAWER. `notable` can be earned by CATEGORY alone, so
  // the first version of this tier admitted a French restaurant guide (tag MARKETS, no ticker) to
  // the front page — verify-impact caught it. A resolved ticker is the test of substance.
  // ⚠️ THIS FIXTURE IS THE ONE THAT ACTUALLY TESTS THE RULE. I first used the Michelin guide, which
  // classifies as ROUTINE — so it was excluded by the rank filter and the assertion passed without
  // ever exercising the ticker test. Mutation testing caught that: deleting the ticker check
  // SURVIVED. The real category-only notable in the junk fixture is this Fed commentary column,
  // notable via tag FED and carrying no issuer anyone can act on.
  const commentary = { headline: "Don't Count Out Corporate Bonds Just Because the Fed Is Raising Rates",
    tag: 'FED', publishedAt: new Date(Date.now() - 1 * 3_600_000).toISOString() };
  ok(`⚠️ a category-only "notable" with no ticker never reaches the section (impact=${impactOf(commentary)})`,
    impactOf(commentary) === 'notable' && deskSelection([commentary], []).items.length === 0,
    'fresh and notable, and still correctly excluded — the ticker is the test of substance');
  const nvda = { headline: 'Nvidia surges as Jensen Huang returns as CEO', tag: 'MARKETS', ticker: 'NVDA',
    publishedAt: new Date(Date.now() - 1 * 3_600_000).toISOString() };
  ok('⚠️ …while a fresh notable story about a real listed issuer does',
    deskSelection([nvda], []).items.length === 1);
  ok('⚠️ …and it is NOT promoted into the hero slot',
    deskSelection([nvda], []).heroWorthy === false);
}

L('⚠️ 4 — no image means no image area');
{
  const card = code('src/lib/cp-shared.jsx');
  ok('⚠️ the card branches on whether an image actually exists',
    /const hasImage = !!primarySrc;/.test(card) && /const cardInner = !hasImage \? textCardInner/.test(card));
  // ⚠️ THE 340px FRAME MUST NOT BE DRAWN FOR AN ABSENT PICTURE.
  ok('⚠️ the text card reserves no photo height',
    !/height:photoH/.test(card.slice(card.indexOf('const textCardInner'), card.indexOf('const cardInner'))));
  ok('⚠️ …and draws no CARD_COLORS gradient',
    !/linear-gradient\(135deg/.test(card.slice(card.indexOf('const textCardInner'), card.indexOf('const cardInner'))));
  ok('⚠️ the headline is the largest element in the text card',
    /fontSize: hero \? 21 :/.test(card));
  ok('⚠️ publisher, ticker and timestamp are all present',
    /\{n\.source\}/.test(card) && /\{n\.sym\}/.test(card) && /timeAgo\(n\.mins\)/.test(card));
  // ⚠️ AND NO IMAGERY IS INVENTED. photoSrc stays null; nothing substitutes a stock photo.
  ok('⚠️ no placeholder imagery is substituted', /const photoSrc = null;/.test(card));

  const page = code('src/components/CatalystPit.jsx');
  ok('⚠️ the section clock is labelled as the SECTION\'s, not the story\'s',
    /Section updated \{timeStr\} ET/.test(page),
    'beside a card, a bare "Updated" reads as the article\'s own time');
  ok('…and the lead shows the publisher summary when one exists',
    /hero showSummary/.test(page));
  // ⚠️ THE HERO IS CONDITIONAL IN THE MARKUP, not just in the data. Mutation testing removed the
  // guard and this suite did not notice: the big slot came back unconditionally, which is the
  // original defect — a slot that must always contain something will always contain something.
  ok('⚠️ the hero is only rendered when one was earned',
    /\{heroWorthy && \(/.test(page), 'an unconditional hero is the defect');
  ok('⚠️ …and the supporting grid starts at 0 when there is no hero',
    /news\.slice\(heroWorthy \? 1 : 0, 4\)/.test(page));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
