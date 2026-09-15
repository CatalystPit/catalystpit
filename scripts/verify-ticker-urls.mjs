// /ticker/[symbol] URL grammar and index-bloat hardening.
//
// Before this: every path segment returned HTTP 200 with a confident "<junk> · Stock Price, News,
// Insider & Congress Trades" title, /ticker/aapl and /ticker/AAPL were two indexable URLs with
// identical content, and the only canonical on the route was the one inherited from the root layout
// — which points at the HOMEPAGE. An unbounded duplicate surface anyone could mint by typing.
//
// What is tested here is the pure grammar: which strings are symbols, what they normalise to, and
// which URL a non-canonical one redirects to. The verification probe is database-backed and
// server-only, so it is exercised separately; see the OFFLINE note at the bottom.
//
// Run: node scripts/verify-ticker-urls.mjs

import { readFile } from 'node:fs/promises';
import { isValidSymbol, normalizeSymbol, tickerPath, TICKER_TABS, MAX_SYMBOL_LEN } from '../src/lib/ticker-symbol.mjs';
import { canonical } from '../src/lib/seo.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

// ── 1. normalization ────────────────────────────────────────────────────────
section('1. symbol normalization');
for (const [raw, want] of [
  ['AAPL', 'AAPL'], ['aapl', 'AAPL'], ['AaPl', 'AAPL'], ['aApL', 'AAPL'],
  ['BRK.B', 'BRK.B'], ['brk.b', 'BRK.B'], ['BrK.b', 'BRK.B'],
  ['BRK-B', 'BRK-B'], ['brk-b', 'BRK-B'],
  ['  aapl  ', 'AAPL'],                    // a stray space in a pasted link is still a real request
  ['a', 'A'],
]) ok(`normalizeSymbol(${JSON.stringify(raw)}) -> ${want}`, normalizeSymbol(raw) === want,
      'got ' + JSON.stringify(normalizeSymbol(raw)));

// Normalisation is IDEMPOTENT: the redirect target can never itself redirect, so no chains.
section('2. no redirect chains (normalize is idempotent)');
for (const raw of ['aapl', 'BrK.b', 'brk-b', ' uhal.b ', 'cftr-pra', 'achr.ws']) {
  const once = normalizeSymbol(raw);
  ok(`${JSON.stringify(raw)} settles in one hop`, once !== null && normalizeSymbol(once) === once,
     `${once} -> ${normalizeSymbol(once)}`);
}

// ── 3. malformed rejection ──────────────────────────────────────────────────
section('3. malformed symbols are rejected (-> HTTP 404)');
for (const raw of [
  '', '   ', '!!!!!!!!', 'NOT_A_VALID_FORMAT_IF_OUTSIDE_ALLOWED_PATTERN', 'NOTAREALTICKER',
  '1ABC', '123', '$AAPL', '(AAPL)', '[NONE]', 'NASDAQ:DHC', 'BRK/B', 'N/A', 'A B', 'AAPL,MSFT',
  '.AAPL', '-AAPL', 'A.', 'A-', 'A..B', 'A--B', 'A.-B', 'A.........', 'ABCDEFGHIJK',
  'AWK 3.625 06/15/26', '<script>', '../../etc/passwd', 'AAPL?tab=x', 'ASTS?', 'EA*',
]) ok(`reject ${JSON.stringify(raw)}`, normalizeSymbol(raw) === null, 'got ' + JSON.stringify(normalizeSymbol(raw)));

// ── 4. share classes and special shapes survive ─────────────────────────────
// A "1-5 alphabetic characters" rule would have 404'd every one of these. They are real rows.
section('4. dotted share classes preserved');
for (const s of ['BRK.A', 'BRK.B', 'BF.A', 'BF.B', 'BH.A', 'BIO.B', 'CRD.A', 'GEF.B', 'GTN.A',
                 'HEI.A', 'LEN.B', 'MKC.V', 'MOG.A', 'MOG.B', 'UHAL.B'])
  ok(`accept ${s}`, isValidSymbol(s) && normalizeSymbol(s.toLowerCase()) === s);

section('5. hyphenated share classes and preferreds preserved');
for (const s of ['BRK-A', 'BRK-B', 'OAK-PA', 'SRG-PA', 'AHL-C', 'AHL-PD', 'ANG-PD', 'CFTR-PRA', 'AB-LEND'])
  ok(`accept ${s}`, isValidSymbol(s) && normalizeSymbol(s.toLowerCase()) === s);

section('6. warrants, units, rights, pink sheets, long and digit-bearing symbols preserved');
for (const s of ['ACHR.WS', 'NWAX.U', 'GAB.RT', 'ECIA.PK', 'HBIA.PK', 'PHXE.P',
                 'ABALX', 'AACAY', 'ALLKGUSD', 'ARCH1USD', 'AXIA3', 'AZUL3', 'FSI01', 'A', 'AA'])
  ok(`accept ${s}`, isValidSymbol(s), `len=${s.length}`);

// The nav search rewrites the trader convention "/ES" to the URL-safe route form "FUT.ES" (see
// resolveFutures in src/lib/futures.js). Every futures root the product offers must survive the
// grammar, or the futures pages become unreachable.
section('6b. futures route form (FUT.<root>) preserved');
for (const root of ['ES', 'MES', 'NQ', 'MNQ', 'YM', 'RTY', 'VIX', 'DXY', 'CL', 'MCL', 'BZ', 'NG',
                    'GC', 'MGC', 'SI', 'HG', 'PL', '6E', '6B', '6J', '6A', '6C', 'BTC', 'ETH']) {
  const s = `FUT.${root}`;
  ok(`accept ${s}`, isValidSymbol(s), `len=${s.length}`);
  ok(`${s} round-trips from lowercase`, normalizeSymbol(s.toLowerCase()) === s);
}

// BRK.B and BRK-B are DISTINCT URLs. They may name the same security, but we hold one of those
// strings and not the other, and inventing a mapping between them would be a guess.
section('7. dotted and hyphenated forms stay distinct');
ok('BRK.B does not become BRK-B', normalizeSymbol('brk.b') === 'BRK.B');
ok('BRK-B does not become BRK.B', normalizeSymbol('brk-b') === 'BRK-B');

// ── 8. length ceiling ───────────────────────────────────────────────────────
section('8. length ceiling');
ok(`MAX_SYMBOL_LEN is ${MAX_SYMBOL_LEN}`, MAX_SYMBOL_LEN === 10);
ok('10 chars accepted', isValidSymbol('ABCDEFGHIJ'));
ok('11 chars rejected', !isValidSymbol('ABCDEFGHIJK'));

// ── 9. redirect target ──────────────────────────────────────────────────────
section('9. redirect target preserves real tabs, drops everything else');
ok('no tab -> bare path', tickerPath('AAPL', undefined) === '/ticker/AAPL');
ok('overview dropped (default view is not a second URL)', tickerPath('AAPL', 'overview') === '/ticker/AAPL');
for (const t of ['news', 'press', 'earnings', 'guidance', 'dividends', 'analyst',
                 'insider', 'short', 'government', 'institutions', 'financials'])
  ok(`tab=${t} preserved`, tickerPath('AAPL', t) === `/ticker/AAPL?tab=${t}`);
for (const junk of ['ref', 'utm_source', 'nope', '', 'INSIDER', 'insider ', ['a', 'b']])
  ok(`tab=${JSON.stringify(junk)} dropped`, tickerPath('AAPL', junk) === '/ticker/AAPL');
ok('tab list matches TickerPage TABS count', TICKER_TABS.size === 12, 'size=' + TICKER_TABS.size);

// ── 10. canonical generation ────────────────────────────────────────────────
section('10. canonical generation');
for (const s of ['AAPL', 'BRK.B', 'BRK-B', 'ZZZZZZ'])
  ok(`canonical(/ticker/${s})`, canonical(`/ticker/${s}`).endsWith(`/ticker/${s}`)
    && /^https:\/\//.test(canonical(`/ticker/${s}`)), canonical(`/ticker/${s}`));
ok('canonical carries no query string', !canonical('/ticker/AAPL').includes('?'));
ok('canonical is uppercase-only', canonical('/ticker/AAPL') !== canonical('/ticker/aapl'));

// ── 11. unresolved-symbol handling is a SEPARATE axis from validity ─────────
// A syntactically valid symbol we hold no data for must still normalise and still get a canonical.
// It is the robots directive that changes, not the URL. This is what keeps a real ticker missing
// from screener_stocks alive.
section('11. unresolved but valid symbols are still first-class URLs');
for (const s of ['ZZZZZZ', 'BRK-B', 'QQQQQ']) {
  ok(`${s} is a valid symbol`, isValidSymbol(s));
  ok(`${s} has a canonical`, canonical(`/ticker/${s}`).endsWith(`/ticker/${s}`));
  ok(`${s} is not rewritten`, normalizeSymbol(s) === s);
}

// ── 12. no source exposure ──────────────────────────────────────────────────
// The grammar module is client-safe by construction. Assert it: nothing in it may name a vendor, a
// feed, a table or a credential, because it is importable from a browser bundle.
section('12. grammar module exposes nothing internal');
const src = await readFile(new URL('../src/lib/ticker-symbol.mjs', import.meta.url), 'utf8');
for (const forbidden of ['finnhub', 'polygon', 'tiingo', 'DATABASE_URL', 'API_KEY', 'neon',
                         'insider_trades', 'fund_holdings', 'primary_events',
                         'sec.gov', 'process.env'])
  ok(`no "${forbidden}"`, !src.toLowerCase().includes(forbidden.toLowerCase()));
ok('no imports at all (pure module)', !/^\s*import\s/m.test(src));

// OFFLINE NOTE: isKnownSymbol lives in ticker-resolve.server.mjs behind a `server-only` guard, which
// throws outside a React Server Component and cannot be imported here. Its behaviour is verified
// against the live universe by scripts/verify-ticker-universe.mjs, which needs DATABASE_URL.

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
