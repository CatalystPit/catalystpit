// SEC EDGAR XBRL companyfacts → quarterly earnings history.
// Handles the real-world shape probed from data.sec.gov:
//  - revenue concept varies by company/era (merge across concepts, latest-filed wins)
//  - each (period) has cumulative + single-quarter rows → keep only ~90-day spans
//  - 10-K reports full year, no standalone Q4 → derive Q4 = FY - (Q1+Q2+Q3)

const REV_CONCEPTS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',  // ASC 606, current for most
  'Revenues',                                             // older / financials (e.g. STT)
  'RevenueFromContractWithCustomerIncludingAssessedTax',
];
const EPS_CONCEPTS = ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'];

const days = (s, e) => (Date.parse(e) - Date.parse(s)) / 86_400_000;
const isQuarter = (d) => d >= 80 && d <= 100;     // single 3-month fiscal quarter
const isAnnual  = (d) => d >= 350 && d <= 380;     // full fiscal year (10-K)
const round1 = (n) => Math.round(n * 10) / 10;

// From a flat array of fact entries: single-quarter rows keyed by period-end (latest filed
// wins), plus full-year rows keyed by fiscal year (for Q4 derivation).
function collect(arr) {
  const byEnd = new Map(), annual = new Map();
  for (const e of arr || []) {
    if ((e.form !== '10-Q' && e.form !== '10-K') || !e.start || !e.end || e.val == null) continue;
    const d = days(e.start, e.end);
    // EARLIEST-filed wins: a period's original filing carries the correct fy/fp; later filings
    // re-report it as a prior-year COMPARATIVE stamped with the new filing's fy/fp (wrong label).
    if (isQuarter(d)) {
      const p = byEnd.get(e.end);
      if (!p || e.filed < p.filed) byEnd.set(e.end, e);
    } else if (isAnnual(d) && e.fp === 'FY') {
      // A 10-K reports the current FY + two prior years as comparatives, ALL stamped with the
      // filing's fy. The real fiscal year is the one with the latest period-end for that fy.
      const p = annual.get(e.fy);
      if (!p || e.end > p.end) annual.set(e.fy, e);
    }
  }
  return { byEnd, annual };
}

// Add derived Q4 rows: FY total minus the fiscal year's three reported quarters.
function withDerivedQ4(arr) {
  const { byEnd, annual } = collect(arr);
  const out = new Map(byEnd);   // period-end → entry
  for (const [fy, ann] of annual) {
    if (out.has(ann.end)) continue;                       // standalone Q4 already present
    const qs = [...byEnd.values()].filter((e) => e.fy === fy && ['Q1', 'Q2', 'Q3'].includes(e.fp));
    if (qs.length === 3) {
      const sum = qs.reduce((s, e) => s + e.val, 0);
      out.set(ann.end, { val: ann.val - sum, start: null, end: ann.end, filed: ann.filed, form: ann.form, accn: ann.accn, fy, fp: 'Q4', derived: true });
    }
  }
  return out;
}

// CIK (10-digit) + accession → standard EDGAR filing-index URL.
export function buildFilingUrl(cik, accn) {
  if (!accn) return null;
  const cikNum = String(cik).replace(/^0+/, '') || '0';   // path uses CIK without leading zeros
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accn.replace(/-/g, '')}/${accn}-index.htm`;
}

export function parseEarnings(facts, cik) {
  const gaap = facts?.facts?.['us-gaap'] || {};
  const revArr = REV_CONCEPTS.filter((c) => gaap[c]?.units?.USD).flatMap((c) => gaap[c].units.USD);
  const epsConcept = EPS_CONCEPTS.find((c) => gaap[c]?.units?.['USD/shares']);
  const epsArr = epsConcept ? gaap[epsConcept].units['USD/shares'] : [];

  const rev = withDerivedQ4(revArr);
  const eps = withDerivedQ4(epsArr);

  // a quarter exists if revenue OR eps has a single-quarter row for that period-end
  const ends = new Set([...rev.keys(), ...eps.keys()]);
  const rows = [];
  for (const end of ends) {
    const r = rev.get(end), e = eps.get(end);
    const ref = r || e;
    rows.push({
      end, fy: ref.fy, fp: ref.fp, report_date: ref.filed, form: ref.form, accn: ref.accn,
      revenue: r ? r.val : null,
      eps_basic: e != null ? e.val : null,
      derived: !!(r?.derived || e?.derived),
    });
  }

  // YoY: match each quarter to the same fiscal period one year earlier
  const byKey = new Map(rows.map((x) => [`${x.fy}|${x.fp}`, x]));
  const yoy = (cur, prev) => (cur != null && prev != null && prev !== 0) ? round1(((cur - prev) / Math.abs(prev)) * 100) : null;
  for (const x of rows) {
    const prior = byKey.get(`${x.fy - 1}|${x.fp}`);
    x.revenue_yoy_pct = yoy(x.revenue, prior?.revenue ?? null);
    x.eps_yoy_pct = yoy(x.eps_basic, prior?.eps_basic ?? null);
  }

  rows.sort((a, b) => b.end.localeCompare(a.end));   // newest period first
  return rows.slice(0, 12).map((x) => ({
    quarter: `${x.fp} ${x.fy}`,
    report_date: x.report_date,
    period_end: x.end,
    revenue: x.revenue,
    revenue_yoy_pct: x.revenue_yoy_pct,
    eps_basic: x.eps_basic != null ? Math.round(x.eps_basic * 100) / 100 : null,   // derived Q4 = FY-(Q1+Q2+Q3) can carry float noise
    eps_yoy_pct: x.eps_yoy_pct,
    form: x.form,
    derived: x.derived,
    filing_url: buildFilingUrl(cik, x.accn),
  }));
}
