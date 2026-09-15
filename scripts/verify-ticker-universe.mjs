// Does the ticker URL grammar 404 anything real?
//
// The grammar in src/lib/ticker-symbol.mjs is a hard gate: a symbol it rejects returns HTTP 404 and
// becomes unreachable. So it is checked against every symbol Catalyst Pit actually holds — all seven
// ticker-keyed tables, not just the screener — rather than against an assumption about what a U.S.
// ticker looks like. "1 to 5 letters" would have killed 5,120 five-character symbols, 66 dotted
// share classes and 26 hyphenated ones.
//
// It also exercises the verification probe that decides index vs noindex, using the same SQL
// ticker-resolve.server.mjs runs. That module is behind a `server-only` guard and cannot be imported
// outside a React Server Component, so the query is mirrored here.
//
// Run: node --env-file=.env.local scripts/verify-ticker-universe.mjs

import { neon } from '@neondatabase/serverless';
import { isValidSymbol, normalizeSymbol } from '../src/lib/ticker-symbol.mjs';

const sql = neon(process.env.DATABASE_URL);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const SOURCES = [
  ['screener_stocks',      'select distinct ticker t from screener_stocks where ticker is not null'],
  ['insider_trades',       'select distinct ticker t from insider_trades where ticker is not null'],
  ['congress_trades',      'select distinct ticker t from congress_trades where ticker is not null'],
  ['fund_holdings',        'select distinct ticker t from fund_holdings where ticker is not null'],
  ['eightk_filings',       'select distinct ticker t from eightk_filings where ticker is not null'],
  ['ticker_daily_candles', 'select distinct ticker t from ticker_daily_candles where ticker is not null'],
  ['primary_events',       'select distinct unnest(tickers) t from primary_events where cluster_id is null'],
];

const where = new Map();  // symbol -> Set(table)
for (const [name, q] of SOURCES) {
  const rows = await sql.query(q);
  for (const r of rows) {
    const t = String(r.t ?? '');
    if (!where.has(t)) where.set(t, new Set());
    where.get(t).add(name);
  }
}
const syms = [...where.keys()];
const accepted = syms.filter(isValidSymbol);
const rejected = syms.filter((s) => !isValidSymbol(s));

console.log('=== UNIVERSE ===');
console.log('  distinct symbols across 7 ticker-keyed tables  ' + syms.length.toLocaleString('en-US'));
console.log('  accepted by the URL grammar                    ' + accepted.length.toLocaleString('en-US')
  + '  (' + (100 * accepted.length / syms.length).toFixed(2) + '%)');
console.log('  rejected                                       ' + rejected.length.toLocaleString('en-US'));

// THE LOAD-BEARING ASSERTION. screener_stocks is the listed universe a user can reach from the
// screener, the search box or a watchlist. Not one of those may 404.
const listed = syms.filter((s) => where.get(s).has('screener_stocks'));
const listedRejected = listed.filter((s) => !isValidSymbol(s));
console.log('\n=== SCREENER-LISTED (the reachable universe) ===');
console.log('  symbols   ' + listed.length.toLocaleString('en-US'));
console.log('  rejected  ' + listedRejected.length);
ok('no screener-listed symbol is rejected', listedRejected.length === 0,
   listedRejected.slice(0, 20).map((s) => JSON.stringify(s)).join(' '));

// Every rejection must be an EXTRACTION ARTIFACT, not a security. Shown in full so the claim is
// auditable rather than asserted.
console.log('\n=== EVERY REJECTED SYMBOL (' + rejected.length + ') ===');
const why = (s) => {
  if (s === '') return 'empty';
  if (/\s/.test(s)) return 'whitespace';
  if (/[a-z]/.test(s)) return 'lowercase';
  if (!/^[A-Z]/.test(s)) return 'no leading letter';
  if (s.length > 10) return 'too long';
  const bad = [...new Set(s.split('').filter((c) => !/[A-Z0-9.-]/.test(c)))].join('');
  return bad ? `illegal char ${JSON.stringify(bad)}` : 'separator shape';
};
for (const s of rejected.sort()) {
  console.log('  ' + JSON.stringify(s).padEnd(34) + why(s).padEnd(22) + [...where.get(s)].join(','));
}
ok('no rejection originates in screener_stocks', !rejected.some((s) => where.get(s).has('screener_stocks')));

// Share classes specifically.
const dotted = accepted.filter((s) => s.includes('.'));
const hyphen = accepted.filter((s) => s.includes('-'));
console.log('\n=== SHARE CLASSES PRESERVED ===');
console.log('  dotted      ' + dotted.length + '   ' + dotted.slice(0, 16).join(' '));
console.log('  hyphenated  ' + hyphen.length + '   ' + hyphen.slice(0, 16).join(' '));
ok('dotted share classes survive', dotted.length >= 60, 'got ' + dotted.length);
ok('hyphenated share classes survive', hyphen.length >= 20, 'got ' + hyphen.length);
for (const s of ['BRK.A', 'BRK.B', 'HEI.A', 'LEN.B', 'MOG.A', 'UHAL.B'])
  ok(`${s} still reachable`, accepted.includes(s) || isValidSymbol(s));

// Lowercase requests for real symbols must normalise onto a symbol we hold, not into nothing.
console.log('\n=== CASE NORMALIZATION AGAINST REAL SYMBOLS ===');
const held = new Set(syms);
let miss = 0;
for (const s of accepted) if (normalizeSymbol(s.toLowerCase()) !== s) miss++;
ok('every held symbol round-trips from its lowercase URL', miss === 0, miss + ' failed');

// ── the verification probe (index vs noindex) ───────────────────────────────
// Same SQL as ticker-resolve.server.mjs. Any hit in any first-party table counts, which is why this
// does not de-index PPTINC — a symbol in insider filings that the screener has never carried.
const PROBE = `select
    exists(select 1 from screener_stocks      where ticker = $1)
 or exists(select 1 from insider_trades       where ticker = $1)
 or exists(select 1 from ticker_daily_candles where ticker = $1)
 or exists(select 1 from fund_holdings        where ticker = $1)
 or exists(select 1 from eightk_filings       where ticker = $1)
 or exists(select 1 from congress_trades      where ticker = $1) as known`;
const known = async (s) => { const [r] = await sql.query(PROBE, [s]); return r.known === true; };

console.log('\n=== VERIFICATION PROBE ===');
for (const s of ['AAPL', 'NVDA', 'BRK.B', 'SRRK', 'UHAL.B', 'PPTINC']) {
  const k = await known(s);
  console.log('  ' + s.padEnd(9) + (k ? 'verified  -> index'   : 'unresolved -> noindex'));
  ok(`${s} verified`, k === true);
}
for (const s of ['ZZZZZZ', 'NOTAREALT', 'QQQQQ', 'BRK-B']) {
  const k = await known(s);
  console.log('  ' + s.padEnd(9) + (k ? 'verified  -> index'   : 'unresolved -> noindex'));
  ok(`${s} unresolved`, k === false);
}

// PPTINC is the whole reason the probe is not keyed to screener_stocks alone.
ok('probe is broader than screener_stocks', where.get('PPTINC') && !where.get('PPTINC').has('screener_stocks'),
   'PPTINC tables: ' + [...(where.get('PPTINC') || [])].join(','));

// Probe cost, since a crawl of thousands of ticker URLs runs it once per symbol per cache window.
const t0 = Date.now();
for (let i = 0; i < 10; i++) await known('AAPL');
console.log('\n  probe cost  ' + ((Date.now() - t0) / 10).toFixed(0) + 'ms average over 10 calls');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
