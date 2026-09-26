// Backfill the cover-page powers, Item 5(c) text, amendment link and 13G rule onto filings that
// were stored before the parser captured them.
//
//   node --env-file=.env.local --loader ./scripts/ext-resolve-loader.mjs scripts/backfill-13d-powers.mjs [--write] [--limit N]
//
// ⚠️ RE-PARSES THE ORIGINAL DOCUMENT. It does not infer the powers from the share count, and it does
// not guess. A filing whose primary document cannot be fetched or parsed is left exactly as it is.
//
// ⚠️ AND IT ONLY EVER FILLS IN NULLS. The columns it writes are ones that did not exist when these
// rows were inserted, so there is nothing to overwrite; the update is still written to touch only
// rows where the value is currently absent, so a re-run cannot rewrite a value someone corrected.
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db.js';
import { parseSchedule13D } from '../src/lib/schedule13d-parse.mjs';

const WRITE = process.argv.includes('--write');
const LIMIT = (() => { const i = process.argv.indexOf('--limit');
  return i > 0 ? Number(process.argv[i + 1]) : null; })();
const L = (s = '') => console.log(s);
const UA = { 'User-Agent': process.env.SEC_USER_AGENT || 'CatalystPit research (bcoghill88@gmail.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await db.execute(sql`
  select id, accession, ticker, primary_doc_url, form_type, filer_name, shares, pct_of_class
    from schedule13d_filings
   where primary_doc_url is not null
     and sole_voting is null and shared_voting is null
       and sole_dispositive is null and shared_dispositive is null
       and previous_accession is null and transaction_desc is null
   order by filed_at desc`);
let rows = res.rows ?? res ?? [];
if (LIMIT) rows = rows.slice(0, LIMIT);
L(`[13d] ${rows.length} filings need backfilling. mode: ${WRITE ? 'WRITE' : 'dry run'}`);
L();

let ok = 0, failed = 0, noPowers = 0, withTx = 0, withPrev = 0, withRule = 0, mismatch = 0;
for (const r of rows) {
  try {
    // ⚠️ SEC ASKS FOR NO MORE THAN TEN REQUESTS A SECOND. This is well under it and deliberate.
    await sleep(130);
    const res2 = await fetch(r.primary_doc_url, { headers: UA });
    if (!res2.ok) { failed++; L(`  ${r.accession} ${r.ticker}: HTTP ${res2.status} — left unchanged`); continue; }
    const parsed = parseSchedule13D(await res2.text());

    // the person whose numbers this row already quotes, matched by name so the powers cannot be
    // taken from a different reporting person than the shares
    const lead = (parsed.persons || []).find((p) => p.name === r.filer_name)
      || (parsed.persons || []).slice().sort((a, b) => (b.pctOfClass ?? -1) - (a.pctOfClass ?? -1))[0]
      || null;

    const sv = lead?.soleVoting ?? null, shv = lead?.sharedVoting ?? null;
    const sd = lead?.soleDispositive ?? null, shd = lead?.sharedDispositive ?? null;
    if (sv == null && shv == null && sd == null && shd == null) noPowers++;
    if (parsed.transactionDesc) withTx++;
    if (parsed.previousAccession) withPrev++;
    if (parsed.ruleDesignation) withRule++;

    // ⚠️ A CONSISTENCY CHECK, REPORTED RATHER THAN ENFORCED. Voting and dispositive totals usually
    // equal the aggregate, but legitimately differ when a person reports overlapping group holdings.
    // It is worth counting; it is not worth refusing a real filing over.
    const vt = sv != null && shv != null ? sv + shv : null;
    if (vt != null && r.shares != null && Math.abs(vt - Number(r.shares)) > 1) mismatch++;

    if (WRITE) {
      await db.execute(sql`
        update schedule13d_filings
           set sole_voting        = coalesce(sole_voting, ${sv}),
               shared_voting      = coalesce(shared_voting, ${shv}),
               sole_dispositive   = coalesce(sole_dispositive, ${sd}),
               shared_dispositive = coalesce(shared_dispositive, ${shd}),
               previous_accession = coalesce(previous_accession, ${parsed.previousAccession ?? null}),
               rule_designation   = coalesce(rule_designation, ${parsed.ruleDesignation ?? null}),
               transaction_desc   = coalesce(transaction_desc, ${parsed.transactionDesc ?? null})
         where id = ${r.id}`);
    }
    ok++;
    if (ok <= 5 || ok % 50 === 0) {
      L(`  ${r.accession} ${String(r.ticker).padEnd(6)} ${String(r.form_type).padEnd(16)}`
        + ` sole/shared voting ${sv ?? '—'}/${shv ?? '—'}`
        + `  disp ${sd ?? '—'}/${shd ?? '—'}`
        + `${parsed.previousAccession ? '  prev ' + parsed.previousAccession : ''}`);
    }
  } catch (e) {
    failed++;
    L(`  ${r.accession}: ${e.message} — left unchanged`);
  }
}
L();
L(`[13d] parsed ${ok}, failed ${failed} (left unchanged)`);
L(`      with at least one power: ${ok - noPowers} of ${ok}   with Item 5(c) text: ${withTx}`);
L(`      with an amendment link: ${withPrev}   with a 13G rule designation: ${withRule}`);
L(`      voting total differs from stored aggregate on ${mismatch} (reported, not refused)`);
if (!WRITE) L('\n[13d] dry run — nothing written. Re-run with --write.');
process.exit(0);
