// scripts/repair-form4-ciks.mjs
//
// Repairs owner_cik / issuer_cik on insider_trades rows the live per-minute parser wrote without
// them, by reading the identifiers back out of the original SEC filing.
//
//   node --env-file=.env.local scripts/repair-form4-ciks.mjs --since=2026-09-11
//   node --env-file=.env.local scripts/repair-form4-ciks.mjs --since=2026-09-11 --limit=50 --dry
//
// ── ⚠️ WHY A SCRIPT AND NOT A RE-INGEST ────────────────────────────────────
//
// Every write path into insider_trades is onConflictDoNothing. Re-ingesting these filings would
// therefore change nothing at all — the rows already exist and the conflict target matches. The
// repair has to be an explicit UPDATE.
//
// ── ⚠️ WHAT IT WILL AND WILL NOT DO ────────────────────────────────────────
//
// It fills NULLs from the filing and nothing else. Every UPDATE carries `AND <column> IS NULL`, so
// a value that already exists cannot be overwritten however the filing parses. It touches no
// economics, no dates, no accession, no ticker and no insider name — only the two identifier
// columns.
//
// ⚠️ AND IT REFUSES TO GUESS AN OWNER. A Form 4 may report several owners on one filing. Our schema
// holds one owner per row, so attributing the first <rptOwnerCik> to every row of a joint filing
// would staple one person's identifier to another person's transactions. Where a filing has one
// owner, that owner is unambiguous. Where it has several, each row is matched to an owner BY NAME
// and left null if that match is not unique. Unrecovered rows are reported, not filled.

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 30 });

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SINCE = arg('since', '2026-09-11');
const UNTIL = arg('until', null);
const LIMIT = Number(arg('limit', '100000'));
const DRY = process.argv.includes('--dry');
/**
 * Wall-clock budget for one invocation.
 *
 * ⚠️ RESUMABILITY IS THE PREDICATE, NOT A SAVED CURSOR. The work queue is "filings that still have
 * a null CIK", so stopping at the budget and starting again simply re-selects what is left. There
 * is nothing to checkpoint and nothing a partial run can corrupt — which is what makes it safe to
 * run a 55,000-filing repair in bounded pieces rather than one three-hour process.
 */
const MAX_MINUTES = Number(arg('max-minutes', '0')) || 0;

// SEC fair access: a declared User-Agent and well under 10 requests a second.
const UA = process.env.SEC_USER_AGENT || 'CatalystPit data-integrity repair (bcoghill88@gmail.com)';
const CONCURRENCY = 5;
const GAP_MS = 750;

// ⚠️ DECODE BEFORE COMPARING. The filing carries raw XML — "WELLS FARGO &amp; COMPANY/MN" — while
// our stored executive was decoded at ingest to "WELLS FARGO & COMPANY/MN". Normalising without
// decoding first turns the ampersand into the token "AMP" on one side and nothing on the other, so
// a name that matches exactly fails to match and a recoverable owner is abandoned as ambiguous.
// That cost exactly one row on the first run, and would cost more on joint institutional filings,
// which are where multi-owner Form 4s mostly come from.
const decodeEntities = (s) => String(s || '')
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#0*39;/g, "'").replace(/&nbsp;/gi, ' ');
const norm = (s) => decodeEntities(s).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** The full submission text file, derived from the index URL we already store. Deterministic. */
function submissionUrl(filingUrl) {
  if (!filingUrl) return null;
  const m = /^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[\w-]+)-index\.html?$/.exec(filingUrl);
  return m ? `${m[1]}.txt` : null;
}

async function fetchFiling(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/plain' } });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
      if (!r.ok) return { ok: false, reason: `http_${r.status}` };
      return { ok: true, body: await r.text() };
    } catch (e) {
      if (attempt === 2) return { ok: false, reason: e.message };
      await new Promise((s) => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return { ok: false, reason: 'retries_exhausted' };
}

/** issuerCik plus every (name, cik) owner pair the filing reports. */
function parseCiks(xml) {
  const issuerCik = xml.match(/<issuerCik>([\s\S]*?)<\/issuerCik>/)?.[1]?.trim().replace(/^0+/, '') || null;
  const ciks = [...xml.matchAll(/<rptOwnerCik>([\s\S]*?)<\/rptOwnerCik>/g)].map((m) => m[1].trim().replace(/^0+/, ''));
  const names = [...xml.matchAll(/<rptOwnerName>([\s\S]*?)<\/rptOwnerName>/g)].map((m) => m[1].trim());
  const owners = ciks.map((cik, i) => ({ cik, name: names[i] ?? null })).filter((o) => o.cik);
  return { issuerCik, owners };
}

(async () => {
  console.log(`[ciks] repairing filings on/after ${SINCE}${DRY ? ' (DRY RUN — no writes)' : ''}`);

  const filings = await sql`
    SELECT accession, min(filing_url) AS filing_url, count(*)::int AS rows,
           count(*) FILTER (WHERE owner_cik IS NULL)::int  AS need_owner,
           count(*) FILTER (WHERE issuer_cik IS NULL)::int AS need_issuer
      FROM insider_trades
     WHERE filing_date >= ${SINCE}::date
       AND (${UNTIL}::date IS NULL OR filing_date < ${UNTIL}::date)
       AND (owner_cik IS NULL OR issuer_cik IS NULL)
     GROUP BY accession
     ORDER BY accession
     LIMIT ${LIMIT}`;
  console.log(`[ciks] ${filings.length} filings to inspect`);

  const stat = {
    filings: filings.length, fetched: 0, failed: 0, noUrl: 0,
    issuerSet: 0, ownerSet: 0, ownerAmbiguous: 0, ownerMissing: 0, issuerMissing: 0,
  };

  const startedAt = Date.now();
  let stoppedEarly = false;
  for (let i = 0; i < filings.length; i += CONCURRENCY) {
    if (MAX_MINUTES && Date.now() - startedAt > MAX_MINUTES * 60_000) { stoppedEarly = true; break; }
    const batch = filings.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (f) => {
      const url = submissionUrl(f.filing_url);
      if (!url) { stat.noUrl++; return; }
      const res = await fetchFiling(url);
      if (!res.ok) { stat.failed++; return; }
      stat.fetched++;
      const { issuerCik, owners } = parseCiks(res.body);
      if (!issuerCik) stat.issuerMissing++;
      if (!owners.length) stat.ownerMissing++;
      if (DRY) return;

      // ⚠️ ISSUER IS A PROPERTY OF THE FILING, so one value covers every row of it. NULL-guarded.
      if (issuerCik) {
        const r = await sql`UPDATE insider_trades SET issuer_cik = ${issuerCik}
                             WHERE accession = ${f.accession} AND issuer_cik IS NULL`;
        stat.issuerSet += r.count;
      }

      const distinct = [...new Set(owners.map((o) => o.cik))];
      if (distinct.length === 1) {
        // Unambiguous: one reporting owner on this filing.
        const r = await sql`UPDATE insider_trades SET owner_cik = ${distinct[0]}
                             WHERE accession = ${f.accession} AND owner_cik IS NULL`;
        stat.ownerSet += r.count;
      } else if (distinct.length > 1) {
        // ⚠️ JOINT FILING. Match each row's stored executive name to one reported owner; anything
        // that does not resolve to exactly one owner is left null rather than guessed.
        const rows = await sql`SELECT id, executive FROM insider_trades
                                WHERE accession = ${f.accession} AND owner_cik IS NULL`;
        for (const row of rows) {
          const hits = owners.filter((o) => o.name && norm(o.name) === norm(row.executive));
          const uniq = [...new Set(hits.map((h) => h.cik))];
          if (uniq.length === 1) {
            const r = await sql`UPDATE insider_trades SET owner_cik = ${uniq[0]}
                                 WHERE id = ${row.id} AND owner_cik IS NULL`;
            stat.ownerSet += r.count;
          } else {
            stat.ownerAmbiguous++;
          }
        }
      }
    }));
    await new Promise((s) => setTimeout(s, GAP_MS));
    if ((i / CONCURRENCY) % 20 === 0) {
      process.stdout.write(`\r[ciks] ${Math.min(i + CONCURRENCY, filings.length)}/${filings.length} filings · issuer ${stat.issuerSet} · owner ${stat.ownerSet} · failed ${stat.failed}   `);
    }
  }

  console.log(`\n[ciks] done ${JSON.stringify(stat)}`);

  const [after] = await sql`
    SELECT count(*)::int rows,
           count(owner_cik)::int with_owner,
           count(issuer_cik)::int with_issuer
      FROM insider_trades WHERE filing_date >= ${SINCE}::date`;
  console.log(`[ciks] period coverage now: ${after.with_owner}/${after.rows} owner_cik · ${after.with_issuer}/${after.rows} issuer_cik`);
  await sql.end();
})();
