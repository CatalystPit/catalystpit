// Is this headline materially non-English? PURE: no DB, no network, no AI.
//
// Catalyst Pit publishes ONE canonical English event line. The wires it reads do not: GlobeNewswire,
// PR Newswire and the Nordic exchange feeds carry issuer announcements in Icelandic, Danish,
// Swedish, Finnish, German, French and more, usually alongside an English edition of the same
// release. Nothing in the engine ever looked at the LANGUAGE of a headline, so a foreign one was
// ingested, marked display-ready on its shape alone (length and word count, which foreign text
// passes trivially) and rendered verbatim on the public wire.
//
// The rewrite queue cannot rescue it either, and that is worth stating plainly: the anti-fabrication
// gate in predicate-grounding.mjs classifies the SOURCE sentence with English verb families, so a
// foreign source classifies as nothing, and any English rewrite that does classify is rejected as
// "an event class the source never asserted". A foreign headline is therefore structurally unable
// to become an English one, and it sits at rewrite_pending or source_fallback with its raw text on
// screen. Detection has to happen, and what it gates is DISPLAY.
//
// DESIGN: HIGH PRECISION, deliberately. A false positive suppresses real market news, which is
// worse than the leak it prevents, so every rule below fires only on positive evidence of another
// language — a non-Latin script, or function words that do not exist in English — and never on the
// mere absence of English. A terse all-caps flash ("APPLE Q3 EPS $1.40 BEATS EST") carries no
// English function words at all and must stay.

// ── evidence: English ────────────────────────────────────────────────────────
// Function words and the verb vocabulary headlines actually use. Presence of these is what makes a
// sentence provably English; their absence proves nothing.
const ENGLISH = new Set(`
the a an and or but if to in of for on at by from with without into onto out up down over under
after before during since until while about against between among across near off per via vs versus
plus amid ahead is are was were be been being has have had will would can could should must may
might does did not no nor than then that this these those it its they their them he she his her
we our you your as so such more most less least new first second third next last than now also both
each any all other another own same only just still yet more
says said say announces announced announce reports reported report posts posted post beats beat
misses missed miss raises raised raise cuts cut lifts lifted lift names named name appoints
appointed appoint launches launched launch wins won win files filed file sets set plans planned
plan agrees agreed agree buys bought buy sells sold sell acquires acquired acquire expands expanded
opens opened open closes closed close adds added add drops dropped drop rises rose rise falls fell
fall jumps jumped jump slides slid gains gained gain loses lost lose signs signed sign completes
completed complete receives received receive issues issued issue declares declared declare approves
approved approve rejects rejected reject halts halted halt resumes resumed resume boosts boosted
trims trimmed hikes hiked upgrades upgraded downgrades downgraded extends extended delays delayed
ends ended starts started begins began joins joined exits exited seeks sought faces faced hits hit
tops topped holds held keeps kept sees saw expects expected warns warned confirms confirmed denies
denied prices priced offers offered enters entered takes took gives gave makes made calls called
shares stock stocks market markets quarter quarterly year annual results revenue earnings guidance
profit loss sales growth deal offer bid stake merger dividend buyback outlook forecast update
presents present portable display displays technology platform solutions service services product
products partnership agreement launch chief officer board unit business
`.trim().split(/\s+/));

// ── evidence: not English ────────────────────────────────────────────────────
// Function words from the languages that actually appear on these wires. Every entry is checked
// against ENGLISH below and any overlap is removed by construction, so a hit here can never be an
// ordinary English word. Content nouns are included only where they are unmistakable ("aktier",
// "société", "spółki") because a headline can be foreign without containing a single particle.
const FOREIGN_RAW = `
og að um við ekki hefur verður verða sem frá þá þetta hjá eða með munu vegna samkvæmt skilmála
vaxta ákvörðun upplýsingagjöf hlutafé félagsins niðurstöður
af til fra ikke har med som ved den det om er på kroner selskabet aktier aktie regnskab årsrapport
uge transaktioner aktietilbagekøb aktietilbagekøbsprogram tilbagekøb
och att för från inte den det om är kronor bolaget bolag aktien delårsrapport bokslutskommuniké
vecka återköp viikko vika
ja on ei että sekä sen yhtiö yhtiön osake osakkeen mukaan vuoden tilinpäätös osavuosikatsaus
der die das und für von mit im zum zur nach bei wird wurde nicht eine einen einem über aus dem den
sind auf des durch gegen sich werden haben geschäftsjahr aktien vorstand aufsichtsrat hauptversammlung
le la les des du une et pour avec dans sur par aux ses son sa sont société résultats exercice
assemblée chiffre affaires actionnaires communiqué dépôt semestriel trimestriel hebdomadaire
rachat déclaration opérations
el los las del una para con por que se su sus son sociedad acciones resultados junta accionistas
ejercicio informe
il lo gli dei delle della degli una che non sono società azioni bilancio assemblea risultati
de het een van voor met niet op zijn wordt naar bij aan over jaarverslag aandelen vennootschap
os da dos das uma não são empresa ações relatório exercício demonstrações
na do nie się oraz spółki spółka akcji akcje raport walne zgromadzenie jak nowe
se je pro společnost akcie zpráva valná hromada ktorá ktora ako pre aby však také jako przez
dla jej oraz także która który sie wszystkich
ning selle aktsiaselts aruanne üldkoosolek
ir un par no ar bendrovė bendrovės akcijų ataskaita sabiedrība akciju pranešimas apie dėl
vertybinių emitento sandorius
és az egy nem meg társaság részvény közgyűlés jelentés
si pentru cu societatea acțiuni raportul adunarea
ve bir için ile şirket hisse genel kurul raporu
`.trim().split(/\s+/);
const FOREIGN = new Set(FOREIGN_RAW.filter((w) => w.length >= 2 && !ENGLISH.has(w)));

// ── scripts ──────────────────────────────────────────────────────────────────
const NON_LATIN = /[Ͱ-ϿЀ-ӿ԰-֏֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯]/;
const NON_LATIN_G = new RegExp(NON_LATIN.source, 'g');
// Latin letters carrying diacritics, plus the Nordic letters that are their own characters.
const DIACRITIC_G = /[À-ÿĀ-ɏ]/g;
const LETTER_G = /[\p{L}]/gu;

const countOf = (s, re) => (s.match(re) || []).length;

// ── tokenisation ─────────────────────────────────────────────────────────────
// A word list that keeps the ORIGINAL case, because case is what identifies a proper noun, and a
// proper noun is where a foreign particle is allowed to appear inside an English sentence:
// "Banco de la Nacion agrees to buy stake" is English prose wrapped around a Spanish NAME. A
// lowercase particle sitting between two capitalised words is part of that name, not evidence.
function tokensOf(text) {
  return String(text || '').split(/[^\p{L}\p{M}'’]+/u).filter(Boolean);
}
const isCapped = (w) => /^[\p{Lu}]/u.test(w);

/**
 * Weigh the evidence in one string.
 * @returns {{ english:string[], foreign:string[], words:number, nonLatinRatio:number, diacriticRatio:number }}
 */
export function languageEvidence(text) {
  const raw = String(text || '');
  const toks = tokensOf(raw);
  const english = new Set();
  const foreign = new Set();
  const lower = new Set();   // the subset written in lower case in the original

  // In a normal sentence a capitalised word is a NAME, which is what lets the guard below tell
  // "Banco de la Nacion" apart from Spanish prose. In a Title Case headline every word is
  // capitalised, so capitalisation says nothing at all — and applying the guard there hid the French
  // particles in "Depot du Rapport Financier Semestriel Groupama" behind their own neighbours.
  const capped = toks.filter(isCapped).length;
  const titleCase = toks.length >= 3 && capped / toks.length >= 0.8;

  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].toLowerCase().replace(/['’]s$/, '');
    if (ENGLISH.has(w)) { english.add(w); continue; }
    if (!FOREIGN.has(w)) continue;
    // Inside a capitalised name ("Banco de la Nacion", "Societe Generale de Banque"), a particle is
    // part of the name. Only a particle with ordinary lowercase company on at least one side counts.
    const prev = toks[i - 1], next = toks[i + 1];
    if (!titleCase && !isCapped(toks[i]) && prev && next && isCapped(prev) && isCapped(next)) continue;
    foreign.add(w);
    // CASE AND LENGTH CARRY EVIDENCE, because the ambiguity is entirely among SHORT tokens. SEC
    // filing titles are "AMPHENOL CORP /DE/ · 8-K" and "OS Therapies Inc", where DE is Delaware and
    // OS is a company name, not French or Icelandic; "LA Rams", "Sen. Fetterman", "MIT research",
    // "pro sports" and "de-escalation" are the same trap. A foreign sentence writes its particles in
    // lower case. A long word does not have that problem at all: "Aktsiaselts", "Geschaftsjahr" and
    // "spolecnost" are not abbreviations of anything English, whatever case they are written in,
    // and requiring lower case there missed Estonian headlines outright.
    if (!isCapped(toks[i]) || w.length >= 6) lower.add(w);
  }

  const letters = countOf(raw, LETTER_G);
  return {
    english: [...english],
    foreign: [...foreign],
    strongForeign: [...lower],
    words: toks.length,
    nonLatinRatio: letters ? countOf(raw, NON_LATIN_G) / letters : 0,
    diacriticRatio: letters ? countOf(raw, DIACRITIC_G) / letters : 0,
  };
}

/**
 * Is this text materially non-English?
 * @returns {{ nonEnglish:boolean, reason:string|null, evidence:object }}
 */
export function detectNonEnglish(text) {
  const ev = languageEvidence(text);
  const no = (reason) => ({ nonEnglish: true, reason, evidence: ev });
  // A couple of foreign characters in a name is not a foreign sentence, so every rule needs a
  // sentence to judge.
  if (ev.words < 2) return { nonEnglish: false, reason: null, evidence: ev };

  // Another writing system entirely. Nothing about this is ambiguous.
  if (ev.nonLatinRatio >= 0.2) return no('non-latin script');
  // Foreign function words carry the most weight because they cannot occur in English by accident.
  if (ev.foreign.length >= 3) return no(`foreign function words: ${ev.foreign.slice(0, 4).join(', ')}`);
  if (ev.foreign.length >= 2 && ev.english.length <= 1) return no(`foreign function words: ${ev.foreign.join(', ')}`);
  // ONE match is only evidence when it is written the way a function word is written, in a sentence
  // long enough to have been one. Below that bar a single match is an abbreviation or a name.
  // A two-letter particle is the weakest evidence there is and cannot carry a suppression on its
  // own: "DuPont de Nemours, Inc. - 8-K" is a Delaware chemical company, not French prose. Three
  // letters or more, written as a function word, in a sentence long enough to be one.
  const single = ev.strongForeign.find((w) => w.length >= 3);
  if (single && ev.english.length === 0 && ev.words >= 4) return no(`foreign function word: ${single}`);
  // No English evidence at all, and the letters themselves are heavily accented. An English headline
  // that merely names Nestle or Orsted does not reach this: one accented letter in a sentence is
  // ~3%, and it would have to carry no English word of any kind as well.
  if (ev.english.length === 0 && ev.words >= 3 && ev.diacriticRatio >= 0.06) return no('accented text with no English');
  return { nonEnglish: false, reason: null, evidence: ev };
}

/**
 * The gate the engine uses. The HEADLINE decides, because the headline is what gets published. The
 * summary is corroboration for the one genuinely ambiguous case: a headline with no English evidence
 * whatsoever, which on its own is not proof of anything.
 */
export function materiallyNonEnglish(headline, summary = '') {
  const h = detectNonEnglish(headline);
  if (h.nonEnglish) return { nonEnglish: true, reason: h.reason, evidence: h.evidence };
  // The body only gets a vote when the HEADLINE is itself suspect — it carries a foreign particle or
  // accented letters. A wire routinely files an English headline over a foreign body ("Hisense
  // presents RoamView portable display" over Slovak copy), and that headline is publishable English:
  // suppressing it would be exactly the false positive this module is built to avoid.
  const suspect = h.evidence.foreign.length > 0 || h.evidence.diacriticRatio >= 0.04;
  if (!summary || !suspect || h.evidence.english.length > 0 || h.evidence.words < 3) {
    return { nonEnglish: false, reason: null, evidence: h.evidence };
  }
  const s = detectNonEnglish(summary);
  if (s.nonEnglish) return { nonEnglish: true, reason: `body text is non-English (${s.reason})`, evidence: h.evidence };
  return { nonEnglish: false, reason: null, evidence: h.evidence };
}

/** Convenience boolean for call sites that only need the verdict. */
export const isNonEnglish = (headline, summary = '') => materiallyNonEnglish(headline, summary).nonEnglish;
