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

// AUTOCOMPLETE: fund name typeahead → top matches (featured first, then deepest coverage).
// Drives the /institutions search box. Lightweight — no filing joins.
async function searchView(q) {
  const like = `%${q.replace(/[%_\\]/g, '')}%`;
  const rows = await db.select({
    slug: institutions.slug, name: institutions.name, featuredLabel: institutions.featuredLabel,
    manager: institutions.manager, filingCount: institutions.filingCount,
  }).from(institutions)
    .where(or(ilike(institutions.name, like), ilike(institutions.featuredLabel, like)))
    .orderBy(desc(sql`(${institutions.featuredLabel} is not null)`), desc(sql`coalesce(${institutions.filingCount}, 0)`), institutions.name)
    .limit(8);
  return rows.map((r) => ({ slug: r.slug, label: r.featuredLabel || r.name || `CIK ${r.slug}`, manager: r.manager, featured: !!r.featuredLabel }));
}

// Manager-family key from the filer name (auto — no hand-picked list): the leading BRAND token, so a
// firm that files under many entities (Vanguard Portfolio Mgmt / Capital Mgmt / Fiduciary Trust …)
// groups under one "Vanguard". Generic/short leading words don't form a family (avoids bad merges).
const GENERIC_FIRST = new Set(['AMERICAN', 'GLOBAL', 'FIRST', 'CAPITAL', 'NATIONAL', 'UNITED', 'GENERAL', 'PACIFIC', 'NORTHERN', 'SECURITY', 'INVESTMENT', 'INVESTMENTS', 'ASSET', 'WEALTH', 'FINANCIAL', 'ADVISORS', 'ADVISERS', 'MANAGEMENT', 'GROUP', 'PARTNERS', 'TRUST', 'NEW', 'GREAT', 'PRIME', 'CORE', 'NEXT']);
function familyKey(name) {
  const toks = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const first = toks[0] === 'THE' ? toks[1] : toks[0];
  if (!first || first.length < 5 || GENERIC_FIRST.has(first)) return null;
  return first;
}
const properCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

// Largest managers by latest 13F value — AUTO-featured (no hand-picked list), with multi-entity firms
// (Vanguard, etc.) merged into a single family card. BlackRock, State Street… surface as they ingest.
async function largestManagers(limit = 24) {
  try {
    const res = await db.execute(sql`
      SELECT i.cik, i.name, i.slug, i.featured_label AS "featuredLabel", i.manager,
             l.quarter, l.filed_date AS "filedDate", l.total_value AS "totalValue", l.holdings_count AS "holdingsCount"
      FROM (SELECT DISTINCT ON (cik) cik, quarter, filed_date, total_value, holdings_count FROM fund_filings ORDER BY cik, quarter DESC) l
      JOIN institutions i ON i.cik = l.cik
      WHERE l.total_value IS NOT NULL
      ORDER BY l.total_value DESC
      LIMIT 80
    `);
    const rows = res?.rows || [];
    const card = (r) => ({ slug: r.slug, label: r.featuredLabel || r.name || `CIK ${r.cik}`, manager: r.manager, category: 'Largest Managers', featured: true, hasData: true, quarter: r.quarter, filedDate: r.filedDate, totalValue: +r.totalValue || 0, holdingsCount: r.holdingsCount, filingCount: null });
    const fam = new Map(), singles = [];
    for (const r of rows) { const k = familyKey(r.name); if (!k) { singles.push(r); continue; } if (!fam.has(k)) fam.set(k, []); fam.get(k).push(r); }
    const cards = [];
    for (const [k, mem] of fam) {
      if (mem.length === 1) { cards.push(card(mem[0])); continue; }
      cards.push({
        slug: `family--${k.toLowerCase()}`, label: properCase(k), manager: `${mem.length} filing entities`,
        category: 'Largest Managers', featured: true, hasData: true,
        quarter: mem.map((m) => m.quarter).filter(Boolean).sort().pop(),
        totalValue: mem.reduce((s, m) => s + (+m.totalValue || 0), 0),
        holdingsCount: mem.reduce((s, m) => s + (+m.holdingsCount || 0), 0), filingCount: null,
      });
    }
    for (const r of singles) cards.push(card(r));
    cards.sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));
    return cards.slice(0, limit);
  } catch (e) { console.log(`[institutions_api] largest failed: ${e.message}`); return []; }
}

// Merged detail for a manager family (e.g. all Vanguard entities): aggregate each entity's latest
// filing into one combined holdings map + total. QoQ activity is omitted for the merged view.
async function familyDetail(key) {
  const k = String(key || '').toUpperCase();
  const meta = { slug: `family--${key}`, label: properCase(k), manager: null, category: 'Largest Managers' };
  const all = await db.select({ cik: institutions.cik, name: institutions.name }).from(institutions).where(ilike(institutions.name, `${k}%`));
  const ciks = all.filter((r) => familyKey(r.name) === k).map((r) => r.cik);
  if (!ciks.length) return { fund: meta, hasData: false };
  meta.manager = `${ciks.length} filing entities`;
  const latest = await db.selectDistinctOn([fundFilings.cik], { cik: fundFilings.cik, quarter: fundFilings.quarter, totalValue: fundFilings.totalValue })
    .from(fundFilings).where(inArray(fundFilings.cik, ciks)).orderBy(fundFilings.cik, desc(fundFilings.quarter));
  if (!latest.length) return { fund: meta, hasData: false };
  const totalValue = latest.reduce((s, l) => s + (l.totalValue || 0), 0);
  const asOf = latest.map((l) => l.quarter).filter(Boolean).sort().pop();
  const res = await db.execute(sql`
    WITH latest AS (SELECT DISTINCT ON (cik) cik, quarter FROM fund_filings WHERE cik IN ${ciks} ORDER BY cik, quarter DESC)
    SELECT h.cusip, max(h.ticker) AS ticker, max(h.issuer) AS issuer, coalesce(h.put_call,'') AS "putCall",
           sum(h.shares)::double precision AS shares, sum(h.value)::double precision AS value
    FROM fund_holdings h JOIN latest l ON l.cik = h.cik AND l.quarter = h.quarter
    GROUP BY h.cusip, coalesce(h.put_call,'')
    ORDER BY sum(h.value) DESC NULLS LAST
    LIMIT ${HOLDINGS_CAP}
  `);
  const holdings = (res?.rows || []).map((r) => ({ ticker: r.ticker, issuer: r.issuer, cusip: r.cusip, shares: r.shares, value: r.value, putCall: r.putCall }));
  const cnt = (await db.execute(sql`WITH latest AS (SELECT DISTINCT ON (cik) cik, quarter FROM fund_filings WHERE cik IN ${ciks} ORDER BY cik, quarter DESC) SELECT count(DISTINCT (h.cusip, coalesce(h.put_call,'')))::int AS n FROM fund_holdings h JOIN latest l ON l.cik = h.cik AND l.quarter = h.quarter`))?.rows?.[0]?.n || holdings.length;
  return { fund: meta, hasData: true, latest: { quarter: asOf, filedDate: null, totalValue, holdingsCount: cnt }, prior: null, holdings, holdingsShown: holdings.length, totalHoldings: cnt, activity: { new: [], added: [], trimmed: [], exited: [] } };
}

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

  const largest = q ? [] : await largestManagers();       // auto-featured biggest managers (top of page)
  // Don't repeat a manager in the curated categories if it's already shown in Largest Managers
  // (by exact slug, or by family for merged cards like Vanguard).
  const largeSlugs = new Set(largest.map((l) => l.slug));
  const largeFams = new Set(largest.filter((l) => l.slug.startsWith('family--')).map((l) => l.slug.slice(8)));
  const featured = featuredRows
    .filter((r) => !largeSlugs.has(r.slug) && !largeFams.has((familyKey(r.name) || '__none__')))
    .map((r) => toCard(r, latest)).sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));
  const directory = dirRows.map((r) => toCard(r, latest));
  return { largest, featured, directory, total, page, pageSize };
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
  if (slug && slug.startsWith('family--')) return familyDetail(slug.slice(8));
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
    const ac = sp.get('ac');
    if (ac != null) {
      const term = ac.trim();
      if (term.length < 2) return Response.json({ results: [] }, { headers: CACHE });
      return Response.json({ results: await searchView(term) }, { headers: CACHE });
    }
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
