// WATCHLIST "WHAT CHANGED" — selection only, from canonical records.
//
// Three things a feature like this gets wrong, and all of them are quiet:
//
//   1. IT INVENTS A SCORE. A row has space for one change, so one must be chosen — and the obvious
//      move is an importance number, which would be a new methodology hiding inside a prototype and
//      tuned against nothing.
//   2. IT INVENTS WORDING. "Director bought $186K" must be three canonical fields printed next to
//      each other, not a sentence someone wrote about a filing.
//   3. IT LETS THE HIGH-FREQUENCY FAMILIES WIN EVERYTHING. Form 4s and congressional disclosures
//      land continuously; a material 8-K lands rarely. Choosing by recency alone is predictable and
//      wrong — it turns "what changed in my names" into an insider-trading feed. That is the defect
//      this file's SELECTION section now exists to hold shut.
//
// Run: node scripts/verify-watchlist-changes.mjs

import { readFileSync } from 'node:fs';
import {
  CHANGE, PRECEDENCE, WINDOW_DAYS, NOTABLE_BANDS, WIRE_HIGH_IMPORTANCE, WIRE_MIN_IMPORTANCE, HISTORY_DAYS,
  fromFiling, fromWire, fromInsider, fromCongress, fromScan, pickChange, pickFallback, pickLine, rankOf, ago,
} from '../src/lib/terminal/watchlist-changes.mjs';
import { HIGH_IMPORTANCE, IMMEDIATE_MIN_IMPORTANCE } from '../src/lib/enrich-policy.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const NOW = Date.parse('2026-09-25T16:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const pick = (c) => pickChange(c, { now: NOW });
// ⚠️ ASSERTIONS ARE MATCHED AGAINST CODE, NOT PROSE. The comments in both files name the very
// shapes being counted — the note explaining why `distinct on (ticker)` alone is no longer enough
// contains `distinct on (ticker)` — so reading the raw file would count an explanation as a query.
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

L('⚠️ EVERY WORD COMES FROM A CANONICAL FIELD');
{
  const f = fromFiling({ primaryLabel: 'Results of operations', material: true, filedAt: hoursAgo(4), url: 'u' });
  ok('a filing prints the classifier\'s own label', f.label === 'Results of operations');
  ok('…and a routine one says so rather than being hidden',
    fromFiling({ primaryLabel: 'Other event', material: false, filedAt: hoursAgo(4) }).detail === 'routine');

  const i = fromInsider({ title: 'Director', action: 'buy', totalValue: 186000, filingDate: daysAgo(2) });
  ok('⚠️ an insider line is role + direction + value, all stated on the filing',
    i.label === 'Director bought $186K');
  ok('a sale reads as a sale', fromInsider({ title: 'CEO', action: 'sell', totalValue: 2400000, filingDate: daysAgo(1) }).label === 'CEO sold $2.4M');
  // ⚠️ A CODE WE CANNOT READ PLAINLY IS NOT GUESSED AT.
  ok('⚠️ a transaction that is neither a plain buy nor a plain sale is not described',
    fromInsider({ title: 'Officer', action: 'gift', totalValue: 1000, filingDate: daysAgo(1) }) === null);
  ok('a missing value is omitted rather than invented',
    fromInsider({ title: 'Director', action: 'buy', totalValue: 0, filingDate: daysAgo(1) }).label === 'Director bought');
  ok('an unknown role is named generically, not guessed',
    fromInsider({ title: '', action: 'buy', totalValue: 5000, filingDate: daysAgo(1) }).label.startsWith('Insider bought'));

  const c = fromCongress({ representative: 'Rep. A. Member', type: 'purchase', amountRange: '$15K–$50K', disclosureDate: daysAgo(3) });
  ok('a congressional line names the member and the direction', c.label === 'Rep. A. Member bought');
  ok('⚠️ …and the amount BAND, because a point estimate would be invented', c.detail === '$15K–$50K');
  ok('a disclosure with no readable direction is skipped',
    fromCongress({ representative: 'X', type: 'exchange', disclosureDate: daysAgo(1) }) === null);

  // ⚠️ THE WIRE LINE IS THE EVENT'S OWN HEADLINE, AND ITS OWN OUTLET.
  const w = fromWire({ headline: 'Acme wins $400M defense contract', source: 'Business Wire',
    importance: 2, publishedAt: hoursAgo(3), url: 'u' });
  ok('⚠️ a wire line is the canonical headline, not a summary of it',
    w.label === 'Acme wins $400M defense contract' && w.detail === 'Business Wire');
  ok('an event with no headline is not described', fromWire({ headline: '  ', importance: 3, publishedAt: hoursAgo(1) }) === null);

  ok('a scan membership names the board', fromScan('Moving Now', hoursAgo(1)).label === 'On Moving Now');
  ok('an undated record is never a change',
    fromFiling({ filedAt: 'nope' }) === null && fromInsider({ action: 'buy', filingDate: null }) === null
    && fromCongress({ type: 'purchase', disclosureDate: undefined }) === null && fromScan('X', null) === null
    && fromWire({ headline: 'h', publishedAt: null }) === null);
}

L('⚠️ "NOTABLE" IS ALWAYS THE SOURCE\'S OWN FLAG, NEVER A JUDGEMENT MADE HERE');
{
  // ⚠️ THE WHOLE PRECEDENCE RESTS ON THIS. If `notable` were decided here it would be a score with
  // a different name; every one of these is a field the source already published.
  ok('a filing is notable exactly when the 8-K item classification says material',
    fromFiling({ primaryLabel: 'Merger', material: true, filedAt: hoursAgo(1) }).notable === true
    && fromFiling({ primaryLabel: 'Exhibits', material: false, filedAt: hoursAgo(1) }).notable === false);
  ok('⚠️ …and an unflagged filing is not promoted on a guess',
    fromFiling({ primaryLabel: 'x', filedAt: hoursAgo(1) }).notable === false);

  ok('a wire event is notable at the wire\'s own HIGH importance',
    fromWire({ headline: 'h', importance: 2, publishedAt: hoursAgo(1) }).notable === true
    && fromWire({ headline: 'h', importance: 1, publishedAt: hoursAgo(1) }).notable === false);
  // ⚠️ THE ONE DUPLICATED CONSTANT IN THE FEATURE, PINNED TO ITS SOURCE. The threshold is restated
  // in the display module to keep the enrichment lexicons out of the browser bundle; if the
  // canonical one ever moves, this fails rather than the two silently disagreeing.
  ok('⚠️ …and that threshold is the canonical HIGH_IMPORTANCE, not a number chosen here',
    WIRE_HIGH_IMPORTANCE === HIGH_IMPORTANCE);

  // ⚠️ AND BELOW THE PIPELINE'S OWN REAL-TIME FLOOR, A WIRE EVENT IS NOT A CHANGE AT ALL.
  //
  // Measured on production before this floor existed: both LOW-importance events attributed to
  // ICLR were an "Icon" in the headline and neither was about the company. LOW is where ticker
  // RESOLUTION noise collects, and the pipeline already declines to handle LOW in real time — so
  // this is its line, applied, not a quality judgement formed here about an individual headline.
  ok('⚠️ a LOW-importance wire item is not a change',
    fromWire({ headline: 'h', importance: 0, publishedAt: hoursAgo(1) }) === null);
  ok('…and a MEDIUM one is', fromWire({ headline: 'h', importance: 1, publishedAt: hoursAgo(1) }) !== null);
  ok('⚠️ …with the floor taken from the pipeline, not chosen here',
    WIRE_MIN_IMPORTANCE === IMMEDIATE_MIN_IMPORTANCE && WIRE_MIN_IMPORTANCE < WIRE_HIGH_IMPORTANCE);

  ok('an insider is notable exactly at the conviction model\'s own high bands',
    fromInsider({ title: 'CEO', action: 'buy', totalValue: 1e6, filingDate: hoursAgo(1), convictionBand: 'VERY HIGH' }).notable === true
    && fromInsider({ title: 'CEO', action: 'buy', totalValue: 1e6, filingDate: hoursAgo(1), convictionBand: 'MODERATE' }).notable === false);
  // ⚠️ THE MODEL GRADES PURCHASES ONLY, SO NEITHER DOES THIS. A large sale carries no band, and
  // inventing one from its dollar value would be the score this feature refuses to have.
  ok('⚠️ a sale is never promoted, because the conviction model does not grade sales',
    fromInsider({ title: 'CEO', action: 'sell', totalValue: 5e7, filingDate: hoursAgo(1), convictionBand: null }).notable === false);
  ok('the bands are the schema\'s own', NOTABLE_BANDS.every((b) => /^(HIGH|VERY HIGH|EXTREME)$/.test(b)));

  // ⚠️ NO FLAG EXISTS FOR A DISCLOSURE, SO NONE IS INVENTED.
  ok('⚠️ a congressional disclosure is never notable, and has one row in the table',
    fromCongress({ representative: 'X', type: 'purchase', amountRange: '$1M – $5M', disclosureDate: hoursAgo(1) }).notable === false
    && PRECEDENCE.filter((p) => p.kind === CHANGE.CONGRESS).length === 1);
}

L('⚠️ SELECTION IS A STATED PRECEDENCE — NOT RECENCY ALONE, AND NOT A SCORE');
{
  // ⚠️ THE DEFECT THIS REPLACED. This assertion used to read "the most recent qualifying event
  // wins, whatever kind it is", and it passed. That behaviour is what made the watchlist read as an
  // insider-trading feed, so the assertion is inverted rather than deleted: the case it used to
  // bless is now the case it forbids.
  const matFiling = fromFiling({ primaryLabel: 'M&A completed', material: true, filedAt: daysAgo(3) });
  const newerSale = fromInsider({ title: 'SVP', action: 'sell', totalValue: 816000, filingDate: hoursAgo(2) });
  ok('⚠️ a material company event beats a NEWER routine insider transaction',
    pick([matFiling, newerSale]).kind === CHANGE.FILING);
  ok('…and the reason is readable off the result', pick([matFiling, newerSale]).why === 'material-filing');

  const newerDisclosure = fromCongress({ representative: 'Ro Khanna', type: 'sale', amountRange: '$1,001 - $15,000', disclosureDate: hoursAgo(1) });
  ok('⚠️ …and it beats a newer congressional disclosure too',
    pick([matFiling, newerDisclosure]).kind === CHANGE.FILING);

  const majorNews = fromWire({ headline: 'FDA approves', source: 'PR Newswire', importance: 3, publishedAt: daysAgo(2) });
  ok('⚠️ a HIGH-importance ticker-attributed story beats a newer routine transaction',
    pick([majorNews, newerSale]).kind === CHANGE.WIRE && pick([majorNews, newerSale]).why === 'major-news');

  // ⚠️ THE TRANSACTION FAMILIES ARE NOT HIDDEN. They win whenever nothing above them has anything,
  // which on a quiet name is most days — and the brief is explicit that this must stay true.
  ok('⚠️ an insider transaction still wins a row with nothing else on it',
    pick([newerSale]).kind === CHANGE.INSIDER && pick([newerSale]).why === 'insider');
  ok('⚠️ …and so does a congressional disclosure', pick([newerDisclosure]).why === 'congress');
  ok('…and a routine filing, when it is all there is', pick([fromFiling({ primaryLabel: 'Other event', material: false, filedAt: hoursAgo(4) })]).why === 'routine-filing');

  // ⚠️ AND A ROUTINE FILING DOES NOT OUTRANK A REAL TRANSACTION. "Exhibits" is something a company
  // must file, not something that happened; putting the filing family above the transaction
  // families wholesale would have traded one wrong answer for another.
  ok('⚠️ a routine 8-K does NOT beat an insider transaction',
    pick([fromFiling({ primaryLabel: 'Exhibits', material: false, filedAt: hoursAgo(1) }), newerSale]).kind === CHANGE.INSIDER);

  // ⚠️ A PROMOTION DECAYS, WHICH IS HOW RECENCY SURVIVES INSIDE A PRECEDENCE.
  const freshBuy = fromInsider({ title: 'CEO', action: 'buy', totalValue: 4e6, filingDate: daysAgo(1), convictionBand: 'EXTREME' });
  const staleBuy = fromInsider({ title: 'CEO', action: 'buy', totalValue: 4e6, filingDate: daysAgo(9), convictionBand: 'EXTREME' });
  const routineFiling = fromFiling({ primaryLabel: 'Reg FD disclosure', material: false, filedAt: hoursAgo(6) });
  ok('⚠️ a fresh high-conviction buy outranks the routine families', pick([freshBuy, routineFiling]).why === 'notable-insider');
  ok('⚠️ …and the same buy nine days later falls back to the ordinary insider row rather than vanishing',
    pick([staleBuy]).why === 'insider' && rankOf(staleBuy, NOW) > rankOf(freshBuy, NOW));

  // Recency still decides inside a family.
  ok('⚠️ recency still decides between two events of the same rank',
    pick([fromFiling({ primaryLabel: 'old', material: true, filedAt: daysAgo(4) }),
      fromFiling({ primaryLabel: 'new', material: true, filedAt: hoursAgo(2) })]).label === 'new');

  ok('nothing qualifying is no line at all', pick([]) === null);
  ok('…and so is a list of nulls', pick([null, null]) === null);

  // ⚠️ THE ORDERING IS A TABLE, NOT ARITHMETIC.
  const src = readFileSync(new URL('../src/lib/terminal/watchlist-changes.mjs', import.meta.url), 'utf8');
  const body = code(src);
  ok('⚠️ nothing here scores, weights or sums candidates',
    !/\bscore\b|\bweight\b|\* *\d+ *\+|reduce\(/i.test(body));
  ok('⚠️ …the only importance it reads is the wire\'s own field, never one computed here',
    (body.match(/^.*\bimportance\b.*$/gim) || []).every((l) => /^export const WIRE_(HIGH|MIN)_IMPORTANCE = \d;$/.test(l.trim())
      || /\(Number\(row\.importance\) \|\| 0\) (>=|<) WIRE_(HIGH|MIN)_IMPORTANCE/.test(l)));
  ok('⚠️ the whole ordering is one exported table a reader can point at',
    /export const PRECEDENCE = Object\.freeze\(\[/.test(body)
    && (body.match(/PRECEDENCE\.findIndex/g) || []).length === 1);
  ok('…and every row of it is (family, the source\'s own flag, a window)',
    PRECEDENCE.every((p) => Object.values(CHANGE).includes(p.kind) && typeof p.when === 'function'
      && Number.isFinite(p.days) && p.days > 0 && typeof p.id === 'string'));
  ok('…with the company-event families above the transaction families',
    PRECEDENCE.findIndex((p) => p.id === 'material-filing') < PRECEDENCE.findIndex((p) => p.id === 'insider')
    && PRECEDENCE.findIndex((p) => p.id === 'major-news') < PRECEDENCE.findIndex((p) => p.id === 'congress'));
}

L('⚠️ THE HISTORICAL FALLBACK — ONLY WHERE THE ROW WOULD OTHERWISE BE BLANK');
{
  const recentFiling = fromFiling({ primaryLabel: 'M&A completed', material: true, filedAt: hoursAgo(5) });
  const recentSale = fromInsider({ title: 'CFO', action: 'sell', totalValue: 90000, filingDate: daysAgo(2) });
  const oldBuy = fromInsider({ title: 'Director', action: 'buy', totalValue: 425000, filingDate: daysAgo(47) });
  const oldSale = fromInsider({ title: 'CEO', action: 'sell', totalValue: 1200000, filingDate: daysAgo(63) });
  const oldDisclosure = fromCongress({ representative: 'Ro Khanna', type: 'purchase', amountRange: '$1,001 - $15,000', disclosureDate: daysAgo(73) });
  const line = (recent, historical) => pickLine({ recent, historical }, { now: NOW });

  // ⚠️ THE ONE GUARANTEE THE WHOLE FEATURE RESTS ON. A fallback that can outrank a qualifying event
  // is not a fallback, it is a new precedence row — and it would silently undo the table above.
  ok('⚠️ a qualifying recent company event is never displaced by an older transaction',
    line([recentFiling], [oldBuy, oldDisclosure]).why === 'material-filing');
  ok('⚠️ …nor is a qualifying recent transaction', line([recentSale], [oldBuy]).why === 'insider');
  ok('…and the fallback fills a row that would otherwise be blank',
    line([], [oldBuy]).why === 'historical-insider' && line([], [oldBuy]).label === 'Director bought $425K');
  ok('⚠️ nothing at all still means no line', line([], []) === null && line(null, null) === null);

  // ⚠️ RECENCY ON THE PUBLIC TIMESTAMP, AND NOTHING ELSE DECIDES IT.
  ok('⚠️ between the two families the one that became public most recently wins',
    pickFallback([oldSale, oldDisclosure], { now: NOW }).kind === CHANGE.INSIDER
    && pickFallback([oldDisclosure, fromInsider({ title: 'CEO', action: 'sell', totalValue: 1, filingDate: daysAgo(90) })], { now: NOW }).kind === CHANGE.CONGRESS);
  ok('⚠️ …and a congressional fallback is dated from DISCLOSURE, not the trade',
    pickFallback([fromCongress({ representative: 'X', type: 'purchase', disclosureDate: daysAgo(73), transactionDate: daysAgo(110) })], { now: NOW }).at === Date.parse(daysAgo(73)));
  ok('…an insider fallback from the Form 4 filing date', pickFallback([oldBuy], { now: NOW }).at === Date.parse(daysAgo(47)));
  // ⚠️ THE CONVICTION BAND IS DELIBERATELY NOT CONSULTED HERE. Promoting an old buy over a newer
  // old sale would imply a currency this line cannot have, and would be the score we do not have.
  ok('⚠️ a high-conviction old buy does NOT outrank a newer old sale',
    pickFallback([fromInsider({ title: 'CEO', action: 'buy', totalValue: 9e6, filingDate: daysAgo(80), convictionBand: 'EXTREME' }), oldSale], { now: NOW }).at === Date.parse(daysAgo(63)));

  // ⚠️ ONLY WHAT A SOURCE PLAINLY CALLS A BUY OR A SELL.
  ok('⚠️ an OTHER-coded Form 4 can never become a fallback line',
    fromInsider({ title: 'Director', action: 'OTHER', totalValue: 0, filingDate: daysAgo(50) }) === null
    && pickFallback([fromInsider({ title: 'Director', action: 'OTHER', totalValue: 0, filingDate: daysAgo(50) })], { now: NOW }) === null);
  ok('…and neither can an Exchange disclosure',
    pickFallback([fromCongress({ representative: 'X', type: 'Exchange', disclosureDate: daysAgo(50) })], { now: NOW }) === null);
  ok('⚠️ a congressional amount is still the published BAND, never an estimate',
    pickFallback([oldDisclosure], { now: NOW }).detail === '$1,001 - $15,000');
  ok('…and an insider value is still the filing\'s own total', pickFallback([oldSale], { now: NOW }).label === 'CEO sold $1.2M');

  // ⚠️ FAIL CLOSED, AND BOUNDED.
  ok('⚠️ a candidate with no readable public timestamp is dropped, not shown with a guessed age',
    pickFallback([{ kind: CHANGE.INSIDER, at: NaN, label: 'x' }, { kind: CHANGE.CONGRESS, at: null, label: 'y' }], { now: NOW }) === null);
  ok('⚠️ nothing dated in the future can become a fallback either',
    pickFallback([{ kind: CHANGE.INSIDER, at: NOW + 3600000, label: 'x' }], { now: NOW }) === null);
  ok('the fallback is bounded, so the query cannot be unbounded either',
    Number.isFinite(HISTORY_DAYS) && HISTORY_DAYS > 0
    && pickFallback([fromInsider({ title: 'D', action: 'buy', totalValue: 1, filingDate: daysAgo(HISTORY_DAYS + 1) })], { now: NOW }) === null
    && pickFallback([fromInsider({ title: 'D', action: 'buy', totalValue: 1, filingDate: daysAgo(HISTORY_DAYS - 1) })], { now: NOW }) !== null);
  ok('…and it reaches back further than any precedence row, or it would add nothing',
    HISTORY_DAYS > Math.max(...PRECEDENCE.map((p) => p.days)));

  // ⚠️ ONLY THE TWO TRANSACTION FAMILIES. A filing or a wire story reaching the fallback would mean
  // an old headline printed as if it were a change.
  ok('⚠️ a stale filing is not a fallback candidate',
    pickFallback([fromFiling({ primaryLabel: 'Merger', material: true, filedAt: daysAgo(40) })], { now: NOW }) === null);
  ok('…nor is a stale wire story',
    pickFallback([fromWire({ headline: 'h', importance: 3, publishedAt: daysAgo(40) })], { now: NOW }) === null);

  // ⚠️ THE FLAG THE ROW RENDERS QUIETLY FROM IS SET ON THE FALLBACK AND ONLY THERE.
  ok('⚠️ a fallback line is marked historical', pickFallback([oldBuy], { now: NOW }).historical === true);
  ok('…and a qualifying line never is', line([recentSale], [oldBuy]).historical === undefined);
  ok('the reason names the family it came from',
    pickFallback([oldDisclosure], { now: NOW }).why === 'historical-congress');
}

L('⚠️ SOURCE-APPROPRIATE WINDOWS, AND A FUTURE DATE IS BAD DATA');
{
  ok('a material filing older than its window is not a change',
    pick([fromFiling({ primaryLabel: 'x', material: true, filedAt: daysAgo(8) })]) === null);
  ok('…and one inside it is', pick([fromFiling({ primaryLabel: 'x', material: true, filedAt: daysAgo(6) })]) !== null);
  // ⚠️ A ROUTINE FILING AGES OUT FASTER THAN A MATERIAL ONE, ON PURPOSE.
  ok('⚠️ a routine filing gets a shorter window than a material one',
    PRECEDENCE.find((p) => p.id === 'routine-filing').days < PRECEDENCE.find((p) => p.id === 'material-filing').days);
  ok('…so a four-day-old "Exhibits" is not a change at all',
    pick([fromFiling({ primaryLabel: 'Exhibits', material: false, filedAt: daysAgo(4) })]) === null);
  // ⚠️ CONGRESS GETS LONGER BECAUSE THE LAW ALLOWS 45 DAYS TO DISCLOSE. A 7-day window would hide
  // most disclosures in the week they became public.
  ok('⚠️ congress is given a longer window than a filing',
    WINDOW_DAYS[CHANGE.CONGRESS] > WINDOW_DAYS[CHANGE.FILING]);
  ok('…and it is measured on the disclosure date, not the trade date',
    fromCongress({ representative: 'X', type: 'purchase', disclosureDate: daysAgo(1),
      transactionDate: daysAgo(40) }).at === Date.parse(daysAgo(1)));
  // ⚠️ NEWS GOES STALE FASTEST OF ALL. A three-day-old headline is not what changed today.
  ok('⚠️ the wire has the shortest windows of the reporting families',
    WINDOW_DAYS[CHANGE.WIRE] < WINDOW_DAYS[CHANGE.FILING]);
  ok('a scan membership is the shortest-lived of them', WINDOW_DAYS[CHANGE.SCAN] <= 2);
  ok('⚠️ nothing dated in the future is ever shown',
    pick([{ kind: CHANGE.FILING, at: NOW + 3600000, label: 'tomorrow', notable: true }]) === null);
  ok('every kind has a window, so none can leak in unbounded',
    Object.values(CHANGE).every((k) => Number.isFinite(WINDOW_DAYS[k]) && WINDOW_DAYS[k] > 0));
  ok('⚠️ …and the query bound is the widest row of the table for that family, so no candidate the '
    + 'precedence could accept is left unfetched',
    WINDOW_DAYS[CHANGE.INSIDER] === Math.max(...PRECEDENCE.filter((p) => p.kind === CHANGE.INSIDER).map((p) => p.days)));
  ok('a kind with no row in the table is never selectable',
    rankOf({ kind: 'invented', at: NOW - 1000, label: 'x' }, NOW) === -1);
}

L('THE AGE SHORTHAND');
{
  ok('minutes', ago(NOW - 12 * 60000, NOW) === '12m');
  ok('hours', ago(NOW - 4 * 3600000, NOW) === '4h');
  ok('days', ago(NOW - 2 * 86400000, NOW) === '2d');
  ok('an undated change shows no age', ago(NaN, NOW) === '');
}

L('⚠️ ONE BATCHED REQUEST, AND EXISTING INSPECTORS');
{
  const routeSrc = readFileSync(new URL('../src/app/api/watchlist/signals/route.js', import.meta.url), 'utf8');
  // ⚠️ MATCHED AGAINST THE CODE, NOT THE PROSE. These comments name the very shapes being
  // counted — 'distinct on (ticker)' appears in the note explaining why it is no longer enough —
  // so an assertion reading the raw file would count the explanation as a fourth query.
  const route = code(routeSrc);
  const term = readFileSync(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');
  // ⚠️ SCOPED TO THE FUNCTION, NOT TO EVERYTHING AFTER IT. Splitting on the opening line alone
  // left the whole rest of the file in the haystack, so an ellipsis style belonging to another
  // component satisfied an assertion about this one — a mutation to ChangeLine itself survived.
  const changeLine = term.split('function ChangeLine')[1]?.split('function WatchlistBody')[0] || '';

  // ⚠️ THE FAILURE THIS AVOIDS: one request per symbol per source, on every poll. Adding the wire
  // added a FAMILY, not a request — it is one lateral inside one statement.
  ok('⚠️ the changes ride on the request the Watchlist already makes', /changes \}/.test(route));
  // One statement per source: filings, insiders, congress, wire, and the two fallback reads.
  ok('…and each source is ONE statement for the whole list',
    (route.match(/distinct on \(ticker/g) || []).length === 5
    && (route.match(/cross join lateral/g) || []).length === 1);
  ok('⚠️ …with no per-symbol loop around a query',
    !/for \(const sym of syms\)[\s\S]{0,400}(db\.execute|await db)/.test(route));
  ok('…bounded by the same symbol list the flags use',
    (route.match(/ticker = any\(\$\{arr\}::text\[\]\)/g) || []).length === 5
    && /unnest\(\$\{arr\}::text\[\]\)/.test(route));
  ok('⚠️ …and by the same windows the display honours',
    /make_interval\(days => \$\{WINDOW_DAYS\[CHANGE\.FILING\]\}\)/.test(route)
    && /make_interval\(days => \$\{WINDOW_DAYS\[CHANGE\.WIRE\]\}\)/.test(route));
  ok('⚠️ …and the query applies the same importance floor, so the lateral returns the best ELIGIBLE '
    + 'story rather than one the display would then discard',
    /and ce\.importance >= \$\{WIRE_MIN_IMPORTANCE\}/.test(route));
  // ⚠️ EVERY source, not four of them. A count floor passed while one family was left unguarded,
  // which is the one shape that matters: an unguarded source takes the whole watchlist down with it.
  ok('⚠️ every source is guarded, so one failing leaves the rest of the row alone',
    (route.match(/catch \{ return \[\]; \}/g) || []).length === (route.match(/async \(\) => \{/g) || []).length);
  ok('the 8-K label comes from the shared classifier, not a second one',
    /classifyItems\(fr\.items\)/.test(route));
  // ⚠️ AND THE ROUTE CALLS THE COMPOSED ENTRY POINT, NOT THE TWO HALVES. Calling pickFallback
  // itself is how a caller would accidentally let a 60-day-old sale beat this morning's 8-K.
  ok('the selection itself is not done in the route',
    /pickLine\(\{ recent: \[/.test(route) && !/PRECEDENCE|rankOf|pickFallback/.test(route));

  // ⚠️ BOTH TIERS OF A FAMILY ARE FETCHED, OR THE PRECEDENCE CANNOT SEE WHAT IT PREFERS.
  ok('⚠️ the filing query keys on materiality, so a routine 8-K cannot hide a material one',
    /distinct on \(ticker, material\)/.test(route) && /order by ticker, material, filed_at desc/.test(route));
  ok('⚠️ …and the insider query keys on the conviction band for the same reason',
    /\(conviction_band = any\(\$\{NOTABLE_BANDS\}::text\[\]\)\) as notable/.test(route)
    && /distinct on \(ticker, notable\)/.test(route) && /order by ticker, notable, filing_date desc/.test(route));

  // ⚠️ THE TRAP THAT SHIPPED A SILENTLY DEAD FAMILY, GENERALISED.
  //
  // The flag was first written inline in BOTH `distinct on` and `order by`. drizzle binds each
  // interpolation as its own parameter, so Postgres compared `any($3)` with `any($4)`, called them
  // different expressions and rejected the statement — and the per-source guard turned that into an
  // empty result rather than an error. The watchlist stayed up and quietly stopped showing insider
  // lines. Nothing in a unit test can see that, so what is asserted is the shape that caused it:
  // no expression may be interpolated twice inside one statement.
  {
    const dup = [];
    for (const m of route.matchAll(/sql`([\s\S]*?)`\)/g)) {
      const seen = new Set();
      for (const e of m[1].matchAll(/\$\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
        if (seen.has(e[1])) dup.push(e[1]);
        seen.add(e[1]);
      }
    }
    ok('⚠️ no expression is interpolated twice in one statement, so drizzle cannot split it into '
      + 'two parameters that Postgres then calls different expressions', dup.length === 0, dup.join(', '));
  }
  ok('⚠️ …using the same bands the display promotes on',
    new RegExp(`\\{${NOTABLE_BANDS.join(',')}\\}`).test(route));
  // ⚠️ SCOPED TO THE WIRE STATEMENT. A blanket ban on `ilike` broke once the congress fallback
  // needed one to match 'Sale (Partial)' — a filter on the disclosure's own type field, which is
  // nothing like resolving a company from headline text. What must never happen is the WIRE being
  // matched that way, so that is what is asserted.
  const wireStmt = (route.match(/from canonical_events ce[\s\S]*?limit 1/) || [''])[0];
  ok('⚠️ the wire is attributed by the event\'s own tickers, never by a text search',
    /ce\.tickers @> array\[s\.ticker\]/.test(wireStmt)
    && !/ilike|to_tsquery|headline ~|similar to/i.test(wireStmt));
  ok('…and reads the canonical event view, not a second news store',
    /from canonical_events ce/.test(route));

  // ── ⚠️ THE FALLBACK IS BATCHED AND FILTERS IN SQL ─────────────────────────
  //
  // ⚠️ THE FILTER HAS TO BE IN SQL, AND THIS IS NOT AN OPTIMISATION. `distinct on (ticker)` returns
  // the newest row; for IREN the nine newest Form 4s are all OTHER-coded and share a filing date
  // with a real $434K Director sale. Filtering in the display would have received an OTHER row,
  // produced null from it and left the row blank with a legitimate sale one row further down.
  ok('⚠️ the insider fallback filters to plain buys and sells in SQL, not after the fact',
    /and action in \('BUY', 'SELL'\)/.test(route));
  ok('⚠️ …and the congress fallback excludes types that are not plainly a purchase or a sale',
    /and \(type ilike '%purchase%' or type ilike '%sale%'\)/.test(route));
  ok('…both bounded by the same history bound the display honours',
    (route.match(/make_interval\(days => \$\{HISTORY_DAYS\}\)/g) || []).length === 2);
  // ⚠️ IN THE SAME BATCH, SO A BLANK ROW COSTS NO EXTRA ROUND TRIP. Fetching them only for the
  // symbols that came back empty would be a second serial hop on every poll with an empty row.
  ok('⚠️ the fallback reads ride the same Promise.all, not a second round trip',
    /const \[news, halt, filings, insiders, congress, wire, histInsiders, histCongress\] = await Promise\.all\(\[/.test(route)
    && !/await Promise\.all\(\[[\s\S]*await Promise\.all\(\[/.test(route));
  ok('…and the same readers build them, so the wording rules live in one place',
    (route.match(/fromInsider\(\{/g) || []).length === 1 && (route.match(/fromCongress\(\{/g) || []).length === 1);
  ok('⚠️ quote polling is untouched', !/getQuotes|market-data|realtime/.test(route));

  // ── ⚠️ A HISTORICAL LINE IS VISUALLY QUIETER, IN THE SAME LAYOUT ───────────
  ok('⚠️ the row reads the fallback flag rather than re-deriving age',
    /const old = change\.historical === true;/.test(changeLine));
  ok('⚠️ …and a 60-day-old transaction is dimmer than a current one',
    /color: old \? C\.dim : C\.muted/.test(changeLine) && /color: old \? C\.hint : C\.dim/.test(changeLine));
  ok('…its marker loses its fill rather than its place', /background: 'transparent', border: `1px solid \$\{C\.hint\}`/.test(changeLine));
  ok('⚠️ the age shown is still the true age, not softened', /changeAgo\(change\.at\)/.test(changeLine));

  // ⚠️ EXISTING INSPECTORS, NOT NEW ONES.
  ok('⚠️ a company-event line opens the existing news inspector',
    /toNews \? inspectNews : inspectEvidence/.test(term)
    && /change\.kind === CHANGE\.FILING \|\| change\.kind === CHANGE\.WIRE/.test(term));
  ok('…and a transaction opens the existing evidence inspector', /inspectEvidence/.test(term));
  ok('neither is reimplemented here', !/api\/eightk|api\/consensus/.test(changeLine));
  ok('⚠️ the line does not steal the row\'s own click', /e\.stopPropagation\(\); \(toNews \? inspectNews : inspectEvidence\)\(sym\)/.test(term));
  ok('it is reachable from a keyboard', /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'/.test(changeLine));

  // ⚠️ A ROW WITH NOTHING TO SAY IS THE ROW IT ALWAYS WAS.
  ok('⚠️ the second line renders only where there is a change',
    /\{sig\.changes\?\.\[r\.ticker\] && \(/.test(term));
  ok('…and the price row is otherwise untouched', /onClick=\{\(\) => onPick && onPick\(r\.ticker\)\}/.test(term));
  // ⚠️ THE LAYOUT IS APPROVED AND NOT PART OF THIS CHANGE.
  ok('⚠️ the approved line layout is unchanged', /fontSize: 10, lineHeight: 1\.3, maxWidth: 230,/.test(term));
  ok('…and a long wire headline is ellipsized rather than wrapping the row',
    /overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'/.test(changeLine));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
