// The public wire must never carry untranslated foreign source text, and must never suppress a real
// English headline to achieve that. Both halves are tested here, and the second half is the one that
// matters more: a false positive deletes real market news from the product.
//
// Every foreign example below is a VERBATIM headline that was live on Pit Wire. Every English
// example is either a verbatim live headline or the exact shape that broke an earlier draft of the
// detector (SEC filing titles, "LA Rams", "Sen. Fetterman", "MIT research", "pro sports",
// "de-escalation", French and Spanish company NAMES inside English sentences).
//
// Run: node scripts/verify-language.mjs

import { detectNonEnglish, materiallyNonEnglish, languageEvidence } from '../src/lib/language.mjs';
import { publicationVerdict } from '../src/lib/x-quality.mjs';
import { normalize } from '../src/lib/primary-sources.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } };

// ── must be caught: verbatim from live Pit Wire ──────────────────────────────
const FOREIGN = [
  'SÍL 2 hs. - ákvörðun vaxta og almenn upplýsingagjöf',
  'SÍL 3 hs. - ákvörðun vaxta og almenn upplýsingagjöf',
  'Niðurstöður í útboði ríkisvíxla - RIKV 26 1216 - RIKV 27 0317',
  'Festi hf.: Reglubundin tilkynning um kaup á eigin bréfum í samræmi við endurkaupaáætlun - vika 37',
  'Kvika banki hf.: Jón Birgir Jónsson ráðinn forstjóri Kviku banka',
  'Traustur rekstur en verðbólgan til vandræða',
  'FORVIA: Déclaration des transactions sur actions propres du 7 au 10 septembre 2026',
  'Dépôt du Rapport Financier Semestriel 2026 Groupama',
  'Capgemini signe un accord définitif de vente de Capgemini Government Solutions',
  'Communiqué de presse: Sanofi et Cheplapharm créent un nouveau partenariat stratégique autour des médicaments matures',
  'SIS: Savaria augmente son dividende de 5,36 %',
  'METLEN y PETRONAS firman un acuerdo de suministro de GNL en el sureste de Europa',
  'Trump ataca a CEO de Anthropic por llamado a ralentizar la IA',
  'Venezuela lleva la dolarización al centro del debate',
  'FEMSA Anuncia Acuerdo de Recompra Acelerada de Acciones',
  'Brasil se suma al grupo global de expansión del biometano',
  'Miral investiert 12 Milliarden AED, um die nächste Wachstumsphase von Yas Island zu gestalten',
  'Pudu Robotics baut nach der IFA 2026 seine Präsenz in Europa aus und treibt eine Strategie für skaliertes und lokalisiertes Wachstum voran',
  'Cyble ernennt Cybersicherheitsexperten Steve Ingram zum Executive Vice President USA, um die Marktexpansion voranzutreiben',
  'Datamaran ernennt Marlies Gevaert zur kaufmännischen Leiterin',
  'Transaktioner i henhold til aktietilbagekøbsprogram',
  'Aktietilbagekøb: Transaktioner i uge 37 2026',
  'Bavarian Nordic – transaktioner i forbindelse med aktietilbagekøbsprogram',
  'Aktsiaselts Infortar omandas täiendava osaluse Aktsiaseltsis Tallink Grupp',
  'Aktsiaselts Infortar omandab oma aktsiaid Nasdaq Tallinna börsil',
  'TS Shippingu jäämurdja MPSV Botnica töö Põhjamerel',
  'Pranešimas apie vadovo sandorius dėl Emitento vertybinių popierių',
  'Czysta energia dla wszystkich: BLUETTI i UN-Habitat rozszerzają wspólne działania na Nigerię',
  'CGTN: Jak BRICS tworzy nowe możliwości rozwoju Globalnego Południa',
  'Khloé Kardashianová oznamuje rozšíření prodeje do sítě Sephora se svým celosvětově oceněným portfoliem parfémů',
  'Hisense predstavuje RoamView, obrazovku, ktorá sa prispôsobí vášmu životnému štýlu',
  'Spoločnosť Shanghai Electric získala prvú zahraničnú objednávku na vysokovýkonné plynové turbíny',
  'Shanghai Electric получила первый зарубежный заказ на газовую турбину большой мощности',
  'ХЛОИ КАРДАШЬЯН РАСШИРЯЕТ ПРИСУТСТВИЕ СВОЕЙ ВСЕМИРНО ПРИЗНАННОЙ КОЛЛЕКЦИИ АРОМАТОВ',
  '"بركز" تحصل على تمويل بقيمة 31 مليون دولار لتسريع نمو حلول شراء مواد البناء',
  '한국인이 창업한 나이버 테크놀로지스, 고어텍스·프리마로프트 출신 임원들과 손잡다',
];

console.log('\n=== untranslated foreign headlines must never reach the public wire ===');
let missed = 0;
for (const h of FOREIGN) {
  const v = materiallyNonEnglish(h);
  if (!v.nonEnglish) { missed++; console.error(`  MISSED: ${h}`); }
}
ok('every live foreign headline is detected', missed === 0, `${missed}/${FOREIGN.length} missed`);
console.log(`  ${FOREIGN.length - missed}/${FOREIGN.length} caught`);

// ── must NOT be caught ───────────────────────────────────────────────────────
// A false positive here deletes a real event from a trading product, so this list is deliberately
// stocked with the hard cases: English sentences that CONTAIN foreign names, abbreviations that look
// like particles, and terse all-caps flashes with no English function word in them at all.
const ENGLISH = [
  // the shapes that broke earlier drafts
  'AMPHENOL CORP /DE/ · 8-K (8.01)',
  'QUALCOMM INC/DE · 8-K (3.02)',
  'GLADSTONE INVESTMENT CORPORATION\\DE · 8-K (5.07)',
  'G III APPAREL GROUP LTD /DE/ · 8-K (1.01,2.01,2.02,7.01,9.01)',
  'OS Therapies Inc · 8-K (8.01,9.01)',
  'PRO DEX INC · 8-K (2.02,9.01)',
  'SI-BONE, Inc. · 8-K (1.01,2.03,8.01,9.01)',
  'La Rosa Holdings Corp. · 8-K (3.03,5.03,7.01,9.01)',
  'KEWAUNEE SCIENTIFIC CORP /DE/ · 8-K (2.02,9.01)',
  'LA Rams face San Francisco in NFL\'s first regular-season game in Australia',
  'Sen. Fetterman pledges to remain with Democratic party after GOP convention video',
  'MIT research examines obstacles to organization-wide AI innovation',
  'Thrive Capital led VCs into pro sports ownership; Collaborative Fund just upped that play',
  'U.S. exploring Russia-Ukraine de-escalation steps during winter, Zelensky says',
  'EIA forecasts Middle East oil production to rise but remain below pre-conflict levels',
  'AI researchers acknowledge non-zero chance of human extinction next decade',
  'Practice San Francisco expands with new locations in Bay Area and Los Angeles',
  'Hisense presents RoamView portable display',
  // English headlines about foreign companies, which is the whole point of the name guard
  'La Banque Postale makes available amendment to universal registration document',
  'Les Hôtels Baverez reports first-half 2026 results',
  'Aktsiaselts Infortar acquires own shares on Nasdaq Tallinn Stock Exchange',
  'Societe Generale to cut 900 jobs across its investment bank',
  'Banco de la Nacion agrees to buy stake in regional lender',
  'Nestle names new chief executive after board review',
  'Orsted wins 1.2 GW offshore wind tender in Denmark',
  'Ferrovial completes sale of Heathrow stake to Ardian',
  'LVMH first-half revenue falls 3% as Asian demand slows',
  // terse flashes with no English function word at all
  'APPLE Q3 EPS $1.40 BEATS EST',
  '*GERMANY TO LOBBY EU ON NEW CHINA POLICY, MAY SEEK MORE TARIFFS',
  'MACRO: US 6-Month Bill High Yield Actual 4.06%',
  'Devonian Health Group validates Thykamine manufacturing quality-control assays',
  'Nine midsize drugmakers join Trump\'s MFN drug pricing program',
  'Federal Reserve estimates state-level trend unemployment rates',
  'Kenya helicopter crash kills 7 people including 5 Americans',
  'Comprehensive Sleep Medicine Associates welcomes Dr. Huzaifa Wasanwala',
  'America\'s global effective tariff reaches 10.0%',
  'Kevin Warsh adopts conventional central banking approach',
];

console.log('\n=== real English headlines must never be suppressed ===');
let wrong = 0;
for (const h of ENGLISH) {
  const v = materiallyNonEnglish(h);
  if (v.nonEnglish) { wrong++; console.error(`  FALSE POSITIVE: ${h}\n     why: ${v.reason}`); }
}
ok('no English headline is suppressed', wrong === 0, `${wrong}/${ENGLISH.length} false positives`);
console.log(`  ${ENGLISH.length - wrong}/${ENGLISH.length} kept`);

console.log('\n=== the body only votes when the headline is itself suspect ===');
ok('an English headline over foreign copy still publishes',
  !materiallyNonEnglish('Hisense presents RoamView portable display',
    'Hisense dnes predstavuje RoamView, prenosnú obrazovku, ktorá sa prispôsobí vášmu životnému štýlu').nonEnglish);
ok('an accented headline with a foreign body is caught',
  materiallyNonEnglish('Sjóvá: Reglubundin tilkynning',
    'Í samræmi við skilmála skuldabréfsins munu vextir bréfsins verða 11,8%').nonEnglish);
ok('a foreign body alone cannot suppress a clean English headline',
  !materiallyNonEnglish('Company raises full-year guidance after strong quarter',
    'Das Unternehmen hebt die Prognose für das Geschäftsjahr an').nonEnglish);

console.log('\n=== evidence is positive, never the mere absence of English ===');
const flash = languageEvidence('APPLE Q3 EPS $1.40 BEATS EST');
ok('a terse flash has no foreign evidence', flash.foreign.length === 0);
ok('...and is not judged on having no English function word',
  !detectNonEnglish('APPLE Q3 EPS $1.40 BEATS EST').nonEnglish);

console.log('\n=== X publication fails closed on untranslated text ===');
const now = Date.parse('2026-09-14T16:00:00Z');
const base = { published_at: '2026-09-14T15:30:00Z', tickers: [], importance: 3 };
const v1 = publicationVerdict({ ...base, headline: 'SÍL 2 hs. - ákvörðun vaxta og almenn upplýsingagjöf' }, now);
ok('a foreign headline is never publishable to X', v1.publish === false);
ok('...with the specific reason, so it is auditable',
  v1.reason === 'untranslated non-English source text', v1.reason);
const v2 = publicationVerdict({ ...base, headline: 'Federal Reserve cuts rates by 25 basis points', tickers: [] }, now);
ok('an English macro headline is unaffected by the language gate',
  v2.reason !== 'untranslated non-English source text', v2.reason || 'published');

console.log('\n=== ingest holds a foreign row out of the public view, and keeps everything else ===');
const feed = { key: 'gnw_public', source: 'GLOBENEWSWIRE', sourceName: 'GlobeNewswire',
  type: 'press_release', category: 'MARKETS', tickerable: true };
const item = {
  title: 'SÍL 2 hs. - ákvörðun vaxta og almenn upplýsingagjöf',
  summary: 'Í samræmi við skilmála skuldabréfsins SIL 23 1 munu vextir skuldabréfsins fyrir tímabilið 20. september til 19. desember verða 11,8%.',
  url: 'https://www.globenewswire.com/news-release/2026/09/14/3361321/0/en/x.html',
  publishedAt: '2026-09-14T15:30:00Z',
};
const row = normalize(feed, item);
ok('a foreign row is NOT display-ready', row.display_ready === false);
ok('...but its source headline is stored in full', row.source_headline === item.title);
ok('...and its url is stored in full', String(row.original_url).includes('globenewswire.com'));
ok('...and it still carries its source and published time', row.source === 'GLOBENEWSWIRE' && !!row.published_at);
const eng = normalize(feed, { ...item, title: 'Nordic issuer sets bond coupon at 11.8% for the December period', summary: 'The rate applies from 20 September.' });
ok('an English row from the same feed is display-ready', eng.display_ready === true);

// A trusted wire cannot override the language gate: trust is about editorial weight, not language.
const trusted = { key: 'wb', source: 'WALTERBLOOMBERG', sourceName: 'x', type: 'terminal_flash', trusted: true, category: 'MARKETS' };
ok('even a TRUSTED feed cannot publish untranslated text',
  normalize(trusted, { ...item, title: 'Transaktioner i henhold til aktietilbagekøbsprogram' }).display_ready === false);
ok('...while its English flashes are unaffected',
  normalize(trusted, { title: '*GERMANY TO LOBBY EU ON NEW CHINA POLICY, MAY SEEK MORE TARIFFS', summary: '', url: 'https://x.com/1', publishedAt: '2026-09-14T15:30:00Z' }).display_ready === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
