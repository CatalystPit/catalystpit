// THE PUBLIC VIEW MODEL for server-rendered ticker pages, and the security boundary for ticker SSR.
//
// Pure functions: no database, no network, no imports, no environment. That is deliberate — it means
// the whitelist can be tested directly in plain Node, and it means nothing in this file can reach out
// and pick up something it should not be publishing.
//
// WHY A WHITELIST AND NOT A DELETE-LIST. /api/wire used to spread the decorated row and delete a
// handful of publisher fields; audited live, that shipped nine pipeline fields nobody had decided to
// publish, because every column added to primary_events appeared in the public JSON automatically.
// The same mistake in SSR is worse: an API response is fetched, but server-rendered HTML is crawled,
// cached and archived. So every object below is CONSTRUCTED FIELD BY FIELD. There is no spread of a
// database row anywhere in this file, and adding a public field has to be a decision someone makes.
//
// What must never appear in the output, and cannot, because nothing reads it:
//   source, source_name, source_kind, source_type, source_uid, source_headline, feed ids and urls,
//   raw, facts, seq, cluster_id, norm_hash, fact_key, fact_sig, content_hash, display_hash,
//   event_key, entity, first_seen_at, last_seen_at, received_at, enriched_at, enrich_attempts,
//   headline_status, pipeline_status, display_ready, importance, noise taxonomy, conviction and every
//   other internal score, cusip, cik, accession, internal row ids, table names, vendor identifiers.

// ── coercion helpers ────────────────────────────────────────────────────────
// Postgres hands back numerics as strings and dates in whatever shape the driver chose. Everything
// public is normalised here so a consumer never has to guess, and a NaN never renders as a fact.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => { const n = num(v); return n === null ? null : Math.trunc(n); };
const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** A calendar date as YYYY-MM-DD, or null. Never a timestamp, never a locale rendering. */
const ymd = (v) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

/** An instant as a UTC ISO string, or null. */
const iso = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// A filing link is public attribution we show ON PURPOSE — an SEC filing must link to the filing.
// It is also the one place a URL crosses into the public model at all, so it is checked rather than
// trusted: anything that is not an https sec.gov link is dropped instead of published. A stray
// vendor URL that ever landed in one of these columns cannot get out through here.
const secUrl = (v) => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && /(^|\.)sec\.gov$/i.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
};

// 8-K item numbers are public EDGAR taxonomy taken from the filing itself ("2.02", "5.02"). Parsed
// against a strict shape rather than passed through, so the column can never emit free text.
const itemCodes = (v) => {
  const s = str(v);
  if (!s) return [];
  return [...new Set((s.match(/\b\d{1,2}\.\d{2}\b/g) || []))];
};

// The disclosed congressional amount BAND, exactly as filed ("$1,001 - $15,000"). The parsed
// min/mid/max columns beside it are our own derivation and are not published.
const amountBand = (v) => {
  const s = str(v);
  return s && /^[\s$\d,.–—+-]+$/.test(s) ? s : null;
};

// ── public sub-models ───────────────────────────────────────────────────────

/**
 * Company identity. Facts a filing or a listing already states.
 *
 * A COMPANY NAME IS UNIQUE; AN INDUSTRY DESCRIPTION IS NOT. Measured against the live screener,
 * 2,719 of the 5,701 rows that carry a company value — 47.7% — hold an SIC industry description
 * instead: 526 tickers say "BLANK CHECKS", 229 say "PHARMACEUTICAL PREPARATIONS", 147 say "REAL
 * ESTATE INVESTMENT TRUSTS". Publishing those as company names would put a false fact in a crawled
 * <h1> for thousands of pages, so a name shared by more than one ticker is not treated as a name.
 * `name_shared_by` comes from the query; when it is absent the value is taken at face value.
 *
 * The rest of the identity survives regardless — exchange, sector and market cap are still true
 * about the security even when we cannot state who it is.
 */
function identityOf(row) {
  if (!row) return null;
  const shared = int(row.name_shared_by);
  // TWO INDEPENDENT REFUSALS, both exact.
  //  - a value that is character-for-character its own industry is a classification that leaked into
  //    a name column (ZTS read "PHARMACEUTICAL PREPARATIONS", XOM "PETROLEUM REFINING");
  //  - a value shared by more than one ticker cannot be any single company's name.
  // The ingestion bug behind both is fixed at the root, so neither should ever fire again. They stay
  // because this is the last gate before a name reaches crawlable HTML, and neither needs a
  // vocabulary, a heuristic or an import to be certain of its answer.
  const isOwnIndustry = row.company != null && row.industry != null
    && String(row.company) === String(row.industry);
  const companyName = isOwnIndustry || (shared !== null && shared > 1) ? null : str(row.company);
  return {
    symbol: str(row.ticker),
    companyName,
    exchange: str(row.exchange),
    sector: str(row.sector),
    industry: str(row.industry),
    country: str(row.country),
    assetType: str(row.asset_type),
    marketCap: num(row.market_cap),
  };
}

/** Last COMPLETED daily close, always carrying its own date. Never presented as a live quote. */
function marketOf(row) {
  if (!row) return null;
  const asOf = ymd(row.date);
  const lastClose = num(row.close);
  if (!asOf || lastClose === null) return null;
  return { asOf, lastClose, volume: num(row.volume) };
}

/** One insider transaction, as the Form 4 states it. No conviction score, no performance columns. */
function insiderTrade(row) {
  return {
    transactionDate: ymd(row.transaction_date),
    filedDate: ymd(row.filing_date),
    person: str(row.executive),
    role: str(row.title),
    action: str(row.action),
    shares: num(row.shares),
    pricePerShare: num(row.price_per_share),
    value: num(row.total_value),
    // A checkbox on the form itself: was this a pre-arranged 10b5-1 plan sale? Public, and the
    // difference between "the CFO sold" and "a scheduled plan sold".
    planned10b5_1: row.rule_10b5_1 === true ? true : row.rule_10b5_1 === false ? false : null,
    filingUrl: secUrl(row.filing_url),
  };
}

/**
 * Rolling insider window. Counts and a net, not a signal.
 *
 * Published under the key `window`, never `summary`: `summary` is a primary_events column that must
 * never appear in public output, and a forbidden name is easier to enforce absolutely than
 * case-by-case.
 */
function insiderWindow(row, windowDays) {
  if (!row) return null;
  const trades = int(row.trades);
  if (!trades) return null;
  return {
    windowDays,
    trades,
    buys: int(row.buys) ?? 0,
    sells: int(row.sells) ?? 0,
    netValue: num(row.net),
    latestFilingDate: ymd(row.latest),
  };
}

/** One congressional transaction, as disclosed. */
function congressTrade(row) {
  return {
    transactionDate: ymd(row.transaction_date),
    disclosedDate: ymd(row.disclosure_date),
    member: str(row.representative),
    // The public /politicians/[slug] route identifier. Ours, but it is a URL, not internal state.
    memberSlug: str(row.member_slug),
    party: str(row.party),
    state: str(row.state),
    chamber: str(row.chamber),
    action: str(row.action),
    amountRange: amountBand(row.amount_range),
  };
}

/**
 * Institutional ownership, AGGREGATE ONLY.
 *
 * Individual fund_holdings rows are never published here and must not be. That table is 9.2M rows of
 * CUSIP-resolved 13F work; per-fund positions on a crawlable page would hand the resolved dataset to
 * anyone who wanted it. A holder count, a total and an ownership percentage say everything a reader
 * needs and reveal nothing about how they were derived.
 */
function institutionsOf(row) {
  if (!row) return null;
  const holders = int(row.filer_count);
  if (!holders) return null;
  return {
    asOfQuarter: ymd(row.as_of_quarter),
    holders,
    shares: num(row.inst_shares),
    value: num(row.inst_value),
    ownershipPercent: num(row.ownership_pct),
  };
}

/**
 * A Catalyst Pit event, rebuilt from two fields.
 *
 * THE HIGHEST-RISK MAPPING IN THE FILE. primary_events carries 35 columns, of which more than twenty
 * describe our pipeline rather than the world: which feed found it, how many found it, when we
 * received it, how it was deduped, how it was enriched, how it scored. A crawler should be able to
 * learn that this company had this news on this date. It should not be able to learn anything about
 * how we came to know.
 *
 * `summary` is excluded on purpose and not merely unused: audited against live rows it carried
 * "according to a document seen by Bloomberg", "(Source: Bloomberg)" and in one case a slab of a
 * publisher's raw markup. `category` is excluded too — it is our taxonomy, and the headline and the
 * date are what the spec needs. `original_url` and `canonical_url` point at the publisher and are
 * exactly what the wire hardening removed from the public payload.
 */
function newsItem(row) {
  const headline = str(row.headline);
  if (!headline) return null;
  return { headline, publishedAt: iso(row.published_at) };
}

/** An 8-K, as EDGAR states it, linking to the filing. Our `material` classification is not published. */
function filingItem(row) {
  const filingUrl = secUrl(row.filing_url);
  const reportDate = ymd(row.report_date);
  if (!filingUrl && !reportDate) return null;
  return { reportDate, filedAt: iso(row.filed_at), items: itemCodes(row.items), filingUrl };
}

/** FINRA short-interest snapshot, dated. */
function shortInterestOf(row) {
  if (!row) return null;
  const shares = num(row.short_int_shares);
  if (shares === null) return null;
  return {
    settlementDate: ymd(row.settlement_date),
    shares,
    daysToCover: num(row.days_to_cover),
    avgDailyVolume: num(row.avg_daily_volume),
  };
}

// ── assembly ────────────────────────────────────────────────────────────────

/**
 * Build the public view model from raw rows.
 *
 * `symbol` must already be the normalised uppercase form (see ticker-symbol.mjs). Every sub-model is
 * independent: a ticker with insider data and nothing else produces a perfectly valid model with
 * nulls and empty arrays elsewhere, because that is the honest description of what we hold.
 */
export function buildPublicView(symbol, raw = {}) {
  const insiders = (raw.insiderRecent || []).map(insiderTrade);
  const congress = (raw.congress || []).map(congressTrade);
  const news = (raw.news || []).map(newsItem).filter(Boolean);
  const filings = (raw.filings || []).map(filingItem).filter(Boolean);
  const institutions = institutionsOf(raw.institutions);
  const shortInterest = shortInterestOf(raw.shortInterest);
  const market = marketOf(raw.candle);

  return {
    symbol,
    identity: identityOf(raw.identity),
    market,
    insiders: { recent: insiders, window: insiderWindow(raw.insiderSummary, raw.insiderWindowDays ?? 180) },
    congress: { recent: congress },
    institutions,
    news: { recent: news },
    filings: { recent: filings },
    shortInterest,
    // Dataset presence, as counts. This is what an eligibility rule and a "what do we have on this
    // company" header both need, and it says nothing about where any of it came from.
    coverage: {
      insiders: insiders.length,
      congress: congress.length,
      institutions: institutions ? institutions.holders : 0,
      news: news.length,
      filings: filings.length,
      market: market ? 1 : 0,
      shortInterest: shortInterest ? 1 : 0,
    },
  };
}

// US listing venues. Anything else — foreign listings, OTC tiers we do not verify — is not a venue we
// will claim to cover.
const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSEAMERICAN', 'NYSE AMERICAN', 'NYSE MKT']);

/**
 * INTERNAL eligibility state. NOT part of the public view model and never serialized into a page.
 *
 * It returns the INPUTS to an indexability decision, not the decision. The threshold — the audit
 * proposed company name + US exchange + common stock + at least two populated datasets — belongs to
 * the step that actually renders and lists these pages, and hard-coding it here would freeze it
 * before the corpus has been looked at.
 *
 * The separation is the point. Public output is built by buildPublicView and contains finished facts;
 * this describes our own coverage and stays on the server.
 */
export function buildEligibility(view) {
  const id = view.identity;
  const exchange = id?.exchange ? id.exchange.toUpperCase() : null;
  const datasets = {
    insiders: view.coverage.insiders > 0,
    congress: view.coverage.congress > 0,
    institutions: view.coverage.institutions > 0,
    news: view.coverage.news > 0,
    filings: view.coverage.filings > 0,
  };
  return {
    hasIdentity: !!id,
    hasCompanyName: !!id?.companyName,
    exchange,
    isUsExchange: !!exchange && US_EXCHANGES.has(exchange),
    assetType: id?.assetType ?? null,
    isCommonStock: (id?.assetType || '').toUpperCase() === 'STOCK',
    datasets,
    // Counts only the five datasets that carry real editorial weight. A daily close and a short
    // interest row exist for almost everything and would make the count meaningless.
    datasetCount: Object.values(datasets).filter(Boolean).length,
  };
}
