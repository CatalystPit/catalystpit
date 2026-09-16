// Rebuilds src/lib/facebook-voice-lexicon.mjs from the production corpus.
//
// The rewriter only ever lowercases a word it is confident is ordinary English. That confidence has
// to come from evidence, so it is measured here rather than guessed: for every token, how often does
// it appear lowercase, capitalised, or in full caps INSIDE MIXED-CASE PROSE? All-caps text is
// skipped entirely — a wire flash in caps says nothing about how a word is normally written.
//
//   node --env-file=.env.local scripts/build-voice-lexicon.mjs
//
// Re-run it when the voice drifts or the corpus grows. It rewrites the lexicon in place; review the
// diff, then run scripts/verify-facebook-voice.mjs before committing.

import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`select source_headline, headline, summary from primary_events
  where source_headline is not null limit 120000`;
console.log('corpus rows: ' + rows.length);

const cap = new Map(), low = new Map(), upper = new Map(), forms = new Map();
const isMixed = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s);
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

for (const r of rows) for (const field of [r.source_headline, r.headline, r.summary]) {
  const t = String(field || ''); if (!t) continue;
  for (const sent of t.split(/(?<=[.!?])\s+|\n+/)) {
    if (!isMixed(sent)) continue;
    const words = sent.match(/[A-Za-z][A-Za-z'’.&-]*/g) || [];
    // SKIP TITLE-CASED HEADLINES. Most of the corpus is press-release headlines written As A Title,
    // where every content word is capitalised by house style rather than because it is a name.
    // Counting those made ordinary words — "extended", "session", "stress", "appetite" — look as
    // though they are usually capitalised, so the rewriter kept capitalising them. Only running
    // prose is evidence about how a word is normally written.
    if (words.length >= 4) {
      const capped = words.filter((w, i) => i > 0 && /^[A-Z]/.test(w)).length;
      if (capped / (words.length - 1) > 0.5) continue;
    }
    words.forEach((w, i) => {
      // Sentence-initial capitals are forced by grammar and prove nothing about the word.
      if (i === 0 || w.length < 2) return;
      const k = w.toUpperCase();
      if (w === k) bump(upper, k);
      else if (/^[A-Z]/.test(w)) { bump(cap, k); if (!forms.has(k)) forms.set(k, new Map()); bump(forms.get(k), w); }
      else bump(low, k);
    });
  }
}
const total = (k) => (cap.get(k) || 0) + (low.get(k) || 0) + (upper.get(k) || 0);

const learnedCommon = [...low.entries()]
  .filter(([k, n]) => n >= 2 && n / total(k) >= 0.7 && /^[A-Z'’.&-]+$/i.test(k))
  .sort((a, b) => b[1] - a[1]).slice(0, 14000).map(([k]) => k);
const acro = [...upper.entries()]
  .filter(([k, n]) => n >= 4 && n / total(k) >= 0.9 && k.length <= 6)
  .sort((a, b) => b[1] - a[1]).slice(0, 400).map(([k]) => k);
const proper = [];
for (const [k, c] of cap) {
  if (c < 5 || c / total(k) < 0.95) continue;
  const f = forms.get(k); let best = null;
  for (const [form, n] of f) if (!best || n > f.get(best)) best = form;
  if (f.get(best) / c < 0.9 || best === best.toUpperCase()) continue;
  proper.push([k, best, c]);
}
proper.sort((a, b) => b[2] - a[2]);

// The corpus is overwhelmingly Title-Cased headlines, so ordinary verbs and nouns are almost never
// seen lowercase mid-sentence: "seek", "joins", "fund" and "investor" were all absent. Without these
// the rewriter capitalises every content word and produces Headline Case instead of a sentence.
const CURATED = `
a an the and or but nor for so yet of in on at by to from with without within into onto upon over
under above below between among across through during before after since until while as if then than
that this these those it its it's their there here when where which who whom whose what why how all
any both each few more most other some such no not only own same very can will just should now
is are was were be been being am do does did doing have has had having would could may might must
shall says said say saying tells told reports reported according reportedly announced announces
announcing seeks seek seeking sought joins join joining joined launches launch launching launched
holds hold holding held targets target targeting targeted plans plan planning planned expects expect
expecting expected raises raise raising raised cuts cut cutting lowers lower lowering lowered
lifts lift lifting lifted boosts boost boosting boosted adds add adding added sells sell selling sold
buys buy buying bought signs sign signing signed files file filing filed names name naming named
appoints appoint appointing appointed steps step stepping stepped resigns resign resigning resigned
opens open opening opened closes close closing closed rises rise rising rose falls fall falling fell
gains gain gaining gained drops drop dropping dropped jumps jump jumping jumped slides slide sliding
slid climbs climb climbing climbed slips slip slipping slipped surges surge surging surged
sinks sink sinking sank tumbles tumble tumbling tumbled rallies rally rallying rallied
warns warn warning warned urges urge urging urged calls call calling called agrees agree agreeing
agreed approves approve approving approved rejects reject rejecting rejected denies deny denying
denied confirms confirm confirming confirmed considers consider considering considered
criticizes criticize criticizing criticized backs back backing backed
new news old recent recently current currently former latest next last first second third
major minor large small big little high higher highest low lower lowest strong stronger weak weaker
good better best bad worse worst early earlier late later long longer short shorter full partial
possible likely unlikely potential expected unexpected significant key main top bottom
company companies firm firms group business businesses market markets stock stocks share shares
fund funds investor investors investment investments adviser advisers advisor advisors analyst
analysts trader traders bank banks lender lenders client clients customer customers
price prices cost costs value values revenue revenues profit profits loss losses earnings sales
growth demand supply output production capacity deal deals talks talk agreement agreements
plan plans deal offer offers bid bids stake stakes position positions holding holdings
report reports statement statements comment comments source sources official officials
government officials president minister secretary chief executive officer chairman board
policy policies rate rates rating ratings target targets forecast forecasts outlook guidance
quarter quarterly annual yearly monthly weekly daily year years month months week weeks day days
data figures numbers results performance
senior junior chief deputy interim acting global national regional local international
bearish bullish short long net gross total average
safeguard safeguards protection protections regulation regulations rule rules law laws bill bills
support opposition bipartisan partisan
launch fund strategy skepticism depreciation practices hyperscalers chipmakers
help within month expected biased focused
technology technologies chip chips energy oil gas power metal metals gold silver
per cent percent percentage point points basis

go goes going gone went come comes coming came get gets getting got give gives giving gave
make makes making made take takes taking took put puts putting keep keeps keeping kept
let lets letting bring brings bringing brought hold see sees seeing saw seen look looks looking
find finds finding found think thinks thinking thought know knows knowing knew known
want wants wanting wanted need needs needing needed try tries trying tried
use uses using used work works working worked run runs running ran move moves moving moved
show shows showing showed shown turn turns turning turned start starts starting started
end ends ending ended begin begins beginning began stop stops stopping stopped
continue continues continuing continued remain remains remaining remained stay stays stayed
include includes including included follow follows following followed lead leads leading led
set sets setting reach reaches reaching reached meet meets meeting met
win wins winning won lose loses losing lost beat beats beating
pay pays paying paid spend spends spending spent save saves saving saved owe owes owed
build builds building built create creates creating created develop develops developing developed
provide provides providing provided offer offering allow allows allowing allowed
require requires requiring required accept accepts accepting accepted refuse refuses refused
face faces facing faced seek address addresses addressing addressed
up down out off over under again further once here there where when why how
who whom whose what which while about against between into through above below
after before during since until from with within without toward towards upon
and or but so because though although unless whether either neither
all any both each every few many much more most other another some such
no nor not only own same than that the then there these this those too very
war wars peace attack attacks strike strikes conflict crisis talks deal
world global national state states country countries city cities region
people person official leader leaders minister ministry department agency
plan planned expected expecting likely unlikely possible potential
five ten twenty thirty fifty hundred thousand million billion trillion
first second third fourth fifth next previous final total
yield yields bond bonds note notes bill bills loan loans debt credit
draw draws drawn sale sales issue issues issued auction
high low open close last final early late strong weak soft firm flat
regarding concerning despite amid among across beyond behind
still yet already also even just almost nearly about around roughly
said says say told tells according reported reports reportedly
confirmed denied declined refused announced revealed disclosed
i me my mine we our ours you your yours he him his she her hers they them their theirs
attack attacks attacking attacked defend defends defending defended
pace paces slow slows slowing slowed fast faster quick quickly
frontier border borders territory land sea air ground
vote votes voting voted election elections campaign campaigns
safety security threat threats risk risks danger
launch launches launching launched fire fires firing fired
cut cuts cutting hike hikes hiking hiked ease easing tighten tightening
inflation deflation recession recovery slowdown downturn upturn
trade tariff tariffs sanction sanctions embargo export exports import imports
supply supplies demand demands output input
chief head heads leader leaders member members staff worker workers
court courts judge judges ruling rulings lawsuit lawsuits case cases
probe probes investigation investigations inquiry review reviews audit
ban bans banned banning limit limits limited restrict restricts restricted
raise raises raised cut lower lowered boost boosted
comment comments commented decline declines
midterm midterms primary primaries
`.trim().split(/\s+/).map((w) => w.toUpperCase());

// Acronyms the corpus has not happened to teach us. Agencies, statistics and market shorthand keep
// their capitals; without them "CBO" publishes as "Cbo".
const CURATED_ACRONYMS = `
CBO CDC NIH NASA FBI CIA NSA DHS DOD DOE DOJ IRS FTC FCC EIA BLS BEA OMB GAO TSA FAA
WTO IMF WHO UN NATO OPEC OPEC+ ECB BOJ BOE PBOC RBA RBI SNB BIS FOMC FED
CPI PPI GDP PCE ISM PMI NFP JOLTS EPS EBITDA ROE ROI ROIC CAGR YOY QOQ MOM YTD FY
IPO SPAC ETF ETN REIT MLP ADR GDR OTC NYSE NASDAQ AMEX LSE TSX HKEX
AI ML LLM GPU CPU DRAM NAND HBM EV ICE OEM SaaS API IOT AR VR
CEO CFO COO CTO CIO CMO CHRO EVP SVP VP MD PhD
EU UK US USA UAE UN NY LA DC SF TX CA FL NJ PA
AM PM ET PT CT MT GMT UTC EST EDT PST PDT
Q1 Q2 Q3 Q4 H1 H2 FX GSE TIPS OIS SOFR LIBOR
`.trim().split(/\s+/).map((w) => w.toUpperCase());

const common = [...new Set([...learnedCommon, ...CURATED])].filter((w) => !CURATED_ACRONYMS.includes(w)).sort();
const acroSorted = [...new Set([...acro, ...CURATED_ACRONYMS])].sort();
const prop = proper.slice(0, 900).map(([k, v]) => [k, v]).sort((a, b) => a[0].localeCompare(b[0]));

// Tokens can contain an apostrophe (D'ACTIONS, IRAN'S) or a backslash, either of which would close
// or corrupt the generated string literal. JSON.stringify quotes and escapes correctly in one step.
const q = (x) => JSON.stringify(String(x));
const wrap = (arr, per) => {
  const lines = [];
  for (let i = 0; i < arr.length; i += per) lines.push('  ' + arr.slice(i, i + per).map(q).join(', ') + ',');
  return lines.join('\n');
};

const out = `// Lexicons for the Facebook editorial voice. GENERATED — see scripts/build-voice-lexicon.mjs.
//
// LEARNED FROM PRODUCTION. Every entry was derived from 60 days of ingested wire text by comparing
// how often a token appears lowercase, capitalised and in full caps inside MIXED-CASE prose.
// All-caps text teaches nothing about casing, so it is ignored as evidence. A token counts as
// ordinary English only when it is dominantly written lowercase, and as a name only when it is
// essentially never lowercase and has one consistent spelling.
//
// CURATED ADDITIONS. The corpus is mostly Title-Cased headlines, so ordinary verbs and nouns are
// rarely observed lowercase mid-sentence — "seek", "joins", "fund" and "investor" were all missing.
// A news-prose vocabulary is merged in for exactly that reason.
//
// Do not hand-edit: re-run the generator and review the diff.

/** Ordinary English. The ONLY words the rewriter is willing to lowercase. */
export const COMMON = new Set([
${wrap(common, 10)}
]);

/** Written in caps even inside mixed-case prose, so caps are the correct spelling. */
export const ACRONYMS = new Set([
${wrap(acroSorted, 12)}
]);

/** Names, with the canonical spelling the sources themselves use. */
export const PROPER = new Map([
${prop.map(([k, v]) => `  [${q(k)}, ${q(v)}],`).join('\n')}
]);

/** A capitalised run ending in one of these is a company name: Title Case the whole run. */
// DELIBERATELY ONLY STRONG LEGAL SUFFIXES. The first version also listed ENERGY, CAPITAL, BANK,
// MOTORS, TECHNOLOGY and MANAGEMENT, which are ordinary words: one "ENERGY" at the end of a sentence
// started an entity run and Title-Cased the clause in front of it. A suffix earns its place here
// only if its presence all but proves the preceding words are a registered name.
export const ENTITY_SUFFIX = new Set([
  'INC', 'INC.', 'CORP', 'CORP.', 'CO.', 'LP', 'LLC', 'LLP', 'PLC', 'LTD', 'LTD.', 'AG', 'SA',
  'NV', 'SE', 'AB', 'OY', 'KK', 'GMBH', 'BV', 'SPA', 'ASA', 'OYJ', 'PBC',
  'HOLDINGS', 'BANCORP', 'TECHNOLOGIES', 'PHARMACEUTICALS', 'THERAPEUTICS', 'BIOSCIENCES',
  'INDUSTRIES', 'LABORATORIES', 'ENTERPRISES', 'INCORPORATED',
]);
`;
fs.writeFileSync(new URL('../src/lib/facebook-voice-lexicon.mjs', import.meta.url), out);
console.log(`COMMON ${common.length}  ACRONYMS ${acroSorted.length}  PROPER ${prop.length}`);
