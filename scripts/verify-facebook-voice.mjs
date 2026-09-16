// CATALYST PIT'S EDITORIAL VOICE: that it changes presentation and never changes a fact.
//
// The two examples this was built from are pinned exactly. Everything else here exists because the
// risk in a rewriter is not that it reads awkwardly — it is that it quietly alters what was said.
// With DATABASE_URL present, section 7 runs the transform over EVERY Walter post we hold and
// re-checks the invariants on real text rather than on examples chosen to pass.
//
//   node --env-file=.env.local scripts/verify-facebook-voice.mjs

import { editorialVoice, editorialize, sentenceCase, isShouted, splitSourceTag,
  assertFactsPreserved } from '../src/lib/facebook-voice.mjs';
import { facebookText } from '../src/lib/facebook-post.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

const HOUSE_IN = '*HOUSE DEMOCRATS SEEK BIPARTISAN AI SAFEGUARDS: POLITICO';
const BURRY_IN = [
  'MICHAEL BURRY JOINS NEW SHORT-FOCUSED FUND',
  '',
  '“Big Short” investor Michael Burry is joining Minerva Investment Management as senior adviser to'
    + ' help launch a new short-biased fund expected within a month.',
  '',
  'Burry has recently targeted AI hyperscalers and chipmakers, criticizing aggressive depreciation'
    + ' practices.',
  '',
  'He currently holds bearish positions on Nvidia and Palantir, bringing his growing AI skepticism'
    + ' directly into the new fund’s strategy.',
].join('\n');

section('1. the House Democrats example — a shouted flash becomes a sentence');
{
  const out = editorialVoice(HOUSE_IN);
  console.log('    ' + out);
  ok('the exact expected copy',
    out === 'House Democrats seek bipartisan AI safeguards, according to Politico.', JSON.stringify(out));
  ok('the flash asterisk is gone', !out.startsWith('*'));
  ok('it is no longer shouting', !isShouted(out));
  ok('the outlet tag became an attribution', /according to Politico/.test(out));
  ok('the outlet is not dropped', /Politico/.test(out));
  ok('AI keeps its capitals', /\bAI\b/.test(out) && !/\bAi\b/.test(out));
  ok('the proper noun keeps its capitals', /House Democrats/.test(out));
  ok('it ends as a sentence', out.endsWith('.'));
  ok('no word was invented',
    assertFactsPreserved(HOUSE_IN, out) === null, String(assertFactsPreserved(HOUSE_IN, out)));
}

section('2. the Michael Burry example — detail kept, structure kept, headline calmed');
{
  const out = editorialVoice(BURRY_IN);
  const lines = out.split('\n');
  console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
  ok('the shouted headline is now a sentence',
    lines[0] === 'Michael Burry joins new short-focused fund.', JSON.stringify(lines[0]));
  // THE BUG THIS PINS. The hyphen in SHORT-FOCUSED was read as a source-tag separator and produced
  // "Michael Burry joins new Short, according to Focused Fund."
  ok('a hyphenated compound is NOT read as a source tag', !/according to/.test(lines[0]));
  ok('the blank lines between paragraphs survive', /\n\n/.test(out));
  ok('all four paragraphs are still there', lines.filter((l) => l.trim()).length === 4);
  ok('the already-clean body is left completely alone',
    out.includes('“Big Short” investor Michael Burry is joining Minerva Investment Management as'
      + ' senior adviser to help launch a new short-biased fund expected within a month.'));
  ok('the second body paragraph is untouched',
    out.includes('Burry has recently targeted AI hyperscalers and chipmakers, criticizing aggressive'
      + ' depreciation practices.'));
  ok('the third body paragraph is untouched',
    out.includes('He currently holds bearish positions on Nvidia and Palantir, bringing his growing'
      + ' AI skepticism directly into the new fund’s strategy.'));
  ok('company and person names are intact',
    /Michael Burry/.test(out) && /Minerva Investment Management/.test(out)
    && /Nvidia/.test(out) && /Palantir/.test(out));
  ok('the quoted nickname is byte-identical', out.includes('“Big Short”'));
  ok('no fact moved', assertFactsPreserved(BURRY_IN, out) === null);
}

section('3. facts are never altered');
{
  const cases = [
    ['*US 20Y BONDS DRAW 5.420% VS 5.400% PRE-SALE WHEN-ISSUED YIELD', ['5.420%', '5.400%', '20Y']],
    ['CBO SAYS THE WAR IN IRAN COST THE U.S. $38 BLN IN THE FIRST FIVE MONTHS', ['$38', 'U.S.']],
    ['FED HOLDS RATES AT 4.25%-4.50%, SIGNALS ONE MORE CUT IN 2026', ['4.25%', '4.50%', '2026']],
    ['APPLE $AAPL RISES 3.2% AFTER Q3 BEAT', ['$AAPL', '3.2%', 'Q3']],
    ['OIL FALLS 1.8% TO $71.40 A BARREL', ['1.8%', '$71.40']],
    ['ECB\'S LAGARDE: INFLATION AT 2.1% IN AUGUST', ['2.1%']],
  ];
  for (const [input, musts] of cases) {
    const out = editorialVoice(input);
    for (const m of musts) ok(`${m} survives`, out.includes(m), out);
    ok(`no fact moved: ${input.slice(0, 34)}…`, assertFactsPreserved(input, out) === null, out);
  }
  // Direction words carry the entire meaning of a market headline.
  for (const [word, line] of [['RISES', 'SHARES RISE AFTER EARNINGS BEAT'], ['FALL', 'SHARES FALL AFTER EARNINGS MISS'],
    ['CUTS', 'FED CUTS RATES BY 25 BASIS POINTS'], ['RAISES', 'FED RAISES RATES BY 25 BASIS POINTS']]) {
    const out = editorialVoice(line);
    ok(`direction is preserved in "${line.slice(0, 26)}…"`,
      out.toUpperCase().includes(word.slice(0, 4)), out);
  }
}

section('3b. an unknown word keeps its capital, and an entity run stays short');
{
  // THE DELIBERATE BIAS. A word in no lexicon is far more often a name than a common noun we happen
  // to be missing, so the fallback capitalises. Lower-casing a surname looks broken; capitalising an
  // ordinary noun merely looks formal. Asserted mid-sentence, where the sentence-initial rule cannot
  // mask it. These surnames are not in the lexicon, which is the point.
  const out = editorialVoice('FED OFFICIAL KASHKARI AND MINISTER VUJCIC SAY RATES WILL RISE');
  ok('an unknown surname keeps its capital', /Kashkari/.test(out), out);
  ok('a second unknown surname keeps its capital', /Vujcic/.test(out), out);
  ok('and is not lowercased', !/kashkari/.test(out) && !/vujcic/.test(out), out);
  ok('ordinary words around it are still lowercased', /say rates will rise/.test(out), out);

  // THE ENTITY RUN MUST BE BOUNDED. It walks backwards from a legal suffix to Title Case a company
  // name; with no stop condition one "HOLDINGS" at the end Title-Cased the clause in front of it.
  const ent = editorialVoice('PRICES WILL GO DOWN AT ACME HOLDINGS');
  ok('the company name is Title Cased', /Acme Holdings/.test(ent), ent);
  // "Prices" is capitalised because it starts the sentence, which is correct; what must NOT happen
  // is the run reaching back and capitalising "will go down at" too.
  ok('the ordinary clause before it is NOT', /will go down at/.test(ent), ent);
  const ent2 = editorialVoice('THE BOARD SAID IT WILL REVIEW THE OFFER FROM NORTHSTAR TECHNOLOGIES');
  ok('a longer clause is untouched by the run', /said it will review the offer from/.test(ent2), ent2);
  ok('the name at the end is still cased', /Northstar Technologies/.test(ent2), ent2);
}

section('4. the attribution rule is narrow');
{
  ok('a trailing outlet is an attribution',
    /according to CNBC/.test(editorialVoice('OPENAI CFO SAYS IT WILL SLOW DOWN IF NEEDED - CNBC')));
  // A colon in ordinary prose is NOT an attribution, and neither is a speaker prefix.
  const kremlin = editorialVoice('*KREMLIN: IF SANCTIONS ARE LIFTED, WORLD ENERGY PRICES WILL GO DOWN');
  ok('a leading speaker prefix is left alone', !/according to/.test(kremlin), kremlin);
  ok('the clause after it is kept whole', /sanctions are lifted/i.test(kremlin), kremlin);
  const short = editorialVoice('OIL UP: BRENT');
  ok('too short a body is not treated as a tag', short.includes('BRENT') || short.includes('Brent'));
  ok('a sentence tail is not an outlet',
    !/according to/.test(editorialVoice('TRUMP SAYS THE DEAL WILL BE SIGNED AND THE WAR WILL END')));
  const { outlet } = splitSourceTag('SHARES SLIDE ON WEAK GUIDANCE - REUTERS');
  ok('splitSourceTag finds a real outlet', outlet === 'REUTERS', String(outlet));
  ok('splitSourceTag ignores a hyphenated compound',
    splitSourceTag('FIRM LAUNCHES NEW SHORT-FOCUSED FUND').outlet === null);
}

section('5. already-clean prose is left alone');
{
  const clean = 'Michael Burry is joining Minerva Investment Management as senior adviser.';
  ok('mixed-case prose is returned unchanged', editorialVoice(clean) === clean, editorialVoice(clean));
  const multi = 'First paragraph here.\n\nSecond paragraph here.';
  ok('paragraph structure is preserved exactly', editorialVoice(multi) === multi);
  ok('a short flash stays short',
    editorialVoice('*BREAKING: FED CUTS RATES').split('\n').length === 1);
  ok('empty input is safe', editorialVoice('') === '');
  ok('null is safe', editorialVoice(null) === 'null' || editorialVoice(null) === '');
  ok('undefined is safe', typeof editorialVoice(undefined) === 'string');
}

section('6. it can never block a post');
{
  // The guard must swallow anything. If it throws, an eligible post does not publish.
  for (const weird of ['', ' ', '\n\n\n', '*', '***', ':', '- CNBC', '🇺🇸', 'A'.repeat(5000),
    ' ', '<<<>>>', '....', '"unclosed', '((((']) {
    let threw = false, out = null;
    try { out = editorialVoice(weird); } catch { threw = true; }
    ok(`no throw on ${JSON.stringify(weird.slice(0, 12))}`, !threw);
    ok(`always a string for ${JSON.stringify(weird.slice(0, 12))}`, typeof out === 'string');
  }
  // A rewrite that loses a fact must fall back to the original, not publish the damage.
  ok('a broken rewrite is rejected by the guard',
    assertFactsPreserved('OIL FALLS 2% TO $70', 'Oil falls 3% to $70') === 'numbers changed');
  ok('a dropped clause is caught',
    assertFactsPreserved('FED CUTS RATES AND SIGNALS MORE', 'Fed cuts rates.') === 'wording changed');
  ok('a changed ticker is caught',
    assertFactsPreserved('$AAPL RISES', '$MSFT rises') !== null);
  ok('altered quoted text is caught',
    assertFactsPreserved('HE SAID "WE WILL ACT"', 'He said "we will not act"') !== null);

  // And the wiring: facebookText must apply it, and must still return the text if it cannot.
  const t = facebookText({ source_headline: HOUSE_IN + ' (@WalterBloomberg)' });
  ok('facebookText publishes the edited copy',
    t === 'House Democrats seek bipartisan AI safeguards, according to Politico.', JSON.stringify(t));
  ok('the Walter watermark is still removed first', !/WalterBloomberg/i.test(t));
  ok('facebookText still returns null with no text', facebookText({}) === null);
}

if (!process.env.DATABASE_URL) {
  console.log('\n(section 7 skipped — no DATABASE_URL)');
} else {
  section('7. every Walter post we hold, checked for altered facts');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`select seq, source_headline from primary_events
    where (source_name ilike '%walter%' or source ilike '%walter%') and source_headline is not null`;
  let changed = 0, identical = 0, broke = 0, shouted = 0;
  const examples = [];
  for (const r of rows) {
    const input = facebookTextInput(r.source_headline);
    const out = editorialVoice(input);
    const why = assertFactsPreserved(input, out);
    if (why) { broke += 1; console.error(`  FAIL seq ${r.seq}: ${why}\n    in : ${input.slice(0, 120)}\n    out: ${out.slice(0, 120)}`); }
    if (out === input) identical += 1; else { changed += 1; if (examples.length < 6) examples.push([input, out]); }
    if (isShouted(input)) shouted += 1;
  }
  console.log(`  ${rows.length} posts   rewritten ${changed}   unchanged ${identical}   shouted originals ${shouted}`);
  for (const [i, o] of examples) {
    console.log('    - ' + i.split('\n')[0].slice(0, 96));
    console.log('      ' + o.split('\n')[0].slice(0, 96));
  }
  ok('no post in the corpus has a fact altered', broke === 0, broke + ' of ' + rows.length);
  ok('the corpus is actually being transformed', changed > rows.length * 0.5, changed + '/' + rows.length);
  ok('nothing became empty', rows.every((r) => editorialVoice(facebookTextInput(r.source_headline)).trim().length > 0));
}

// The same normalisation facebookText applies before the voice runs, so section 7 measures the real
// input rather than the stored string.
function facebookTextInput(sourceHeadline) {
  return String(sourceHeadline)
    .replace(/\r\n?/g, '\n').replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .replace(/\s*\(\s*@WalterBloomberg\s*\)\s*$/i, '')
    .trim();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
