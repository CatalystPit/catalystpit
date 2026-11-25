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

// ── LATEST 13F FILINGS ──────────────────────────────────────────────────────
//
// What has just been DISCLOSED, newest disclosure first. The rest of this page is organised by
// holdings and by quarter, which answers "what does this manager own" but never "what landed
// today" — so a filer catching up on four old quarters in one afternoon was invisible.
//
// ⚠️ ORDERED BY filed_date, NEVER BY QUARTER. The quarter is the period the positions describe;
// the filing date is when the market could first read them, and they are routinely months apart.
// Sorting by quarter would bury exactly the rows this module exists to surface: measured on the
// live table, a single day's filings covered quarters ending 2024-09-30 through 2026-06-30, and
// every one of the older ones would sink out of view under a quarter sort.
//
// ⚠️ AND IT NEVER SAYS ANYONE BOUGHT TODAY. A 13F is a snapshot of a quarter that has already
// ended, disclosed up to 45 days later; the row states both dates and claims nothing about what a
// manager is doing now.
//
// Amendments and restatements are included as stored — several rows may share a cik and quarter
// with different accessions, which is what a corrected filing looks like. They are not labelled
// as amendments because the table carries no flag for it, and inferring one from row order would
// be a guess.
/**
 * LATEST INSTITUTIONAL ACTIVITY — position changes across every manager, newest disclosure first.
 *
 * ⚠️ THIS IS THE FUND PAGE'S COMPARISON, WIDENED — NOT A SECOND ENGINE. The position key is
 * `cusip|putCall` and the dead band is the same 0.1%, both imported from institutions-activity
 * rather than restated, so the feed and a fund's own New/Increased/Reduced/Closed lists cannot
 * drift into disagreeing about the same filing.
 *
 * ⚠️ AND IT DOES NOT COMPARE 18 MILLION HOLDINGS. Measured while building it:
 *   · resolving quarter pairs with a correlated `(SELECT max(quarter) … < x)` subquery: 14,227ms
 *   · the same answer from lag() over a window on fund_filings (67k rows):        ~430ms
 *   · handing those pairs to the holdings join via unnest(), so the 18M-row table is driven by
 *     its (cik, quarter) index instead of scanned:                                 ~200ms
 * ~600ms cold, behind the route's existing hour-long CDN cache, so it runs once per cache period
 * and never per reader. No N+1, no per-row query, no provider call.
 */
export async function latestActivity({ windowDays = 45, maxPairs = 30, perManager = 3, limit = 60, cutoff = null } = {}) {
  // 1. WHICH DISCLOSURES ARE NEW, and what does each one supersede.
  //    DISTINCT ON (cik, filed_date) with quarter DESC: a manager back-filing eight quarters in
  //    one submission has disclosed ONE current position, not eight events.
  const { rows: pairRows } = await db.execute(sql`
    with ranked as (
      select cik, quarter, filed_date, accession,
             lag(quarter) over (partition by cik order by quarter) as prev_quarter
        from ${ffRel(cutoff)} ff
    )
    select distinct on (cik, filed_date) cik, quarter, filed_date, accession, prev_quarter
      from ranked
     -- ⚠️ ::int ON THE PARAMETER, NOT JUST THE NUMBER. Inlined as a literal this reads fine, but
     -- every value through drizzle arrives as a placeholder of UNKNOWN type, and subtracting an
     -- unknown from a date is ambiguous to Postgres — so the query reads fine, runs fine against
     -- an inlined literal, and throws only on the deployed route. Same shape of trap as the array
     -- binding above: correct-looking SQL that fails only once it is actually bound.
     where filed_date >= (select max(filed_date) - ${windowDays}::int from ${ffRel(cutoff)} ff2)
       and prev_quarter is not null
     order by cik, filed_date, quarter desc`);

  const pairs = (pairRows ?? [])
    .sort((a, b) => String(b.filed_date).localeCompare(String(a.filed_date)))
    .slice(0, maxPairs);
  if (!pairs.length) return [];

  // 2. COMPARE ONLY THOSE PAIRS.
  //    ⚠️ AGGREGATED TO THE POSITION KEY FIRST. fund_holdings is unique on
  //    (cik, quarter, cusip, class, put_call), so one security can occupy several rows. Joining
  //    raw rows on cusip alone produced the same ticker twice for one manager with contradictory
  //    verdicts — a live example showed AAPL as both REDUCED and INCREASED. Summing to
  //    (cusip, put_call) is one row per real position, which is what the fund page's Map does.
  const { rows } = await db.execute(sql`
    -- ⚠️ A VALUES LIST BUILT WITH sql.join, NOT unnest() OVER BOUND ARRAYS. The array form reads
    -- naturally and works against the raw driver, but drizzle's sql template does not bind a JS
    -- array as a Postgres array — it expands to a parameter list, and the query 500s in
    -- production while passing locally. Exactly the trap that took /api/health down once before
    -- (a JS array bound into any()). Each value is still a placeholder, so this is parameterised,
    -- not interpolated.
    with p(cik, quarter, prev_quarter, filed_date, accession) as (
      values ${sql.join(pairs.map((x) => sql`(${x.cik}::text, ${x.quarter}::date, ${x.prev_quarter}::date, ${x.filed_date}::date, ${x.accession}::text)`), sql`, `)}
    ),
    cur as (
      select p.cik, p.quarter, p.filed_date, p.accession, h.cusip, h.put_call,
             max(h.ticker) as ticker, max(h.issuer) as issuer,
             sum(h.shares) as shares, sum(h.value) as value
        from p join fund_holdings h on h.cik = p.cik and h.quarter = p.quarter
       where h.ticker is not null
       group by p.cik, p.quarter, p.filed_date, p.accession, h.cusip, h.put_call
    ),
    prv as (
      select p.cik, p.quarter as cq, p.filed_date, p.accession, h.cusip, h.put_call,
             max(h.ticker) as ticker, max(h.issuer) as issuer,
             sum(h.shares) as shares, sum(h.value) as value
        from p join fund_holdings h on h.cik = p.cik and h.quarter = p.prev_quarter
       where h.ticker is not null
       group by p.cik, p.quarter, p.filed_date, p.accession, h.cusip, h.put_call
    ),
    joined as (
      select coalesce(c.cik, v.cik) as cik,
             coalesce(c.quarter, v.cq) as quarter,
             -- ⚠️ COALESCED FROM BOTH SIDES. An EXITED position exists only on the prior side, so
             -- taking the disclosure date from the cur side alone left it null, and a null sorted to the
             -- TOP of a filed_date DESC feed, putting exits above today's news.
             coalesce(c.filed_date, v.filed_date) as filed_date,
             coalesce(c.accession, v.accession) as accession,
             coalesce(c.ticker, v.ticker) as ticker,
             coalesce(c.issuer, v.issuer) as issuer,
             coalesce(c.put_call, v.put_call) as put_call,
             c.shares as cur_shares, v.shares as prev_shares,
             coalesce(c.value, v.value) as value
        from cur c full outer join prv v
          on v.cik = c.cik and v.cusip = c.cusip and v.put_call = c.put_call
    ),
    -- The same dead band the fund page applies, expressed once here and asserted in the suite.
    classed as (
      select j.*, case
               when prev_shares is null then 'NEW'
               when cur_shares is null then 'EXITED'
               when cur_shares > prev_shares * 1.001 then 'INCREASED'
               when cur_shares < prev_shares * 0.999 then 'REDUCED'
             end as action
        from joined j
    ),
    -- No single filer may own the feed: a manager contributes its largest few moves.
    ranked as (
      select c.*, row_number() over (partition by c.cik order by coalesce(c.value, 0) desc) as rn
        from classed c where c.action is not null and c.filed_date is not null
    )
    select r.ticker, r.issuer, r.cik, r.put_call, r.cur_shares, r.prev_shares, r.value,
           r.quarter::text as quarter, r.filed_date::text as filed_date, r.accession, r.action,
           i.name, i.slug
      from ranked r join institutions i on i.cik = r.cik
     where r.rn <= ${perManager}::int
       and i.name is not null and trim(i.name) <> '' and i.slug is not null
     order by r.filed_date desc, coalesce(r.value, 0) desc
     limit ${limit}`);

  return (rows ?? []).map((r) => ({
    ticker: r.ticker,
    company: r.issuer,
    manager: r.name,
    managerUrl: `/institutions/${r.slug}`,
    action: r.action,
    putCall: r.put_call || null,
    prevShares: r.prev_shares == null ? null : Number(r.prev_shares),
    shares: r.cur_shares == null ? null : Number(r.cur_shares),
    value: r.value == null ? null : Number(r.value),
    // ⚠️ TWO DATES, EACH UNDER ITS OWN NAME, NEVER INTERCHANGED. `disclosed` is when it became
    // public; `quarterEnd` is the period it describes.
    disclosed: r.filed_date,
    quarterEnd: r.quarter,
    accession: r.accession,
    filingUrl: r.accession
      ? `https://www.sec.gov/Archives/edgar/data/${r.cik}/${String(r.accession).replace(/-/g, '')}/${r.accession}-index.htm`
      : null,
    tickerUrl: r.ticker ? `/ticker/${encodeURIComponent(r.ticker)}` : null,
  }));
}
