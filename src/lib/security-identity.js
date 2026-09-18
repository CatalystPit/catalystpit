// BUILDING AND READING THE SECURITY MASTER.
//
// The precedence lives in security-identity.mjs and is tested without a database. This file is the
// plumbing: it gathers the candidate names our tables and SEC's ticker file already hold, hands them
// to the resolver, and stores one row per ticker.
//
// Refreshed on the nightly screener cron, BEFORE the screener rebuild, so the rebuild's company
// column is filled from the master rather than from its own narrower derivation.

import { sql } from 'drizzle-orm';
import { db } from './db';
import { buildIdentities, resolveFilerName, parseSecTickerFile } from './security-identity.mjs';

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };

/**
 * ticker -> name, from filings, with the dominant-name tie-break applied per ticker.
 *
 * Exported because the screener rebuild needs exactly this when the master has not been built yet,
 * and two copies of a tie-break rule is how the two answers drift apart.
 */
export async function filerNameMap(table, dateCol) {
  // Grouped rather than `distinct on`: the resolver needs to know HOW MANY filings back each name,
  // which is what breaks a same-date tie in favour of the issuer over a holder filing against it.
  const res = await db.execute(sql`
    select ticker, company, max(${dateCol}) as d, count(*)::int as n
      from ${table}
     where ticker is not null and company is not null and company <> ''
     group by ticker, company`);
  const byTicker = new Map();
  for (const r of (res.rows ?? res)) {
    const t = String(r.ticker).toUpperCase();
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t).push({ name: r.company, date: r.d, count: r.n });
  }
  const out = new Map();
  for (const [t, rows] of byTicker) {
    const name = resolveFilerName(rows);
    if (name) out.set(t, name);
  }
  return out;
}

/**
 * SEC's standing ticker → registrant-title list.
 *
 * Fails SOFT. This is somebody else's file over the public internet, fetched inside a nightly
 * rebuild; an outage must cost us the funds' names for a night, not the rebuild.
 */
async function secTickerNames(fetchImpl) {
  try {
    const r = await fetchImpl(SEC_TICKERS_URL, { headers: SEC_HEADERS, cache: 'no-store' });
    if (!r.ok) return new Map();
    return new Map(parseSecTickerFile(await r.json()).map((x) => [x.ticker, x.name]));
  } catch {
    return new Map();
  }
}

/** The vendor's own security name, captured by the ticker-details backfill. Lowest precedence. */
async function providerNames() {
  try {
    const res = await db.execute(sql`select ticker, name from screener_meta where name is not null and name <> ''`);
    return new Map((res.rows ?? res).map((r) => [String(r.ticker).toUpperCase(), r.name]));
  } catch {
    // The column is added by migration 0030; a database that has not taken it yet still builds.
    return new Map();
  }
}

/**
 * Rebuild the security master.
 *
 * Idempotent, and safe to run while anything else is writing: every row is an upsert keyed on the
 * ticker, and a ticker no source can name is left alone rather than blanked — losing a name we
 * already print because SEC had a bad night is not an improvement.
 */
export async function refreshSecurityIdentity({ fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  const [form4, registrant, sec_ticker, provider] = await Promise.all([
    filerNameMap(sql`insider_trades`, sql`filing_date`),
    filerNameMap(sql`eightk_filings`, sql`filed_at`),
    secTickerNames(fetchImpl),
    providerNames(),
  ]);

  const rows = buildIdentities({ form4, registrant, sec_ticker, provider });
  if (!rows.length) return { ok: false, tickers: 0, reason: 'no candidate names', ms: Date.now() - startedAt };

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = batch.map((r) => sql`(${r.ticker}, ${r.name}, ${r.source}, now())`);
    await db.execute(sql`
      insert into security_identity (ticker, name, source, updated_at)
      values ${sql.join(values, sql`, `)}
      on conflict (ticker) do update set
        name = excluded.name, source = excluded.source, updated_at = excluded.updated_at`);
  }

  const bySource = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
  return { ok: true, tickers: rows.length, bySource, ms: Date.now() - startedAt };
}

/**
 * The whole map, for the screener rebuild.
 *
 * Returns null when the table has not been built, so the caller falls back to deriving names itself
 * rather than silently dropping every company name off the screener — the same contract
 * readTickerIssuer() has, for the same reason.
 */
export async function readSecurityIdentity() {
  try {
    const res = await db.execute(sql`select ticker, name from security_identity where name is not null and name <> ''`);
    const rows = res.rows ?? res;
    return rows.length ? new Map(rows.map((r) => [String(r.ticker).toUpperCase(), r.name])) : null;
  } catch {
    return null;
  }
}
