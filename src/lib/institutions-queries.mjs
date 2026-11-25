// ── THE 13F READ, AND THE TWO RULES THAT TRAVEL WITH IT ────────────────────
//
// ⚠️ MOVED OUT OF /api/institutions BECAUSE app/institutions/page.jsx RENDERS THE FILINGS LIST NOW.
//
// Two of these are not conveniences, they are rules about who may see what, and a second copy of
// either is a defect waiting to be written:
//
//   ffRel    the FREE end-of-day boundary for fund_filings, as a relation fragment. A caller that
//            forgets it serves the Pro dataset. Five queries in the route depend on it.
//   publicCap the LOGIN funnel. A logged-OUT caller sees at most PUBLIC_ROWS rows of any array in
//            the payload, with the remainder reported as a locked count. This is a product
//            decision about the funnel, not a licensing one — and it is why a crawler, which is
//            always logged out, will only ever see ten rows of this room however it is rendered.
//            Measured against production: directory 10 rows / 38 locked, largest 10 / 14,
//            featured 10 / 33, latest-filings 10 / 15, out of a registry of 10,013 institutions.
//
// ⚠️ NOTHING HERE CHANGED ITS MEANING IN THE MOVE. Same SQL, same cap, same comments.
import { db } from './db';
import { fundFilings } from './schema';
import { sql } from 'drizzle-orm';

/** The Free end-of-day boundary as a RELATION, for raw SQL that selects `from fund_filings`. */
export const ffRel = (cutoff) => (cutoff
  ? sql`(select * from fund_filings where inserted_at <= ${cutoff}::timestamptz)`
  : sql`fund_filings`);

/** The same rule for the drizzle builders, which cannot take a relation fragment. */
export const ffCut = (cutoff) => (cutoff ? sql`${fundFilings.insertedAt} <= ${cutoff}::timestamptz` : undefined);

// Logged-out sees at most this many records of any array; signed-in Free sees the full history at
// the EOD cutoff. The gate is HAVING AN ACCOUNT, which is deliberately not the same as paying.
export const PUBLIC_ROWS = 10;

/**
 * Apply the logged-out row cap, reporting what was withheld rather than silently truncating.
 *
 * ⚠️ A SERVER-RENDERED PUBLIC PAGE MUST PASS `loggedIn: false`. Shared HTML is read by everyone,
 * including every crawler, so it carries the logged-out view by definition. Passing anything else
 * would publish the signed-in product to an anonymous cache.
 */
export function publicCap(payload, { loggedIn = false } = {}) {
  if (loggedIn || !payload || typeof payload !== 'object') return payload;
  const out = { ...payload, publicPreview: true, publicRowLimit: PUBLIC_ROWS };
  for (const [k, v] of Object.entries(out)) {
    if (!Array.isArray(v) || v.length <= PUBLIC_ROWS) continue;
    out[k] = v.slice(0, PUBLIC_ROWS);
    out[`${k}LockedCount`] = v.length - PUBLIC_ROWS;
  }
  return out;
}

/**
 * The most recent 13F filings across all registered managers, newest first.
 *
 * ⚠️ THIS IS THE MOST CITABLE THING IN THE ROOM, which is why it is the piece that moved first.
 * Every row carries the organization, the reporting period, the disclosure date, the holdings
 * count, a link to our own research on that manager AND a link to the primary document on SEC
 * EDGAR. That is a complete, attributed, dated fact without a single number of our own invention.
 */
export async function latestFilings(limit = 25, cutoff = null) {
  const { rows } = await db.execute(sql`
    select f.cik, f.accession, f.filed_date::text as filed_date, f.quarter::text as quarter,
           f.holdings_count, i.name, i.slug
      from ${ffRel(cutoff)} f
      join institutions i on i.cik = f.cik
     where f.filed_date is not null
       and i.name is not null and trim(i.name) <> ''
       and i.slug is not null
     order by f.filed_date desc, f.inserted_at desc
     limit ${limit}`);
  return (rows ?? []).map((r) => ({
    cik: r.cik,
    accession: r.accession,
    manager: r.name,
    slug: r.slug,
    // ⚠️ A DATE, NOT A TIMESTAMP. SEC's 13F index publishes a filing DATE; we store a date and
    // there is no time to show. Rendering one would mean inventing 00:00.
    disclosed: r.filed_date,
    quarterEnd: r.quarter,
    holdings: Number.isFinite(Number(r.holdings_count)) ? Number(r.holdings_count) : null,
    managerUrl: `/institutions/${r.slug}`,
    // The primary document, built from the accession the row already stores.
    filingUrl: r.accession
      ? `https://www.sec.gov/Archives/edgar/data/${r.cik}/${String(r.accession).replace(/-/g, '')}/${r.accession}-index.htm`
      : null,
  }));
}
