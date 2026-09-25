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
  CHANGE, PRECEDENCE, WINDOW_DAYS, NOTABLE_BANDS, WIRE_HIGH_IMPORTANCE, WIRE_MIN_IMPORTANCE,
  fromFiling, fromWire, fromInsider, fromCongress, fromScan, pickChange, rankOf, ago,
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
  ok('…and each source is ONE statement for the whole list',
    (route.match(/distinct on \(ticker/g) || []).length === 3
    && (route.match(/cross join lateral/g) || []).length === 1);
  ok('⚠️ …with no per-symbol loop around a query',
    !/for \(const sym of syms\)[\s\S]{0,400}(db\.execute|await db)/.test(route));
  ok('…bounded by the same symbol list the flags use',
    (route.match(/ticker = any\(\$\{arr\}::text\[\]\)/g) || []).length === 3
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
  ok('the selection itself is not done in the route',
    /pickChange\(\[/.test(route) && !/PRECEDENCE|rankOf/.test(route));

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
  ok('⚠️ the wire is attributed by the event\'s own tickers, never by a text search',
    /ce\.tickers @> array\[s\.ticker\]/.test(route) && !/ilike|to_tsquery|headline ~/.test(route));
  ok('…and reads the canonical event view, not a second news store',
    /from canonical_events ce/.test(route));

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
