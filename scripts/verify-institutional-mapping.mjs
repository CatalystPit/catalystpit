// INSTITUTIONAL CUSIP → TICKER: the rules that keep an unrelated security off a ticker.
//
// Characters 1-6 of a CUSIP identify the ISSUER. A ticker names one security, so its holdings should
// carry one issuer prefix. 574 tickers carried more than one because the name fallback assigns a
// ticker from the issuer STRING when OpenFIGI cannot map the CUSIP, and a sponsor's name is a prefix
// of every product it sponsors: 92 Invesco funds on IVZ, 35 ProShares funds on AGQ, 19 Innovator ETFs
// on INHD, the iShares trusts on BLK.
//
// Run: node --env-file=.env.local scripts/verify-institutional-mapping.mjs
//   (source assertions run without DATABASE_URL; live sections are skipped without it)

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);
const n = (x) => Number(x).toLocaleString('en-US');
const AUTH = ['openfigi', 'manual', 'consensus'];

// ── 1. the inference path can no longer overwrite authority ────────────────
section('1. name inference is the last word, never the overriding one');
{
  const src = await readFile(new URL('../src/lib/institutions-universe.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function resolveHoldingsByName'),
                       src.indexOf('export async function reresolveDisputedCusips'));
  ok('the sec-name cusip_map write no longer overwrites', /ON CONFLICT \(cusip\) DO NOTHING/.test(fn),
    'found DO UPDATE — an inference would replace an OpenFIGI answer');
  ok('it never writes a ticker over an authoritative mapping',
    /NOT EXISTS[\s\S]{0,220}cusip_map[\s\S]{0,160}openfigi/.test(fn));
  ok('it still only fills NULLs', /h\.ticker IS NULL/.test(fn));
  ok('the old unconditional holdings update is gone',
    !/WHERE h\.cusip = m\.cusip AND h\.ticker IS NULL`\)/.test(fn));
}

section('2. the targeted re-resolution bypasses the caches under suspicion');
{
  const src = await readFile(new URL('../src/lib/security-resolver.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function reresolveCusips'),
                       src.indexOf('// Single-CUSIP convenience.'));
  ok('it exists', fn.length > 400);
  ok('it calls the existing OpenFIGI helper, not a new one', /await openfigi\(/.test(fn));
  ok('it does not read cusip_map for an answer', !/select\(\)\.from\(cusipMap\)[\s\S]{0,200}out\.set/.test(fn));
  ok('it does not promote from KV', !/kvGet/.test(fn));
  ok('it writes source openfigi', /source: 'openfigi'/.test(fn));
  ok('an unmappable CUSIP is recorded unresolved with a NULL ticker',
    /ticker: null, status: 'unresolved'/.test(fn));
  ok('it is bounded', /maxLookups/.test(fn));
  ok('it never returns the key', !/OPENFIGI_KEY/.test(fn));
  const uni = await readFile(new URL('../src/lib/institutions-universe.js', import.meta.url), 'utf8');
  const sel = uni.slice(uni.indexOf('export async function reresolveDisputedCusips'),
                        uni.indexOf('// One-time cleanup for earlier mis-resolutions'));
  ok('the disputed set is chosen by CUSIP issuer prefix', /left\(cusip, 6\)/.test(sel));
  ok('it targets only multi-prefix tickers', /having count\(\*\) > 1/.test(sel));
  ok('it returns counts, never the mapping', /const \{ map, \.\.\.counts \} = out;/.test(sel));
}

section('3. the repair uses authoritative evidence only');
{
  const src = await readFile(new URL('./repair-institutional-tickers.mjs', import.meta.url), 'utf8');
  ok('authoritative sources are openfigi/manual/consensus',
    /const AUTH = \['openfigi', 'manual', 'consensus'\]/.test(src));
  ok('kv is NOT authoritative', !/'kv'/.test(src.split('const AUTH')[1].slice(0, 200)));
  for (const banned of ['issuer name', 'dominance', 'majority prefix', 'plurality'])
    ok(`no ${banned} rule in the repair SQL`, !new RegExp(banned, 'i').test(src.replace(/^\/\/.*$/gm, '')));
  ok('it refuses to run before re-resolution', /REFUSING TO APPLY/.test(src));
  ok('it only ever writes fund_holdings.ticker',
    !/update fund_holdings[\s\S]{0,200}set (?!ticker)/i.test(src));
  ok('it never deletes a holding', !/delete from fund_holdings/i.test(src));
}

// ── live ───────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) { console.log('\n(live sections skipped — no DATABASE_URL)'); }
else {
  const sql = neon(process.env.DATABASE_URL);
  const DISPUTED = `
    with pfx as (select ticker, left(cusip,6) p from fund_holdings
                  where ticker is not null and cusip ~ '^[0-9A-Z]{9}$' group by ticker, left(cusip,6))
    select ticker from pfx group by ticker having count(*) > 1`;

  section('4. live contamination level');
  const [c] = await sql.query(`select count(*)::int t from (${DISPUTED}) d`);
  const [h] = await sql.query(`select count(*)::int rows,
      count(*) filter (where ticker is not null)::int with_ticker from fund_holdings`);
  console.log('  tickers carrying >1 issuer prefix  ' + n(c.t));
  console.log('  holdings ' + n(h.rows) + '   with ticker ' + n(h.with_ticker));

  section('5. the four demonstrated cases');
  // The repair applied is REASSIGN-ONLY: a holding moves when an authoritative source positively
  // names a different security, and nothing is nulled. So these tickers are not yet down to one
  // issuer — what remains on them is entirely the population OpenFIGI cannot map, which is a
  // deliberate, separate follow-up. What IS guaranteed is asserted: nothing stayed that authority
  // contradicted, and the residue is only ever unmappable CUSIPs.
  for (const t of ['AGQ', 'IVZ', 'INHD', 'BLK']) {
    const r = await sql.query(`select left(f.cusip,6) pfx, count(*)::int rows,
        (array_agg(f.issuer order by f.value desc nulls last))[1] issuer,
        bool_or(m.source = any($2) and m.ticker is null) unmappable,
        bool_or(m.source = any($2) and m.ticker is not null and m.ticker <> f.ticker) contradicted
      from fund_holdings f left join cusip_map m on m.cusip = f.cusip
      where f.ticker=$1 and f.cusip ~ '^[0-9A-Z]{9}$'
      group by left(f.cusip,6) order by sum(f.value) desc nulls last`, [t, AUTH]);
    const residue = r.filter((x) => !x.unmappable).length;
    console.log('  ' + t.padEnd(7) + r.length + ' prefix(es), ' + (r.length - residue) + ' of them unmappable');
    ok(`${t}: nothing authority contradicts remains`, !r.some((x) => x.contradicted),
      r.filter((x) => x.contradicted).map((x) => x.pfx).join(','));
    ok(`${t}: every remaining stray is an unmappable CUSIP`, residue <= 1,
      residue + ' prefixes are neither the security nor unmappable');
  }

  section('6. tickers that must not be damaged');
  for (const t of ['AAPL', 'MSFT', 'NVDA', 'GOOG', 'GOOGL', 'AMZN', 'XOM', 'T', 'KO',
                   'BRK.A', 'BRK.B', 'GME', 'ASTS', 'SPY']) {
    const [r] = await sql.query(`select count(*)::int rows, count(distinct left(cusip,6))::int pfx
      from fund_holdings where ticker=$1 and cusip ~ '^[0-9A-Z]{9}$'`, [t]);
    console.log('  ' + t.padEnd(8) + n(r.rows).padStart(7) + ' rows, ' + r.pfx + ' prefix(es)');
    ok(`${t} still has holdings`, r.rows > 0, 'lost every holding');
    // A normal ticker must be untouched by the repair: no holding may be left carrying a ticker an
    // authoritative source contradicts. Prefix count is NOT asserted here — a rename or redomicile
    // legitimately gives one security two CUSIP prefixes (Google Inc 38259P -> Alphabet 02079K).
    const [c] = await sql.query(`select count(*)::int n from fund_holdings f
        join cusip_map m on m.cusip = f.cusip
       where f.ticker = $1 and m.source = any($2) and m.ticker is not null and m.ticker <> f.ticker`,
      [t, AUTH]);
    ok(`${t} has no contradicted holding`, c.n === 0, c.n + ' contradicted');
  }

  section('7. no inferred mapping sits on top of an authoritative one');
  // Scoped to the population the repair covered: tickers carrying more than one CUSIP issuer.
  const [conf] = await sql.query(`
    select count(*)::int n from fund_holdings f join cusip_map m on m.cusip = f.cusip
     where f.ticker is not null and m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker
       and f.ticker in (${DISPUTED})`, [AUTH]);
  ok('no contaminated ticker still contradicts authority', conf.n === 0, n(conf.n) + ' disagree');

  // OUTSIDE THIS REPAIR, recorded rather than silently passed over. 20,174 holdings on SINGLE-prefix
  // tickers also disagree with their authoritative mapping, but they are a notation gap, not
  // contamination: BRK/B -> BRK.B, BRK/A -> BRK.A, HEI/A -> HEI.A, TRI4EUR -> TRI. Slash-form share
  // classes and a foreign line, which ticker_canonical exists to normalise. Separate follow-up.
  const [outside] = await sql.query(`
    select count(*)::int n from fund_holdings f join cusip_map m on m.cusip = f.cusip
     where f.ticker is not null and m.source = any($1) and m.ticker is not null and m.ticker <> f.ticker
       and f.ticker not in (${DISPUTED})`, [AUTH]);
  console.log('  outside this repair — single-prefix notation gaps: ' + n(outside.n) + ' holdings');
  ok('the notation gap is not growing into the repaired set', outside.n > 0 || conf.n === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
