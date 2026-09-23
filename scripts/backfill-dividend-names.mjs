// RESOLVE MISSING SECURITY NAMES FOR THE DIVIDEND CALENDAR.
//
//   node --env-file=.env.local --experimental-loader ./scripts/ext-resolve-loader.mjs \
//     scripts/backfill-dividend-names.mjs [--apply] [--limit=N]
//
// Writes into security_identity — the table that already exists to hold "one canonical display
// name per ticker" — so the calendar picks the names up through the join it ALREADY performs.
// No query changes, no new table, no per-request vendor call: the page reads the database.
//
// ── WHY NOT THE SECURITY MASTER ─────────────────────────────────────────────
//
// ⚠️ /tiingo/fundamentals/meta IS CONTAMINATED BY RECYCLED TICKERS AND MUST NOT BE USED FOR NAMES.
// Measured against the 1,013 unnamed calendar tickers it resolves 3, and one of those three is
// wrong in the most dangerous way:
//
//     JAVA  master says "SUN MICROSYSTEMS INC."   (defunct since 2010)
//     JAVA  actually is "JPMORGAN ACTIVE VALUE ETF"
//
// A ticker outliving its issuer is exactly the identity contamination that must never reach a row.
// The per-symbol endpoint returns the CURRENT listing for the symbol and gets JAVA right, so that
// is what this uses — one request per unnamed ticker, once, offline. It is not an N+1 on the
// request path; the calendar never calls a vendor at all.

import { db } from '../src/lib/db.js';
import { securityIdentity } from '../src/lib/schema.js';
import { sql } from 'drizzle-orm';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 2000;
const TOKEN = process.env.TIINGO_API_KEY;
const L = (s = '') => console.log(s);

if (!TOKEN) { console.error('TIINGO_API_KEY required'); process.exit(2); }

// ⚠️ ONLY TICKERS THE CALENDAR ACTUALLY SHOWS. The stored feed is global — 13,970 unnamed tickers
// overall, mostly foreign lines and fund classes the calendar already excludes with `covered`.
// Resolving those would be thousands of requests for rows no customer can see.
const res = await db.execute(sql`
  select distinct d.ticker, coalesce(m.asset_type,'(unclassified)') as asset_type
    from dividend_events d
    join screener_stocks   s on s.ticker = d.ticker
    left join screener_meta     m on m.ticker = d.ticker
    left join security_identity i on i.ticker = d.ticker
   where coalesce(s.company, i.name) is null
   order by 1
   limit ${LIMIT}`);
const targets = res.rows ?? res;
L(`unnamed tickers on the customer-facing calendar: ${targets.length}${APPLY ? '' : '   (DRY RUN — pass --apply to write)'}`);

// ⚠️ A NAME MUST LOOK LIKE A NAME. The guard is deliberately dumb: anything that is merely the
// ticker back again, or an error string, or empty, is refused rather than written — a wrong name
// is worse than the "—" it would replace.
const usable = (name, ticker) => {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  if (s.length < 2 || s.length > 120) return false;
  if (s.toUpperCase() === String(ticker).toUpperCase()) return false;
  if (/^(n\/?a|none|null|unknown|error|not found)$/i.test(s)) return false;
  return true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let resolved = 0, refused = 0, failed = 0;
const examples = [], refusals = [];
const rows = [];

for (let i = 0; i < targets.length; i++) {
  const { ticker, asset_type: kind } = targets[i];
  try {
    const r = await fetch(`https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}?token=${TOKEN}`,
      { headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    if (!r.ok) { failed += 1; if (refusals.length < 6) refusals.push(`${ticker} [${kind}] — HTTP ${r.status}`); continue; }
    const j = await r.json();
    if (!usable(j?.name, ticker)) {
      refused += 1;
      if (refusals.length < 6) refusals.push(`${ticker} [${kind}] — name "${j?.name ?? ''}" refused`);
      continue;
    }
    const name = String(j.name).trim().replace(/\s+/g, ' ');
    rows.push({ ticker, name, source: 'provider' });
    resolved += 1;
    if (examples.length < 10) examples.push(`${ticker.padEnd(8)} [${String(kind).padEnd(13)}] -> ${name}`);
  } catch { failed += 1; }
  // Gentle on the provider; this is a one-off backfill, not a hot path.
  if (i % 25 === 24) await sleep(250);
  if (i % 200 === 199) L(`  …${i + 1}/${targets.length}`);
}

L(`\nresolved: ${resolved}   refused (unusable name): ${refused}   failed: ${failed}`);
L('\nexamples recovered:');
examples.forEach((e) => L(`  ${e}`));
if (refusals.length) { L('\nexamples deliberately LEFT UNRESOLVED:'); refusals.forEach((e) => L(`  ${e}`)); }

if (APPLY && rows.length) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(securityIdentity).values(rows.slice(i, i + CHUNK))
      // ⚠️ DO NOT OVERWRITE A STRONGER SOURCE. form4 / registrant / sec_ticker names are derived
      // from filings the issuer made about itself; a provider name is the weakest of the four and
      // must never displace one of them.
      .onConflictDoUpdate({
        target: securityIdentity.ticker,
        set: { name: sql`excluded.name`, source: sql`excluded.source`, updatedAt: sql`now()` },
        where: sql`security_identity.source = 'provider'`,
      });
  }
  L(`\nwrote ${rows.length} names to security_identity`);
} else if (!APPLY) {
  L('\n(dry run — nothing written)');
}
process.exit(0);
