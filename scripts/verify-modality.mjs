// Modality-preservation regression suite.
//
// Every REJECT case below uses only real names and real figures taken from its own source, passes
// the noun gate, passes the number gate, and passes every predicate check. What each one does is
// raise the CERTAINTY of the claim: a thought experiment, a forecast, a price target or one
// analyst's argument arrives as a market event.
//
// The ACCEPT half matters just as much. A gate that rejects everything is not a safety feature, it
// is an outage — the rewrite pipeline falls back to the publisher's own headline and Catalyst Pit
// stops having a voice. Ordinary factual rewrites must still pass, including ones that mention a
// forecast, a target or a year in passing.
//
// Run: node scripts/verify-modality.mjs

import { validateHeadline } from '../src/lib/headline-writer.mjs';
import {
  validateModality, classifyModality, isFraming, achievedValues, sourceAsserts,
  valueNotAchieved, attributionStripped, sourceHeadlineOf, RANK,
} from '../src/lib/modality.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sec = (s) => console.log(`\n=== ${s} ===`);

// Through the FULL public chain, so these prove what production actually enforces.
const reject = (label, src, out, reason) => {
  const v = validateHeadline(out, src, []);
  check(`${label} → rejected (${reason})`, !v.ok && v.reason === reason,
    v.ok ? 'ACCEPTED' : `got "${v.reason}"${v.detail ? ' / ' + v.detail : ''}`);
};
const rejectAny = (label, src, out) => {
  const v = validateHeadline(out, src, []);
  check(`${label} → rejected`, !v.ok, v.ok ? 'ACCEPTED' : '');
};
const accept = (label, src, out, tickers = []) => {
  const v = validateHeadline(out, src, tickers);
  check(`${label} → accepted`, v.ok, v.ok ? '' : `rejected: ${v.reason}${v.detail ? ' / ' + v.detail : ''}`);
};

// ── 1. the case that named this file ─────────────────────────────────────────
// A revaluation thought experiment. The source headline is VERBLESS and contains no hedging word of
// any kind, so no blacklist can reach it.
sec('HYPOTHETICAL CANNOT BECOME A FACTUAL PRESENT-TENSE EVENT');

const GOLD = 'HEADLINE: Gold At $155,000 An Ounce\n'
  + 'If the US were to revalue its gold reserves to back the money supply, the implied price would be '
  + 'about $155,000 an ounce. It is a thought experiment about what such a revaluation would mean.';

reject('"Gold At $155,000 An Ounce" -> "Gold reaches $155,000 per ounce"',
  GOLD, 'Gold reaches $155,000 per ounce', 'unachieved');
reject('the same claim as "hits"', GOLD, 'Gold hits $155,000 an ounce', 'unachieved');
reject('the same claim as "tops"', GOLD, 'Gold tops $155,000 an ounce', 'unachieved');
reject('the same claim as "climbs to"', GOLD, 'Gold climbs to $155,000 an ounce', 'unachieved');
reject('the same claim as "trades at"', GOLD, 'Gold trades at $155,000 an ounce', 'unachieved');
reject('the same claim as "now at"', GOLD, 'Gold now at $155,000 an ounce', 'unachieved');

// Verbless sources with no number at all still cannot become events.
const MERGER = 'HEADLINE: What If Apple Bought Netflix?\n'
  + 'A look at how such a deal could reshape streaming, assuming regulators would allow it.';
rejectAny('"What If Apple Bought Netflix?" -> "Apple acquires Netflix"', MERGER, 'Apple acquires Netflix');

// ── 2. forecasts ─────────────────────────────────────────────────────────────
sec('FORECAST CANNOT BECOME AN ACHIEVED PRICE');

const FCAST = 'HEADLINE: Goldman forecasts oil at $120 a barrel by 2027\n'
  + 'Goldman Sachs raised its long-term forecast and now projects oil reaching $120 a barrel by 2027.';
reject('forecast -> achieved', FCAST, 'Oil reaches $120 a barrel', 'unachieved');
reject('forecast -> achieved, reworded', FCAST, 'Crude tops $120 a barrel', 'unachieved');

const BTC = 'HEADLINE: Analyst sees bitcoin at $250,000 next year\n'
  + 'The analyst believes bitcoin could reach $250,000 in 2027 if ETF inflows continue.';
reject('projection -> achieved', BTC, 'Bitcoin hits $250,000', 'unachieved');

// ── 3. price targets ─────────────────────────────────────────────────────────
sec('TARGET CANNOT BECOME A CURRENT PRICE');

const PT = 'HEADLINE: Morgan Stanley raises Tesla price target to $430\n'
  + 'Morgan Stanley raised its Tesla price target to $430 from $310, keeping an overweight rating.';
reject('price target -> stock reaches it', PT, 'Tesla stock reaches $430', 'unachieved');
reject('price target -> stock trades there', PT, 'Tesla shares trade at $430', 'unachieved');
// The target being RAISED is a real event and must still be reportable.
accept('the target change itself is reportable', PT, 'Morgan Stanley lifts Tesla target to $430 from $310');

// ── 4. conditionals keep their conditional meaning ───────────────────────────
sec('CONDITIONAL STATEMENTS PRESERVE CONDITIONAL MEANING');

const COND = 'HEADLINE: Acme could cut 5,000 jobs if the merger closes\n'
  + 'Acme Corp said it could cut as many as 5,000 jobs if the proposed merger closes next year.';
rejectAny('conditional -> flat assertion', COND, 'Acme cuts 5,000 jobs');
accept('conditional preserved with "could"', COND, 'Acme could shed as many as 5,000 jobs if the merger closes');
accept('conditional preserved with "may"', COND, 'Acme may shed 5,000 jobs should the merger close');

check('a hedge anywhere scopes the whole sentence',
  classifyModality('Gold could reach $155,000 if inflation persists').class === 'hypothetical',
  classifyModality('Gold could reach $155,000 if inflation persists').class);

// ── 5. attribution ───────────────────────────────────────────────────────────
sec('AN OPINION IS ITS HOLDER\'S');

const VIEW = 'HEADLINE: Dalio argues the dollar is losing reserve status\n'
  + 'Ray Dalio argues in a new essay that the dollar is losing its reserve currency status.';
reject('opinion stated as finding', VIEW, 'The dollar is losing reserve status', 'attribution');
accept('opinion kept attributed', VIEW, 'Dalio says the dollar is losing reserve status');

// A NEWSWIRE attributing a real event is not an opinion holder, and dropping it is correct editing.
const WIRE = 'HEADLINE: Reuters reports Acme cut full-year guidance\n'
  + 'Acme Corp cut its full-year guidance, Reuters reported on Tuesday.';
accept('newswire attribution may be dropped', WIRE, 'Acme cuts full-year guidance');

// ── 6. THE FALSE-POSITIVE HALF ───────────────────────────────────────────────
// Everything here is an ordinary, correct rewrite of a real event. A gate that rejects any of these
// has stopped being a safety feature.
sec('ORDINARY FACTUAL REWRITES STILL PASS');

const REAL = 'HEADLINE: Gold rises to $2,700 an ounce on Fed rate-cut bets\n'
  + 'Gold rose to $2,700 an ounce on Tuesday as traders raised bets on a Federal Reserve rate cut.';
accept('a real move at a real level', REAL, 'Gold climbs to $2,700 an ounce');
accept('the same move, different verb', REAL, 'Gold tops $2,700 an ounce');

const CLOSE = 'HEADLINE: Nasdaq closes at 18,400, its first record since 2021\n'
  + 'The Nasdaq Composite closed at 18,400 on Friday, its first record close since 2021.';
accept('a year in the sentence is not a level', CLOSE, 'Nasdaq closes at 18,400 for first record since 2021');

// A year sitting right after an achievement verb is a DATE. Without the year exclusion this is read
// as a claim that the level "2021" was reached, and every "highest since ..." rewrite is rejected.
const BTCYEAR = 'HEADLINE: Bitcoin climbs to a three-year high\n'
  + 'Bitcoin climbed to a three-year high on Tuesday, its strongest showing since 2021.';
accept('a year after an achievement verb is a date, not a level', BTCYEAR, 'Bitcoin hits 2021 highs');

// QUOTED_FRAME is the only thing standing between these two: the source contains the achievement
// verb AND the number, and still asserts nothing, because "could" governs the verb.
const OILCOND = 'HEADLINE: Oil could climb to $120 a barrel, analysts say\n'
  + 'Analysts said oil could climb to $120 a barrel if supply disruptions widen.';
reject('a hedged achievement verb is not an achievement', OILCOND, 'Oil climbs to $120 a barrel', 'unachieved');

const EARN = 'HEADLINE: Acme Corp posts Q3 revenue of $1.2B, raises full-year guidance\n'
  + 'Acme Corp reported third-quarter revenue of $1.2B and raised its full-year guidance.';
accept('an ordinary earnings rewrite', EARN, 'Acme Corp lifts full-year outlook after $1.2B quarter');

// A factual event whose source merely MENTIONS a forecast must not be dragged down by the mention.
const MIX = 'HEADLINE: Pfizer wins FDA approval for its RSV vaccine\n'
  + 'The FDA approved Pfizer\'s RSV vaccine. Analysts expect peak sales of $2B by 2030.';
accept('a real event in a story that also mentions a forecast', MIX, 'FDA clears Pfizer RSV vaccine');

const LAYOFF = 'HEADLINE: Intel to cut 15,000 jobs in restructuring\n'
  + 'Intel said it will cut about 15,000 jobs as part of a restructuring announced on Thursday.';
accept('an announced future action, kept future', LAYOFF, 'Intel plans to cut 15,000 jobs in restructuring');

// ── 7. unit behaviour ────────────────────────────────────────────────────────
// The helpers, directly, so a failure points at the part that broke.
sec('UNITS');

check('sourceHeadlineOf strips the prefix',
  sourceHeadlineOf('HEADLINE: Gold At $155,000\nbody here') === 'Gold At $155,000');
check('sourceHeadlineOf ignores the body',
  sourceHeadlineOf('HEADLINE: A\nB\nC') === 'A');

check('a verbless caption is framing', isFraming('Gold At $155,000 An Ounce'));
check('a caption with a verb is not framing', isFraming('Gold is at $155,000 an ounce') === false);
check('an ordinary headline is not framing', isFraming('Acme Corp raises full-year guidance') === false);
// "Why The Dollar Keeps Falling" HAS a finite verb, so the caption test declines and the sentence
// falls through to the other bands. Deliberate: the caption test is the conservative half of rule 1
// — a false negative here costs nothing, because rule 2 guards every number either way.
check('a "Why ..." headline with a verb is not a caption', isFraming('Why The Dollar Keeps Falling') === false);
check('a verbless "Why ..." headline is a caption', isFraming('Why Gold At $155,000'));

check('no marker means factual', classifyModality('Acme Corp raises guidance').class === 'factual');
check('a question ranks lowest', classifyModality('Will Gold Hit $155,000?').rank === RANK.question);
check('a target is a forecast', classifyModality('Morgan Stanley raises price target to $430').class === 'forecast');
check('"could" is a possibility', classifyModality('Acme could cut 5,000 jobs').class === 'possible');
check('empty text is treated as factual (nothing to preserve)', classifyModality('').class === 'factual');

check('achievedValues finds a governed value',
  achievedValues('Gold reaches $155,000 per ounce')[0]?.norm === '155000',
  JSON.stringify(achievedValues('Gold reaches $155,000 per ounce')));
check('achievedValues ignores an ungoverned value',
  achievedValues('Gold at $155,000 per ounce').length === 0);
check('achievedValues ignores a bare year',
  achievedValues('Nasdaq closes at a record for the first time since 2021').length === 0);

check('sourceAsserts is true for a real report',
  sourceAsserts('2700', 'Gold rose to $2,700 an ounce on Tuesday'));
check('sourceAsserts is false behind a forecast frame',
  sourceAsserts('120', 'Goldman forecasts oil reaching $120 a barrel') === false);
check('sourceAsserts is false behind a conditional frame',
  sourceAsserts('155000', 'Gold would reach $155,000 an ounce') === false);

check('valueNotAchieved returns null when nothing is claimed',
  valueNotAchieved('Acme raises guidance', 'HEADLINE: Acme raises guidance') === null);
check('attributionStripped returns null with no opinion in the source',
  attributionStripped('Acme cuts guidance', 'Acme cut its guidance') === null);

// ── 8. the gate stays out of the way when it should ──────────────────────────
sec('NON-INTERFERENCE');
check('validateModality passes an ordinary pair',
  validateModality('Acme lifts full-year outlook', 'HEADLINE: Acme Corp raises full-year guidance\nAcme raised guidance.').ok);
check('validateModality rejects empty output',
  validateModality('', 'HEADLINE: anything').ok === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
