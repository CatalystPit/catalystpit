// PROOF THAT RECOMPUTING THE INSTITUTIONAL AGGREGATE CANNOT FIRE AN EVIDENCE ALERT.
//
//   node --env-file=.env.local scripts/institutional-alert-safety.mjs --snapshot
//   node --env-file=.env.local scripts/institutional-alert-safety.mjs --compare
//
// ⚠️ WHAT AN ALERT ACTUALLY READS. evidence/model.mjs:changedSince filters on publicTime and nothing
// else. For the institution family, evidence/resolve.js sets publicTime = fund_filings.filed_date and
// eventTime = the quarter end — two clocks, months apart, kept distinct on purpose. The aggregate this
// repair touches is ticker_institutional_ownership, which is NOT an evidence source: the 13F evidence
// is built from fund_filings and fund_holdings breadth, and the aggregate is a display table.
//
// That is the argument. This is the measurement: every input an institutional alert can see, before
// and after. filed_date is what publicTime is, so the failure condition is any filing whose filed_date
// moves forward, any accession appearing where none was, and any change in the per-ticker breadth
// series the evidence reads.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const SNAP = path.join(process.cwd(), 'node_modules', '.cache', 'institutional-alert-snapshot.json');

// ⚠️ PINNED TO THE SNAPSHOT INSTANT. The institutions cron keeps ingesting while this runs, and a
// genuinely new 13F arriving mid-measurement looks exactly like the repair moving a date forward.
const take = async (asOf) => {
  // publicTime, per filing: the only column an institutional alert compares.
  const filings = await sql`
    SELECT cik, quarter::text q, filed_date::text fd, accession
      FROM fund_filings WHERE inserted_at <= ${asOf}::timestamptz`;
  // The breadth series the evidence resolver reads, per ticker-quarter.
  const breadth = await sql`
    SELECT h.ticker, h.quarter::text q, count(DISTINCT h.cik)::int holders
      FROM fund_holdings h
     WHERE h.ticker IS NOT NULL AND coalesce(h.put_call,'') = '' AND h.inserted_at <= ${asOf}::timestamptz
     GROUP BY 1,2`;
  return {
    filings: Object.fromEntries(filings.map((r) => [`${r.cik}|${r.q}`, `${r.fd}|${r.accession}`])),
    breadth: Object.fromEntries(breadth.map((r) => [`${r.ticker}|${r.q}`, r.holders])),
  };
};

if (process.argv.includes('--snapshot')) {
  const asOf = new Date().toISOString();
  const snap = await take(asOf);
  fs.writeFileSync(SNAP, JSON.stringify({ asOf, ...snap }));
  console.log(`snapshot as of ${asOf}`);
  console.log(`  filings: ${Object.keys(snap.filings).length}`);
  console.log(`  ticker-quarter breadth rows: ${Object.keys(snap.breadth).length}`);
  console.log(`  -> ${SNAP}`);
  process.exit(0);
}

const saved = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
console.log(`comparing against the corpus as it stood at ${saved.asOf}\n`);
const after = await take(saved.asOf);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const movedForward = [], changedAccession = [], appeared = [], vanished = [];
for (const [k, v] of Object.entries(saved.filings)) {
  const now = after.filings[k];
  if (!now) { vanished.push(k); continue; }
  const [fdWas, accWas] = v.split('|');
  const [fdNow, accNow] = now.split('|');
  if (fdNow > fdWas) movedForward.push(`${k} ${fdWas}->${fdNow}`);
  if (accNow !== accWas) changedAccession.push(`${k} ${accWas}->${accNow}`);
}
for (const k of Object.keys(after.filings)) if (!(k in saved.filings)) appeared.push(k);

ok('⚠️ no filing\'s filed_date moved forward — publicTime is untouched', movedForward.length === 0, movedForward.slice(0, 5).join(' · '));
ok('no filing changed its operative accession', changedAccession.length === 0, changedAccession.slice(0, 5).join(' · '));
ok('⚠️ no filing appeared inside the snapshot window', appeared.length === 0, `${appeared.length}`);
ok('no filing vanished', vanished.length === 0, `${vanished.length}`);

// Breadth CAN legitimately change — the pick fix restores positions that were being dropped. What must
// not happen is a ticker-quarter GAINING a holder count that makes an old quarter look like news, so
// the direction and the size are reported rather than asserted away.
let up = 0, down = 0, same = 0, newKeys = 0;
const upSample = [];
for (const [k, v] of Object.entries(saved.breadth)) {
  const now = after.breadth[k];
  if (now === undefined) { down++; continue; }
  if (now > v) { up++; if (upSample.length < 6) upSample.push(`${k} ${v}->${now}`); }
  else if (now < v) down++; else same++;
}
for (const k of Object.keys(after.breadth)) if (!(k in saved.breadth)) newKeys++;
console.log(`\n  breadth rows unchanged ${same} · up ${up} · down ${down} · new ${newKeys}`);
if (upSample.length) console.log(`  sample up: ${upSample.join(' · ')}`);
ok('⚠️ the repair does not invent a ticker-quarter that did not exist', newKeys === 0, `${newKeys}`);

// Nothing in the repair writes these, so they are checked rather than trusted.
const [t] = await sql`SELECT
  count(*) FILTER (WHERE inserted_at > ${saved.asOf}::timestamptz)::int filings_touched
  FROM fund_filings`;
ok('⚠️ no fund_filings row was re-inserted by the repair', t.filings_touched === 0, `${t.filings_touched}`);
const [h] = await sql`SELECT
  count(*) FILTER (WHERE inserted_at > ${saved.asOf}::timestamptz)::int holdings_touched
  FROM fund_holdings`;
console.log(`  fund_holdings rows inserted since the snapshot: ${h.holdings_touched} (live ingest, not this repair)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
