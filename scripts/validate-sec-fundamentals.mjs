// THE VALIDATION SET — SELECTED FACTS vs THE FILINGS THEY CAME FROM.
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/validate-sec-fundamentals.mjs
//
// ⚠️ NOTHING IS WRITTEN TO screener_fundamentals BY THIS SCRIPT. It fetches the frames, runs the real
// selectors, derives the real metrics, and prints every value with the accession it came from so the
// numbers can be checked against the filings on sec.gov. The production write happens only after this
// reads correctly — the brief's ordering, and the right one: a mass write followed by an inspection is an
// inspection of damage.
//
// ⚠️ AND THE AUTHORITY IS THE FILING, NOT ANOTHER VENDOR. Every figure below carries its accession; the
// check is "does this match what the company filed", which is a question sec.gov answers directly. It is
// explicitly NOT a comparison against Polygon, Finnhub or FMP — those are the providers this whole body
// of work removed, and using them as a yardstick would be using unlicensed data to validate licensed data.
//
// The cohort is chosen to break different things:
//
//   AAPL   September FYE, and the stale-`Revenues` trap lives in its companyfacts
//   MSFT   June FYE, calendar-misaligned quarters
//   NVDA   January FYE, and its live revenue tag is the LEGACY one
//   MU     August/September FYE, 52/53-week calendar
//   JPM    a bank: revenue is interest + non-interest income and often tagged neither standard way
//   BRK-B  multiple share classes under one CIK, enormous share counts
//   O      a REIT: earnings are small relative to cash flow, FFO is not net income
//   TSM    an ADR — the $11.8 trillion market cap case, which must be REFUSED
//   SHEL   a 20-F filer with a US listing, second ADR case
//   NVO    a third ADR, different domicile
//   RIVN   persistent negative earnings: EPS TTM negative, P/E must be absent
//   SMCI   a recent stock split
import { fetchAllFrames, selectFacts, deriveFundamentals } from '../src/lib/sec/fundamentals-ingest.mjs';
import { secTickerIndex } from '../src/lib/market/sec-classification.mjs';
import { resolveFilerType, loadFilerTypes } from '../src/lib/sec/sec-filer-type.mjs';
import { buildFilingUrl } from '../src/lib/sec-earnings.mjs';
import { PE_EPS_BASIS_LABEL } from '../src/lib/sec/xbrl-concepts.mjs';
import { db } from '../src/lib/db';
import { sql } from 'drizzle-orm';

const COHORT = ['AAPL', 'MSFT', 'NVDA', 'MU', 'JPM', 'BRK-B', 'O', 'TSM', 'SHEL', 'NVO', 'RIVN', 'SMCI'];
const money = (v) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Number(v).toFixed(2)}`);
const num = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

console.log('fetching SEC frames (one request per concept per period, whole market)…');
const frames = await fetchAllFrames({ onProgress: null });
console.log(`frames fetched: quarterly ${frames.quarterly.length}, instant ${frames.instant.length}, annual ${frames.annual.length}`);
if (frames.throttled) console.log('⚠️ SEC THROTTLED mid-fetch — results below are partial by design, not wrong');
if (frames.misses.length) console.log(`frames with no data (normal for narrow tags): ${frames.misses.length}`);

// ticker → CIK from SEC's own index, and the reverse for the selector.
const index = await secTickerIndex();
if (!index) { console.error('SEC ticker index unavailable — cannot validate'); process.exit(1); }
const cikToTickers = new Map();
for (const t of COHORT) {
  // SEC's index spells share classes with a dash (BRK-B); our canonical symbol may use a dot.
  const cik = index.get(t) || index.get(t.replace(/-/g, '.')) || index.get(t.replace(/\./g, '-'));
  if (!cik) { console.log(`  (no CIK for ${t} — identity resolution does not cover it)`); continue; }
  if (!cikToTickers.has(Number(cik))) cikToTickers.set(Number(cik), []);
  cikToTickers.get(Number(cik)).push(t);
}

const selected = selectFacts({ frames, cikToTickers });
console.log(`facts selected for the cohort: ${selected.length}`);

// Filer types, fetched once each (paced inside the helper).
const known = await loadFilerTypes();
for (const [cik] of cikToTickers) {
  if (known.has(cik)) continue;
  const r = await resolveFilerType(cik);
  if (r.ok) known.set(cik, { filerType: r.filerType, forms: r.forms });
  else if (r.throttled) { console.log('⚠️ SEC throttled while resolving filer types — stopping'); break; }
}

// Licensed prices, from our own store. No vendor call.
const { getQuotes } = await import('../src/lib/market-data.js');
const quotes = await getQuotes(COHORT.map((t) => t.replace(/-/g, '.')), { realtime: false });

console.log('\n' + '='.repeat(118));
for (const t of COHORT) {
  const mine = selected.filter((f) => f.ticker === t);
  const cik = [...cikToTickers.entries()].find(([, ts]) => ts.includes(t))?.[0] ?? null;
  const filer = cik ? known.get(cik) : null;
  const q = quotes[t] || quotes[t.replace(/-/g, '.')] || null;

  console.log(`\n### ${t}   CIK ${cik ?? '—'}   filer ${filer?.filerType ?? 'unresolved'} [${filer?.forms ?? ''}]   facts ${mine.length}`);
  if (!mine.length) { console.log('   no facts selected — this issuer reports none of the registry concepts in these frames'); continue; }

  // Facts as stored, so deriveFundamentals sees the same shape it will in production.
  const asStored = mine.map((f) => ({
    concept: f.concept, kind: f.kind, tag: f.tag, taxonomy: f.taxonomy, unit: f.unit,
    period_start: f.periodStart, period_end: f.periodEnd, val: f.val, accn: f.accn, fiscal_label: f.fiscalLabel,
  }));
  const d = deriveFundamentals(asStored, {
    price: q?.price ?? null, priceDate: q?.asOf ? String(q.asOf).slice(0, 10) : null,
    filerType: filer?.filerType ?? null,
  });

  const latest = mine.slice().sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)))[0];
  console.log(`   LATEST FILING      ${latest.accn ?? '—'}   ${buildFilingUrl(cik, latest.accn) || ''}`);
  console.log(`   FISCAL PERIOD      ${latest.fiscalLabel ?? '(instant)'}  period_end ${latest.periodEnd}  FYE month ${latest.fyeMonth}`);
  console.log(`   REVENUE (TTM)      ${money(d.revenueTtm)}${d.reasons.revenueTtm ? '   [' + d.reasons.revenueTtm + ']' : ''}`);
  console.log(`   NET INCOME (TTM)   ${money(d.netIncomeTtm)}${d.reasons.netIncomeTtm ? '   [' + d.reasons.netIncomeTtm + ']' : ''}`);
  console.log(`   EPS diluted TTM    ${num(d.epsDilutedTtm)}${d.reasons.epsDilutedTtm ? '   [' + d.reasons.epsDilutedTtm + ']' : ''}`);
  console.log(`   EPS basic TTM      ${num(d.epsBasicTtm)}${d.reasons.epsBasicTtm ? '   [' + d.reasons.epsBasicTtm + ']' : ''}`);
  console.log(`   SHARES OUTSTANDING ${d.sharesOutstanding == null ? '—' : Number(d.sharesOutstanding).toLocaleString()}  as of ${d.sharesAsOf ?? '—'}`);
  console.log(`   MARKET CAP INPUTS  price ${num(q?.price)} (${q?.asOf ? String(q.asOf).slice(0, 10) : 'no licensed price'})  × shares above`);
  console.log(`   MARKET CAP         ${money(d.marketCap)}${d.reasons.marketCap ? '   [REFUSED: ' + d.reasons.marketCap + ']' : ''}`);
  console.log(`   P/E                ${num(d.pe)}${d.reasons.pe ? '   [REFUSED: ' + d.reasons.pe + ']' : ''}  ${d.peBasis ? '(' + PE_EPS_BASIS_LABEL + ')' : ''}`);
  console.log(`   EQUITY / ASSETS    ${money(d.equity)} / ${money(d.assets)}`);
  console.log(`   OCF / CAPEX / FCF  ${money(d.operatingCashFlow)} / ${money(d.capex)} / ${money(d.freeCashFlow)}${d.reasons.freeCashFlow ? '   [' + d.reasons.freeCashFlow + ']' : ''}`);
  console.log(`   CASH (tag)         ${money(d.cash)}  ${d.cashTag ?? ''}`);

  // Every accession behind the published TTM figures, so each can be opened and read.
  const accns = [...new Set(mine.filter((f) => ['revenue', 'netIncome', 'epsDiluted'].includes(f.concept)).map((f) => f.accn).filter(Boolean))];
  console.log(`   SOURCE ACCESSIONS  ${accns.slice(0, 6).join(', ')}`);
  const revQ = mine.filter((f) => f.concept === 'revenue').sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
  if (revQ.length) {
    console.log(`   revenue quarters   ${revQ.map((f) => `${f.periodStart}→${f.periodEnd} ${money(f.val)} [${f.tag.slice(0, 22)}]`).join('\n                      ')}`);
  }
}
console.log('\n' + '='.repeat(118));
await db.execute(sql`select 1`);
process.exit(0);
