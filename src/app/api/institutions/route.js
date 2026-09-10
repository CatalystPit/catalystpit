import { db } from '../../../lib/db';
import { fundHoldings, fundFilings, institutions, tickerInstitutionalOwnership } from '../../../lib/schema';
import { INSTITUTIONS, INSTITUTION_BY_SLUG } from '../../../lib/institutions.mjs';
import { and, eq, inArray, desc, sql, isNotNull, ilike, or } from 'drizzle-orm';

export const runtime = 'nodejs';

// 13F data is public → CDN-cacheable. Per-quarter data changes at most daily during filing season.
const CACHE = { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' };
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const HOLDINGS_CAP = 200;   // top positions returned for the detail table (giants have thousands)
const DIFF_CAP = 1000;      // per-quarter rows loaded for QoQ diff (bounds giants)

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    return (await r.json())?.result ?? null;
  } catch { return null; }
}
// Resolved CIK: seeded config value, else the cron's per-slug KV cache.
async function cikFor(fund) {
  if (fund.cik) return String(Number(String(fund.cik).replace(/\D/g, '')));
  const c = await kvGet(`catalystpit:inst:cik:${fund.slug}`);
  return c ? String(Number(String(c).replace(/\D/g, ''))) : null;
}

// Latest filing summary (as-of quarter / 13F value / holdings count) for a set of CIKs.
async function latestFilingByCik(ciks) {
  if (!ciks.length) return {};
  try {
    const rows = await db
      .selectDistinctOn([fundFilings.cik], {
        cik: fundFilings.cik, quarter: fundFilings.quarter, filedDate: fundFilings.filedDate,
        totalValue: fundFilings.totalValue, holdingsCount: fundFilings.holdingsCount,
      })
      .from(fundFilings)
      .where(inArray(fundFilings.cik, ciks))
      .orderBy(fundFilings.cik, desc(fundFilings.quarter));
    return Object.fromEntries(rows.map((r) => [r.cik, r]));
  } catch (e) {
    console.log(`[institutions_api] latest-filing query failed (migration not run?): ${e.message}`);
    return {};
  }
}

const toCard = (r, latest) => {
  const s = latest[r.cik] || null;
  return {
    slug: r.slug, label: r.featuredLabel || r.name || `CIK ${r.cik}`, manager: r.manager,
    category: r.category || 'Other', featured: !!r.featuredLabel,
    hasData: !!s, quarter: s?.quarter ?? null, filedDate: s?.filedDate ?? null,
    totalValue: s?.totalValue ?? null, holdingsCount: s?.holdingsCount ?? null,
    filingCount: r.filingCount ?? null,
  };
};

// Featured curated funds (top of page) + a searchable, paginated directory of EVERY discovered 13F filer.
async function listView(q, page, pageSize) {
  // If the registry hasn't been populated yet, fall back to the curated roster so the page still renders.
  let featuredRows = [];
  try {
    featuredRows = await db.select({
      cik: institutions.cik, name: institutions.name, slug: institutions.slug, featuredLabel: institutions.featuredLabel,
      manager: institutions.manager, category: institutions.category, filingCount: institutions.filingCount,
    }).from(institutions).where(isNotNull(institutions.featuredLabel));
  } catch (e) {
    console.log(`[institutions_api] registry read failed (migration not run?): ${e.message}`);
    return legacyListView();
  }
  if (!featuredRows.length) return legacyListView();

  // Directory: all filers, optional name search, ordered by depth of data then recency, paginated.
  const like = q ? `%${q}%` : null;
  const where = like ? or(ilike(institutions.name, like), ilike(institutions.featuredLabel, like)) : undefined;
  const dirRows = await db.select({
    cik: institutions.cik, name: institutions.name, slug: institutions.slug, featuredLabel: institutions.featuredLabel,
    manager: institutions.manager, category: institutions.category, filingCount: institutions.filingCount,
    lastQuarter: institutions.lastQuarter,
  }).from(institutions).where(where)
    .orderBy(sql`coalesce(${institutions.filingCount}, 0) desc, ${institutions.lastQuarter} desc nulls last, ${institutions.name} asc`)
    .limit(pageSize).offset(page * pageSize);
  const [{ total } = { total: 0 }] = await db.select({ total: sql`count(*)`.mapWith(Number) }).from(institutions).where(where);

  const ciks = [...new Set([...featuredRows.map((r) => r.cik), ...dirRows.map((r) => r.cik)])];
  const latest = await latestFilingByCik(ciks);

  const featured = featuredRows.map((r) => toCard(r, latest)).sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));
  const directory = dirRows.map((r) => toCard(r, latest));
  return { featured, directory, total, page, pageSize };
}

// Pre-registry fallback: the original curated-roster view (kept for resilience during backfill).
async function legacyListView() {
  const ciks = await Promise.all(INSTITUTIONS.map(cikFor));
  const bySlug = Object.fromEntries(INSTITUTIONS.map((f, i) => [f.slug, ciks[i]]));
  const latest = await latestFilingByCik(ciks.filter(Boolean));
  const featured = INSTITUTIONS.map((f) => {
    const cik = bySlug[f.slug]; const s = cik ? latest[cik] : null;
    return {
      slug: f.slug, label: f.label, manager: f.manager, category: f.category, featured: true,
      hasData: !!s, quarter: s?.quarter ?? null, filedDate: s?.filedDate ?? null,
      totalValue: s?.totalValue ?? null, holdingsCount: s?.holdingsCount ?? null, filingCount: null,
    };
  });
  return { featured, directory: [], total: 0, page: 0, pageSize: 0 };
}

async function detailView(slug) {
  // Resolve from the auto-discovered registry first; fall back to the curated config during backfill.
  let cik = null, meta = null;
  try {
    const [inst] = await db.select({
      cik: institutions.cik, name: institutions.name, slug: institutions.slug,
      featuredLabel: institutions.featuredLabel, manager: institutions.manager, category: institutions.category,
    }).from(institutions).where(eq(institutions.slug, slug)).limit(1);
    if (inst) { cik = inst.cik; meta = { slug: inst.slug, label: inst.featuredLabel || inst.name, manager: inst.manager, category: inst.category }; }
  } catch { /* registry not ready yet */ }
  if (!cik) {
    const fund = INSTITUTION_BY_SLUG[slug];
    if (!fund) return { error: 'not_found' };
    cik = await cikFor(fund);
    meta = { slug: fund.slug, label: fund.label, manager: fund.manager, category: fund.category };
    if (!cik) return { fund: meta, hasData: false };
  }
  let quarters = [];
  try {
    quarters = await db.select({ quarter: fundFilings.quarter, filedDate: fundFilings.filedDate, totalValue: fundFilings.totalValue, holdingsCount: fundFilings.holdingsCount })
      .from(fundFilings).where(eq(fundFilings.cik, cik)).orderBy(desc(fundFilings.quarter)).limit(2);
  } catch (e) {
    console.log(`[institutions_api] detail query failed (migration not run?): ${e.message}`);
    return { fund: meta, hasData: false };
  }
  if (!quarters.length) return { fund: meta, hasData: false };

  const latest = quarters[0];
  const prior = quarters[1] || null;

  // Top holdings for the latest quarter.
  const holdings = await db.select({
    ticker: fundHoldings.ticker, issuer: fundHoldings.issuer, cusip: fundHoldings.cusip,
    shares: fundHoldings.shares, value: fundHoldings.value, putCall: fundHoldings.putCall,
  }).from(fundHoldings)
    .where(and(eq(fundHoldings.cik, cik), eq(fundHoldings.quarter, latest.quarter)))
    .orderBy(desc(fundHoldings.value)).limit(HOLDINGS_CAP);

  // QoQ activity — diff top DIFF_CAP positions of each quarter by CUSIP.
  let activity = { new: [], added: [], trimmed: [], exited: [] };
  if (prior) {
    const load = (q) => db.select({ cusip: fundHoldings.cusip, ticker: fundHoldings.ticker, issuer: fundHoldings.issuer, shares: fundHoldings.shares, value: fundHoldings.value, putCall: fundHoldings.putCall })
      .from(fundHoldings).where(and(eq(fundHoldings.cik, cik), eq(fundHoldings.quarter, q)))
      .orderBy(desc(fundHoldings.value)).limit(DIFF_CAP);
    const [cur, prev] = await Promise.all([load(latest.quarter), load(prior.quarter)]);
    const key = (r) => `${r.cusip}|${r.putCall || ''}`;   // a put and the underlying shares are distinct positions
    const prevBy = new Map(prev.map((r) => [key(r), r]));
    const curBy = new Map(cur.map((r) => [key(r), r]));
    for (const r of cur) {
      const p = prevBy.get(key(r));
      if (!p) activity.new.push({ ...r, prevShares: 0 });
      else if ((r.shares || 0) > (p.shares || 0) * 1.001) activity.added.push({ ...r, prevShares: p.shares });
      else if ((r.shares || 0) < (p.shares || 0) * 0.999) activity.trimmed.push({ ...r, prevShares: p.shares });
    }
    for (const p of prev) if (!curBy.has(key(p))) activity.exited.push({ ...p, prevShares: p.shares, value: 0 });
    const byVal = (a, b) => (b.value || 0) - (a.value || 0);
    const byPrev = (a, b) => (b.prevShares || 0) - (a.prevShares || 0);
    activity.new = activity.new.sort(byVal).slice(0, 20);
    activity.added = activity.added.sort(byVal).slice(0, 20);
    activity.trimmed = activity.trimmed.sort(byVal).slice(0, 20);
    activity.exited = activity.exited.sort(byPrev).slice(0, 20);
  }

  return {
    fund: meta,
    hasData: true, latest, prior,
    holdings, holdingsShown: holdings.length, totalHoldings: latest.holdingsCount,
    activity,
  };
}

const HOLDER_CAP = 100;   // holders returned per ticker (mega-caps are held by thousands of filers)

// EVERY 13F filer holding a given ticker (in each fund's LATEST filed quarter), plus the precomputed
// 13F-reported ownership stat. No longer limited to the curated 57 — reads the full registry.
async function tickerView(ticker) {
  const holds = await db.select({ cik: fundHoldings.cik, quarter: fundHoldings.quarter, shares: fundHoldings.shares, value: fundHoldings.value, putCall: fundHoldings.putCall })
    .from(fundHoldings).where(eq(fundHoldings.ticker, ticker));
  if (!holds.length) return { ticker, funds: [], count: 0, ownership: null };

  const ciks = [...new Set(holds.map((h) => h.cik))];
  const latest = await db.selectDistinctOn([fundFilings.cik], { cik: fundFilings.cik, quarter: fundFilings.quarter, totalValue: fundFilings.totalValue })
    .from(fundFilings).where(inArray(fundFilings.cik, ciks)).orderBy(fundFilings.cik, desc(fundFilings.quarter));
  const latestByCik = Object.fromEntries(latest.map((r) => [r.cik, r]));

  const insts = await db.select({ cik: institutions.cik, name: institutions.name, slug: institutions.slug, featuredLabel: institutions.featuredLabel, manager: institutions.manager })
    .from(institutions).where(inArray(institutions.cik, ciks));
  const instByCik = Object.fromEntries(insts.map((r) => [r.cik, r]));

  const funds = [];
  for (const h of holds) {
    const lq = latestByCik[h.cik];
    if (!lq || h.quarter !== lq.quarter) continue;      // only each fund's current quarter
    const inst = instByCik[h.cik];
    funds.push({
      slug: inst?.slug || `cik-${h.cik}`,
      label: inst?.featuredLabel || inst?.name || `CIK ${h.cik}`,
      manager: inst?.manager || null,
      featured: !!inst?.featuredLabel,
      shares: h.shares, value: h.value, putCall: h.putCall, quarter: h.quarter,
      pctPort: lq.totalValue ? +(h.value / lq.totalValue * 100).toFixed(2) : null,
    });
  }
  funds.sort((a, b) => (b.value || 0) - (a.value || 0));
  const count = funds.length;

  // Precomputed ownership stat (Σ common shares ÷ shares outstanding), if the nightly aggregate has run.
  let ownership = null;
  try {
    const [o] = await db.select().from(tickerInstitutionalOwnership).where(eq(tickerInstitutionalOwnership.ticker, ticker)).limit(1);
    if (o) ownership = { pct: o.ownershipPct, filerCount: o.filerCount, instShares: o.instShares, instValue: o.instValue, sharesOut: o.sharesOut, asOf: o.asOfQuarter };
  } catch { /* aggregate not ready */ }

  return { ticker, funds: funds.slice(0, HOLDER_CAP), count, ownership };
}

export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const ticker = sp.get('ticker');
    const slug = sp.get('slug');
    const q = (sp.get('q') || '').trim().slice(0, 60);
    const page = Math.max(0, parseInt(sp.get('page') || '0', 10) || 0);
    const pageSize = Math.min(100, Math.max(10, parseInt(sp.get('pageSize') || '48', 10) || 48));
    const payload = ticker ? await tickerView(ticker.toUpperCase().trim())
      : slug ? await detailView(slug)
      : await listView(q, page, pageSize);
    return Response.json(payload, { headers: CACHE });
  } catch (e) {
    console.log(`[institutions_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
