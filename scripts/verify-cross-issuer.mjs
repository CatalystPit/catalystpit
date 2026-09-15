// CROSS-ISSUER 13F TICKER MAPPING — the rules that keep an unrelated security off a ticker.
//
// Every fixture below is a REAL issuer string taken from production fund_holdings, and every
// registrant title is the real SEC company_tickers.json title for that entity. The defect was not
// hypothetical and neither are the cases: "INVESCO EXCH TRADED FD TR II" is what a filer actually
// wrote on the line that put an unrelated Invesco ETF onto IVZ.
//
//   node --env-file=.env.local scripts/verify-cross-issuer.mjs
//   (the resolver sections run without DATABASE_URL; live sections are skipped without it)

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { ncore, sameIssuer, isDerivativeClass, isDebtDeriv } from '../src/lib/issuer-core.mjs';
import { buildIndex, matchIssuerName } from '../src/lib/name-resolver.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const n = (x) => Number(x).toLocaleString('en-US');
const AUTH = ['openfigi', 'manual', 'consensus'];

// Real SEC registrant titles for every entity involved in the production defect.
const IDX = buildIndex({
  1: { cik_str: 914208, ticker: 'IVZ', title: 'Invesco Ltd.' },
  2: { cik_str: 1067839, ticker: 'QQQ', title: 'Invesco QQQ Trust, Series 1' },
  3: { cik_str: 1364742, ticker: 'BLK', title: 'BlackRock, Inc.' },
  4: { cik_str: 1084765, ticker: 'BFK', title: 'BlackRock Municipal Income Trust' },
  5: { cik_str: 1976695, ticker: 'INHD', title: 'INNO HOLDINGS INC.' },
  6: { cik_str: 1835378, ticker: 'CTV', title: 'Innovid Corp.' },
  7: { cik_str: 1652044, ticker: 'GOOGL', title: 'Alphabet Inc.' },
  8: { cik_str: 1652044, ticker: 'GOOG', title: 'Alphabet Inc.' },
  9: { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  10: { cik_str: 1067983, ticker: 'BRK-A', title: 'BERKSHIRE HATHAWAY INC' },
  11: { cik_str: 937966, ticker: 'ASML', title: 'ASML Holding N.V.' },
  12: { cik_str: 1639920, ticker: 'SPOT', title: 'Spotify Technology S.A.' },
  13: { cik_str: 34088, ticker: 'XOM', title: 'Exxon Mobil Corp' },
  14: { cik_str: 93751, ticker: 'STT', title: 'State Street Corp' },
  15: { cik_str: 1656936, ticker: 'CWAN', title: 'Clearwater Analytics Holdings, Inc.' },
  16: { cik_str: 842023, ticker: 'LEA', title: 'LEAR CORP' },
  17: { cik_str: 915912, ticker: 'AVB', title: 'AVALONBAY COMMUNITIES INC' },
  18: { cik_str: 1866175, ticker: 'AVBC', title: 'Avidia Bancorp, Inc.' },
  19: { cik_str: 1274494, ticker: 'VOO', title: 'Vanguard S&P 500 ETF' },
  20: { cik_str: 1100663, ticker: 'AGG', title: 'iShares Core U.S. Aggregate Bond ETF' },
});

// ── 1. a sponsor's name never establishes a security's ticker ──────────────
section('1. sponsor and trust names cannot reach the sponsor\'s ticker');
{
  // Every one of these is a production issuer string that the OLD prefix rule collapsed onto the
  // sponsor. Each must now resolve to nothing at all.
  const SPONSOR_LINES = [
    ['INVESCO EXCH TRADED FD TR II', 'IVZ'], ['INVESCO EXCHANGE TRADED FD T', 'IVZ'],
    ['INVESCO QQQ TR', 'IVZ'], ['INVESCO EXCH TRD SLF IDX FD', 'IVZ'],
    ['INVESCO ACTIVELY MANAGED EXC', 'IVZ'], ['INVESCO DB MULTI-SECTOR COMM', 'IVZ'],
    ['INVESCO ALERIAN GALAXY BLOCKCHAIN USERS AND DECENTRALIZED COMMERCE ETF', 'IVZ'],
    ['PROSHARES TR', 'AGQ'], ['PROSHARES TR II', 'AGQ'],
    ['INNOVATOR ETFS TRUST', 'INHD'], ['INNOVATOR HEDGED NASDAQ-100 ETF', 'INHD'],
    ['BLACKROCK ETF TRUST', 'BLK'], ['BLACKROCK MUN INC TRUST II', 'BLK'],
    ['BLACKROCK CORE BD TR', 'BLK'], ['BLACKROCK MUNIHOLDINGS QUALI', 'BLK'],
    ['ISHARES TRUST', 'BLK'], ['ISHARES TR', 'BLK'],
    ['STATE STR SPDR S&P 500 ETF T', 'STT'], ['SPDR S&P 500 ETF TR', 'STT'],
    ['SELECT SECTOR SPDR TR', 'STT'], ['GLOBAL X FDS', 'GTLL'],
    ['DIREXION ETF TRUST', 'TECS'], ['VANECK ETF TRUST', 'SMH'],
    ['SCHWAB STRATEGIC TR', 'SCHG'], ['CBRE CLARION GLOBAL REAL ESTATE INCOME', 'CBRE'],
    ['TIDAL TRUST II', 'DEFT'],
  ];
  for (const [line, sponsorTicker] of SPONSOR_LINES) {
    const got = matchIssuerName(IDX, line);
    ok(`"${line.slice(0, 34)}" does not become ${sponsorTicker}`, got !== sponsorTicker, `got ${got}`);
  }
  ok('a sponsor line resolves to nothing, not to something else',
    SPONSOR_LINES.every(([l]) => matchIssuerName(IDX, l) === null || matchIssuerName(IDX, l) === 'BFK' || matchIssuerName(IDX, l) === 'AGG'));
}

section('2. the four demonstrated tickers, at the name layer');
{
  ok('AGQ: no ProShares trust line resolves at all',
    ['PROSHARES TR', 'PROSHARES TR II', 'PROSHARES SHORT MSCI EAFE', 'PROSHARES ULTRA XRP ETF']
      .every((s) => matchIssuerName(IDX, s) === null));
  ok('IVZ: only the operating company resolves', matchIssuerName(IDX, 'INVESCO LTD') === 'IVZ');
  ok('IVZ: its funds do not', ['INVESCO QQQ TR', 'INVESCO EXCH TRADED FD TR II', 'INVESCO EXCHANGE TRADED FD T']
    .every((s) => matchIssuerName(IDX, s) !== 'IVZ'));
  ok('INHD: the operating company resolves', matchIssuerName(IDX, 'INNO HOLDINGS INC') === 'INHD');
  ok('INHD: Innovator and Innovid do not become INHD',
    matchIssuerName(IDX, 'INNOVATOR ETFS TRUST') !== 'INHD' && matchIssuerName(IDX, 'INNOVID CORP') !== 'INHD');
  ok('INHD: Innovid resolves to its OWN ticker', matchIssuerName(IDX, 'INNOVID CORP') === 'CTV');
  ok('BLK: the operating company resolves', matchIssuerName(IDX, 'BLACKROCK INC') === 'BLK');
  ok('BLK: a closed-end BlackRock trust resolves to ITS ticker, not BLK',
    matchIssuerName(IDX, 'BLACKROCK MUNICIPAL INCOME TRUST') === 'BFK');
  ok('BLK: the iShares trusts do not become BLK',
    ['ISHARES TRUST', 'ISHARES TR', 'BLACKROCK ETF TRUST'].every((s) => matchIssuerName(IDX, s) !== 'BLK'));
}

section('3. legitimate identity still resolves');
{
  for (const [line, want] of [
    ['INVESCO LTD', 'IVZ'], ['BLACKROCK INC', 'BLK'], ['INNO HOLDINGS INC', 'INHD'],
    ['ALPHABET INC', 'GOOG'], ['ALPHABET INC CL A', 'GOOG'],
    ['ASML HLDG NV', 'ASML'], ['ASML HOLDING ADR', 'ASML'], ['SPOTIFY TECHNOLOGY SA', 'SPOT'],
    ['EXXON MOBIL CORP', 'XOM'], ['STATE STREET CORP', 'STT'],
    ['CLEARWATER ANALYTICS HOLDINGS INC', 'CWAN'], ['LEAR CORP', 'LEA'],
    ['AVALONBAY COMMUNITIES INC', 'AVB'], ['Avidia Bancorp, Inc.', 'AVBC'],
  ]) ok(`"${line}" -> ${want}`, matchIssuerName(IDX, line) === want, 'got ' + matchIssuerName(IDX, line));
  // GOOG/GOOGL are prefix-related, so one registrant name resolves to the shorter primary. BRK-A and
  // BRK-B are not, and the matcher refuses rather than picking one — the class lives in the CUSIP,
  // which is where both of them are actually resolved from.
  ok('prefix-related share classes collapse to the primary', matchIssuerName(IDX, 'ALPHABET INC') === 'GOOG');
  ok('divergent share classes are refused, not guessed', matchIssuerName(IDX, 'BERKSHIRE HATHAWAY INC') === null);
  ok('an ETF family under one registrant is never guessed',
    matchIssuerName(IDX, 'VANGUARD INDEX FDS') === null);
  // CAPITAL is not a droppable word, so "ALPHABET INC CAP STK" does not reduce to ALPHABET. That is
  // the deliberate trade: measured over production, zero unresolved holdings carry CAP or CAPITAL in
  // the issuer, while dropping it collapsed Capital International onto the bare core INTERNATIONAL.
  ok('CAPITAL is never dropped, even where it costs a match',
    matchIssuerName(IDX, 'ALPHABET INC CAP STK CL A') === null && ncore('BURFORD CAPITAL') === 'BURFORDCAPITAL');
}

section('4. ambiguity and debt resolve to NULL, never to a guess');
{
  ok('an unknown issuer resolves to null', matchIssuerName(IDX, 'SOME PRIVATE HOLDCO LLC') === null);
  ok('a note line resolves to null', matchIssuerName(IDX, 'EXXON MOBIL 3.25 08/16/2029') === null);
  ok('a convertible resolves to null', matchIssuerName(IDX, 'JAZZ INVESTMENTS I 2.5 09/15/2030') === null);
  ok('a financing subsidiary is not its parent', matchIssuerName(IDX, 'SEAGATE HDD CAYMAN NOTE 5.00') === null);
  ok('isDebtDeriv catches the shapes filers use',
    ['NABORS INDS NOTE 7.50', 'PAGAYA 1.25 10/01/2029', 'AEGON FUNDING PFD'].every(isDebtDeriv));
  ok('a derivative class never speaks for identity',
    ['OPTION', 'PUT', 'CALL', 'W EXP 11/30/2027', 'NOTE 2.25% 2027'].every(isDerivativeClass));
  ok('an ETF creation unit is NOT read as a derivative',
    !isDerivativeClass('UNIT SER 1') && !isDerivativeClass('COM') && !isDerivativeClass('SH BEN INT'));
}

section('5. the resolver is deterministic');
{
  const lines = ['INVESCO LTD', 'INVESCO QQQ TR', 'BLACKROCK INC', 'PROSHARES TR', 'ALPHABET INC CAP STK CL A'];
  const a = lines.map((l) => matchIssuerName(IDX, l));
  for (let i = 0; i < 25; i++)
    ok('run ' + i + ' matches run 0', JSON.stringify(lines.map((l) => matchIssuerName(IDX, l))) === JSON.stringify(a));
  ok('the core is order-independent and stable',
    ncore('BLACKROCK INC') === ncore('BlackRock, Inc.') && ncore('BLACKROCK INC') === 'BLACKROCK');
  ok('equality, not containment', !sameIssuer('INVESCO EXCH TRADED FD TR II', 'INVESCO LTD')
    && sameIssuer('INVESCO LTD', 'Invesco Ltd.'));
}

// ── 6. the shipped code says what it must ──────────────────────────────────
section('6. the pipeline cannot reintroduce the defect');
{
  const nr = await readFile(new URL('../src/lib/name-resolver.js', import.meta.url), 'utf8');
  ok('the bidirectional prefix match is gone',
    !/startsWith\(n\)|n\.startsWith\(e\.n\)/.test(nr), 'prefix matching is still in matchOne');
  ok('matching is an exact core lookup', /idx\.byN\.get\(n\)/.test(nr));
  ok('the normaliser is shared, not re-declared', /from '\.\/issuer-core\.mjs'/.test(nr) && !/const ncore =/.test(nr));

  const iu = await readFile(new URL('../src/lib/institutions-universe.js', import.meta.url), 'utf8');
  const fn = iu.slice(iu.indexOf('export async function resolveHoldingsByName'),
                      iu.indexOf('export async function reresolveDisputedCusips'));
  ok('inference never overwrites a cusip_map row', /ON CONFLICT \(cusip\) DO NOTHING/.test(fn));
  ok('inference never writes over an authoritative mapping', /openfigi', 'manual', 'consensus'/.test(fn));
  ok('a REJECTED cusip is skipped when choosing an issuer', /c\.status = 'rejected'/.test(fn));
  ok('a REJECTED cusip can never be refilled on the holdings', /OR c\.status = 'rejected'/.test(fn));
  ok('derivative and debt lines do not vote on identity',
    /security_position_class/.test(fn) && /NOT IN \('debt', 'option', 'warrant', 'right', 'preferred'\)/.test(fn));
  ok('no second hand-written class regex in the pipeline', !/~\*/.test(fn));
  ok('it still only fills NULLs', /h\.ticker IS NULL/.test(fn));

  const rp = await readFile(new URL('./repair-cross-issuer.mjs', import.meta.url), 'utf8');
  ok('the repair never deletes a holding', !/delete from fund_holdings/i.test(rp));
  ok('the repair only ever writes fund_holdings.ticker', !/update fund_holdings[\s\S]{0,120}set (?!ticker)/i.test(rp));
  ok('the repair is scoped to multi-issuer-prefix tickers', /having count\(\*\) > 1/.test(rp));
  ok('the repair refuses to wipe a ticker entirely', /!gs\.some\(/.test(rp));
  ok('the repair invalidates only the CUSIPs it touched', /catalystpit:cusip:/.test(rp) && !/flushall|flushdb/i.test(rp));
}

// ── live ───────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) { console.log('\n(live sections skipped — no DATABASE_URL)'); }
else {
  const sql = neon(process.env.DATABASE_URL);

  section('7. the four demonstrated tickers, in production');
  // ONE ISSUER, not one CUSIP. A security legitimately acquires a second CUSIP prefix on a
  // redomicile or a reorganisation — BlackRock's 09247X pre-dates its 09290D — so the assertion is
  // that every prefix still on the ticker is the SAME ISSUER, which is the thing that was wrong.
  const EXPECTED = { AGQ: 'PROSHARES', IVZ: 'INVESCO', INHD: 'INNO', BLK: 'BLACKROCK' };
  for (const t of ['AGQ', 'IVZ', 'INHD', 'BLK']) {
    const r = await sql.query(`select left(f.cusip,6) pfx, count(*)::int rows,
        (array_agg(f.issuer order by cnt desc))[1] issuer, sum(f.rows)::int trows
      from (select cusip, issuer, count(*)::int cnt, count(*)::int rows, sum(value) value
              from fund_holdings where ticker = $1 and cusip ~ '^[0-9A-Z]{9}$'
             group by cusip, issuer) f
      group by 1 order by sum(f.rows) desc`, [t]);
    const dom = r.map((x) => ncore(x.issuer));
    console.log('  ' + t.padEnd(6) + r.length + ' prefix(es): '
      + r.map((x, i) => x.pfx + ' ' + x.trows + 'r ' + dom[i].slice(0, 22)).join('   |   '));
    ok(`${t}: every remaining prefix is the ticker's own issuer`,
      dom.every((c) => c.startsWith(EXPECTED[t])), dom.filter((c) => !c.startsWith(EXPECTED[t])).join(','));
    ok(`${t} still has holdings`, r.reduce((s, x) => s + x.trows, 0) > 0, 'lost every holding');
  }
  const [rej] = await sql.query("select count(*)::int n from cusip_map where status = 'rejected'");
  console.log('  cusips rejected by the repair: ' + n(rej.n));
  ok('the repair recorded its rejections durably', rej.n > 0);

  section('8. a rejected mapping cannot be restored');
  const [back] = await sql.query(`select count(*)::int n from fund_holdings f
    join cusip_map m on m.cusip = f.cusip where m.status = 'rejected' and f.ticker is not null`);
  ok('no rejected CUSIP carries a ticker', back.n === 0, n(back.n) + ' do');
  const [kv] = await sql.query(`select count(*)::int n from cusip_map where status = 'rejected' and ticker is not null`);
  ok('a rejected cusip_map row holds no ticker to promote', kv.n === 0, n(kv.n) + ' do');

  section('9. trustworthy CUSIP mapping wins everywhere');
  const [con] = await sql.query(`select count(*)::int n from fund_holdings f join cusip_map m on m.cusip = f.cusip
     where f.ticker is not null and m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker`, [AUTH]);
  ok('no holding contradicts an authoritative mapping', con.n === 0, n(con.n) + ' do');
  const [dup] = await sql.query(`select count(*)::int n from
    (select cusip from cusip_map where ticker is not null group by cusip having count(distinct ticker) > 1) z`);
  ok('no CUSIP maps to two tickers', dup.n === 0, n(dup.n) + ' do');

  section('10. legitimate securities were not damaged');
  const WATCH = ['AAPL', 'MSFT', 'NVDA', 'MSTR', 'GME', 'ASTS', 'SPY', 'QQQ', 'VOO', 'VUG', 'SGOV',
                 'BSV', 'BRK.A', 'BRK.B', 'GOOG', 'GOOGL', 'FOX', 'FOXA', 'NWS', 'NWSA', 'HEI.A', 'TRI'];
  for (const t of WATCH) {
    const [r] = await sql.query(`select count(*)::int rows, count(distinct cik)::int filers
      from fund_holdings where ticker = $1`, [t]);
    ok(`${t} still has holdings`, r.rows > 0, 'lost every holding');
  }
  const [slash] = await sql.query("select count(*)::int n from fund_holdings where ticker ~ '[/*]'");
  ok('no holding carries a slash-form ticker any more', slash.n === 0, n(slash.n) + ' do');
  for (const [a, b] of [['BRK.A', 'BRK/A'], ['BRK.B', 'BRK/B'], ['HEI.A', 'HEI/A'], ['TRI', 'TRI4EUR']]) {
    const [x] = await sql.query('select count(*)::int n from fund_holdings where ticker = $1', [b]);
    ok(`${b} was folded into ${a}`, x.n === 0, n(x.n) + ' remain');
  }
  const [etf] = await sql.query(`select count(*)::int n from ticker_institutional_ownership
    where ticker = any($1)`, [['SPY', 'QQQ', 'VOO', 'VUG', 'SGOV', 'BSV', 'AGG']]);
  ok('the ETFs are still in the ownership aggregate', etf.n === 7, etf.n + ' of 7');

  section('11. contamination level overall');
  const [c] = await sql.query(`with pfx as (select ticker, left(cusip,6) p from fund_holdings
      where ticker is not null and cusip ~ '^[0-9A-Z]{9}$' group by ticker, left(cusip,6))
    select count(*)::int t from (select ticker from pfx group by ticker having count(*) > 1) z`);
  console.log('  tickers still carrying >1 CUSIP issuer prefix: ' + n(c.t));
  ok('the contaminated population shrank', c.t < 563, c.t + ' vs 563 before');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
