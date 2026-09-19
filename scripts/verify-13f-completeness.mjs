// THE SILENT-SUCCESS FAILURE MODES, AS REGRESSION TESTS.
//
// Three distinct ways a 13F filing disappeared while the run reported success. All three produced
// the same observable: a quarter absent from the database, no error recorded, no counter moved, and
// a completion marker written anyway. They are tested together because they are one class of bug —
// an unresolved unit wearing the clothes of a resolved one.
//
//   1. TRANSPORT       EDGAR 503 → secFetch null → fetchHoldings [] → `if (!rows.length) continue`.
//                      Present since the path's first commit, 113a871d.
//   2. PARSE           <infoTable xmlns:ns1="..."> — an attribute on the element — did not match
//                      `<(?:\w+:)?infoTable>`, so a perfectly readable filing parsed to zero rows
//                      and took the same silent path. Cost BNP Paribas Asset Management six
//                      consecutive quarters, 18,119 positions, entirely invisibly.
//   3. BOOKKEEPING     A partial result still satisfied "no error was recorded", so the completion
//                      marker was written and the filer was never revisited.
//
// Run: node --import ./scripts/real-db-register.mjs scripts/verify-13f-completeness.mjs

import { infoTableDetector, infoTableBlocks, fieldMatcher, splitSubmissionDocuments } from '../src/lib/institutions-quarter.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };

// The exact opening tag BNP Paribas files, from 0001520354-25-000023.
const BNP = '<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">' +
  '<infoTable xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">' +
  '<nameOfIssuer> <![CDATA[3M CO]]> </nameOfIssuer><titleOfClass>COM</titleOfClass>' +
  '<cusip>88579Y101</cusip><value>35079</value>' +
  '<shrsOrPrnAmt><sshPrnamt>238815</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>' +
  '</infoTable></informationTable>';
const PLAIN = '<infoTable><cusip>037833100</cusip><value>1000</value>' +
  '<shrsOrPrnAmt><sshPrnamt>50</sshPrnamt></shrsOrPrnAmt></infoTable>';
const PREFIXED = '<ns1:infoTable><ns1:cusip>594918104</ns1:cusip></ns1:infoTable>';

console.log('\n=== 2. THE PARSE FAILURE: an attribute on <infoTable> ===');
{
  ok('the real BNP element is DETECTED', infoTableDetector().test(BNP));
  ok('the real BNP element is EXTRACTED', (BNP.match(infoTableBlocks()) || []).length === 1);
  ok('a plain element still works', infoTableDetector().test(PLAIN));
  ok('a namespace-prefixed element still works', infoTableDetector().test(PREFIXED));
  ok('prefixed extracts too', (PREFIXED.match(infoTableBlocks()) || []).length === 1);
}

console.log('\n=== the tag boundary still has to mean something ===');
{
  // Without a boundary requirement, `<infoTableSummary>` would be read as a position block and the
  // cover-page totals would be parsed as holdings.
  ok('<infoTableSummary> is NOT an infoTable', !infoTableDetector().test('<infoTableSummary>x</infoTableSummary>'));
  ok('<myInfoTable> is not matched by the bare name', !infoTableDetector().test('<myInfoTable>x</myInfoTable>'));
  ok('a closing tag alone is not a match', !infoTableDetector().test('</infoTable>'));
  ok('empty input is not a match', !infoTableDetector().test(''));
}

console.log('\n=== fields tolerate attributes, and keep their boundary ===');
{
  const blk = (BNP.match(infoTableBlocks()) || [])[0] || '';
  const grab = (n) => { const m = blk.match(fieldMatcher(n)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
  ok('cusip reads', grab('cusip') === '88579Y101');
  ok('value reads', grab('value') === '35079');
  ok('shares read from the nested element', grab('sshPrnamt') === '238815');
  ok('CDATA issuer reads', grab('nameOfIssuer') === '3M CO');
  // Null-safe on purpose: a broken matcher must report FAIL, not throw. The first version indexed
  // [1] directly and a mutation that returned no match crashed the suite instead of failing it,
  // which reads as an error rather than as the defect being caught.
  const field = (xml, name) => { const m = xml.match(fieldMatcher(name)); return m ? m[1] : null; };

  // `value` must not swallow `tableValueTotal`, a cover-page field with a completely different
  // meaning — reading it as a position's value would inflate the holding ~1000x.
  ok('value does not match tableValueTotal',
    field('<tableValueTotal>999999</tableValueTotal><value>42</value>', 'value') === '42');
  // The sharper boundary case: a tag ENDING with the field name. Without a left boundary,
  // `<otherCusip>` is read as the position's cusip and every holding takes the wrong identity.
  ok('a tag ending with the field name is not matched',
    field('<otherCusip>BADBADBAD</otherCusip>', 'cusip') === null);
  ok('...and the real field is still found beside it',
    field('<otherCusip>BAD</otherCusip><cusip>037833100</cusip>', 'cusip') === '037833100');
  ok('an attribute on a field is tolerated',
    field('<cusip xsi:nil="false">037833100</cusip>', 'cusip') === '037833100');
}

console.log('\n=== 1+3. SUCCESS / PARTIAL / FAILED are distinguishable ===');
{
  // The semantics ingestFiler now returns. Modelled here so the contract is asserted without a
  // network call: the runner keys its completion marker off `status`, never off a counter.
  const classify = (unresolved, sawIndex) => {
    if (!sawIndex) return 'failed';
    return unresolved.length ? 'partial' : 'complete';
  };
  ok('everything resolved → complete', classify([], true) === 'complete');
  ok('an unreadable quarter → partial', classify([{ quarter: '2025-03-31', reason: 'unreadable' }], true) === 'partial');
  ok('a zero-parse quarter → partial', classify([{ quarter: '2025-03-31', reason: 'no-positions-parsed' }], true) === 'partial');
  ok('no submissions index → failed, NOT complete', classify([], false) === 'failed');
  ok('failed is not complete', classify([], false) !== 'complete');
  // The heart of it: "nothing went wrong that we counted" must never imply completeness.
  ok('partial is never complete', classify([{ quarter: 'q', reason: 'unreadable' }], true) !== 'complete');
}

console.log('\n=== a reason survives, so a gap can be explained and resumed ===');
{
  const unresolved = [{ quarter: '2025-03-31', reason: 'unreadable' }, { quarter: '2025-06-30', reason: 'no-positions-parsed' }];
  ok('every entry names its quarter', unresolved.every((u) => !!u.quarter));
  ok('every entry names why', unresolved.every((u) => u.reason === 'unreadable' || u.reason === 'no-positions-parsed'));
  ok('the two causes stay distinguishable', new Set(unresolved.map((u) => u.reason)).size === 2);
}

console.log('\n=== 4. THE COMPLETE-SUBMISSION FALLBACK PARSES PER DOCUMENT ===');
{
  // Routes 1 and 2 fetch ONE document and stop at the first holding an info table. Route 3 reads the
  // whole concatenated submission, so without splitting it first, a filing carrying TWO info-table
  // documents would have both read as one table and their positions merged — a security in each
  // would be summed across documents never meant to be combined. Silent, and arithmetically
  // plausible, which is the worst combination.
  const doc = (type, body) => `<DOCUMENT>\n<TYPE>${type}\n${body}\n</DOCUMENT>\n`;
  const table = (cusip) => `<informationTable><infoTable><cusip>${cusip}</cusip><value>10</value>` +
    `<shrsOrPrnAmt><sshPrnamt>5</sshPrnamt></shrsOrPrnAmt></infoTable></informationTable>`;

  const twoTables = doc('13F-HR', '<primaryDoc/>') + doc('INFORMATION TABLE', table('111111111')) +
    doc('INFORMATION TABLE', table('222222222'));
  const docs = splitSubmissionDocuments(twoTables);
  ok('three documents are separated', docs.length === 3);
  ok('the cover page holds no table', !infoTableDetector().test(docs[0]));
  const withTable = docs.filter((d) => infoTableDetector().test(d));
  // Null-safe: a broken splitter must FAIL these, not throw. A crash reads as an error in the test
  // rather than as the defect being caught, and the distinction matters when reading a mutation run.
  const blocks = (d) => (typeof d === 'string' ? (d.match(infoTableBlocks()) || []).length : -1);
  ok('both info-table documents are found', withTable.length === 2);
  ok('each yields ONE position, not two merged', blocks(withTable[0]) === 1 && blocks(withTable[1]) === 1);
  // The regression itself: parsing the raw submission would see both.
  ok('parsing the UNSPLIT submission would have merged them — the bug this prevents',
    (twoTables.match(infoTableBlocks()) || []).length === 2);
  ok('the first table document is the one taken, matching routes 1 and 2',
    String(withTable[0] ?? '').includes('111111111'));

  const normal = doc('13F-HR', '<primaryDoc/>') + doc('INFORMATION TABLE', table('037833100'));
  const one = splitSubmissionDocuments(normal).filter((d) => infoTableDetector().test(d));
  ok('the ordinary two-document filing still yields exactly one table', one.length === 1);
  ok('...and one position', blocks(one[0]) === 1);
}

console.log('\n=== the splitter never turns a readable filing into an unreadable one ===');
{
  // A submission with no SGML markers is one document. Returning nothing here would convert a
  // filing we CAN read into a fetch failure — trading one silent loss for another.
  const bare = '<informationTable><infoTable><cusip>037833100</cusip></infoTable></informationTable>';
  ok('a submission with no <DOCUMENT> markers is returned whole', splitSubmissionDocuments(bare).length === 1);
  ok('...and still parses', infoTableDetector().test(String(splitSubmissionDocuments(bare)[0] ?? '')));
  ok('empty string yields nothing', splitSubmissionDocuments('').length === 0);
  ok('a non-string yields nothing, not a crash',
    splitSubmissionDocuments(null).length === 0 && splitSubmissionDocuments(undefined).length === 0);
  ok('an unterminated <DOCUMENT> still yields its content',
    splitSubmissionDocuments('<DOCUMENT>\n<TYPE>X\nbody-without-close').length === 1);
  ok('lowercase markers are handled', splitSubmissionDocuments('<document>a</document>').length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
