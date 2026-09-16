// CATALYST PIT'S EDITORIAL VOICE for the Facebook Page.
//
// Walter publishes terminal copy: a leading asterisk for a flash, the whole line in capitals, and the
// outlet bolted on as a tag — "*HOUSE DEMOCRATS SEEK BIPARTISAN AI SAFEGUARDS: POLITICO". That is
// the right register for a trading terminal and the wrong one for a public Page, where it reads as
// shouting rather than reporting.
//
// WHAT THIS CHANGES: presentation only. Capitalisation, the leading asterisk, the trailing source
// tag, and terminal punctuation.
//
// WHAT THIS NEVER CHANGES: the facts. No word is added, removed or reordered — with the single,
// visible exception of turning a trailing outlet tag into the attribution phrase it already means.
// Numbers, prices, percentages, dates, times, tickers, quoted text and direction words are carried
// through untouched, and assertFactsPreserved() re-checks that on every call rather than trusting
// that the rules above are correctly written.
//
// WHY IT IS RULE-BASED AND NOT A MODEL. A rewrite that can invent is a rewrite that can libel, and
// this publishes to a public Page unattended, seconds after ingestion, with nobody reading it first.
// A deterministic transform can be wrong about a capital letter. It cannot invent an acquisition.
//
// THE COST, STATED HONESTLY. Restoring sentence case to text that was destructively upper-cased is
// not fully decidable — the information was thrown away before we received it. The rules below lean
// on evidence (the post's own mixed-case prose first, then a lexicon learned from 60 days of wire
// text) and, where they still cannot tell, they KEEP A CAPITAL. Over-capitalising a common noun
// looks slightly formal; lower-casing somebody's surname looks broken.

import { COMMON, ACRONYMS, PROPER, ENTITY_SUFFIX } from './facebook-voice-lexicon.mjs';

/** A line is "shouted" when its letters are overwhelmingly capitals and there are enough to judge. */
export function isShouted(line) {
  const letters = String(line || '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= 0.9;
}

// Outlet tags as the wires write them, always at the very end of a line:
//   "...: POLITICO"   "... - CNBC"   "...-IRNA"   "... — REUTERS"
// Only ALL-CAPS or Capitalised single names are eligible, and only up to four words, so a colon in
// ordinary prose ("BREAKING: THE FED HAS DECIDED TO ...") is not mistaken for an attribution.
// A colon may be attached to the preceding word, but a DASH must have whitespace before it —
// otherwise the hyphen inside a compound is read as a separator and "NEW SHORT-FOCUSED FUND"
// publishes as "new Short, according to Focused Fund." Found by running this over real posts.
const SOURCE_TAG = /(?:\s*:|\s+[-–—])\s*([A-Z][A-Za-z0-9&.'’]*(?:\s+[A-Z][A-Za-z0-9&.'’]*){0,3})\s*$/;
// Words that mean the tail is a sentence, not an outlet.
const NOT_A_SOURCE = /\b(SAYS?|SAID|WILL|HAS|HAVE|IS|ARE|WAS|WERE|TO|OF|IN|ON|AND|OR|THE|A|AN|NOT|NO|BE)\b/i;

/** Title Case one token: first letter up, the rest down. "BURRY" -> "Burry", "MCDONALD" -> "Mcdonald" */
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * Restore ordinary sentence case to a shouted line.
 *
 * The order of evidence is the whole design, strongest first:
 *   1. `local` — how this very post spelled the word in its own mixed-case prose. The Michael Burry
 *      item shouts its headline and then writes "Michael Burry" properly two lines down, so the post
 *      tells us the answer and nothing has to be guessed.
 *   2. ACRONYMS  — written in caps even inside mixed-case prose, so caps are correct.
 *   3. PROPER    — names, with the spelling the sources themselves use.
 *   4. COMMON    — ordinary English, and the ONLY case in which a word is lowercased.
 *   5. otherwise — keep a capital. An unknown word in a shouted line is far more often a name than
 *      a common noun the lexicon happens to be missing.
 */
export function sentenceCase(line, local = new Map()) {
  const tokens = String(line).split(/(\s+)/);

  // A capitalised run ending in a corporate suffix is one company name: "ENERGY TRANSFER LP" must not
  // become "energy transfer LP" just because "energy" is an ordinary word on its own.
  // BOUNDED, and it must be. The first version walked back to the start of the line with no stop
  // condition, so a single "ENERGY" at the end Title-Cased the entire sentence. The run stops at an
  // ordinary English word and after at most four tokens, which is the length of a real company name.
  const inEntityRun = new Set();
  const bareOf = (t) => t.replace(/[^A-Za-z.&'’-]/g, '').toUpperCase();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!ENTITY_SUFFIX.has(bareOf(tokens[i]))) continue;
    inEntityRun.add(i);
    let taken = 0;
    for (let j = i - 1; j >= 0 && taken < 4; j -= 1) {
      if (/^\s+$/.test(tokens[j])) continue;
      const prev = bareOf(tokens[j]);
      if (!prev || /\d/.test(tokens[j])) break;
      if (COMMON.has(prev)) break;                       // an ordinary word ends the name
      inEntityRun.add(j);
      taken += 1;
    }
  }

  const out = tokens.map((tok, idx) => {
    if (/^\s+$/.test(tok) || !/[A-Za-z]/.test(tok)) return tok;
    // Split leading/trailing punctuation off so quotes, brackets and commas survive untouched.
    const m = tok.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/s);
    const [, pre, core, post] = m;
    if (!core) return tok;
    // A token carrying a digit is data — a price, a date, a contract code. Never re-case it.
    if (/\d/.test(core)) return tok;
    const key = core.toUpperCase();
    // "U.S." keeps its full stops, so the trailing-punctuation split above leaves "U.S" while the
    // lexicon holds "U.S.". Both spellings are tried before the word is treated as unknown.
    const dotted = key + '.';

    let cased;
    if (local.has(key)) cased = local.get(key);
    else if (ACRONYMS.has(key)) cased = key;
    else if (ACRONYMS.has(dotted) && post.startsWith('.')) cased = key;
    else if (PROPER.has(key)) cased = PROPER.get(key);
    else if (inEntityRun.has(idx)) cased = titleCase(core);
    else if (COMMON.has(key)) cased = core.toLowerCase();
    else cased = titleCase(core);

    // Hyphenated compounds are cased part by part: "SHORT-FOCUSED" -> "short-focused".
    if (cased === titleCase(core) && core.includes('-')) {
      cased = core.split('-').map((part, i) => {
        const k = part.toUpperCase();
        if (ACRONYMS.has(k)) return k;
        if (PROPER.has(k)) return PROPER.get(k);
        if (COMMON.has(k)) return i === 0 ? part.toLowerCase() : part.toLowerCase();
        return titleCase(part);
      }).join('-');
    }
    return pre + cased + post;
  });

  // Capitalise the first letter of the line and of every new sentence. Done last so it wins over the
  // lexicon: a sentence may legitimately start with an ordinary word.
  let started = false;
  for (let i = 0; i < out.length; i += 1) {
    if (/^\s+$/.test(out[i]) || !/[A-Za-z]/.test(out[i])) continue;
    const endsSentence = /[.!?]["'’”]?$/.test(out[i]);
    if (!started) {
      out[i] = out[i].replace(/[A-Za-z]/, (c) => c.toUpperCase());
      started = true;
    } else if (endsSentence) {
      // Mark the NEXT word-bearing token as sentence-initial.
      for (let j = i + 1; j < out.length; j += 1) {
        if (/^\s+$/.test(out[j]) || !/[A-Za-z]/.test(out[j])) continue;
        if (/\d/.test(out[j])) break;
        out[j] = out[j].replace(/[A-Za-z]/, (c) => c.toUpperCase());
        break;
      }
    }
  }
  return out.join('');
}

/**
 * Learn how THIS post spells its own names, from the paragraphs it wrote in mixed case.
 * The post is always the best authority on itself.
 */
function localCasing(paragraphs) {
  const map = new Map();
  for (const p of paragraphs) {
    if (isShouted(p)) continue;
    for (const w of p.match(/[A-Za-z][A-Za-z'’.&-]*/g) || []) {
      if (w.length < 2 || !/[A-Z]/.test(w)) continue;
      const k = w.toUpperCase();
      if (!map.has(k)) map.set(k, w);
    }
  }
  return map;
}

/** Pull a trailing outlet tag off a line, returning the line and the outlet (or null). */
export function splitSourceTag(line) {
  const m = String(line).match(SOURCE_TAG);
  if (!m) return { body: line, outlet: null };
  const outlet = m[1].trim();
  const body = line.slice(0, line.length - m[0].length);
  // Guard against prose: "...: THE FED WILL ACT" is a sentence, not an attribution.
  if (NOT_A_SOURCE.test(outlet)) return { body: line, outlet: null };
  if (!/[A-Za-z]/.test(body) || body.trim().split(/\s+/).length < 3) return { body: line, outlet: null };
  // AND it must be an outlet we recognise. Without this, any capitalised tail became a source:
  // "WHAT TO WATCH TODAY — U.S. MARKETS" was published as "according to U.S. Markets".
  if (!isKnownOutlet(outlet)) return { body: line, outlet: null };
  return { body, outlet };
}

/**
 * KNOWN OUTLETS, and an attribution is only ever built from one of these.
 *
 * The rule used to accept any capitalised tail after a dash or colon, which turned the heading
 * "WHAT TO WATCH TODAY — U.S. MARKETS" into "What to watch today, according to U.S. Markets" —
 * inventing a source that was never claimed. That is the one class of error this file exists to
 * prevent, so the tail must now name an outlet we actually recognise. An unrecognised tail is left
 * exactly where it was: no attribution, no rewording, nothing lost.
 */
const OUTLET_CASE = new Map([
  ['CNBC', 'CNBC'], ['BBC', 'BBC'], ['WSJ', 'WSJ'], ['FT', 'FT'], ['AFP', 'AFP'], ['AP', 'AP'],
  ['IRNA', 'IRNA'], ['TASS', 'TASS'], ['RIA', 'RIA'], ['DPA', 'DPA'], ['PTI', 'PTI'], ['ANSA', 'ANSA'],
  ['NYT', 'NYT'], ['NY POST', 'NY Post'], ['SCMP', 'SCMP'], ['KCNA', 'KCNA'], ['ABC', 'ABC'],
  ['CNN', 'CNN'], ['NBC', 'NBC'], ['CBS', 'CBS'], ['MNI', 'MNI'], ['IFR', 'IFR'], ['LSEG', 'LSEG'],
  ['RTRS', 'Reuters'], ['REUTERS', 'Reuters'], ['BLOOMBERG', 'Bloomberg'], ['POLITICO', 'Politico'],
  ['AXIOS', 'Axios'], ['SEMAFOR', 'Semafor'], ['NIKKEI', 'Nikkei'], ['XINHUA', 'Xinhua'],
  ['KYODO', 'Kyodo'], ['YONHAP', 'Yonhap'], ['INTERFAX', 'Interfax'], ['ANADOLU', 'Anadolu'],
  ['STATE TV', 'State TV'], ['STATE MEDIA', 'state media'], ['AL JAZEERA', 'Al Jazeera'],
  ['AL ARABIYA', 'Al Arabiya'], ['SANA', 'SANA'], ['MEHR', 'Mehr'], ['FARS', 'Fars'],
  ['TASNIM', 'Tasnim'], ['ISNA', 'ISNA'], ['SABA', 'Saba'], ['TRT', 'TRT'],
  ['THE INFORMATION', 'The Information'], ['THE TIMES', 'The Times'], ['GUARDIAN', 'The Guardian'],
  ['TELEGRAPH', 'The Telegraph'], ['HANDELSBLATT', 'Handelsblatt'], ['LES ECHOS', 'Les Echos'],
  ['MARKETWATCH', 'MarketWatch'], ['BARRONS', 'Barron\'s'], ['FORBES', 'Forbes'],
  ['BUSINESS INSIDER', 'Business Insider'], ['THE BLOCK', 'The Block'], ['COINDESK', 'CoinDesk'],
  ['GLOBES', 'Globes'], ['YNET', 'Ynet'], ['HAARETZ', 'Haaretz'], ['JPOST', 'The Jerusalem Post'],
  ['WAM', 'WAM'], ['SPA', 'SPA'], ['QNA', 'QNA'], ['KUNA', 'KUNA'], ['BNA', 'BNA'],
]);
const isKnownOutlet = (o) => OUTLET_CASE.has(String(o).trim().toUpperCase().replace(/\.$/, ''));
const caseOutlet = (o) => {
  const k = o.toUpperCase();
  if (OUTLET_CASE.has(k)) return OUTLET_CASE.get(k);
  return o.split(/\s+/).map((w) => {
    const u = w.toUpperCase();
    if (ACRONYMS.has(u) && u.length <= 4) return u;
    if (PROPER.has(u)) return PROPER.get(u);
    return titleCase(w);
  }).join(' ');
};

/**
 * THE FACT GUARD. Re-derives the load-bearing content from both strings and refuses the rewrite if
 * anything moved. This is not a substitute for the rules being right; it is what makes a bug in them
 * harmless, because a mismatch means the ORIGINAL text is published.
 */
export function assertFactsPreserved(before, after) {
  const digits = (s) => (s.match(/\d[\d,.:%]*/g) || []).map((x) => x.replace(/[.,:]+$/, ''));
  const tickers = (s) => (s.match(/\$[A-Za-z.]{1,6}\b/g) || []);
  const quoted = (s) => (s.match(/[""„«][^""„«»]{0,400}[""»]|"[^"]{0,400}"/g) || []);
  const letters = (s) => s.replace(/[^A-Za-z]/g, '').toUpperCase();
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  if (!same(digits(before), digits(after))) return 'numbers changed';
  if (!same(tickers(before), tickers(after))) return 'tickers changed';
  if (!same(quoted(before), quoted(after))) return 'quoted text changed';
  // Every letter must survive in order, ignoring case. This is the strong one: it catches a dropped
  // word, a reordered clause or a deleted clause, and it is why nothing here can silently rewrite a
  // fact. The attribution phrase is the one sanctioned addition, so it is discounted — from BOTH
  // sides. Removing it only from the output made every post that already contained the words
  // "according to" report a false mismatch, which is 10 of the 118 posts in the corpus.
  const discount = (s) => letters(s.replace(/,?\s*according to\s+/gi, ' '));
  if (discount(before) !== discount(after)) return 'wording changed';
  return null;
}

/**
 * Rewrite one post into Catalyst Pit's voice. Pure, deterministic, and total: any input returns a
 * string, and any doubt returns the input unchanged.
 */
export function editorialize(text) {
  const input = String(text ?? '');
  if (!input.trim()) return input;

  const paragraphs = input.split('\n');
  const local = localCasing(paragraphs);

  const rewritten = paragraphs.map((para) => {
    if (!para.trim()) return para;                       // blank lines hold the structure: keep them
    // The terminal's flash marker. It means "this is a headline", which the Page conveys by being a
    // post, so it carries no information here.
    let line = para.replace(/^\s*\*+\s*/, '');

    const { body, outlet } = splitSourceTag(line);
    let core = outlet ? body : line;
    if (isShouted(core)) core = sentenceCase(core, local);
    core = core.replace(/\s+$/, '');

    if (outlet) {
      core = core.replace(/[,;:]\s*$/, '');
      core += `, according to ${caseOutlet(outlet)}`;
    }
    // A headline is a statement; give it a full stop so the Page reads as prose rather than a feed.
    if (core && !/[.!?…:"'’”)\]]$/.test(core)) core += '.';
    return core;
  });

  const out = rewritten.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || input;
}

/**
 * The only entry point publishing should use.
 *
 * FAILURE-SAFE BY CONSTRUCTION. A throw, an empty result, or any fact that moved returns the
 * ORIGINAL text, so the worst case of a rewriting bug is that the Page gets the wire copy it would
 * have got anyway. It can never be the reason a post fails to publish.
 */
export function editorialVoice(text) {
  const input = String(text ?? '');
  try {
    const out = editorialize(input);
    if (!out || !out.trim()) return input;
    const broke = assertFactsPreserved(input, out);
    if (broke) return input;
    return out;
  } catch {
    return input;
  }
}
