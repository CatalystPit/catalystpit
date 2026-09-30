// Merge phantom politicians created by a suffix/credential name split, on documentary evidence only.
//
//   node --env-file=.env.local scripts/repair-congress-identity.mjs            (dry run)
//   node --env-file=.env.local scripts/repair-congress-identity.mjs --apply
//
// ── ⚠️ WHAT WENT WRONG ───────────────────────────────────────────────────────
//
// The FMP feed sometimes puts a name SUFFIX or CREDENTIAL in lastName: {Angus, Jr.},
// {William, IV}, {Neal, FACS}, {Neal Patrick, "Dunn, MD, FACS"}. norm() reduces those to nothing, so
// matchMember found no roster entry, and buildRow's fallback coined 'angus-jr', 'william-iv',
// 'neal-facs' and 'neal-patrick-dunn-md-facs' AS IF THEY WERE MEMBERS OF CONGRESS. They appeared on
// /politicians; Angus King's and Bill Hagerty's own pages were missing the trades held under them.
//
// Worse, member_slug is an input to canonicalHash, so the dedupe could not see the collision — by
// construction it cannot catch an identity error. 27 of the 40 rows are second copies of trades
// already held under the correct member from the official Senate feed.
//
// ── ⚠️ HOW IDENTITY IS ESTABLISHED HERE — NOT BY NAME SIMILARITY ─────────────
//
// Fuzzy name matching on a ~535-person set produces confident-but-wrong merges, so none is used.
// Every merge below rests on one of exactly two kinds of evidence:
//
//   ROSTER    the stored first/last resolve through the FIXED matchMember to one roster entry.
//             "Dunn, MD, FACS" -> "dunn" -> D000628, the one Dunn in the House.
//   DOCUMENT  the row cites the same disclosure PDF/PTR as a row already on a bioguide slug. One
//             PTR document has exactly one filer, so a shared document IS an identity proof.
//             This is what resolves 'neal-facs' (last name "FACS" alone identifies nobody, and
//             "Neal" is also a real House surname — Richard Neal, N000015 — so guessing would have
//             been a coin flip): it shares all three of its documents with the row that ROSTER
//             resolves to D000628.
//
// Anything neither rule resolves is left exactly as it is and reported. That is the point.
//
// ── ⚠️ A REPAIR CANNOT MANUFACTURE AN EVIDENCE ALERT ─────────────────────────
//
// publicTime for a congress trade is disclosure_date, and changedSince() keeps an evidence object
// only when publicTime > the subscriber's watermark. This script writes member_slug, party, state
// and tx_hash, and DELETES proven duplicates. It never writes disclosure_date or inserted_at, so no
// row can cross a watermark. The snapshot below proves it instead of asserting it: the alert-visible
// surface (per-ticker newest disclosure_date) is captured before and compared after, and the script
// exits non-zero if any ticker's newest disclosure advanced or any new ticker appeared.
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { buildIndex, matchMember } from '../src/lib/congress-match.mjs';
import { canonicalHash } from '../src/lib/congress-ingest.mjs';

const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv.includes('--apply');
const roster = JSON.parse(readFileSync(new URL('../src/lib/congress-roster.json', import.meta.url), 'utf8'));
const index = buildIndex(roster);
const byBioguide = new Map(roster.map((e) => [e.bioguide, e]));
const isBioguide = (s) => /^[A-Z][0-9]{6}$/.test(String(s || ''));

// ── the alert-visible surface, before ────────────────────────────────────────
const pubSnap = async () => {
  const r = await sql`select coalesce(ticker,'(none)') t, max(disclosure_date)::text newest, count(*)::int n
                      from congress_trades group by 1`;
  return new Map(r.map((x) => [x.t, { newest: x.newest, n: x.n }]));
};
const before = await pubSnap();
console.log(`alert-visible snapshot: ${before.size} tickers, newest disclosure_date each\n`);

// ── ⚠️ PROVE THE HASH RECOMPUTATION IS FAITHFUL BEFORE IT DRIVES ANYTHING ────
// A repair that recomputes tx_hash from the wrong columns would silently rewrite identity for every
// row it touched. So recompute it for rows whose hash is already correct and require an exact match.
const control = await sql`select tx_hash, member_slug, transaction_date::text td, ticker, action,
                                 amount_min, amount_max, asset_description
                          from congress_trades where member_slug ~ '^[A-Z][0-9]{6}$' limit 400`;
let hashOk = 0;
for (const r of control) {
  const h = canonicalHash({
    memberSlug: r.member_slug, transactionDate: r.td, ticker: r.ticker, action: r.action,
    amountMin: r.amount_min, amountMax: r.amount_max, assetDescription: r.asset_description,
  });
  if (h === r.tx_hash) hashOk++;
}
console.log(`hash recomputation control: ${hashOk}/${control.length} stored hashes reproduced exactly`);
if (hashOk !== control.length) {
  console.error('REFUSING TO REPAIR: cannot reproduce stored tx_hash from stored columns.');
  process.exit(1);
}

// ── resolve every non-bioguide slug ──────────────────────────────────────────
const orphanSlugs = (await sql`select distinct member_slug from congress_trades
                               where member_slug !~ '^[A-Z][0-9]{6}$'`).map((r) => r.member_slug);
console.log(`\nnon-bioguide slugs: ${orphanSlugs.length}\n`);

const resolved = new Map();   // slug -> { target, how, detail }

// pass 1 — ROSTER: the fixed matcher on the stored source name fields
for (const slug of orphanSlugs) {
  const [r] = await sql`select first_name, last_name, chamber, district from congress_trades
                        where member_slug = ${slug} and last_name is not null limit 1`;
  if (!r) continue;
  const { entry, method } = matchMember(index, {
    firstName: r.first_name, lastName: r.last_name, chamber: r.chamber, district: r.district,
  });
  if (entry) resolved.set(slug, { target: entry.bioguide, how: 'ROSTER', detail: `${r.first_name} / ${r.last_name} -> ${method}` });
}

// pass 2 — DOCUMENT: a shared disclosure document with an already-identified row. Repeated until it
// stops finding anything, so a chain (neal-facs -> neal-patrick-dunn-md-facs -> D000628) resolves.
for (let round = 0; round < 5; round++) {
  let added = 0;
  for (const slug of orphanSlugs) {
    if (resolved.has(slug)) continue;
    const peers = await sql`select distinct b.member_slug s from congress_trades a
                            join congress_trades b on b.link = a.link and b.member_slug <> a.member_slug
                            where a.member_slug = ${slug} and a.link is not null`;
    const targets = new Set();
    for (const p of peers) {
      if (isBioguide(p.s)) targets.add(p.s);
      else if (resolved.has(p.s)) targets.add(resolved.get(p.s).target);
    }
    // ⚠️ ONE candidate only. Two different members sharing a document would mean the document
    // attribution itself is wrong, and this script does not get to pick.
    if (targets.size === 1) {
      const target = [...targets][0];
      resolved.set(slug, { target, how: 'DOCUMENT', detail: `shares ${peers.length} document link(s) with ${target}` });
      added++;
    }
  }
  if (!added) break;
}

for (const slug of orphanSlugs) {
  const r = resolved.get(slug);
  const e = r ? byBioguide.get(r.target) : null;
  console.log(r
    ? `  ${slug.padEnd(28)} -> ${r.target} (${e ? e.first + ' ' + e.last + ', ' + e.chamber + '/' + e.state : '?'})  [${r.how}] ${r.detail}`
    : `  ${slug.padEnd(28)} -> UNRESOLVED — left untouched and reported`);
}

// ── plan: duplicate (delete) vs mis-attributed (update) ──────────────────────
const haveHash = new Set((await sql`select tx_hash from congress_trades`).map((r) => r.tx_hash));
const deletes = [], updates = [], skipped = [];

for (const [slug, res] of resolved) {
  const entry = byBioguide.get(res.target);
  const rows = await sql`select id, tx_hash, transaction_date::text td, ticker, action,
                                amount_min, amount_max, asset_description, disclosure_date::text dd
                         from congress_trades where member_slug = ${slug}`;
  for (const row of rows) {
    const newHash = canonicalHash({
      memberSlug: res.target, transactionDate: row.td, ticker: row.ticker, action: row.action,
      amountMin: row.amount_min, amountMax: row.amount_max, assetDescription: row.asset_description,
    });
    // ⚠️ THE DUPLICATE TEST IS THE HASH ITSELF, not a judgement call. If the trade already exists
    // under the correct member it has this exact canonical identity, so the row is a second copy.
    if (haveHash.has(newHash)) deletes.push({ ...row, slug, target: res.target, newHash });
    else { updates.push({ ...row, slug, target: res.target, newHash, entry }); haveHash.add(newHash); }
  }
}
for (const slug of orphanSlugs) if (!resolved.has(slug)) {
  const [c] = await sql`select count(*)::int n from congress_trades where member_slug = ${slug}`;
  skipped.push({ slug, n: c.n });
}

console.log(`\nPLAN${APPLY ? '' : '  (dry run)'}`);
console.log(`  duplicates to delete   : ${deletes.length}`);
for (const d of deletes) console.log(`     ${d.slug} -> ${d.target}  ${d.td} ${d.ticker || '(no ticker)'} ${d.action} — already held under ${d.target}`);
console.log(`  rows to re-attribute   : ${updates.length}`);
for (const u of updates) console.log(`     ${u.slug} -> ${u.target}  ${u.td} ${u.ticker || '(no ticker)'} ${u.action}`);
console.log(`  left untouched         : ${skipped.length ? skipped.map((s) => s.slug + '(' + s.n + ')').join(', ') : '(none)'}`);

if (APPLY) {
  for (const d of deletes) await sql`delete from congress_trades where id = ${d.id}`;
  for (const u of updates) {
    // Derived attribution only. first_name / last_name keep the source's own values so the original
    // record stays auditable; disclosure_date and inserted_at are never touched.
    //
    // ⚠️ representative IS REWRITTEN TO THE ROSTER'S OFFICIAL NAME, because it is a DERIVED display
    // field (rec.office, else firstName + lastName) and the split that caused this left it reading
    // "Neal FACS" and "Angus Jr.". /api/congress-overview returns it per trade, so leaving it would
    // print those on the correct member's page; the politician header only avoided them by the luck of
    // a max() comparison. The roster's officialFull is the authoritative name for that bioguide ID.
    const official = u.entry?.officialFull || [u.entry?.first, u.entry?.last].filter(Boolean).join(' ') || null;
    await sql`update congress_trades set member_slug = ${u.target}, tx_hash = ${u.newHash},
                     party = coalesce(${u.entry?.party || null}, party),
                     state = coalesce(${u.entry?.state || null}, state),
                     representative = coalesce(${official}, representative)
              where id = ${u.id}`;
  }
  console.log(`\napplied: ${deletes.length} deleted, ${updates.length} re-attributed`);
}

// ── prove no alert-visible field moved ───────────────────────────────────────
const after = await pubSnap();
const advanced = [], appeared = [];
for (const [t, a] of after) {
  const b = before.get(t);
  if (!b) { appeared.push(t); continue; }
  if (a.newest > b.newest) advanced.push(`${t}: ${b.newest} -> ${a.newest}`);
}
console.log('\nALERT SAFETY');
console.log(`  tickers before/after            : ${before.size} / ${after.size}`);
console.log(`  newest disclosure_date ADVANCED : ${advanced.length}  ${advanced.length ? '⚠️ ' + advanced.slice(0, 5).join('; ') : '(none — nothing can cross a watermark)'}`);
console.log(`  tickers that APPEARED           : ${appeared.length}  ${appeared.length ? '⚠️ ' + appeared.slice(0, 5).join(', ') : '(none)'}`);
if (advanced.length || appeared.length) {
  console.error('REFUSING TO CALL THIS SAFE: a publicTime-bearing value moved forward.');
  process.exit(1);
}

const left = await sql`select count(*)::int n from congress_trades where member_slug !~ '^[A-Z][0-9]{6}$'`;
console.log(`\nrows still on a non-bioguide slug: ${left[0].n}`);
