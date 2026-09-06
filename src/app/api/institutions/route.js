import { db } from '../../../lib/db';
import { fundHoldings, fundFilings } from '../../../lib/schema';
import { INSTITUTIONS, INSTITUTION_BY_SLUG } from '../../../lib/institutions.mjs';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';

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

async function listView() {
  const ciks = await Promise.all(INSTITUTIONS.map(cikFor));
  const bySlug = Object.fromEntries(INSTITUTIONS.map((f, i) => [f.slug, ciks[i]]));
  const known = ciks.filter(Boolean);
  let latestByCik = {};
  if (known.length) {
    // Latest filing summary per cik. Resilient: if the table doesn't exist yet (migration not
    // run) or the DB hiccups, still return the roster so the page renders "awaiting import".
    try {
      const rows = await db
        .selectDistinctOn([fundFilings.cik], {
          cik: fundFilings.cik, quarter: fundFilings.quarter, filedDate: fundFilings.filedDate,
          totalValue: fundFilings.totalValue, holdingsCount: fundFilings.holdingsCount,
        })
        .from(fundFilings)
        .where(inArray(fundFilings.cik, known))
        .orderBy(fundFilings.cik, desc(fundFilings.quarter));
      latestByCik = Object.fromEntries(rows.map((r) => [r.cik, r]));
    } catch (e) {
      console.log(`[institutions_api] list summary query failed (migration not run?): ${e.message}`);
    }
  }
  const funds = INSTITUTIONS.map((f) => {
    const cik = bySlug[f.slug];
    const s = cik ? latestByCik[cik] : null;
    return {
      slug: f.slug, label: f.label, manager: f.manager, category: f.category,
      hasData: !!s,
      quarter: s?.quarter ?? null, filedDate: s?.filedDate ?? null,
      totalValue: s?.totalValue ?? null, holdingsCount: s?.holdingsCount ?? null,
    };
  });
  return { funds };
}

async function detailView(slug) {
  const fund = INSTITUTION_BY_SLUG[slug];
  if (!fund) return { error: 'not_found' };
  const cik = await cikFor(fund);
  if (!cik) return { fund: { slug: fund.slug, label: fund.label, manager: fund.manager, category: fund.category }, hasData: false };

  const meta = { slug: fund.slug, label: fund.label, manager: fund.manager, category: fund.category };
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
    fund: { slug: fund.slug, label: fund.label, manager: fund.manager, category: fund.category },
    hasData: true, latest, prior,
    holdings, holdingsShown: holdings.length, totalHoldings: latest.holdingsCount,
    activity,
  };
}

export async function GET(request) {
  try {
    const slug = new URL(request.url).searchParams.get('slug');
    const payload = slug ? await detailView(slug) : await listView();
    return Response.json(payload, { headers: CACHE });
  } catch (e) {
    console.log(`[institutions_api] failed: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
