// scripts/recover-congress-collapsed.mjs
//
// Re-fetch only the filings that stored FEWER transactions than their parser found, and insert
// the rows that the old dedup key silently collapsed. Run AFTER
// scripts/rekey-congress-assetdesc.mjs, so existing rows already carry the new hash and cannot
// be re-inserted as duplicates.
//
//   node --env-file=.env.local scripts/recover-congress-collapsed.mjs --dry-run
//   node --env-file=.env.local scripts/recover-congress-collapsed.mjs [--chamber=senate] [--limit=50]
//
// Idempotent: inserts are ON CONFLICT DO NOTHING against the canonical tx_hash, so re-running
// recovers nothing the second time.

import { neon } from '@neondatabase/serverless';
import { fetchHousePtr } from '../src/lib/congress-house.mjs';
import { fetchSenatePtr, establishSession } from '../src/lib/congress-senate.mjs';
import { buildRow, canonicalHash, isOptionTrade } from '../src/lib/congress-ingest.mjs';
import { buildIndex } from '../src/lib/congress-match.mjs';
import roster from '../src/lib/congress-roster.json' with { type: 'json' };

// The roster index drives member_slug. Without it buildRow falls back to a name-slug and the
// recovered rows would orphan onto a different member than the ones already stored.
const index = buildIndex(roster);

const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : d; };
const DRY = process.argv.includes('--dry-run');
const ONLY = arg('chamber', null);
const LIMIT = Number(arg('limit', 0)) || Infinity;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COLS = ['tx_hash','chamber','first_name','last_name','representative','member_slug','party','state','district',
  'ticker','asset_description','asset_type','owner','type','action','amount_range','amount_min','amount_max','amount_mid',
  'transaction_date','disclosure_date','filing_lag_days','cap_gains_over_200','comment','link'];
const tuple = (r) => [r.txHash,r.chamber,r.firstName,r.lastName,r.representative,r.memberSlug,r.party,r.state,r.district,
  r.ticker,r.assetDescription,r.assetType,r.owner,r.type,r.action,r.amountRange,r.amountMin,r.amountMax,r.amountMid,
  r.transactionDate,r.disclosureDate,r.filingLagDays,r.capGainsOver200,r.comment,r.link];

async function insertRows(rows) {
  if (!rows.length) return 0;
  // collapse within the batch first: one statement cannot touch the same conflict key twice
  const seen = new Map();
  for (const r of rows) if (r.txHash && !seen.has(r.txHash)) seen.set(r.txHash, r);
  const list = [...seen.values()];
  if (DRY) return list.length;
  let written = 0;
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    const params = [];
    const values = batch.map((r) => {
      const t = tuple(r); const base = params.length; params.push(...t);
      return `(${t.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    const res = await sql.query(
      `INSERT INTO congress_trades (${COLS.join(',')}) VALUES ${values}
       ON CONFLICT (tx_hash) DO NOTHING RETURNING 1`, params);
    written += res.length;
  }
  return written;
}

const gaps = await sql.query(`
  SELECT f.chamber, f.doc_id, f.year, f.filer_name, f.filing_date, f.url, f.txn_count,
         COALESCE(s.n, 0) AS stored
  FROM congress_filings f
  LEFT JOIN (SELECT link, count(*)::int n FROM congress_trades GROUP BY link) s
    ON s.link LIKE '%' || f.doc_id || '%'
  WHERE f.status = 'parsed' AND f.txn_count > COALESCE(s.n, 0)
  ${ONLY ? `AND f.chamber = '${ONLY.replace(/[^a-z]/gi, '')}'` : ''}
  ORDER BY (f.txn_count - COALESCE(s.n, 0)) DESC`);

console.log(`${gaps.length} filings with a gap${DRY ? '  [DRY RUN]' : ''}`);
let cookies = null, recovered = 0, done = 0, failed = 0, mismatched = 0, unanchored = 0;

for (const g of gaps.slice(0, LIMIT === Infinity ? gaps.length : LIMIT)) {
  const [first, ...rest] = String(g.filer_name || '').split(' ');
  const last = rest.pop() || '';
  try {
    let res;
    if (g.chamber === 'senate') {
      if (!cookies) cookies = await establishSession();
      res = await fetchSenatePtr({ first, last, filingDate: g.filing_date, href: g.url }, cookies);
    } else {
      res = await fetchHousePtr({ docId: g.doc_id, year: g.year, first, last, filingDate: g.filing_date });
    }
    if (res.status !== 'parsed' || !res.recs?.length) { failed++; continue; }
    const rows = res.recs.map((rec) => buildRow(rec, g.chamber, index)).filter((r) => r.txHash);

    // member_slug is part of the canonical hash, and matchMember only resolves a bioguide when the
    // filer_name string matches the roster. Re-deriving it here can land on a name-slug where the
    // stored rows carry a bioguide, and every recovered hash would then miss the conflict check and
    // insert a DUPLICATE of a trade we already hold, under a second identity for the same person.
    // Anchor to the identity the document's existing rows already use. Documents with no stored
    // rows keep the derived slug and are reported, since there is nothing to anchor to.
    const [anchor] = await sql`
      SELECT member_slug, representative, first_name, last_name, party, state, district
        FROM congress_trades WHERE link LIKE ${'%' + g.doc_id + '%'} LIMIT 1`;
    if (anchor?.member_slug) {
      for (const r of rows) {
        if (r.memberSlug === anchor.member_slug) continue;
        mismatched++;
        r.memberSlug = anchor.member_slug;
        r.representative = anchor.representative ?? r.representative;
        r.firstName = anchor.first_name ?? r.firstName;
        r.lastName = anchor.last_name ?? r.lastName;
        r.party = anchor.party ?? r.party;
        r.state = anchor.state ?? r.state;
        r.district = anchor.district ?? r.district;
        r.txHash = canonicalHash({
          memberSlug: r.memberSlug, transactionDate: r.transactionDate, ticker: r.ticker,
          action: r.action, amountMin: r.amountMin, amountMax: r.amountMax,
          isOption: isOptionTrade(r.assetType), assetDescription: r.assetDescription,
        });
      }
    } else { unanchored++; }

    const n = await insertRows(rows);
    recovered += n; done++;
    if (n) console.log(`  ${String(g.filer_name).slice(0, 22).padEnd(23)} ${g.chamber.padEnd(7)} parsed ${String(res.recs.length).padStart(4)}  recovered ${String(n).padStart(4)}`);
  } catch (e) { failed++; console.error(`  FAIL ${g.doc_id}: ${e.message}`); }
  await sleep(g.chamber === 'senate' ? 1200 : 400);
}
console.log(`\ndone. filings processed ${done}, failed ${failed}, transactions recovered ${recovered}`);
console.log(`identity: ${mismatched} parsed rows re-anchored to the member their document already uses, `
  + `${unanchored} filings had no stored rows to anchor to`);
