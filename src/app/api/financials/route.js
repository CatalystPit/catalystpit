// Financials — Income Statement / Balance Sheet / Cash Flow from SEC EDGAR XBRL companyfacts
// (same source as Earnings; free, commercial-OK). Architecture (validated in scripts/probe-financials.mjs):
// universal-core + CONDITIONAL ROWS + FALLBACK CHAINS — never a fixed row template. A line item is
// shown only if its tag resolves for that filer; absent tags are omitted entirely (so a bank like STT
// cleanly drops COGS / gross profit / current-asset rows it doesn't report).

export const runtime = 'nodejs';
export const maxDuration = 20;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SEC_UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const CIK_MAP_KEY = 'sec:cik_map';        // shared with /api/earnings
const TTL = 24 * 3600;                    // 24h — filings change quarterly at most
const TTL_STALE = 7 * 24 * 3600;
const MS_DAY = 86_400_000;
const N_PERIODS = 5;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    return (await r.json()).result ?? null;
  } catch { return null; }
}
async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?ex=${ttlSec}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' }, body: value,
    });
  } catch { /* non-fatal */ }
}

async function getCikMap() {
  const hit = await kvGet(CIK_MAP_KEY);
  if (hit != null) { try { return JSON.parse(hit); } catch { /* refetch */ } }
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_UA });
    if (!r.ok) return {};
    const data = await r.json();
    const map = {};
    for (const e of Object.values(data)) map[e.ticker] = String(e.cik_str).padStart(10, '0');
    await kvSet(CIK_MAP_KEY, JSON.stringify(map), TTL_STALE);
    return map;
  } catch { return {}; }
}

// ── statement definitions: ordered fallback chains; rows resolve-or-omit ──
const INCOME = [
  { label: 'Revenue', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'] },
  { label: 'Cost of revenue', tags: ['CostOfGoodsAndServicesSold', 'CostOfRevenue'] },
  { label: 'Gross profit', tags: ['GrossProfit'] },
  { label: 'Operating income', tags: ['OperatingIncomeLoss'] },
  { label: 'Net income', tags: ['NetIncomeLoss'] },
  { label: 'Diluted EPS', tags: ['EarningsPerShareDiluted'], perShare: true },
];
const BALANCE = [
  { label: 'Total assets', tags: ['Assets'] },
  { label: 'Current assets', tags: ['AssetsCurrent'] },
  { label: 'Cash & equivalents', tags: ['CashAndCashEquivalentsAtCarryingValue'] },
  { label: 'Total liabilities', tags: ['Liabilities'] },
  { label: 'Current liabilities', tags: ['LiabilitiesCurrent'] },
  { label: 'Long-term debt', tags: ['LongTermDebtNoncurrent', 'LongTermDebt'] },
  { label: "Shareholders' equity", tags: ['StockholdersEquity'] },
];
const CASHFLOW = [
  { label: 'Operating cash flow', tags: ['NetCashProvidedByUsedInOperatingActivities'] },
  { label: 'Investing cash flow', tags: ['NetCashProvidedByUsedInInvestingActivities'] },
  { label: 'Financing cash flow', tags: ['NetCashProvidedByUsedInFinancingActivities'] },
];

const spanDays = (e) => (Date.parse(e.end) - Date.parse(e.start)) / MS_DAY;
const dedupeByEnd = (rows) => { const m = new Map(); for (const e of rows) if (e.end) m.set(e.end, e); return [...m.values()]; };

// XBRL `fy`/`fp` are FILING-relative (a 10-K tags its comparative years with the filing's fy), so
// labels are derived from the END DATE + the company's fiscal-year-end month instead — deterministic
// and filing-independent. Apple FYE = Sept (9); calendar filers = Dec (12).
function fiscalOf(end, fye) {
  const y = +end.slice(0, 4), m = +end.slice(5, 7);
  const fy = m <= fye ? y : y + 1;                  // a quarter ending after FYE belongs to the next FY
  const startM = (fye % 12) + 1;
  const q = Math.floor((((m - startM) + 12) % 12) / 3) + 1;
  return { fy, q };
}
const annualLabel = (end, fye) => `FY${fiscalOf(end, fye).fy}`;
const qLabel = (end, fye) => { const { fy, q } = fiscalOf(end, fye); return `Q${q} FY${String(fy).slice(-2)}`; };

// periods for one concept node, most-recent first
function periodsFor(node, mode, fye) {
  const units = node.units || {};
  const unitKey = units.USD ? 'USD' : (units['USD/shares'] ? 'USD/shares' : Object.keys(units)[0]);
  const series = units[unitKey] || [];
  if (!series.length) return [];
  const isPerShare = unitKey === 'USD/shares';
  const isDuration = series.some((e) => e.start);

  // ── INSTANT concepts (balance sheet): point-in-time snapshots ──
  if (!isDuration) {
    const rows = mode === 'annual'
      ? series.filter((e) => e.fp === 'FY')
      : series.filter((e) => /^Q[1-4]$/.test(e.fp || '') || e.fp === 'FY');   // quarter-ends + year-ends
    return dedupeByEnd(rows).filter((e) => e.end)
      .sort((a, b) => b.end.localeCompare(a.end))
      .map((e) => ({ end: e.end, val: e.val, label: mode === 'annual' ? annualLabel(e.end, fye) : qLabel(e.end, fye) }));
  }

  // ── DURATION concepts (income, cash flow) ──
  if (mode === 'annual') {
    return dedupeByEnd(series.filter((e) => e.start && spanDays(e) >= 340 && spanDays(e) <= 380))
      .sort((a, b) => b.end.localeCompare(a.end))
      .map((e) => ({ end: e.end, val: e.val, label: annualLabel(e.end, fye) }));
  }
  // quarterly per-share (EPS): NOT additive — use discrete 3-month facts directly, never difference.
  if (isPerShare) {
    return dedupeByEnd(series.filter((e) => e.start && spanDays(e) >= 80 && spanDays(e) <= 100))
      .sort((a, b) => b.end.localeCompare(a.end))
      .map((e) => ({ end: e.end, val: e.val, label: qLabel(e.end, fye) }));
  }
  // quarterly dollar amounts: difference cumulative YTD into discrete quarters. Group by START date
  // (one fiscal year's YTD chain shares a start), diff consecutive ends, dedupe by end. This yields
  // Q1–Q4 (Q4 = FY − 9-mo YTD) for income AND cash flow, and isn't fooled by filing-relative fy tags.
  const byStart = {};
  for (const e of series.filter((x) => x.start && x.end)) (byStart[e.start] ||= []).push(e);
  const seen = new Map();
  for (const start of Object.keys(byStart)) {
    const rows = dedupeByEnd(byStart[start]).sort((a, b) => a.end.localeCompare(b.end));
    let prev = 0;
    for (const r of rows) { const q = r.val - prev; prev = r.val; if (!seen.has(r.end)) seen.set(r.end, q); }
  }
  return [...seen.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([end, val]) => ({ end, val, label: qLabel(end, fye) }));
}

// fiscal-year-end month from the modal month of a core concept's FY-tagged ends
function detectFye(gaap) {
  for (const tag of ['Assets', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'NetIncomeLoss']) {
    const u = gaap[tag]?.units?.USD;
    if (!u) continue;
    const months = u.filter((e) => e.fp === 'FY' && e.end).map((e) => +e.end.slice(5, 7));
    if (!months.length) continue;
    const counts = {};
    for (const m of months) counts[m] = (counts[m] || 0) + 1;
    return +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }
  return 12;
}

// resolve a row across its fallback chain — pick the tag whose latest period is the MOST RECENT
// (guards the AAPL stale-`Revenues` trap: legacy `Revenues` ends 2018, so it never beats the live tag).
function resolveRow(gaap, tags, mode, fye) {
  let best = null;
  for (const tag of tags) {
    const node = gaap[tag];
    if (!node) continue;
    const periods = periodsFor(node, mode, fye);
    if (!periods.length) continue;
    if (!best || periods[0].end > best.periods[0].end) best = { tag, periods };
  }
  return best;
}

function buildSection(gaap, defs, mode, fye) {
  const resolved = [];
  for (const d of defs) {
    const r = resolveRow(gaap, d.tags, mode, fye);
    if (r) resolved.push({ label: d.label, perShare: !!d.perShare, periods: r.periods });
  }
  if (!resolved.length) return null;
  const cols = resolved[0].periods.slice(0, N_PERIODS).map((p) => ({ end: p.end, label: p.label }));   // anchor = first resolved (a core row)
  const rows = resolved
    .map((r) => {
      const m = new Map(r.periods.map((p) => [p.end, p.val]));
      return { label: r.label, perShare: r.perShare, values: cols.map((c) => (m.has(c.end) ? m.get(c.end) : null)) };
    })
    // Drop rows with NO value in the displayed window. Catches abandoned/stale tags whose only data
    // predates these columns (e.g. STT's LongTermDebt ends 2015) — enforces "no all-blank rows".
    .filter((r) => r.values.some((v) => v != null));
  if (!rows.length) return null;
  return { columns: cols.map((c) => c.label), rows };
}

const empty = (ticker, cik) => ({ ticker, cik: cik ?? null, available: false, annual: null, quarterly: null, meta: { source: 'sec-edgar' } });

async function buildFinancials(ticker) {
  const cik = (await getCikMap())[ticker] || null;
  if (!cik) return empty(ticker, null);                 // not an SEC filer (ETF/foreign/junk)

  let facts = null, status = 0;
  try {
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_UA, cache: 'no-store' });
    status = r.status;
    if (r.ok) facts = await r.json();
  } catch { /* fall through */ }
  if (!facts) return { ...empty(ticker, cik), _status: status };

  const gaap = facts.facts?.['us-gaap'] || {};
  const fye = detectFye(gaap);
  const section = (defs) => ({
    annual: buildSection(gaap, defs, 'annual', fye),
    quarterly: buildSection(gaap, defs, 'quarterly', fye),
  });
  const inc = section(INCOME), bal = section(BALANCE), cf = section(CASHFLOW);

  const annual = { income: inc.annual, balance: bal.annual, cashflow: cf.annual };
  const quarterly = { income: inc.quarterly, balance: bal.quarterly, cashflow: cf.quarterly };
  const available = !!(annual.income || annual.balance || annual.cashflow);

  return { ticker, cik, entityName: facts.entityName || null, available, annual, quarterly, meta: { source: 'sec-edgar' } };
}

export async function GET(request) {
  let ticker = '';
  try {
    ticker = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
    const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
    if (!TICKER_RE.test(ticker)) return Response.json({ error: 'Invalid ticker' }, { status: 400 });

    const key = `financials:${ticker}`;
    if (!forceRefresh) {
      const hit = await kvGet(key);
      if (hit != null) { try { return Response.json({ ...JSON.parse(hit), cached: true }); } catch { /* refetch */ } }
    }

    const fresh = await buildFinancials(ticker);
    // cache real results + legit empties; don't cache transient SEC failures (status 0/5xx with facts null)
    if (fresh.available || fresh._status === 404 || fresh.cik == null) {
      const { _status, ...payload } = fresh;
      await kvSet(key, JSON.stringify(payload), TTL);
      return Response.json({ ...payload, cached: false });
    }
    const { _status, ...payload } = fresh;
    return Response.json({ ...payload, cached: false });        // SEC hiccup → empty, uncached, retry next load
  } catch (e) {
    console.log(`[financials] ${ticker} route error: ${e.message}`);
    return Response.json({ ...empty(ticker, null), error: false }, { status: 200 });   // null discipline
  }
}
