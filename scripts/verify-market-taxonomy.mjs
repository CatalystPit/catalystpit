// THE CANONICAL MARKET TAXONOMY, AS REGRESSION TESTS.
//
// Sectors were derived by a function that described itself accurately — "Coarse SIC-code → GICS-ish
// sector (approximate; good enough for screening buckets)" — and was then used to colour the market
// heatmap, which is a claim about where money moved. Measured on live data it put:
//
//   TSLA in INDUSTRIALS        SIC 3711, caught by `3000-3999 → Industrials`
//   PG   in BASIC MATERIALS    SIC 2841 (soap), caught by `2800-2899 → Basic Materials`
//   PLD  in FINANCIAL SERVICES SIC 6798 (REIT), caught by `6000-6799 → Financial Services`
//
// TSLA was the reported symptom. PG and PLD are the same defect, which is the reason this is a
// taxonomy and not a ticker override: `if (ticker === 'TSLA')` would have fixed one third of a
// problem and left the other two invisible.
//
// The fixtures below are SIC CODES, not tickers. A ticker-keyed table would pass these tests by
// memorising answers and would classify nothing it had not already been told about.
//
// Run: node scripts/verify-market-taxonomy.mjs

import { sicToMarketSector, isCanonicalSector, SECTORS } from '../src/lib/market-taxonomy.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}`); } };
const is = (label, sic, want) => ok(`${label} (SIC ${sic}) → ${want}`, sicToMarketSector(sic) === want);

console.log('\n=== THE THREE REPORTED FAILURES ===');
{
  is('TSLA motor vehicles', 3711, 'Consumer Cyclical');
  is('PG soap & detergents', 2841, 'Consumer Defensive');
  is('PLD real estate investment trust', 6798, 'Real Estate');
  // The ranges that used to swallow them must still work for what genuinely belongs there.
  is('CAT construction machinery stays Industrials', 3531, 'Industrials');
  is('LIN industrial chemicals stays Basic Materials', 2810, 'Basic Materials');
  is('JPM national commercial banks stays Financial Services', 6021, 'Financial Services');
}

console.log('\n=== one representative company per canonical sector ===');
{
  is('AAPL electronic computers', 3571, 'Technology');
  is('JPM banks', 6021, 'Financial Services');
  is('JNJ pharmaceutical preparations', 2834, 'Healthcare');
  is('AMZN catalog & mail-order', 5961, 'Consumer Cyclical');
  is('KO beverages', 2086, 'Consumer Defensive');
  is('T telephone communications', 4813, 'Communication Services');
  is('BA aircraft', 3721, 'Industrials');
  is('XOM petroleum refining', 2911, 'Energy');
  is('NEM gold mining', 1040, 'Basic Materials');
  is('NEE electric services', 4911, 'Utilities');
  is('AMT real estate operators', 6512, 'Real Estate');
  ok('every canonical sector is reachable from at least one SIC code',
    SECTORS.every((s) => [3571, 6021, 2834, 5961, 2086, 4813, 3721, 2911, 1040, 4911, 6512, 3711, 2841, 6798]
      .some((c) => sicToMarketSector(c) === s)));
}

console.log('\n=== the boundaries the old coarse ranges got wrong ===');
{
  // Manufacturing is one SIC division and three different market sectors.
  is('semiconductors are Technology, not Industrials', 3674, 'Technology');
  is('medical devices are Healthcare, not Industrials', 3841, 'Healthcare');
  is('surgical instruments are Healthcare', 3845, 'Healthcare');
  is('aircraft remain Industrials', 3724, 'Industrials');
  // SEC files semiconductor equipment under "Special Industry Machinery, NEC". $1.06T of the $1.07T
  // in that code is ASML, Lam Research and peers, which trade with semis rather than machinery.
  is('semiconductor equipment is Technology, not Industrials', 3559, 'Technology');
  is('general industrial machinery is still Industrials', 3550, 'Industrials');
  is('railroad equipment remains Industrials', 3743, 'Industrials');
  // Chemicals split between staples and materials.
  is('cosmetics are Consumer Defensive', 2844, 'Consumer Defensive');
  is('industrial inorganic chemicals are Basic Materials', 2819, 'Basic Materials');
  is('agricultural chemicals are Basic Materials', 2870, 'Basic Materials');
  // The 6000 block splits three ways.
  is('REITs are Real Estate', 6798, 'Real Estate');
  is('closed-end funds are Financial Services', 6726, 'Financial Services');
  is('real estate operators are Real Estate', 6519, 'Real Estate');
  is('insurance carriers are Financial Services', 6311, 'Financial Services');
  // Retail vs staples retail.
  is('grocery stores are Consumer Defensive', 5411, 'Consumer Defensive');
  is('restaurants are Consumer Cyclical', 5812, 'Consumer Cyclical');
  is('apparel retail is Consumer Cyclical', 5651, 'Consumer Cyclical');
  is('drug stores are Consumer Defensive', 5912, 'Consumer Defensive');
  // Media vs technology.
  is('software is Technology', 7372, 'Technology');
  is('data processing is Technology', 7374, 'Technology');
  is('broadcasting is Communication Services', 4833, 'Communication Services');
  is('motion pictures are Communication Services', 7812, 'Communication Services');
}

console.log('\n=== exact codes beat the ranges that contain them ===');
{
  // 3711 sits inside 3700-3799; 2841 inside 2800-2899; 6798 inside 6700-6799. If range order or the
  // exact table regressed, these are the assertions that notice.
  ok('3711 is not Industrials', sicToMarketSector(3711) !== 'Industrials');
  ok('2841 is not Basic Materials', sicToMarketSector(2841) !== 'Basic Materials');
  ok('6798 is not Financial Services', sicToMarketSector(6798) !== 'Financial Services');
  ok('but 3721 in the same block IS Industrials', sicToMarketSector(3721) === 'Industrials');
  ok('and 2819 in the same block IS Basic Materials', sicToMarketSector(2819) === 'Basic Materials');
  ok('and 6726 in the same block IS Financial Services', sicToMarketSector(6726) === 'Financial Services');
}

console.log('\n=== unclassifiable stays unclassified — never guessed ===');
{
  // The whole point of the rewrite: an unmappable security must be VISIBLY unclassified rather than
  // filed under whichever range happened to catch it.
  ok('an unknown code returns null', sicToMarketSector(9999) === null);
  ok('zero returns null', sicToMarketSector(0) === null);
  ok('null returns null', sicToMarketSector(null) === null);
  ok('undefined returns null', sicToMarketSector(undefined) === null);
  ok('empty string returns null', sicToMarketSector('') === null);
  ok('non-numeric text returns null', sicToMarketSector('PHARMACEUTICAL PREPARATIONS') === null);
  ok('a negative code returns null', sicToMarketSector(-3711) === null);
  ok('a string code still works', sicToMarketSector('3711') === 'Consumer Cyclical');
  ok('a padded string code still works', sicToMarketSector(' 3711 ') === 'Consumer Cyclical');
}

console.log('\n=== every result is a canonical sector or null ===');
{
  let bad = null;
  for (let c = 1; c <= 9999; c++) {
    const s = sicToMarketSector(c);
    if (s !== null && !isCanonicalSector(s)) { bad = `${c} → ${s}`; break; }
  }
  ok('no SIC code produces a non-canonical sector', bad === null);
  ok('isCanonicalSector rejects an invented sector', !isCanonicalSector('Industrials & Stuff'));
  ok('isCanonicalSector rejects OTHER', !isCanonicalSector('OTHER'));
  ok('isCanonicalSector rejects null', !isCanonicalSector(null));
  ok('there are exactly 11 canonical sectors', SECTORS.length === 11);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
