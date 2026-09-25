// WATCHLIST "WHAT CHANGED" — selection only, from canonical records.
//
// Two things a feature like this gets wrong, and both are quiet:
//
//   1. IT INVENTS A SCORE. A row has space for one change, so one must be chosen — and the obvious
//      move is an importance number, which would be a new methodology hiding inside a prototype and
//      tuned against nothing.
//   2. IT INVENTS WORDING. "Director bought $186K" must be three canonical fields printed next to
//      each other, not a sentence someone wrote about a filing.
//
// Run: node scripts/verify-watchlist-changes.mjs

import { readFileSync } from 'node:fs';
import {
  CHANGE, WINDOW_DAYS, fromFiling, fromInsider, fromCongress, fromScan, pickChange, ago,
} from '../src/lib/terminal/watchlist-changes.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const L = (s) => console.log(`\n=== ${s} ===`);
const NOW = Date.parse('2026-09-25T16:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

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

  ok('a scan membership names the board', fromScan('Moving Now', hoursAgo(1)).label === 'On Moving Now');
  ok('an undated record is never a change',
    fromFiling({ filedAt: 'nope' }) === null && fromInsider({ action: 'buy', filingDate: null }) === null
    && fromCongress({ type: 'purchase', disclosureDate: undefined }) === null && fromScan('X', null) === null);
}

L('⚠️ SELECTION IS RECENCY, NOT A SCORE');
{
  const older = fromFiling({ primaryLabel: 'Results of operations', filedAt: daysAgo(3) });
  const newer = fromInsider({ title: 'Director', action: 'buy', totalValue: 50000, filingDate: hoursAgo(2) });
  ok('⚠️ the most recent qualifying event wins, whatever kind it is',
    pickChange([older, newer], { now: NOW }).kind === CHANGE.INSIDER);
  ok('…and the same holds the other way round',
    pickChange([fromInsider({ title: 'Director', action: 'buy', totalValue: 1, filingDate: daysAgo(5) }),
      fromFiling({ primaryLabel: 'Merger', filedAt: hoursAgo(1) })], { now: NOW }).kind === CHANGE.FILING);
  ok('nothing qualifying is no line at all', pickChange([], { now: NOW }) === null);
  ok('…and so is a list of nulls', pickChange([null, null], { now: NOW }) === null);

  // ⚠️ NO IMPORTANCE NUMBER ANYWHERE.
  const src = readFileSync(new URL('../src/lib/terminal/watchlist-changes.mjs', import.meta.url), 'utf8');
  ok('⚠️ nothing here scores, weights or ranks by importance',
    !/score|weight|importance|priority\s*[:=]\s*\d/i.test(src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')));

  // The tie-break is stated, and only breaks ties.
  const t = Date.parse(hoursAgo(1));
  const tie = pickChange([{ kind: CHANGE.SCAN, at: t, label: 'On Moving Now' },
    { kind: CHANGE.FILING, at: t, label: 'Merger' }], { now: NOW });
  ok('a tie breaks in a stated order', tie.kind === CHANGE.FILING);
  ok('⚠️ but the order never promotes an older event over a newer one',
    pickChange([{ kind: CHANGE.FILING, at: Date.parse(daysAgo(2)), label: 'old' },
      { kind: CHANGE.SCAN, at: t, label: 'new' }], { now: NOW }).kind === CHANGE.SCAN);
}

L('⚠️ RECENCY WINDOWS, AND A FUTURE DATE IS BAD DATA');
{
  ok('a filing older than its window is not a change',
    pickChange([fromFiling({ primaryLabel: 'x', filedAt: daysAgo(WINDOW_DAYS[CHANGE.FILING] + 1) })], { now: NOW }) === null);
  ok('…and one inside it is', pickChange([fromFiling({ primaryLabel: 'x', filedAt: daysAgo(1) })], { now: NOW }) !== null);
  // ⚠️ CONGRESS GETS LONGER BECAUSE THE LAW ALLOWS 45 DAYS TO DISCLOSE. A 7-day window would hide
  // most disclosures in the week they became public.
  ok('⚠️ congress is given a longer window than a filing',
    WINDOW_DAYS[CHANGE.CONGRESS] > WINDOW_DAYS[CHANGE.FILING]);
  ok('…and it is measured on the disclosure date, not the trade date',
    fromCongress({ representative: 'X', type: 'purchase', disclosureDate: daysAgo(1),
      transactionDate: daysAgo(40) }).at === Date.parse(daysAgo(1)));
  ok('a scan membership is the shortest-lived of them', WINDOW_DAYS[CHANGE.SCAN] <= 2);
  ok('⚠️ nothing dated in the future is ever shown',
    pickChange([{ kind: CHANGE.FILING, at: NOW + 3600000, label: 'tomorrow' }], { now: NOW }) === null);
  ok('every kind has a window, so none can leak in unbounded',
    Object.values(CHANGE).every((k) => Number.isFinite(WINDOW_DAYS[k])));
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
  const route = readFileSync(new URL('../src/app/api/watchlist/signals/route.js', import.meta.url), 'utf8');
  const term = readFileSync(new URL('../src/app/terminal/TerminalClient.jsx', import.meta.url), 'utf8');

  // ⚠️ THE FAILURE THIS AVOIDS: one request per symbol per source, on every poll.
  ok('⚠️ the changes ride on the request the Watchlist already makes', /changes \}/.test(route));
  ok('…and each source is ONE statement for the whole list',
    (route.match(/distinct on \(ticker\)/g) || []).length === 3);
  ok('…bounded by the same symbol list the flags use', (route.match(/ticker = any\(/g) || []).length === 3);
  ok('⚠️ …and by the same windows the display honours',
    /make_interval\(days => \$\{WINDOW_DAYS\[CHANGE\.FILING\]\}\)/.test(route));
  ok('a source failing leaves the rest of the row alone', (route.match(/catch \{ return \[\]; \}/g) || []).length >= 3);
  ok('the 8-K label comes from the shared classifier, not a second one',
    /classifyItems\(fr\.items\)/.test(route));
  ok('the selection itself is not done in the route', /pickChange\(\[/.test(route) && !/importance/i.test(route));

  // ⚠️ EXISTING INSPECTORS, NOT NEW ONES.
  ok('⚠️ a filing opens the existing news inspector', /toNews \? inspectNews : inspectEvidence/.test(term));
  ok('…and research opens the existing evidence inspector', /inspectEvidence/.test(term));
  ok('neither is reimplemented here', !/api\/eightk|api\/consensus/.test(term.split('function ChangeLine')[1]?.split('function WatchlistBody')[0] || ''));
  ok('⚠️ the line does not steal the row\'s own click', /e\.stopPropagation\(\); \(toNews \? inspectNews : inspectEvidence\)\(sym\)/.test(term));
  ok('it is reachable from a keyboard', /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'/.test(term.split('function ChangeLine')[1] || ''));

  // ⚠️ A ROW WITH NOTHING TO SAY IS THE ROW IT ALWAYS WAS.
  ok('⚠️ the second line renders only where there is a change',
    /\{sig\.changes\?\.\[r\.ticker\] && \(/.test(term));
  ok('…and the price row is otherwise untouched', /onClick=\{\(\) => onPick && onPick\(r\.ticker\)\}/.test(term));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
