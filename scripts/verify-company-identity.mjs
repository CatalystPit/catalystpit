// COMPANY IDENTITY: an industry description is not a company name.
//
// screener_stocks.company fell back to the SIC industry description whenever no insider name was at
// hand, so 2,805 symbols — 49% of every populated value — read "PHARMACEUTICAL PREPARATIONS" (ZTS),
// "PETROLEUM REFINING" (XOM), "RADIO BROADCASTING STATIONS" (SIRI). Two things went wrong downstream:
// a public page would have titled a real company with its industry, and the company-name matcher
// indexed those phrases as names — 92 of them resolved to a real ticker, so a Title-Case headline
// reading "Meat Packing Plants Close Three Sites" would have been cashtagged $JBS.
//
// Run: node --env-file=.env.local scripts/verify-company-identity.mjs
//   (the pure sections run without DATABASE_URL; the live sections are skipped without it)

import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { isSicDescription, SIC_DESCRIPTIONS } from '../src/lib/sic-descriptions.mjs';
import { buildIndex, resolveCompanies, looksLikeIndustry } from '../src/lib/company-symbols.mjs';
import { buildPublicView } from '../src/lib/ticker-seo-view.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (s) => console.log('\n' + s);

// The phrases the audit found living in screener_stocks.company.
const CONTAMINANTS = [
  'PHARMACEUTICAL PREPARATIONS',
  'INSURANCE AGENTS, BROKERS & SERVICE',
  'BIOLOGICAL PRODUCTS, (NO DIAGNOSTIC SUBSTANCES)',
  'PETROLEUM REFINING',
  'SERVICES-PREPACKAGED SOFTWARE',
  'RADIO BROADCASTING STATIONS',
  // The ones that actually produced a ticker through the live matcher.
  'MEAT PACKING PLANTS', 'METAL CANS', 'HOSPITAL & MEDICAL SERVICE PLANS',
  'GLASS PRODUCTS, MADE OF PURCHASED GLASS', 'SERVICES-EMPLOYMENT AGENCIES',
  'REAL ESTATE INVESTMENT TRUSTS', 'BLANK CHECKS', 'INVESTMENT ADVICE',
  'SERVICES-COMPUTER PROGRAMMING, DATA PROCESSING, ETC.', 'NATIONAL COMMERCIAL BANKS',
];

// Real names that must keep working, across the cap range.
const REAL_NAMES = [
  ['Apple Inc.', 'AAPL'], ['MICROSOFT CORP', 'MSFT'], ['Zoetis Inc.', 'ZTS'],
  ['BERKSHIRE HATHAWAY INC', 'BRK.B'], ['BROWN & BROWN, INC.', 'BRO'],
  ['Scholar Rock Holding Corp', 'SRRK'], ['EXXON MOBIL CORP', 'XOM'],
  ['ORACLE CORP', 'ORCL'], ['SIRIUS XM HOLDINGS INC.', 'SIRI'],
  ['GameStop Corp.', 'GME'], ['AST SpaceMobile, Inc.', 'ASTS'],
  ['Vericel Corp', 'VCEL'], ['Butterfly Network, Inc.', 'BFLY'],
  ['Kymera Therapeutics, Inc.', 'KYMR'], ['Alkami Technology, Inc.', 'ALKT'],
  ['Blue Bird Corp', 'BLBD'], ['Stoke Therapeutics, Inc.', 'STOK'],
];

// ── 1. the vocabulary ───────────────────────────────────────────────────────
section('1. EDGAR SIC vocabulary is exact, not a guess');
ok('vocabulary is populated', SIC_DESCRIPTIONS.length > 300, 'n=' + SIC_DESCRIPTIONS.length);
for (const p of CONTAMINANTS) ok(`"${p.slice(0, 44)}" is an industry`, isSicDescription(p));
for (const [nm] of REAL_NAMES) ok(`"${nm}" is NOT an industry`, !isSicDescription(nm));
// Equality, not substring: a company whose name merely contains an industry word is still a company.
ok('"Pharmaceutical Preparations Inc" is not matched by substring',
  !isSicDescription('Pharmaceutical Preparations Holdings Inc'));
ok('"Metal Cans Manufacturing Co" is not matched by substring', !isSicDescription('Metal Cans Manufacturing Co'));
ok('case and punctuation cannot defeat it', isSicDescription('  petroleum   refining  '));
ok('empty is not an industry', !isSicDescription('') && !isSicDescription(null));

section('2. looksLikeIndustry now covers what the shape pattern missed');
for (const p of CONTAMINANTS) ok(`rejects "${p.slice(0, 40)}"`, looksLikeIndustry(p));
for (const [nm] of REAL_NAMES) ok(`accepts "${nm}"`, !looksLikeIndustry(nm));

// ── 3. the exact company=industry rule inside buildIndex ────────────────────
section('3. a row whose company IS its own industry never enters the index');
(() => {
  // Deliberately uses a phrase NOT in the vocabulary, so only the exact rule can catch it.
  const invented = 'SYNTHETIC WIDGET FABRICATION, NEC 2099';
  ok('control: the invented phrase is not in the vocabulary', !isSicDescription(invented));
  const dirty = buildIndex([{ ticker: 'XXXX', company: invented, industry: invented }]);
  ok('rejected by the exact rule',
    resolveCompanies(`${invented} reports record results`, dirty, 3).length === 0);
  const noEvidence = buildIndex([{ ticker: 'XXXX', company: invented }]);
  ok('control: without the industry column the same row WOULD index',
    resolveCompanies(`${invented} reports record results`, noEvidence, 3).length === 1,
    'if this fails the control is broken, not the rule');
  const real = buildIndex([{ ticker: 'AAPL', company: 'Apple Inc.', industry: 'ELECTRONIC COMPUTERS' }]);
  ok('a real name beside a different industry still indexes',
    resolveCompanies('Apple unveils new silicon', real, 3)[0] === 'AAPL');
})();

// ── 4. resolver regression: the contaminated corpus ─────────────────────────
section('4. SIC phrases do not resolve to tickers');
{
  // Build the index the way primary-events.js does, but seeded with the contamination as it existed.
  const rows = [
    ...CONTAMINANTS.map((c, i) => ({ ticker: `Z${String(i).padStart(3, '0')}`, company: c })),
    { ticker: 'SLGN', company: 'METAL CANS' },
    { ticker: 'JBS', company: 'MEAT PACKING PLANTS' },
    { ticker: 'HUM', company: 'HOSPITAL & MEDICAL SERVICE PLANS' },
    { ticker: 'APOG', company: 'GLASS PRODUCTS, MADE OF PURCHASED GLASS' },
    ...REAL_NAMES.map(([company, ticker]) => ({ ticker, company })),
  ];
  const idx = buildIndex(rows);
  for (const p of CONTAMINANTS) {
    const got = resolveCompanies(`${p} reports record quarterly results`, idx, 3);
    ok(`"${p.slice(0, 40)}" -> no ticker`, got.length === 0, 'got ' + JSON.stringify(got));
  }
  // Title Case is the realistic shape: a PR wire capitalises every word, which is exactly how a
  // headline could have matched an all-caps SIC phrase.
  const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  for (const p of ['MEAT PACKING PLANTS', 'METAL CANS', 'HOSPITAL & MEDICAL SERVICE PLANS']) {
    const got = resolveCompanies(`${title(p)} Close Three Sites`, idx, 3);
    ok(`Title Case "${title(p)}" -> no ticker`, got.length === 0, 'got ' + JSON.stringify(got));
  }
  section('5. real company names still resolve');
  for (const [nm, tk] of REAL_NAMES) {
    const got = resolveCompanies(`${nm} reports record quarterly results`, idx, 3);
    ok(`"${nm}" -> ${tk}`, got.includes(tk), 'got ' + JSON.stringify(got));
  }
  // Headline form without the legal suffix, which is the whole reason the resolver exists.
  for (const [h, tk] of [['Apple unveils M5 silicon', 'AAPL'], ['Zoetis raises full-year guidance', 'ZTS'],
                         ['Berkshire Hathaway trims its stake', 'BRK.B'], ['GameStop names a new CFO', 'GME'],
                         ['Butterfly Network wins FDA clearance', 'BFLY']]) {
    ok(`"${h}" -> ${tk}`, resolveCompanies(h, idx, 3).includes(tk),
      'got ' + JSON.stringify(resolveCompanies(h, idx, 3)));
  }
}

// ── 6. the public view model ────────────────────────────────────────────────
section('6. ticker SEO public model never emits a contaminated name');
for (const p of CONTAMINANTS.slice(0, 6)) {
  // Even with the shared-name defence disarmed (name_shared_by = 1, i.e. "this name is unique"),
  // an industry description must not surface as a company name.
  const v = buildPublicView('T', { identity: { ticker: 'T', company: p, industry: p, exchange: 'NASDAQ', name_shared_by: 1 } });
  ok(`"${p.slice(0, 38)}" is not published as a company name`, v.identity.companyName === null,
    JSON.stringify(v.identity.companyName));
  ok('the rest of the identity survives', v.identity.exchange === 'NASDAQ');
}
{
  const v = buildPublicView('AAPL', { identity: { ticker: 'AAPL', company: 'Apple Inc.', industry: 'ELECTRONIC COMPUTERS', name_shared_by: 1 } });
  ok('a real name is still published', v.identity.companyName === 'Apple Inc.');
  const shared = buildPublicView('U', { identity: { ticker: 'U', company: 'Acme Inc.', name_shared_by: 229 } });
  ok('the name_shared_by defence still fires', shared.identity.companyName === null);
}

// ── 7. identity and signals stay separate, asserted on the source ───────────
section('7. identity is not computed from a signal window');
{
  const src = await readFile(new URL('../src/lib/screener-data.js', import.meta.url), 'utf8');
  ok('the SIC fallback is gone', !/company:\s*i\?\.company\s*\|\|\s*m\?\.industry/.test(src));
  ok('company is never assigned from industry',
    !/company:\s*[^,\n]*\bm\?\.industry/.test(src));
  ok('a dedicated identity lookup exists', /async function companyIdentity\s*\(/.test(src));
  ok('the row builder uses it', /company:\s*nameByT\.get\(t\)\s*\?\?\s*null/.test(src));
  ok('the 90-day signal aggregate no longer supplies a name',
    !/company:\s*sql`max\(\$\{insiderTrades\.company\}\)`/.test(src));
  // The signal window itself must be untouched.
  ok('the 90-day insider window is still in place',
    /gte\(insiderTrades\.transactionDate,\s*since90\)/.test(src));
  ok('the value>0 signal filter is still in place',
    /insiderTrades\.totalValue\}\s*>\s*0/.test(src));
  // Scoped to the function BODY, so nothing in rebuildScreener below it can satisfy this assertion
  // or break it by accident.
  const body = src.slice(src.indexOf('async function companyIdentity'),
                         src.indexOf('export async function rebuildScreener'));
  ok('identity lookup exists and is non-trivial', body.length > 400, 'len=' + body.length);
  ok('identity reads insider_trades with no window and no signal filter',
    /from insider_trades/.test(body) && !/since90|interval|current_date\s*-|total_value/.test(body),
    body.match(/since90|interval|current_date\s*-|total_value/)?.[0] || '');
  ok('identity takes the most recent filing', /order by ticker, filing_date desc/.test(body));
  ok('8-K is the second tier', /from eightk_filings/.test(src) && /a Form 4 name outranks a registrant name/.test(src));
  ok('no 13F, FINRA or vendor name in the identity path',
    !/companyIdentity[\s\S]{0,1200}(fund_holdings|short_interest|d\.name)/.test(src));
  ok('the stale-name coalesce is gone',
    !/coalesce\(excluded\.company,\s*screener_stocks\.company\)/.test(src));
  ok('industry is still written to industry', /industry:\s*m\?\.industry\s*\?\?\s*null/.test(src));
}

// ── 8. live data ────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('\n(live sections skipped — no DATABASE_URL)');
} else {
  const sql = neon(process.env.DATABASE_URL);
  section('8. live screener data');
  const [a] = await sql.query(`select count(*)::int rows,
      count(*) filter (where company is not null and company <> '')::int named,
      count(*) filter (where company is null or company = '')::int nulls,
      count(*) filter (where company is not null and company = industry)::int co_eq_ind
      from screener_stocks`);
  console.log('  rows ' + a.rows + '   named ' + a.named + '   null ' + a.nulls + '   company=industry ' + a.co_eq_ind);
  ok('no row has company = industry', a.co_eq_ind === 0, 'found ' + a.co_eq_ind);

  const bad = await sql.query(`select ticker, company from screener_stocks
     where company is not null and company <> '' order by ticker`);
  const sic = bad.filter((r) => isSicDescription(r.company));
  ok('no stored company name is an EDGAR industry description', sic.length === 0,
    sic.slice(0, 6).map((r) => r.ticker + '="' + r.company + '"').join(' '));

  section('9. every stored name is an SEC name');
  const [prov] = await sql.query(`
    with f4 as (select distinct ticker, company from insider_trades where ticker is not null and company is not null and company <> ''),
         ek as (select distinct ticker, company from eightk_filings where ticker is not null and company is not null and company <> '')
    select count(*)::int named,
           count(*) filter (where exists (select 1 from f4 where f4.ticker=s.ticker and f4.company=s.company))::int from_f4,
           count(*) filter (where not exists (select 1 from f4 where f4.ticker=s.ticker and f4.company=s.company)
                              and exists (select 1 from ek where ek.ticker=s.ticker and ek.company=s.company))::int from_8k,
           count(*) filter (where not exists (select 1 from f4 where f4.ticker=s.ticker and f4.company=s.company)
                              and not exists (select 1 from ek where ek.ticker=s.ticker and ek.company=s.company))::int unaccounted
      from screener_stocks s where s.company is not null and s.company <> ''`);
  console.log('  Form 4 ' + prov.from_f4 + '   8-K ' + prov.from_8k + '   unaccounted ' + prov.unaccounted);
  ok('every stored name traces to a Form 4 or an 8-K', prov.unaccounted === 0, 'unaccounted ' + prov.unaccounted);

  section('10. representative symbols');
  const syms = ['AAPL','MSFT','ZTS','BRO','SRRK','XOM','ORCL','SIRI','BRK.A','BRK.B','GOOG','GME','ASTS'];
  const rows = await sql.query('select ticker, company, industry from screener_stocks where ticker = any($1) order by ticker', [syms]);
  const byT = new Map(rows.map((r) => [r.ticker, r]));
  for (const t of syms) {
    const r = byT.get(t);
    const nm = r ? r.company : undefined;
    console.log('  ' + t.padEnd(7) + (r ? String(nm ?? 'NULL').slice(0, 44) : '(not in screener)'));
    if (!r) continue;
    ok(`${t}: name is not its industry`, !(nm && nm === r.industry));
    ok(`${t}: name is not an EDGAR industry description`, !isSicDescription(nm));
  }
  for (const [t, want] of [['AAPL','Apple'],['MSFT','MICROSOFT'],['ZTS','Zoetis'],['BRO','BROWN'],
                           ['SRRK','Scholar Rock'],['XOM','EXXON'],['ORCL','ORACLE'],['SIRI','SIRIUS'],
                           ['GME','GameStop'],['ASTS','AST SpaceMobile']]) {
    const nm = byT.get(t)?.company;
    ok(`${t} names the company`, !!nm && nm.toUpperCase().includes(want.toUpperCase()), String(nm));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
