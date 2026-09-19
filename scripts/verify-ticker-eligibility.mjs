// WHAT MAY BE SHOWN TO A USER AS A TICKER.
//
// The homepage's largest-buy card rendered:
//
//     NONE  ·  $9.8M  ·  LIBERTY MUTUAL HOLDING CO INC.  ·  bought · 2026-09-18
//
// Nothing was broken in the renderer and nothing failed to resolve. Form 4 carries an
// issuerTradingSymbol field, an unlisted issuer's filer types "NONE" into it, and the row was stored
// as filed. The security was 5C Lending Partners Corp — a non-traded fund with no public ticker —
// and Liberty Mutual was the 10% owner doing the buying, which is why a buyer's name appeared beside
// a non-symbol. The card selector took topBuys[0] unconditionally; no layer between the filing and
// the homepage ever asked whether the symbol was a symbol.
//
// The risk in fixing this is OVER-rejection, and it is not hypothetical: ALL, GO, IT, NA, ON and SO
// all look like filler and are all real securities in our own universe. A generous blocklist would
// have silently removed Allstate, Grocery Outlet, Gartner, Nano Labs, ON Semiconductor and Southern
// Company from every card and every board — a worse bug than the one being fixed, and a quieter one.
//
// Run: node scripts/verify-ticker-eligibility.mjs

import { isRenderableTicker, firstRenderable } from '../src/lib/security-identity.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };

console.log('\n=== the placeholders that caused this ===');
{
  ok('NONE is rejected', !isRenderableTicker('NONE'));
  ok('lowercase none is rejected', !isRenderableTicker('none'));
  ok('padded " NONE " is rejected', !isRenderableTicker('  NONE  '));
  ok('NULL is rejected', !isRenderableTicker('NULL'));
  ok('N/A is rejected', !isRenderableTicker('N/A'));
  ok('UNKNOWN is rejected', !isRenderableTicker('UNKNOWN'));
  ok('UNDEFINED is rejected', !isRenderableTicker('UNDEFINED'));
  ok('TBD is rejected', !isRenderableTicker('TBD'));
}

console.log('\n=== absent values are rejected, never rendered ===');
{
  ok('null', !isRenderableTicker(null));
  ok('undefined', !isRenderableTicker(undefined));
  ok('empty string', !isRenderableTicker(''));
  ok('whitespace only', !isRenderableTicker('   '));
  ok('a number is not a ticker', !isRenderableTicker(123));
  ok('an object is not a ticker', !isRenderableTicker({ ticker: 'AAPL' }));
}

console.log('\n=== identifiers that are not symbols ===');
{
  ok('a raw CUSIP is rejected', !isRenderableTicker('88579Y101'));
  ok('a raw CIK is rejected', !isRenderableTicker('0001998387'));
  ok('an ISIN is rejected', !isRenderableTicker('US0378331005'));
  ok('a company name is rejected', !isRenderableTicker('LIBERTY MUTUAL HOLDING CO INC.'));
  ok('a name fragment is rejected', !isRenderableTicker('5C Lending'));
  ok('too long is rejected', !isRenderableTicker('ABCDEFG'));
  ok('digits inside are rejected', !isRenderableTicker('AA1'));
  ok('a trailing dot is rejected', !isRenderableTicker('BRK.'));
  ok('a leading dot is rejected', !isRenderableTicker('.B'));
}

console.log('\n=== REAL TICKERS THAT LOOK LIKE FILLER — must all pass ===');
{
  // Every one of these is in the screener universe. Rejecting any is a worse bug than NONE.
  ok('ALL (Allstate)', isRenderableTicker('ALL'));
  ok('GO (Grocery Outlet)', isRenderableTicker('GO'));
  ok('IT (Gartner)', isRenderableTicker('IT'));
  ok('NA (Nano Labs)', isRenderableTicker('NA'));
  ok('ON (ON Semiconductor)', isRenderableTicker('ON'));
  ok('SO (Southern Company)', isRenderableTicker('SO'));
  // NAN spent one draft of this fix inside the blocklist. It is Nuveen New York Quality Municipal
  // Income Fund, $357M. Caught by querying the live universe before shipping, which is the only
  // reason it is a test and not an outage — an over-rejected ticker looks exactly like a security
  // that simply is not trading.
  ok('NAN (Nuveen New York Quality Municipal Income Fund)', isRenderableTicker('NAN'));
}

console.log('\n=== every shape the screener universe actually contains ===');
{
  ok('1 letter', isRenderableTicker('F'));
  ok('4 letters', isRenderableTicker('AAPL'));
  ok('5 letters', isRenderableTicker('AAAZX'));
  ok('class share BRK.B', isRenderableTicker('BRK.B'));
  ok('class share BF.A', isRenderableTicker('BF.A'));
  ok('class share MKC.V', isRenderableTicker('MKC.V'));
  ok('4+suffix NWAX.U', isRenderableTicker('NWAX.U'));
  ok('4+suffix UHAL.B', isRenderableTicker('UHAL.B'));
  ok('lowercase input is accepted and is the same ticker', isRenderableTicker('aapl'));
}

console.log('\n=== candidate fallback: skip the invalid, keep the ranking ===');
{
  const c = (ticker, v) => ({ ticker, v });
  ok('first valid is taken', firstRenderable([c('AAPL', 3), c('MSFT', 2)])?.ticker === 'AAPL');
  ok('first invalid → second valid', firstRenderable([c('NONE', 9), c('MSFT', 2)])?.ticker === 'MSFT');
  ok('three invalid → fourth valid',
    firstRenderable([c('NONE', 9), c(null, 8), c('', 7), c('NVDA', 1)])?.ticker === 'NVDA');
  ok('all invalid → null, never a blank card',
    firstRenderable([c('NONE', 9), c('N/A', 8), c(undefined, 7)]) === null);
  ok('empty list → null', firstRenderable([]) === null);
  ok('a non-array → null', firstRenderable(null) === null);
  ok('order is preserved, not re-sorted', firstRenderable([c('NONE', 9), c('ON', 5), c('AAPL', 99)])?.ticker === 'ON');
  ok('a custom accessor works', firstRenderable([{ sym: 'NONE' }, { sym: 'TSLA' }], (x) => x.sym)?.sym === 'TSLA');
}

console.log('\n=== the exact production row that caused the bug ===');
{
  const row = { ticker: 'NONE', company: '5C Lending Partners Corp.', executive: 'LIBERTY MUTUAL HOLDING Co INC.', totalValue: 9761987.52 };
  const next = { ticker: 'AAPL', company: 'Apple Inc.', executive: 'COOK TIMOTHY', totalValue: 1000000 };
  ok('the offending row is not renderable', !isRenderableTicker(row.ticker));
  ok('selection skips it and takes the next real security', firstRenderable([row, next])?.ticker === 'AAPL');
  ok('its issuer name is not promoted to a ticker', !isRenderableTicker(row.company));
  ok('its buyer name is not promoted to a ticker', !isRenderableTicker(row.executive));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
