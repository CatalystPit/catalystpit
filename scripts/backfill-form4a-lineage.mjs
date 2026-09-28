// BACKFILL FORM 4/A AMENDMENT LINEAGE.
//
//   node scripts/backfill-form4a-lineage.mjs            # resolve, check, report — writes nothing
//   node scripts/backfill-form4a-lineage.mjs --apply    # write amends_accession / superseded_by
//
// ⚠️ EVERY LINK COMES FROM THE SEC'S OWN FILING METADATA. A Form 4/A states
// <dateOfOriginalSubmission>; with the issuer, the reporting owners and the period that identifies
// the amended filing whenever exactly one filing matches. Nothing here looks at shares, prices,
// transaction codes or filing proximity — two filings agreeing on those is a coincidence, and
// promoting it to a lineage claim would silently rewrite what the evidence engine believes.
//
// UNRESOLVED IS A RESULT, NOT A FAILURE. A missing edge is visible debt; a false one is corruption.
//
// ⚠️ NO TIMESTAMP IS TOUCHED. filing_date, transaction_date and inserted_at are never written, so
// nothing can look newly ingested and no Evidence Alert can fire from a data correction — alerts
// compare publicTime, which is filing_date.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { resolveAmendment, resolveChains, filingDay, LINK_BASIS } from '../src/lib/form4-lineage.mjs';

const APPLY = process.argv.includes('--apply');
const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());
const DIR = path.join(process.cwd(), 'node_modules', '.cache', 'form4a');

const recs = fs.readdirSync(DIR)
  .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
  .filter(Boolean);
const usable = recs.filter((r) => !r.error);
console.log(`cached 4/A records: ${recs.length} (${recs.length - usable.length} unreadable)`);
console.log(`carrying dateOfOriginalSubmission: ${usable.filter((r) => r.dateOfOriginalSubmission).length}`);
console.log(`carrying ANY accession-shaped string: ${usable.filter((r) => (r.accessionRefs || []).length).length}`);

// ── resolve ─────────────────────────────────────────────────────────────────
const cik = (v) => String(v ?? '').replace(/^0+/, '');
const edges = [];
const decided = [];
let explicit = 0, deterministic = 0, unresolved = 0;
const reasons = new Map();

for (const r of usable) {
  const src = {
    isAmendment: true,
    issuerCik: cik(r.issuerCik),
    ownerCiks: (r.ownerCiks || []).map(cik),
    // ⚠️ filingDay, not the raw string: two filer agents state `2025-02-19-05:00`, which Postgres
    // refuses as a date and which would never string-match a clean one.
    periodOfReport: filingDay(r.periodOfReport),
    origSubmissionDate: filingDay(r.dateOfOriginalSubmission),
    accessionRefs: r.accessionRefs || [],
  };
  let cands = [];
  if (src.origSubmissionDate && src.issuerCik) {
    // The issuer's non-amendment filings submitted on the stated date — plus any accession the
    // filing names outright, which need not share that date.
    const named = src.accessionRefs.length ? src.accessionRefs : [''];
    const rows = await sql`
      SELECT DISTINCT accession, issuer_cik, owner_cik, filing_date::text fd, period_of_report::text por
        FROM insider_trades
       WHERE issuer_cik = ${src.issuerCik}
         AND coalesce(is_amendment, false) = false
         AND (filing_date = ${src.origSubmissionDate}::date OR accession = ANY(${named}))`;
    cands = rows.map((c) => ({
      accession: c.accession, issuerCik: c.issuer_cik, ownerCik: c.owner_cik,
      filingDate: c.fd, periodOfReport: c.por,
    }));
  }
  const res = resolveAmendment(src, cands, r.accession);
  decided.push({ amendment: r.accession, ...res, ticker: r.ticker, src });
  reasons.set(res.reason, (reasons.get(res.reason) || 0) + 1);
  if (res.basis === LINK_BASIS.EXPLICIT) { explicit++; edges.push({ amendment: r.accession, amends: res.accession }); }
  else if (res.basis === LINK_BASIS.DETERMINISTIC) { deterministic++; edges.push({ amendment: r.accession, amends: res.accession }); }
  else unresolved++;
}

console.log(`\nEXPLICIT      ${explicit}`);
console.log(`DETERMINISTIC ${deterministic}`);
console.log(`UNRESOLVED    ${unresolved}`);
console.log('\nwhy unresolved:');
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${String(n).padStart(5)}  ${why}`);

// ── chains ──────────────────────────────────────────────────────────────────
const filedRows = await sql`SELECT DISTINCT accession, filing_date::text fd FROM insider_trades`;
const filedAt = new Map(filedRows.map((r) => [r.accession, r.fd]));
const authoritative = resolveChains(edges, filedAt);
const chainTargets = new Map();
for (const [orig, cur] of authoritative) {
  chainTargets.set(cur, (chainTargets.get(cur) || 0) + 1);
}
const multi = edges.filter((e) => authoritative.has(e.amendment)).length;
console.log(`\nsupersession edges: ${edges.length}`);
console.log(`filings that will carry superseded_by: ${authoritative.size}`);
console.log(`chains with more than one amendment: ${multi}`);

// ── PHASE 9 integrity, BEFORE anything is written ───────────────────────────
let bad = 0;
const fail = (n, d) => { bad++; console.error(`  INTEGRITY FAIL ${n}${d ? ' — ' + d : ''}`); };
console.log('\n=== integrity ===');
if (edges.some((e) => e.amendment === e.amends)) fail('a filing supersedes itself');
if (new Set(edges.map((e) => e.amendment)).size !== edges.length) fail('duplicate lineage edges');
{
  const byOrig = new Map();
  for (const e of edges) byOrig.set(e.amends, (byOrig.get(e.amends) || 0) + 1);
  const contested = [...byOrig].filter(([, n]) => n > 1);
  if (contested.length) console.log(`  note: ${contested.length} originals claimed by more than one amendment; resolveChains keeps the newest`);
}
{
  // Cross-issuer and chronology, checked against the corpus rather than against the resolver.
  const accIssuer = new Map();
  const accDate = new Map();
  for (const r of await sql`SELECT DISTINCT accession, issuer_cik, filing_date::text fd FROM insider_trades`) {
    accIssuer.set(r.accession, cik(r.issuer_cik)); accDate.set(r.accession, r.fd);
  }
  let cross = 0, chrono = 0;
  for (const e of edges) {
    if (accIssuer.has(e.amendment) && accIssuer.has(e.amends)
      && accIssuer.get(e.amendment) !== accIssuer.get(e.amends)) cross++;
    const a = accDate.get(e.amendment), o = accDate.get(e.amends);
    if (a && o && a < o) chrono++;
  }
  if (cross) fail('cross-issuer linkage', `${cross}`); else console.log('  ok  no cross-issuer linkage');
  if (chrono) fail('an amendment filed before the filing it amends', `${chrono}`);
  else console.log('  ok  no impossible chronology');
}
{
  let cycles = 0;
  for (const [orig, cur] of authoritative) if (orig === cur) cycles++;
  if (cycles) fail('cycles/self-links after chain resolution', `${cycles}`);
  else console.log('  ok  no cycles or self-links after chain resolution');
}
console.log(bad ? `\n${bad} integrity failure(s) — NOTHING WILL BE WRITTEN` : '\nintegrity: clean');
if (bad) process.exit(1);

// ── what the LEGACY rule left behind ────────────────────────────────────────
//
// ⚠️ THERE WAS ALREADY A SUPERSESSION MECHANISM, AND IT WAS UNSOUND. backfill-form4-history.mjs
// superseded every non-amendment filing sharing (issuer_cik, owner_cik, period_of_report) with a
// 4/A — no check that the amendment says it amends a filing submitted that day, no requirement that
// exactly one filing fit, and `superseded_by IS NULL` so the FIRST amendment processed won. It could
// mark a filing submitted after the amendment, and it could point at an accession we do not hold.
// Its output is audited here rather than trusted.
const legacy = await sql`
  SELECT DISTINCT o.accession, o.ticker, o.superseded_by, o.filing_date::text ofd, a.fd afd
    FROM insider_trades o
    LEFT JOIN LATERAL (SELECT filing_date::text fd FROM insider_trades x
                        WHERE x.accession = o.superseded_by LIMIT 1) a ON true
   WHERE o.superseded_by IS NOT NULL`;
const impossible = [...new Set(legacy.filter((r) => r.afd && r.afd < r.ofd).map((r) => r.accession))];
const unreproduced = legacy.filter((r) => !authoritative.has(r.accession));
console.log('\n=== legacy supersession links ===');
console.log(`  already set:                      ${new Set(legacy.map((r) => r.accession)).size}`);
console.log(`  reproduced deterministically:     ${legacy.filter((r) => authoritative.get(r.accession) === r.superseded_by).length}`);
console.log(`  superseded by a DIFFERENT filing: ${legacy.filter((r) => authoritative.has(r.accession) && authoritative.get(r.accession) !== r.superseded_by).length}  (overwritten — the newest amendment is authoritative)`);
console.log(`  not reproduced, left in place:    ${unreproduced.length}  (unproven, but clearing them would double-count the filing)`);
console.log(`  ⚠️ IMPOSSIBLE (superseder filed first), will be CLEARED: ${impossible.length}`);
for (const r of legacy.filter((x) => impossible.includes(x.accession)))
  console.log(`      ${String(r.ticker).padEnd(6)} ${r.accession} filed ${r.ofd} <- ${r.superseded_by} filed ${r.afd}`);

// ── report a sample before writing ──────────────────────────────────────────
console.log('\n=== sample links ===');
for (const d of decided.filter((x) => x.basis === LINK_BASIS.DETERMINISTIC).slice(0, 8)) {
  console.log(`  ${String(d.ticker).padEnd(6)} ${d.amendment} amends ${d.accession}`);
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

// ── write ───────────────────────────────────────────────────────────────────
// Idempotent by construction: every statement sets a value to what it already is on a second run.
let wroteAmd = 0, wroteSup = 0;
for (const d of decided) {
  const basis = d.basis;
  const amends = d.accession;
  const r = await sql`
    UPDATE insider_trades
       SET amends_accession = ${amends}, amend_link_basis = ${basis},
           orig_submission_date = ${d.src.origSubmissionDate ?? null}::date
     WHERE accession = ${d.amendment}
       AND (amends_accession IS DISTINCT FROM ${amends}
            OR amend_link_basis IS DISTINCT FROM ${basis}
            OR orig_submission_date IS DISTINCT FROM ${d.src.origSubmissionDate ?? null}::date)
    RETURNING 1`;
  wroteAmd += r.length;
}
for (const [orig, cur] of authoritative) {
  const r = await sql`
    UPDATE insider_trades SET superseded_by = ${cur}
     WHERE accession = ${orig} AND superseded_by IS DISTINCT FROM ${cur}
    RETURNING 1`;
  wroteSup += r.length;
}
// A filing cannot be superseded by one submitted before it. These predate this work and are cleared
// rather than left to keep excluding a filing from every aggregate on a provably wrong basis.
let cleared = 0;
for (const acc of impossible) {
  if (authoritative.has(acc)) continue;                 // a real link replaced it above
  const r = await sql`UPDATE insider_trades SET superseded_by = NULL
                       WHERE accession = ${acc} AND superseded_by IS NOT NULL RETURNING 1`;
  cleared += r.length;
}
console.log(`\nrows updated: amendment lineage ${wroteAmd}, superseded originals ${wroteSup}, impossible legacy links cleared ${cleared}`);
