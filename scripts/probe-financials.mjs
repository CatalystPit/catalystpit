// PROBE ONLY — Financials tab feasibility from SEC EDGAR XBRL companyfacts.
// Run: node scripts/probe-financials.mjs
// Same endpoint as the Earnings tab: data.sec.gov/api/xbrl/companyfacts/CIK{10}.json (UA header).
// For AAPL + STT, report which us-gaap line-item tags exist, most-recent annual (FY) value, and
// whether quarterly data is present. For MISSING expected tags, list the filer's actual same-concept
// tags — exposing cross-company variation (esp. STT, a bank, vs AAPL).

const SEC_UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const TICKERS = ['AAPL', 'STT'];

// [tag, unit, concept-hint regex for finding alternatives when missing]
const SECTIONS = {
  'INCOME STATEMENT': [
    ['Revenues', 'USD', /revenue/i],
    ['RevenueFromContractWithCustomerExcludingAssessedTax', 'USD', /revenue/i],
    ['CostOfRevenue', 'USD', /cost(ofrevenue|ofgoods)/i],
    ['CostOfGoodsAndServicesSold', 'USD', /cost(ofrevenue|ofgoods)/i],
    ['GrossProfit', 'USD', /grossprofit/i],
    ['OperatingIncomeLoss', 'USD', /operatingincome/i],
    ['NetIncomeLoss', 'USD', /netincomeloss/i],
    ['EarningsPerShareDiluted', 'USD/shares', /earningspershare/i],
  ],
  'BALANCE SHEET': [
    ['Assets', 'USD', /^assets/i],
    ['AssetsCurrent', 'USD', /^assetscurrent/i],
    ['Liabilities', 'USD', /^liabilities/i],
    ['LiabilitiesCurrent', 'USD', /^liabilitiescurrent/i],
    ['StockholdersEquity', 'USD', /(stockholdersequity|stockholdersequityincludingportion)/i],
    ['CashAndCashEquivalentsAtCarryingValue', 'USD', /cashandcash/i],
    ['LongTermDebtNoncurrent', 'USD', /longtermdebt|debt.*noncurrent/i],
  ],
  'CASH FLOW': [
    ['NetCashProvidedByUsedInOperatingActivities', 'USD', /operatingactivities/i],
    ['NetCashProvidedByUsedInInvestingActivities', 'USD', /investingactivities/i],
    ['NetCashProvidedByUsedInFinancingActivities', 'USD', /financingactivities/i],
  ],
};

const fmtUSD = (v) => {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${Number(v).toFixed(2)}`;
};

async function getJson(url) {
  const r = await fetch(url, { headers: SEC_UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function cikFor(ticker) {
  const data = await getJson('https://www.sec.gov/files/company_tickers.json');
  for (const e of Object.values(data)) if (String(e.ticker).toUpperCase() === ticker) return String(e.cik_str).padStart(10, '0');
  return null;
}

// most-recent annual (fp=FY) and most-recent quarterly (fp=Q1/Q2/Q3) for a tag's unit series
function summarize(gaap, tag, unit) {
  const node = gaap[tag];
  if (!node) return { exists: false };
  const series = node.units?.[unit] || node.units?.[Object.keys(node.units || {})[0]] || [];
  if (!series.length) return { exists: true, unitMissing: true, units: Object.keys(node.units || {}) };
  const pick = (filterFn) => {
    const rows = series.filter(filterFn).filter((r) => r.end);
    rows.sort((a, b) => a.end.localeCompare(b.end));
    return rows[rows.length - 1] || null;
  };
  const annual = pick((r) => r.fp === 'FY' || r.form === '10-K' && r.fp === 'FY');
  const quarterly = pick((r) => /^Q[1-4]$/.test(r.fp || ''));
  return {
    exists: true,
    units: Object.keys(node.units || {}),
    count: series.length,
    annual: annual ? { val: annual.val, end: annual.end, fy: annual.fy, form: annual.form } : null,
    quarterly: quarterly ? { val: quarterly.val, end: quarterly.end, fp: quarterly.fp } : null,
  };
}

async function probe(ticker) {
  console.log('\n' + '='.repeat(80) + `\n${ticker}`);
  const cik = await cikFor(ticker);
  if (!cik) { console.log('  CIK not found'); return; }
  let facts;
  try { facts = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`); }
  catch (e) { console.log(`  companyfacts fetch failed: ${e.message}`); return; }
  const gaap = facts.facts?.['us-gaap'] || {};
  const allTags = Object.keys(gaap);
  console.log(`  CIK ${cik} | entityName "${facts.entityName}" | total us-gaap tags: ${allTags.length}`);

  for (const [section, tags] of Object.entries(SECTIONS)) {
    console.log(`\n  ── ${section} ──`);
    for (const [tag, unit, hint] of tags) {
      const s = summarize(gaap, tag, unit);
      if (!s.exists) {
        const alts = allTags.filter((t) => hint.test(t)).slice(0, 6);
        console.log(`    ✗ ${tag}  — MISSING`);
        if (alts.length) console.log(`        filer has instead: ${alts.join(', ')}`);
        continue;
      }
      if (s.unitMissing) { console.log(`    ⚠ ${tag}  — exists but no '${unit}' unit (has: ${s.units.join(',')})`); continue; }
      const a = s.annual ? `${fmtUSD(s.annual.val)} (FY${s.annual.fy}, ${s.annual.end}, ${s.annual.form})` : 'no FY value';
      const q = s.quarterly ? `Q present (${s.quarterly.fp} ${s.quarterly.end} = ${fmtUSD(s.quarterly.val)})` : 'NO quarterly';
      const unitNote = s.units.includes(unit) ? '' : `  [unit=${s.units.join(',')}]`;
      console.log(`    ✓ ${tag}${unitNote}\n        annual: ${a} | ${q}`);
    }
  }
}

async function main() { for (const t of TICKERS) await probe(t); }
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
