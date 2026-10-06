// MOVE THE ROWS THE CANONICAL PARSER REFUSES OUT OF insider_trades AND INTO insider_quarantine.
//
//   node --env-file=.env.local scripts/repair-form4-price-corruption.mjs [--apply]
//
// Dry run by default. Nothing is written without --apply.
//
// ⚠️ IT RE-PARSES THE FILING FROM EDGAR RATHER THAN TRUSTING THE STORED ROW, and that is the point: the
// repair is whatever the corrected parser now says about the real document, not a value anybody typed
// here. If EDGAR's document has since been amended and the price is now sane, the parser will produce a
// clean row and this script will refuse to remove anything — which is the correct outcome and the reason
// the check is not skipped.
//
// ⚠️ NOTHING IS DELETED WITHOUT BEING PRESERVED FIRST. The row goes into insider_quarantine, with its
// reason, its parsed contents and its source URL, before it leaves insider_trades. A quarantined row is
// still evidence that a real event happened; it is only its PRICE that cannot be trusted, and the
// footnote on this particular filing says what the real price was. Deleting it outright would destroy
// the trail back to the filer's mistake.

import { neon } from '@neondatabase/serverless';
import { parseForm4, validateRow, QUARANTINE_REASONS } from '../src/lib/form4.mjs';

const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv.includes('--apply');

// ⚠️ THE SUB-THRESHOLD CASES, NAMED EXPLICITLY, BECAUSE NO RULE WE HAVE CATCHES THEM.
//
// The bounds in validateRow catch the IMPOSSIBLE. They do not catch the merely absurd, and MYNZ is the
// proof: 643,850 shares filed at $402,000 per share is $258,827,700,000, which sits under MAX_VALUE
// ($500B) while the price sits under MAX_PRICE ($1M). Nothing inside the filing distinguishes it from a
// legitimate BRK.A purchase at $730,000 a share — only knowing what the security actually trades at
// does, and MYNZ has no licensed close for that date at all, so even a market cross-check would have
// missed it.
//
// So these are operator judgements, not a rule, and they are recorded as such: each entry names a
// filing somebody opened on EDGAR and read. The script still re-fetches the document and prints its own
// numbers before acting, so the justification is evidence rather than an assertion in a list — and it
// REFUSES to act if the filing no longer says what the entry claims.
const VERIFIED_AGGREGATE_IN_PRICE_FIELD = [
  {
    accession: '0002105585-26-000003',
    ticker: 'MYNZ',
    // What the filing says, asserted here so the script can check the claim rather than trust it.
    expectPrice: 402000,
    expectShares: 643850,
    note: 'filer placed the aggregate consideration ($402,000) in transactionPricePerShare; '
      + '402000/643850 = $0.62 a share, consistent with the issuer being a sub-dollar security. '
      + 'No footnote, and no licensed close exists for the transaction date to cross-check against, '
      + 'so this was judged by reading the filing.',
  },
];
const UA = 'CatalystPit Research bcoghill88@gmail.com';

// The same narrow failure class the scan uses. A row refused for a bad DATE is a different defect.
const PRICE_CLASS = new Set([
  QUARANTINE_REASONS.ABSURD_PRICE, QUARANTINE_REASONS.ABSURD_VALUE,
  QUARANTINE_REASONS.MALFORMED_PRICE, QUARANTINE_REASONS.VALUE_INCONSISTENT,
  QUARANTINE_REASONS.ABSURD_SHARES, QUARANTINE_REASONS.MALFORMED_SHARES,
]);

// Find the offending rows the same way the scan did, so the two agree by construction.
const candidates = [];
for (const r of await sql`select id, ticker, executive, transaction_code, shares, price_per_share,
    total_value, shares_owned_after, transaction_date, filing_date, accession, filing_url,
    issuer_cik, owner_cik, conviction
  from insider_trades`) {
  const bad = validateRow({
    shares: Number(r.shares), pricePerShare: Number(r.price_per_share),
    totalValue: Number(r.total_value),
    sharesOwnedAfter: r.shares_owned_after == null ? null : Number(r.shares_owned_after),
    transactionDate: r.transaction_date, filingDate: r.filing_date,
    transactionCode: r.transaction_code,
    rawShares: String(r.shares), rawPrice: String(r.price_per_share),
  }, { today: new Date('2100-01-01') });
  if (bad && PRICE_CLASS.has(bad.reason)) candidates.push({ row: r, bad });
}

console.log(`${candidates.length} stored row(s) fail the price/value bounds\n`);

for (const { row, bad } of candidates) {
  console.log(`── ${row.ticker} id=${row.id} ${row.accession}`);
  console.log(`   stored: ${Number(row.shares).toLocaleString()} shares @ `
    + `$${Number(row.price_per_share).toLocaleString()} = $${Number(row.total_value).toLocaleString()}`);
  console.log(`   ${bad.reason}: ${bad.detail}`);

  // ── re-parse from EDGAR ────────────────────────────────────────────────────────────────────────
  const dir = row.accession.replace(/-/g, '');
  const cik = String(row.issuer_cik).replace(/^0+/, '');
  let xmlUrl = null;
  try {
    const idx = await fetch(`https://www.sec.gov/Archives/edgar/data/${cik}/${dir}/`,
      { headers: { 'User-Agent': UA } });
    const html = await idx.text();
    const m = [...html.matchAll(/href="([^"]*\.xml)"/g)].map((x) => x[1])
      // The ownership document, not the index or an exhibit.
      .filter((h) => !/index/i.test(h));
    xmlUrl = m.length ? new URL(m[0], 'https://www.sec.gov').toString() : null;
  } catch (e) {
    console.log(`   SKIPPED: could not list the filing directory (${e.message})`);
    continue;
  }
  if (!xmlUrl) { console.log('   SKIPPED: no ownership XML found in the filing directory'); continue; }

  await new Promise((r) => setTimeout(r, 400));   // SEC fair-access pacing
  const xml = await (await fetch(xmlUrl, { headers: { 'User-Agent': UA } })).text();
  const out = parseForm4(xml, {
    accession: row.accession, filingDate: row.filing_date, indexUrl: row.filing_url, docUrl: xmlUrl,
  });

  console.log(`   re-parsed from ${xmlUrl}`);
  console.log(`   → ${out.rows.length} servable row(s), ${out.quarantine.length} quarantined`);

  // ⚠️ THE GUARD ON THE REPAIR ITSELF. Only remove the row when the corrected parser agrees it is
  // unservable. If EDGAR now yields a clean row, the filer amended it and this is not ours to delete.
  const q = out.quarantine.find((x) => PRICE_CLASS.has(x.reason));
  if (!q) {
    console.log('   REFUSING to remove: the corrected parser does not reject this filing any more.');
    console.log('   The filing may have been amended; re-ingest it through the normal path instead.');
    continue;
  }
  console.log(`   corrected parser says: ${q.reason} — ${q.detail}`);

  if (!APPLY) { console.log('   (dry run — pass --apply to move it)\n'); continue; }

  // Preserve first, delete second. Order matters: a crash between the two must leave the row in
  // insider_trades rather than nowhere.
  await sql`insert into insider_quarantine
    (accession, issuer_cik, owner_cik, ticker, filing_date, reason, detail, parsed, raw_url, resolved_note)
    values (${row.accession}, ${row.issuer_cik}, ${row.owner_cik}, ${row.ticker}, ${row.filing_date},
            ${q.reason}, ${String(q.detail).slice(0, 500)},
            ${JSON.stringify({ storedRow: row, reparsed: q })}::jsonb, ${xmlUrl},
            ${'moved out of insider_trades by repair-form4-price-corruption.mjs; the filer placed the '
              + 'aggregate consideration in transactionPricePerShare'})`;
  const gone = await sql`delete from insider_trades where id = ${row.id} returning id`;
  console.log(`   MOVED: quarantined and deleted id=${gone[0]?.id}\n`);
}

// ── ⚠️ PASS 2: the explicitly verified sub-threshold filings ───────────────────────────────────
const extraTickers = [];
for (const v of VERIFIED_AGGREGATE_IN_PRICE_FIELD) {
  const stored = await sql`select id, ticker, shares, price_per_share, total_value, filing_date,
      accession, filing_url, issuer_cik, owner_cik
    from insider_trades where accession = ${v.accession}`;
  if (!stored.length) { console.log(`── ${v.ticker} ${v.accession}: not in insider_trades (already repaired?)\n`); continue; }

  for (const row of stored) {
    console.log(`── ${row.ticker} id=${row.id} ${row.accession}  [explicitly verified]`);
    console.log(`   stored: ${Number(row.shares).toLocaleString()} shares @ `
      + `${Number(row.price_per_share).toLocaleString()} = ${Number(row.total_value).toLocaleString()}`);

    // ⚠️ THE CLAIM IS CHECKED AGAINST THE DOCUMENT. If the filer has since amended the filing, or the
    // entry above is simply wrong, this refuses rather than deleting a row on the strength of a list.
    const dir = row.accession.replace(/-/g, "");
    const cik = String(row.issuer_cik).replace(/^0+/, "");
    let xmlUrl = null, xml = null;
    try {
      const idx = await fetch(`https://www.sec.gov/Archives/edgar/data/${cik}/${dir}/`,
        { headers: { 'User-Agent': UA } });
      const hrefs = [...(await idx.text()).matchAll(/href="([^"]*\.xml)"/g)].map((x) => x[1])
        .filter((h) => !/index/i.test(h));
      if (hrefs.length) xmlUrl = new URL(hrefs[0], 'https://www.sec.gov').toString();
      if (xmlUrl) {
        await new Promise((r) => setTimeout(r, 400));
        xml = await (await fetch(xmlUrl, { headers: { 'User-Agent': UA } })).text();
      }
    } catch (e) { console.log(`   SKIPPED: could not fetch the filing (${e.message})\n`); continue; }
    if (!xml) { console.log("   SKIPPED: no ownership XML found\n"); continue; }

    const filedPrice = Number(xml.match(/<transactionPricePerShare>\s*<value>([^<]*)<\/value>/)?.[1]);
    const filedShares = Number(xml.match(/<transactionShares>\s*<value>([^<]*)<\/value>/)?.[1]);
    console.log(`   filing says: ${filedShares?.toLocaleString()} shares @ ${filedPrice?.toLocaleString()}`);
    console.log(`   implied per-share if that price is an AGGREGATE: ${(filedPrice / filedShares).toFixed(4)}`);

    if (filedPrice !== v.expectPrice || filedShares !== v.expectShares) {
      console.log(`   REFUSING: the filing no longer matches the verified entry `
        + `(expected ${v.expectShares} @ ${v.expectPrice}). Re-check it by hand.\n`);
      continue;
    }
    if (!APPLY) { console.log("   (dry run — pass --apply to move it)\n"); continue; }

    await sql`insert into insider_quarantine
      (accession, issuer_cik, owner_cik, ticker, filing_date, reason, detail, parsed, raw_url, resolved_note)
      values (${row.accession}, ${row.issuer_cik}, ${row.owner_cik}, ${row.ticker}, ${row.filing_date},
              ${'AGGREGATE_IN_PRICE_FIELD'},
              ${`${filedPrice} filed as price/share on ${filedShares} shares = ${filedPrice * filedShares}`},
              ${JSON.stringify({ storedRow: row, filedPrice, filedShares })}::jsonb, ${xmlUrl},
              ${v.note})`;
    const gone = await sql`delete from insider_trades where id = ${row.id} returning id`;
    extraTickers.push(row.ticker);
    console.log(`   MOVED: quarantined and deleted id=${gone[0]?.id}\n`);
  }
}

if (APPLY) {
  // ⚠️ THE DERIVED SURFACES ARE MARKED FOR RECOMPUTE, NOT EDITED. Conviction lived on the deleted row
  // and went with it; consensus is a materialised cache keyed by ticker, so it is marked dirty and the
  // existing reconciliation rebuilds it from what insider_trades now says.
  const tickers = [...new Set([...candidates.map((c) => c.row.ticker), ...extraTickers])];
  try {
    const { markConsensusDirty } = await import('../src/lib/consensus/materialization.mjs');
    await markConsensusDirty(tickers);
    console.log(`marked consensus dirty for ${tickers.join(', ')}`);
  } catch (e) {
    console.log(`could not mark consensus dirty (${e.message}); the 30-minute reconciliation cron will catch it`);
  }
}
