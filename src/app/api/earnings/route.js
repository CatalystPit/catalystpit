import { parseEarnings } from '../../../lib/sec-earnings.mjs';
import { resolveNextEarnings } from '../../../lib/earnings-next.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
// SEC requires a descriptive User-Agent or it 403s. https://www.sec.gov/os/accessing-edgar-data
const SEC_UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

const CIK_MAP_KEY = 'sec:cik_map';            // ticker → 10-digit CIK, cached 7d (cron refresh = separate concern)
const TTL_EARNINGS = 24 * 3600;               // parsed earnings per ticker
const TTL_STALE    = 7 * 24 * 3600;           // last-good copy for SEC-outage fallback

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

// ticker → 10-digit CIK map, KV-cached 7d. Returns {} on fetch failure (→ ticker simply not found).
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

const empty = (ticker, cik, error) =>
  Response.json({ ticker, cik: cik ?? null, count: 0, earnings: [], next: null, ...(error ? { error } : {}), meta: { cached: false, source: 'sec-edgar' } });

// ── ⚠️ THE ANNOUNCEMENT HISTORY, WHICH IS NOT THE FILING HISTORY ─────────────
//
// `report_date` on an earnings row is the day the 10-Q/10-K was FILED. An earnings DATE is the day
// the company announced — an 8-K carrying Item 2.02, "Results of Operations and Financial
// Condition". Those are different events: measured over 2,472 real pairs the announcement lands a
// median of 5 days BEFORE the filing (p10 0, p90 24). Predicting "next earnings" from filing dates
// was predicting the wrong event with the wrong cadence.
//
// ⚠️ ONE REQUEST, AND IT RIDES THE SAME 24-HOUR CACHE AS THE FACTS. submissions.json returns both
// things in a single call — the 8-K rows with an `items` string, and the 10-Q/10-K rows with the
// filer's declared period-of-report. It is fetched IN PARALLEL with companyfacts, so the route's
// latency is unchanged, and the ticker page still makes exactly the requests it made before.
//
// `reportDate` is preferred over `filingDate` for a 2.02: it is the day the filer states the results
// were released, which for an after-close announcement is the day the market actually learned.
async function secFilingHistory(cik) {
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_UA, cache: 'no-store' });
    if (!r.ok) return { announcements: [], periodic: [], fiscalYearEnd: null };
    const j = await r.json();
    const b = j.filings?.recent || {};
    const forms = b.form || [];
    const announcements = [], periodic = [];
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === '8-K' && String(b.items?.[i] || '').includes('2.02')) {
        announcements.push({ event: b.reportDate?.[i] || b.filingDate?.[i], filed: b.filingDate?.[i] });
      } else if (forms[i] === '10-Q' || forms[i] === '10-K') {
        periodic.push({ filed: b.filingDate?.[i], form: forms[i], period: b.reportDate?.[i] || null });
      }
    }
    const uniq = (arr, k) => [...new Map(arr.filter((x) => k(x)).map((x) => [k(x), x])).values()];
    return {
      announcements: uniq(announcements, (x) => x.event).sort((a, c) => a.event.localeCompare(c.event)),
      periodic: uniq(periodic, (x) => `${x.form}|${x.filed}`).sort((a, c) => a.filed.localeCompare(c.filed)),
      fiscalYearEnd: j.fiscalYearEnd || null,
    };
  } catch { return { announcements: [], periodic: [], fiscalYearEnd: null }; }
}

// A CONFIRMED FORWARD SCHEDULE HAS NO LICENSED SOURCE, SO THERE IS NEVER ONE TO MERGE.
//
// ⚠️ THIS READ THE TWELVE DATA EARNINGS CALENDAR out of KV, gated on TWELVE_DATA_API_KEY. The key is
// not set in production, so no unlicensed date has reached a reader through it — but the gate was the
// KEY rather than the LICENCE, and that same key would have flipped lib/market-data.js onto Twelve Data
// for every quote in the product. Both halves are gone now.
//
// ⚠️ AND THE CALLER IS ALREADY CORRECT WITHOUT IT. `next` falls back to the estimate derived from this
// issuer's own filing cadence, which the response labels as an estimate rather than a confirmed date.
// Returning null keeps that path and claims nothing it cannot support: an invented earnings date is the
// one thing worse than an absent one.
async function scheduledFor() {
  return null;
}

// ⚠️ `next` IS COMPUTED PER REQUEST, NEVER CACHED WITH THE PAYLOAD. Two of its fields depend on
// today's date — `imminent`, and the same-day Item 2.02 that is the only SEC-confirmable case — so a
// value cached for 24 hours would be wrong for up to a day, which is the class of bug this whole
// change exists to remove. The expensive inputs stay cached; the decision is pure arithmetic.
async function respond(payload, { scheduled = null } = {}) {
  // ⚠️ MERGE THE XBRL QUARTERS INTO THE FALLBACK SERIES, because submissions.json truncates.
  //
  // `filings.recent` holds roughly the last 1,000 filings, which for a normal issuer is a decade —
  // but JPMorgan files 26,408 in a single year, so `recent` reaches back only to 2025-09-29 and
  // yields four Item 2.02 events. The XBRL quarters do not have that problem: parseEarnings returns
  // 12 periods regardless of how much unrelated paper the issuer files. So the periodic fallback is
  // the union of both, keyed on the filing date.
  const fromXbrl = (payload.earnings || [])
    .filter((r) => r.report_date)
    .map((r) => ({ filed: r.report_date, form: r.form || null, period: r.period_end || null }));
  const periodic = [...new Map(
    [...(payload.periodic || []), ...fromXbrl].filter((p) => p?.filed).map((p) => [p.filed, p]),
  ).values()].sort((a, b) => a.filed.localeCompare(b.filed));

  const next = resolveNextEarnings({
    announcements: payload.announcements || [],
    periodic,
    scheduled,
  });
  // The history is an INPUT to the decision, not part of the response: the page needs `next`, not a
  // few hundred filing rows it would have to reason about itself.
  const { announcements: _a, periodic: _p, ...pub } = payload;
  return Response.json({ ...pub, next });
}

// ⚠️ THE POLYGON EARNINGS FALLBACK IS DELETED. It covered foreign issuers that file 20-F/IFRS rather
// than us-gaap quarters, which SEC XBRL cannot express as quarterly rows — a real gap, and the honest
// consequence is that those issuers show fewer quarters rather than vendor-sourced ones. It was already
// uncalled; leaving ~45 lines of vendor client in place needs only one future caller to undo that.

async function earningsFallback(ticker, cik) {
  return empty(ticker, cik);
}

export async function GET(request) {
  let ticker = '';
  try {
    ticker = (new URL(request.url).searchParams.get('ticker') || '').toUpperCase().trim();
    if (!TICKER_RE.test(ticker)) return empty(ticker, null, 'invalid_ticker');

    // v2: the cached payload now carries the announcement history the estimator needs. A v1 entry
    // has no `announcements`, so it would silently fall back to filing dates for up to a day.
    const key = `earnings:v2:${ticker}`, lastKey = `${key}:last`;
    const scheduled = await scheduledFor(ticker);
    const hit = await kvGet(key);
    if (hit != null) { try { const v = JSON.parse(hit); return await respond({ ...v, meta: { ...v.meta, cached: true } }, { scheduled }); } catch { /* refetch */ } }

    const cik = (await getCikMap())[ticker] || null;
    if (!cik) return earningsFallback(ticker, null);   // not in SEC map (foreign/ADR) → try Polygon financials

    let facts = null, status = 0;
    // ⚠️ IN PARALLEL, so adding the announcement history costs no wall-clock on the ticker page.
    const historyPromise = secFilingHistory(cik);
    try {
      const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_UA, cache: 'no-store' });
      status = r.status;
      if (r.ok) facts = await r.json();
    } catch (e) { console.log(`[earnings] ${ticker} SEC fetch threw: ${e.message}`); }
    const history = await historyPromise;

    // 404 = entity has no XBRL financial facts (ETF/trust/foreign) → try Polygon before giving up.
    if (!facts && status === 404) return earningsFallback(ticker, cik);

    if (!facts) {                                   // real SEC failure → stale-fallback, else empty (never 503)
      const stale = await kvGet(lastKey);
      if (stale != null) { try { const v = JSON.parse(stale); return await respond({ ...v, meta: { ...v.meta, cached: true } }, { scheduled }); } catch { /* fall through */ } }
      console.log(`[earnings] ${ticker} (${cik}) SEC fetch failed (status ${status}), no stale cache`);
      return empty(ticker, cik, 'data_unavailable');
    }

    const earnings = parseEarnings(facts, cik);
    if (!earnings.length) return earningsFallback(ticker, cik);   // foreign/IFRS filer (no us-gaap quarters) → Polygon
    const payload = {
      ticker, cik, count: earnings.length, earnings,
      announcements: history.announcements, periodic: history.periodic,
      meta: { cached: false, source: 'sec-edgar', announcements: history.announcements.length },
    };
    await kvSet(key, JSON.stringify(payload), TTL_EARNINGS);
    await kvSet(lastKey, JSON.stringify(payload), TTL_STALE);
    console.log(`[earnings] ${ticker} (${cik}) quarters=${earnings.length} announcements=${history.announcements.length}`);
    return await respond(payload, { scheduled });
  } catch (e) {
    console.log(`[earnings] ${ticker} failed: ${e.message}`);
    return empty(ticker, null, 'data_unavailable');
  }
}
