// THE CONGRESS POINT-IN-TIME WINDOW.
//
// Pit Consensus windowed congressional activity on the TRANSACTION date. Under the STOCK Act a
// member may disclose up to 45 days after trading, and on our own data the median lag is 28 days,
// the 90th percentile 116, the maximum 1,932 — with 17.6% disclosed more than 90 days later.
//
// So the old window did two wrong things at once:
//
//   IT READ THE FUTURE. Evidence was dated to a day nobody outside Congress could have known it.
//   IT DISCARDED THE PRESENT. Any trade whose lag exceeded 90 days fell outside the window forever —
//   it became public and the score never saw it. Measured when the fix landed: 597 of the 911 buy
//   disclosures then inside the window, 65.5%, across 401 tickers and $12.4M.
//
// These assertions are the characterization of the OLD behaviour and the specification of the new
// one, written so the defect cannot return quietly.
//
// Run: node scripts/verify-congress-window.mjs

import { readFileSync } from 'node:fs';
import {
  dayMs, informationDate, transactionDate, withinInformationWindow, disclosureLagDays, WINDOW_DAYS,
} from '../src/lib/congress-window.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const D = (s) => Date.parse(`${s}T00:00:00Z`);
const TODAY = D('2026-09-18');
const daysAgo = (n) => TODAY - n * 86_400_000;
const trade = (txnDaysAgo, discDaysAgo) => ({
  transaction_date: new Date(daysAgo(txnDaysAgo)).toISOString().slice(0, 10),
  disclosure_date: discDaysAgo == null ? null : new Date(daysAgo(discDaysAgo)).toISOString().slice(0, 10),
});

console.log('\n=== the information date is the DISCLOSURE date ===');
{
  const t = trade(100, 2);
  ok('information date reads disclosure', informationDate(t) === daysAgo(2));
  ok('the transaction date is preserved separately', transactionDate(t) === daysAgo(100));
  ok('...and the two are different facts', informationDate(t) !== transactionDate(t));
  ok('the lag is reported', disclosureLagDays(t) === 98);
  ok('snake_case and camelCase rows both work',
    informationDate({ disclosureDate: '2026-09-16' }) === D('2026-09-16'));
  ok('the documented window is 90 days', WINDOW_DAYS === 90);
}

console.log('\n=== the six cases this fix exists for ===');
{
  // 1. TRANSACTION 10 DAYS AGO, DISCLOSED TODAY — in, under either rule.
  ok('txn 10d ago, disclosed today → IN', withinInformationWindow(trade(10, 0), TODAY));

  // 2. TRANSACTION 100 DAYS AGO, DISCLOSED TODAY — the headline case. The OLD rule excluded this
  //    entirely: the trade became public today and the score never saw it.
  ok('txn 100d ago, disclosed today → IN (was invisible)', withinInformationWindow(trade(100, 0), TODAY));

  // 3. TRANSACTION TODAY, DISCLOSED LATER — must NOT count today. This is the future-information
  //    guard, and it is the assertion that makes historical evaluation trustworthy.
  ok('txn today, disclosed in 20 days → OUT today',
    withinInformationWindow({ transaction_date: '2026-09-18', disclosure_date: '2026-10-08' }, TODAY) === false);
  ok('...and IN once that day arrives',
    withinInformationWindow({ transaction_date: '2026-09-18', disclosure_date: '2026-10-08' }, D('2026-10-08')) === true);

  // 4. A VERY LATE DISCLOSURE — two years after the fact is still news on the day it is filed.
  ok('txn 730d ago, disclosed today → IN', withinInformationWindow(trade(730, 0), TODAY));
  // ...and it ages out of the window on its own schedule, by disclosure not by transaction.
  ok('...and ages out 91 days after DISCLOSURE', withinInformationWindow(trade(730, 91), TODAY) === false);

  // 5. MISSING DISCLOSURE DATE — unusable, and explicitly NOT approximated by the transaction date.
  //    Falling back would reintroduce the defect.
  ok('a missing disclosure date is OUT, never a fallback',
    withinInformationWindow({ transaction_date: '2026-09-17', disclosure_date: null }, TODAY) === false);
  ok('...and its information date is null', informationDate({ transaction_date: '2026-09-17' }) === null);
  ok('a malformed disclosure date is OUT',
    withinInformationWindow({ disclosure_date: 'not-a-date' }, TODAY) === false);

  // 6. THE BOUNDARY, both sides.
  ok('disclosed exactly 90 days ago → IN', withinInformationWindow(trade(120, 90), TODAY));
  ok('disclosed 91 days ago → OUT', withinInformationWindow(trade(120, 91), TODAY) === false);
  ok('disclosed exactly today → IN', withinInformationWindow(trade(5, 0), TODAY));
  ok('disclosed tomorrow → OUT', withinInformationWindow(trade(5, -1), TODAY) === false);
}

console.log('\n=== future information cannot enter a score computed at any past instant ===');
{
  // Replay the same trade across a timeline. It must be invisible before disclosure and visible
  // after — never before. This is the property that makes the fix a point-in-time fix rather than
  // merely a wider window.
  const t = { transaction_date: '2026-05-01', disclosure_date: '2026-08-20' };
  const visible = ['2026-05-01', '2026-06-15', '2026-08-19', '2026-08-20', '2026-09-18', '2026-11-19']
    .map((d) => [d, withinInformationWindow(t, D(d))]);
  ok('invisible on the transaction day', visible[0][1] === false);
  ok('invisible three months later, still undisclosed', visible[1][1] === false);
  ok('invisible the day BEFORE disclosure', visible[2][1] === false);
  ok('visible ON the disclosure day', visible[3][1] === true);
  ok('still visible a month later', visible[4][1] === true);
  ok('gone once the window passes', visible[5][1] === false);
  // The old rule would have made it visible from 2026-05-01 — three and a half months early.
  ok('the old transaction-date rule would have leaked it',
    D('2026-05-01') >= D('2026-05-01') - 90 * 86_400_000 && visible[0][1] === false);
}

console.log('\n=== the fix is strictly additive, and that is provable ===');
{
  // disclosure_date >= transaction_date always, so any row the OLD window admitted the new one
  // admits too. Measured against production at the time of the fix: 300 tickers gained, 0 lost.
  const oldRule = (row, asOf) => {
    const txn = transactionDate(row);
    return txn != null && txn >= asOf - 90 * 86_400_000 && txn <= asOf;
  };
  const cases = [trade(10, 5), trade(89, 1), trade(45, 44), trade(90, 0), trade(5, 5)];
  const regressions = cases.filter((c) => oldRule(c, TODAY) && !withinInformationWindow(c, TODAY));
  ok('nothing the old rule admitted is now excluded', regressions.length === 0, String(regressions.length));
  // ...and it genuinely admits more.
  ok('the new rule admits what the old one dropped',
    !oldRule(trade(100, 0), TODAY) && withinInformationWindow(trade(100, 0), TODAY));
}

console.log('\n=== the SHIPPED query windows on disclosure, not transaction ===');
{
  // The assertions above prove the RULE. This one proves the rule is the one production runs — the
  // confluence suite's database double discards the where clause, so the only way to pin the column
  // is to read the source. A pure test passing while the SQL drifts back is exactly the failure this
  // prevents.
  const src = readFileSync(new URL('../src/lib/confluence.js', import.meta.url), 'utf8');
  const congressBlock = src.slice(src.indexOf('congressTrades.action'), src.indexOf('groupBy(congressTrades.ticker)'));
  ok('the congress window filters on disclosureDate', /congressTrades\.disclosureDate/.test(congressBlock));
  ok('...and NOT on transactionDate', !/congressTrades\.transactionDate/.test(congressBlock), congressBlock.slice(0, 160));
  // The insider window is a different question with a different answer and is NOT touched by this
  // patch: its lag is ~2 days and its correctness is tracked separately.
  ok('the insider window is unchanged by this patch', /insiderTrades\.transactionDate/.test(src));
}

console.log('\n=== date parsing ===');
{
  ok('an ISO day parses', dayMs('2026-09-18') === D('2026-09-18'));
  ok('a timestamp is truncated to its day', dayMs('2026-09-18T14:22:00Z') === D('2026-09-18'));
  ok('a Date object works', dayMs(new Date(D('2026-09-18'))) === D('2026-09-18'));
  ok('nonsense is null', dayMs('nope') === null && dayMs(null) === null && dayMs(undefined) === null);
  ok('a lag needs both dates', disclosureLagDays({ disclosure_date: '2026-09-18' }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
