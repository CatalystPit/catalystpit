// THE SECURITY MASTER: precedence, and the two things it must never do.
//
// What is actually under test here is a pair of promises.
//
// The first is PRECEDENCE. A name its owner filed outranks a name a vendor supplied, always, and the
// order is not a preference — it is the reason a licensed vendor can be swapped out without any
// filed identity changing. If these assertions stop holding, "canonical" means nothing.
//
// The second is that WE NEVER INVENT A NAME. An SIC industry description is not a company name, a
// truncated 13F issuer string is not a company name, and a blank is a better answer than either.
// null is a legitimate result and is asserted as one.
//
// Pure: no database, no network, no credentials.
//
// Run: node scripts/verify-security-identity.mjs

import {
  IDENTITY_SOURCES, sourceRank, cleanIdentityName, pickIdentity,
  resolveFilerName, parseSecTickerFile, buildIdentities,
} from '../src/lib/security-identity.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

console.log('\n=== the precedence is an order, and it is the one we documented ===');
{
  ok('four sources, highest first',
    IDENTITY_SOURCES.join() === 'form4,registrant,sec_ticker,provider');
  ok('a filed name outranks a registrant name', sourceRank('form4') < sourceRank('registrant'));
  ok('a registrant name outranks SEC\'s standing list', sourceRank('registrant') < sourceRank('sec_ticker'));
  // THE ONE THAT MATTERS COMMERCIALLY. The vendor is temporary and its naming is licensed; it must
  // never be able to overwrite a name an issuer filed for itself.
  ok('the vendor is always last', sourceRank('provider') === IDENTITY_SOURCES.length - 1);
  ok('every documented source ranks ahead of the vendor',
    ['form4', 'registrant', 'sec_ticker'].every((s) => sourceRank(s) < sourceRank('provider')));
  ok('an unknown source ranks nowhere', sourceRank('finra') === Infinity && sourceRank('') === Infinity);
}

console.log('\n=== a name we are willing to print ===');
{
  ok('a real name survives', cleanIdentityName('Apple Inc.') === 'Apple Inc.');
  ok('filings pad and wrap; we collapse', cleanIdentityName('  Cohen  &\n Steers   Inc  ') === 'Cohen & Steers Inc');
  ok('empty is null', cleanIdentityName('') === null && cleanIdentityName('   ') === null);
  ok('absent is null', cleanIdentityName(null) === null && cleanIdentityName(undefined) === null);
  // The regression this codebase already paid for once: "PHARMACEUTICAL PREPARATIONS" under ZTS.
  ok('an SIC description is not a company name', cleanIdentityName('PHARMACEUTICAL PREPARATIONS') === null);
  ok('and neither is another one', cleanIdentityName('PETROLEUM REFINING') === null);
  ok('a real name that merely looks industrial still survives',
    cleanIdentityName('Pharmaceutical Product Development, Inc.') === 'Pharmaceutical Product Development, Inc.');
}

console.log('\n=== picking between sources ===');
{
  const p = pickIdentity([
    { source: 'provider', name: 'Apple Inc' },
    { source: 'form4', name: 'Apple Inc.' },
    { source: 'sec_ticker', name: 'APPLE INC' },
  ]);
  ok('the filed name wins regardless of argument order', p.name === 'Apple Inc.' && p.source === 'form4');

  // THE TEN REPORTED SYMBOLS, in miniature: no filing, so SEC's ticker file answers.
  const fund = pickIdentity([
    { source: 'form4', name: null },
    { source: 'registrant', name: '' },
    { source: 'sec_ticker', name: 'COHEN & STEERS INFRASTRUCTURE FUND INC' },
  ]);
  ok('a fund with no filings resolves from SEC\'s ticker file',
    fund.name === 'COHEN & STEERS INFRASTRUCTURE FUND INC' && fund.source === 'sec_ticker');

  // An ETF: in no SEC ticker file, files no Form 4. The vendor is the only source that knows it.
  const etf = pickIdentity([{ source: 'sec_ticker', name: null }, { source: 'provider', name: 'Vanguard S&P 500 ETF' }]);
  ok('an ETF falls all the way to the vendor', etf.name === 'Vanguard S&P 500 ETF' && etf.source === 'provider');

  ok('nothing resolvable is null, not a placeholder', pickIdentity([{ source: 'form4', name: '  ' }]) === null);
  ok('no candidates at all is null', pickIdentity([]) === null && pickIdentity(null) === null);
  // A source we have not sanctioned cannot sneak a name in by being the only one present.
  ok('an unranked source is refused even when it is alone',
    pickIdentity([{ source: 'thirteen_f', name: 'FIRST TR INTER DURATN PFD &amp;' }]) === null);
  // Two candidates from the SAME source is not a case buildIdentities produces, but pickIdentity is
  // exported and the answer must not depend on argument order. First wins, stably.
  ok('an equal-ranked candidate does not displace the one already held',
    pickIdentity([{ source: 'form4', name: 'First Filed Name' }, { source: 'form4', name: 'Second Filed Name' }]).name === 'First Filed Name');
  // An SIC description must not win just because it arrived at the top of the ladder.
  ok('a rejected name does not block a good one below it',
    pickIdentity([{ source: 'form4', name: 'PETROLEUM REFINING' }, { source: 'sec_ticker', name: 'Exxon Mobil Corp' }]).name === 'Exxon Mobil Corp');
}

console.log('\n=== the filer tie-break (the VKI regression) ===');
{
  // VERBATIM FROM PRODUCTION. Three Form 4 rows for VKI on one date: two name the issuer, one names
  // Bank of America, which had filed against it as a 10% holder. `distinct on (ticker) order by
  // filing_date desc` is not a total order, and Postgres picked Bank of America — so the screener
  // printed "BANK OF AMERICA CORP /DE/" on an Invesco municipal trust.
  const vki = [
    { name: 'Invesco Advantage Municipal Income Trust II', date: '2026-05-04', count: 2 },
    { name: 'BANK OF AMERICA CORP /DE/', date: '2026-05-04', count: 1 },
  ];
  ok('the issuer beats a holder filing against it on the same date',
    resolveFilerName(vki) === 'Invesco Advantage Municipal Income Trust II');
  ok('and the order the rows arrive in cannot change that',
    resolveFilerName([...vki].reverse()) === 'Invesco Advantage Municipal Income Trust II');

  // A rename must still win, even against a long history under the old name — which is exactly why
  // the latest date is consulted BEFORE the count.
  ok('a later filing beats a more numerous older one', resolveFilerName([
    { name: 'Old Name Corp', date: '2020-01-01', count: 400 },
    { name: 'New Name Inc.', date: '2026-08-01', count: 1 },
  ]) === 'New Name Inc.');

  ok('a single filing resolves', resolveFilerName([{ name: 'Realty Income Corp', date: '2026-01-01', count: 1 }]) === 'Realty Income Corp');
  ok('no usable rows is null', resolveFilerName([{ name: '', date: '2026-01-01', count: 9 }]) === null);
  ok('no rows at all is null', resolveFilerName([]) === null && resolveFilerName(null) === null);
  ok('an SIC description is refused here too',
    resolveFilerName([{ name: 'RADIO BROADCASTING STATIONS', date: '2026-01-01', count: 50 }]) === null);
  // Total order: equal date AND equal weight still has to give the same answer twice.
  const dead = [{ name: 'B Corp', date: '2026-01-01', count: 1 }, { name: 'A Corp', date: '2026-01-01', count: 1 }];
  ok('a dead heat is broken deterministically',
    resolveFilerName(dead) === 'A Corp' && resolveFilerName([...dead].reverse()) === 'A Corp');
  // A name filed across several dates POOLS its weight rather than competing with itself. Here the
  // issuer's 3+2 filings beat the holder's 4 on the tied latest date — which is the whole point: an
  // issuer files for itself over and over, a holder files against it occasionally.
  ok('one name\'s filings pool across dates', resolveFilerName([
    { name: 'Issuer Inc.', date: '2026-01-01', count: 3 },
    { name: 'Issuer Inc.', date: '2026-06-01', count: 2 },
    { name: 'Holder LLC', date: '2026-06-01', count: 4 },
  ]) === 'Issuer Inc.');
}

console.log('\n=== SEC\'s ticker file ===');
{
  const file = {
    0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    1: { cik_str: 1 , ticker: 'utf', title: 'COHEN & STEERS INFRASTRUCTURE FUND INC' },
    2: { cik_str: 2, ticker: '', title: 'No Ticker Co' },
    3: { cik_str: 3, ticker: 'BAD', title: '   ' },
    4: null,
  };
  const parsed = parseSecTickerFile(file);
  ok('good rows parse', parsed.length === 2);
  ok('tickers are upper-cased', parsed.some((x) => x.ticker === 'UTF'));
  ok('a row with no ticker is skipped', !parsed.some((x) => x.name === 'No Ticker Co'));
  ok('a row with no title is skipped', !parsed.some((x) => x.ticker === 'BAD'));
  // Somebody else's file, fetched inside a nightly rebuild: a malformed entry must not throw.
  ok('malformed entries do not throw', Array.isArray(parseSecTickerFile(null)) && parseSecTickerFile(undefined).length === 0);
}

console.log('\n=== folding every source into one row per ticker ===');
{
  const rows = buildIdentities({
    form4: new Map([['AAPL', 'Apple Inc.']]),
    registrant: new Map([['KO', 'Coca-Cola Co']]),
    sec_ticker: new Map([['AAPL', 'APPLE INC'], ['UTF', 'COHEN & STEERS INFRASTRUCTURE FUND INC']]),
    provider: new Map([['SPY', 'SPDR S&P 500 ETF Trust'], ['AAPL', 'Apple Inc']]),
  });
  const by = new Map(rows.map((r) => [r.ticker, r]));
  ok('every named ticker appears exactly once', rows.length === 4 && by.size === 4);
  ok('AAPL keeps its filed name', by.get('AAPL').name === 'Apple Inc.' && by.get('AAPL').source === 'form4');
  ok('KO keeps its registrant name', by.get('KO').source === 'registrant');
  ok('UTF resolves from SEC', by.get('UTF').source === 'sec_ticker');
  ok('SPY resolves from the vendor', by.get('SPY').source === 'provider');
  ok('the output is sorted, so two runs write the same thing',
    rows.map((r) => r.ticker).join() === [...by.keys()].sort().join());
  // A ticker nothing can name is ABSENT. It is never present carrying a placeholder.
  const sparse = buildIdentities({ form4: new Map([['ZZZZ', '   ']]) });
  ok('an unnameable ticker is absent, not blank', sparse.length === 0);
  ok('no sources at all is an empty list', buildIdentities().length === 0 && buildIdentities({}).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
