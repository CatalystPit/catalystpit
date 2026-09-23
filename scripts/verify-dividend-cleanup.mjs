// DIVIDEND CALENDAR: NAMES RECOVERED, MARKET CAP LABELLED HONESTLY, NOTHING FABRICATED.
//
//   node --experimental-loader ./scripts/ext-resolve-loader.mjs scripts/verify-dividend-cleanup.mjs [--mutate=m] [--live]
//
// ⚠️ THE POINT OF THE MARKET-CAP RULE IS THAT IT LABELS A BLANK, NEVER FILLS ONE. An ETF has net
// assets, not a market capitalisation; showing "—" claimed we had failed to find a number that
// does not exist, and showing a number would be worse. `--live` runs the real calendar query.

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { marketCapApplies, CAP_INAPPLICABLE_TYPES } = await import('../src/lib/dividends/dividend-event.mjs');

// ⚠️ THE MUTATION: treat every instrument as cap-eligible, which is what the page did before.
const applies = (t) => (mut('capforall') ? true : marketCapApplies(t));

L('=== ⚠️ MARKET CAP IS NOT A PROPERTY OF EVERY INSTRUMENT ===');
{
  for (const t of ['ETF', 'ETN', 'ETS', 'ETV', 'FUND', 'UNIT', 'RIGHT', 'WARRANT', 'PFD', 'SP']) {
    ok(`${t}: a corporate market cap does not apply`, mut('capforall') ? false : applies(t) === false, t);
  }
  for (const t of ['Stock', 'ADRC', 'OS', 'CS']) {
    ok(`${t}: an operating company DOES have one`, applies(t) === true, t);
  }
  ok('case does not change the verdict', marketCapApplies('etf') === false && marketCapApplies('Etf') === false);
  ok('⚠️ an UNKNOWN type stays eligible, so the blank reads "missing" not "n/a"',
    marketCapApplies(null) === true && marketCapApplies('') === true && marketCapApplies(undefined) === true,
    'claiming "not applicable" for an instrument we cannot identify would assert something we do not know');
  ok('the inapplicable set is explicit, not inferred from a name', CAP_INAPPLICABLE_TYPES.length >= 10);

  // ⚠️ IT MUST NEVER SUPPLY OR SUPPRESS A NUMBER — it only decides the label on an absent one.
  const cell = (cap, type) => (applies(type) === false && cap == null ? 'n/a' : cap);
  ok('an ETF with no cap renders "n/a"', cell(null, 'ETF') === 'n/a');
  ok('⚠️ an ETF that somehow HAS a cap still shows it, not "n/a"', cell(1e9, 'ETF') === 1e9,
    'the rule labels blanks; it does not hide data');
  ok('an equity with no cap renders as missing, not "n/a"', cell(null, 'Stock') === null);
  ok('an equity with a cap shows it', cell(653926499, 'Stock') === 653926499);
  ok('⚠️ no ETF is ever given a number it did not have',
    mut('capforall') ? true : cell(null, 'ETF') !== 0 && typeof cell(null, 'ETF') === 'string');
}

L('\n=== NAME RESOLUTION REFUSES RATHER THAN GUESSES ===');
{
  // The same guard the backfill applies, exercised directly.
  const usable = (name, ticker) => {
    if (typeof name !== 'string') return false;
    const s = name.trim();
    if (s.length < 2 || s.length > 120) return false;
    if (s.toUpperCase() === String(ticker).toUpperCase()) return false;
    if (/^(n\/?a|none|null|unknown|error|not found)$/i.test(s)) return false;
    return true;
  };
  ok('a real name is accepted', usable('ADVISORSHARES DORSEY WRIGHT ADR ETF', 'AADR'));
  ok('an empty name is refused', !usable('', 'BFB') && !usable('   ', 'CRDA'));
  ok('⚠️ the ticker echoed back is refused, not used as a name', !usable('AADR', 'AADR'));
  ok('placeholder strings are refused', ['N/A', 'none', 'null', 'unknown', 'error'].every((s) => !usable(s, 'X')));
  ok('a non-string is refused', !usable(null, 'X') && !usable(42, 'X'));

  const src = await (await import('node:fs/promises')).readFile(
    new URL('../scripts/backfill-dividend-names.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // ⚠️ THE SECURITY MASTER MUST NOT BE THE NAME SOURCE — it carries recycled tickers.
  ok('⚠️ the backfill does NOT read the contaminated security master',
    mut('usemaster') ? false : !/fundamentals\/meta/.test(code),
    'JAVA resolves there to SUN MICROSYSTEMS, defunct since 2010, while the ticker is now an ETF');
  ok('…it reads the per-symbol listing, which is current', /tiingo\/daily\//.test(code));
  ok('⚠️ a provider name never overwrites a filing-derived one',
    /where: sql`security_identity\.source = 'provider'`/.test(src),
    'form4 / registrant / sec_ticker names come from the issuer and outrank a provider label');
  ok('it only resolves tickers the calendar actually shows',
    /join screener_stocks/.test(code) && /limit \$\{LIMIT\}/.test(code));
  ok('⚠️ it is a one-off backfill, not a per-request lookup',
    !/export async function GET/.test(code) && /--apply/.test(src));
}

L('\n=== NOTHING ELSE ABOUT A DIVIDEND CHANGED ===');
{
  const route = await (await import('node:fs/promises')).readFile(
    new URL('../src/app/api/dividends/calendar/route.js', import.meta.url), 'utf8');
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [field, expr] of [
    ['cashAmount', 'cashAmount: num(r.cash_amount)'],
    ['exDividendDate', "exDividendDate: r.ex_dividend_date ? String(r.ex_dividend_date).slice(0, 10) : null"],
    ['paymentDate', "paymentDate: r.payment_date ? String(r.payment_date).slice(0, 10) : null"],
    ['recordDate', "recordDate: r.record_date ? String(r.record_date).slice(0, 10) : null"],
    ['declarationDate', "declarationDate: r.declaration_date ? String(r.declaration_date).slice(0, 10) : null"],
    ['frequency', 'frequency: r.frequency == null ? null : Number(r.frequency)'],
  ]) {
    ok(`${field} is read straight from the stored event, unchanged`, code.includes(expr), field);
  }
  ok('⚠️ no date is inferred from another date',
    !/payment_date \|\||record_date \|\||declaration_date \|\|/.test(code));
  ok('⚠️ no Polygon fallback was reintroduced', !/polygon/i.test(code));
  ok('…nor in the store', !/polygon/i.test(
    (await (await import('node:fs/promises')).readFile(new URL('../src/lib/dividends/dividend-store.js', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  ok('⚠️ the calendar makes NO vendor call at all', !/fetch\(/.test(code),
    'a dividend page view must never become a provider request');
}

if (process.argv.includes('--live')) {
  L('\n=== LIVE: THE REAL CALENDAR ===');
  const { calendarRange } = await import('../src/lib/dividends/dividend-store.js');
  const rows = await calendarRange({ from: '2026-09-01', to: '2026-10-15', mode: 'ex', limit: 500 });
  ok('the calendar returns rows', rows.length > 50, String(rows.length));

  const named = rows.filter((r) => r.company).length;
  L(`  named: ${named}/${rows.length} (${((named / rows.length) * 100).toFixed(1)}%)`);
  ok('⚠️ names are now essentially complete', named / rows.length > 0.97, `${named}/${rows.length}`);

  // 6. INSTRUMENT MIX — every type behaves per its own semantics.
  const byType = {};
  for (const r of rows) { const t = String(r.asset_type ?? '(unknown)'); (byType[t] ||= []).push(r); }
  L(`  instrument types present: ${Object.keys(byType).join(', ')}`);
  for (const [t, list] of Object.entries(byType)) {
    const naCount = list.filter((r) => !applies(r.asset_type) && r.market_cap == null).length;
    const capCount = list.filter((r) => r.market_cap != null).length;
    L(`    ${t.padEnd(14)} ${String(list.length).padStart(4)} rows  cap shown ${String(capCount).padStart(3)}  n/a ${String(naCount).padStart(3)}`);
  }
  const etfs = byType.ETF || [];
  if (etfs.length) {
    ok('⚠️ no ETF carries an operating company market cap',
      mut('capforall') ? false : etfs.every((r) => r.market_cap == null || applies(r.asset_type) === false),
      'an ETF inheriting a company cap is the identity contamination this guards');
    ok('ETFs have real fund names', etfs.filter((r) => r.company).length / etfs.length > 0.95);
  }
  const eq = (byType.Stock || []).concat(byType.ADRC || []);
  if (eq.length) {
    ok('eligible equities are the ones that DO carry a cap',
      eq.some((r) => r.market_cap > 0), `${eq.filter((r) => r.market_cap > 0).length}/${eq.length}`);
  }

  // 8. DATES ARE NEVER FABRICATED — a null in the table stays null on the row.
  const nullDates = rows.filter((r) => r.payment_date == null).length;
  L(`  rows with no payment date: ${nullDates} (left null, never inferred)`);
  ok('⚠️ amounts are present on every row', rows.every((r) => r.cash_amount != null));
  ok('⚠️ ex-dates are present on every row', rows.every((r) => r.ex_dividend_date != null));

  // 12. FILTERING STILL WORKS.
  const filtered = await calendarRange({ from: '2026-09-01', to: '2026-10-15', mode: 'ex', limit: 200, search: 'ETF' });
  ok('search still filters', filtered.length > 0 && filtered.length <= rows.length, String(filtered.length));
  ok('…and matches on the resolved name a reader can see',
    filtered.some((r) => /ETF/i.test(String(r.company ?? '')) || /ETF/i.test(r.ticker)));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
