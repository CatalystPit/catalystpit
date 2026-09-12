// scripts/backfill-form4-history.mjs
//
// Walks SEC EDGAR daily-index files BACKWARD from a start date and ingests Form 4
// and 4/A filings into insider_trades. Built for a ~12h run over ~426k filings, so
// the priorities are: never lose progress, never double-count, never exceed SEC
// Fair Access, and never silently drop a bad record.
//
//   node --env-file=.env.local scripts/backfill-form4-history.mjs --years=3
//
// Useful flags:
//   --years=3            how far back to go (default 3). Extendable later; nothing
//                        in the schema encodes a window.
//   --from=YYYY-MM-DD    start (walks backward from here; default today)
//   --codes=P,S          transaction codes to STORE (default open-market only).
//                        Use --codes=ALL to keep every code.
//   --rps=8              requests/sec (SEC caps at 10; 8 leaves headroom)
//   --days=N             stop after N index days (for a bounded trial run)
//   --resume             continue from insider_ingest_state instead of --from
//   --dry-run            parse and report, write nothing
//
// Resumability: the cursor is committed AFTER each index day completes, so an
// interrupted run restarts at the first day it did not finish. Re-running is
// harmless — inserts are ON CONFLICT DO NOTHING against uq_insider_txn.

import { neon } from '@neondatabase/serverless';
import { parseForm4 } from '../src/lib/form4.mjs';

const JOB = 'form4-backfill';
const UA = { 'User-Agent': 'CatalystPit Historical Ingest bcoghill88@gmail.com' };

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const flag = (k) => process.argv.includes(`--${k}`);

const YEARS = Number(arg('years', 3));
const RPS = Number(arg('rps', 8));
const MAX_DAYS = Number(arg('days', 0)) || Infinity;
const DRY = flag('dry-run');
const RESUME = flag('resume');
const CODES_RAW = arg('codes', 'P,S').toUpperCase();
const KEEP_ALL = CODES_RAW === 'ALL';
const KEEP_CODES = new Set(CODES_RAW.split(',').map((s) => s.trim()).filter(Boolean));

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

// ─── SEC Fair Access pacing ────────────────────────────────────────────────
// A simple spacing gate rather than a burst bucket: SEC measures sustained rate,
// and a steady cadence is what keeps a 12h job from being throttled or blocked.
let nextSlot = 0;
const paced = async (url, tries = 4) => {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    nextSlot = Date.now() + 1000 / RPS;
    try {
      const res = await fetch(url, { headers: UA });
      if (res.status === 429 || res.status === 503) {         // backoff and retry
        await new Promise((r) => setTimeout(r, 2000 * attempt * attempt));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt === tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
};

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

// ─── state ─────────────────────────────────────────────────────────────────
async function loadState() {
  const r = await sql.query(`SELECT * FROM insider_ingest_state WHERE job = $1`, [JOB]);
  return r[0] || null;
}
async function saveState(patch) {
  if (DRY) return;
  await sql.query(
    `INSERT INTO insider_ingest_state (job, cursor_date, target_from, filings_seen, filings_parsed, rows_written, rows_quarantined, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (job) DO UPDATE SET cursor_date=$2, target_from=$3, filings_seen=$4,
       filings_parsed=$5, rows_written=$6, rows_quarantined=$7, last_error=$8, updated_at=now()`,
    [JOB, patch.cursorDate, patch.targetFrom, patch.filingsSeen, patch.filingsParsed,
     patch.rowsWritten, patch.rowsQuarantined, patch.lastError || null],
  );
}

// ─── one index day → distinct Form 4 filings ───────────────────────────────
// form.idx lists a filing once PER FILER (issuer + each reporting owner), a ~2.1x
// duplication. Deduping by accession here is what keeps the fetch count honest.
async function filingsForDay(day) {
  const [y, m, d] = day.split('-');
  const q = 'QTR' + (Math.floor((Number(m) - 1) / 3) + 1);
  const res = await paced(`https://www.sec.gov/Archives/edgar/daily-index/${y}/${q}/form.${y}${m}${d}.idx`);
  if (!res || !res.ok) return { ok: res?.status === 404, filings: [] };  // 404 = weekend/holiday
  const text = await res.text();
  const seen = new Map();
  for (const line of text.split('\n')) {
    if (!/^\s*4(\/A)?\s/.test(line)) continue;
    const path = line.trim().split(/\s{2,}/).pop()?.trim();
    const accession = path?.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.set(accession, { accession, filingDate: day, docUrl: `https://www.sec.gov/Archives/${path}`, indexUrl: `https://www.sec.gov/Archives/${path}` });
  }
  return { ok: true, filings: [...seen.values()] };
}

// ─── writes ────────────────────────────────────────────────────────────────
const COLS = [
  'ticker','company','executive','title','transaction_code','action','shares','price_per_share',
  'total_value','shares_owned_after','security_title','transaction_date','filing_date','accession',
  'filing_url','rule_10b5_1','footnotes','issuer_cik','owner_cik','period_of_report','form_type',
  'is_amendment','amends_accession','acquired_disposed','ownership_type','ownership_nature',
  'is_derivative','is_officer','is_director','is_ten_pct_owner','is_other_relation',
];
const toTuple = (r) => [
  r.ticker, r.company, r.executive, r.title, r.transactionCode || null, r.action, r.shares,
  r.pricePerShare, r.totalValue, r.sharesOwnedAfter, r.securityTitle, r.transactionDate,
  r.filingDate, r.accession, r.filingUrl, r.rule10b5_1, r.footnotes, r.issuerCik, r.ownerCik,
  r.periodOfReport, r.formType, r.isAmendment, r.amendsAccession, r.acquiredDisposed,
  r.ownershipType, r.ownershipNature, r.isDerivative, r.isOfficer, r.isDirector,
  r.isTenPctOwner, r.isOtherRelation,
];

let enriched = 0;
async function insertRows(rows) {
  if (!rows.length) return 0;
  if (DRY) return rows.length;   // report what WOULD be written
  let written = 0;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const params = [];
    const values = batch.map((r) => {
      const t = toTuple(r);
      const base = params.length;
      params.push(...t);
      return `(${t.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    // Idempotent on the trade itself, but NOT a no-op: the 145k rows ingested before
    // this migration have NULL issuer_cik/owner_cik, and every historical-context query
    // keys on CIK — DO NOTHING would leave them permanently invisible. So a conflict
    // ENRICHES the existing row with the provenance we previously dropped, while never
    // touching the original trade economics (shares, price, value, dates, code).
    // COALESCE keeps whatever is already there if SEC now returns null.
    const res = await sql.query(
      `INSERT INTO insider_trades (${COLS.join(',')}) VALUES ${values}
       ON CONFLICT (accession, transaction_date, transaction_code, security_title, shares, price_per_share, shares_owned_after)
       DO UPDATE SET
         issuer_cik        = COALESCE(insider_trades.issuer_cik,        EXCLUDED.issuer_cik),
         owner_cik         = COALESCE(insider_trades.owner_cik,         EXCLUDED.owner_cik),
         period_of_report  = COALESCE(insider_trades.period_of_report,  EXCLUDED.period_of_report),
         form_type         = COALESCE(insider_trades.form_type,         EXCLUDED.form_type),
         is_amendment      = insider_trades.is_amendment OR EXCLUDED.is_amendment,
         amends_accession  = COALESCE(insider_trades.amends_accession,  EXCLUDED.amends_accession),
         acquired_disposed = COALESCE(insider_trades.acquired_disposed, EXCLUDED.acquired_disposed),
         ownership_type    = COALESCE(insider_trades.ownership_type,    EXCLUDED.ownership_type),
         ownership_nature  = COALESCE(insider_trades.ownership_nature,  EXCLUDED.ownership_nature),
         is_derivative     = insider_trades.is_derivative OR EXCLUDED.is_derivative,
         is_officer        = COALESCE(insider_trades.is_officer,        EXCLUDED.is_officer),
         is_director       = COALESCE(insider_trades.is_director,       EXCLUDED.is_director),
         is_ten_pct_owner  = COALESCE(insider_trades.is_ten_pct_owner,  EXCLUDED.is_ten_pct_owner),
         is_other_relation = COALESCE(insider_trades.is_other_relation, EXCLUDED.is_other_relation),
         rule_10b5_1       = COALESCE(insider_trades.rule_10b5_1,       EXCLUDED.rule_10b5_1),
         footnotes         = COALESCE(insider_trades.footnotes,         EXCLUDED.footnotes)
       RETURNING (xmax = 0) AS inserted`, params,
    );
    written += res.filter((r) => r.inserted).length;
    enriched += res.length - res.filter((r) => r.inserted).length;
  }
  return written;
}

async function insertQuarantine(items) {
  if (!items.length) return 0;
  if (DRY) return items.length;
  let n = 0;
  for (const q of items) {
    try {
      const res = await sql.query(
        `INSERT INTO insider_quarantine (accession, issuer_cik, owner_cik, ticker, filing_date, reason, detail, parsed, raw_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT DO NOTHING RETURNING 1`,
        [q.accession, q.issuerCik, q.ownerCik, q.ticker, q.filingDate, q.reason, q.detail,
         JSON.stringify(q.parsed ?? null), q.rawUrl],
      );
      n += res.length;
    } catch (e) { console.error('  quarantine write failed', q.accession, e.message); }
  }
  return n;
}

// A 4/A restates an earlier filing for the same (issuer, owner, period). Mark the
// superseded originals rather than deleting them, so aggregates can exclude them
// while the original filing stays on the record.
async function applyAmendments(amendments) {
  if (!amendments.length || DRY) return 0;
  let n = 0;
  for (const a of amendments) {
    if (!a.issuerCik || !a.ownerCik || !a.periodOfReport) continue;
    const res = await sql.query(
      `UPDATE insider_trades SET superseded_by = $1
       WHERE issuer_cik = $2 AND owner_cik = $3 AND period_of_report = $4
         AND is_amendment = false AND accession <> $1 AND superseded_by IS NULL
       RETURNING 1`,
      [a.accession, a.issuerCik, a.ownerCik, a.periodOfReport],
    );
    n += res.length;
  }
  return n;
}

// ─── main ──────────────────────────────────────────────────────────────────
(async () => {
  const prior = RESUME ? await loadState() : null;
  const startFrom = prior?.cursor_date
    ? addDays(new Date(prior.cursor_date), -1)
    : new Date(arg('from', iso(new Date())));
  const targetFrom = prior?.target_from
    ? new Date(prior.target_from)
    : addDays(new Date(), -Math.round(YEARS * 365.25));

  console.log(`[backfill] ${iso(startFrom)} → back to ${iso(targetFrom)}`);
  console.log(`[backfill] storing codes: ${KEEP_ALL ? 'ALL' : [...KEEP_CODES].join(',')}   rps=${RPS}${DRY ? '   DRY RUN' : ''}`);

  const tally = {
    filingsSeen: Number(prior?.filings_seen || 0),
    filingsParsed: Number(prior?.filings_parsed || 0),
    rowsWritten: Number(prior?.rows_written || 0),
    rowsQuarantined: Number(prior?.rows_quarantined || 0),
  };
  let skippedByCode = 0, superseded = 0, amendmentsSeen = 0, daysDone = 0;
  const t0 = Date.now();

  for (let day = startFrom; day >= targetFrom && daysDone < MAX_DAYS; day = addDays(day, -1)) {
    const dayStr = iso(day);
    let dayRows = [], dayQuar = [], dayAmend = [];
    const { filings } = await filingsForDay(dayStr);
    if (!filings.length) { if (!DRY) await saveState({ ...tally, cursorDate: dayStr, targetFrom: iso(targetFrom) }); continue; }

    tally.filingsSeen += filings.length;
    for (const f of filings) {
      const res = await paced(f.docUrl);
      if (!res || !res.ok) continue;
      const txt = await res.text();
      const xml = txt.match(/<\?xml[\s\S]*?<\/ownershipDocument>/)?.[0] || txt;
      let out;
      try { out = parseForm4(xml, f); }
      catch (e) {
        dayQuar.push({ accession: f.accession, reason: 'PARSE_FAILED', detail: e.message, filingDate: dayStr, rawUrl: f.docUrl, parsed: null });
        continue;
      }
      tally.filingsParsed++;
      if (out.meta?.isAmendment) { amendmentsSeen++; dayAmend.push({ accession: f.accession, ...out.meta }); }
      for (const r of out.rows) {
        if (!KEEP_ALL && !KEEP_CODES.has(r.transactionCode)) { skippedByCode++; continue; }
        dayRows.push(r);
      }
      dayQuar.push(...out.quarantine);
    }

    const w = await insertRows(dayRows);
    const q = await insertQuarantine(dayQuar);
    superseded += await applyAmendments(dayAmend);
    tally.rowsWritten += w; tally.rowsQuarantined += q;
    daysDone++;

    // Cursor commits only after the day is fully written — an interrupted run redoes
    // at most one day, and redoing is free because inserts are idempotent.
    await saveState({ ...tally, cursorDate: dayStr, targetFrom: iso(targetFrom) });

    const mins = (Date.now() - t0) / 60000;
    console.log(`${dayStr}  filings ${String(filings.length).padStart(4)}  +rows ${String(w).padStart(4)}  quar ${String(q).padStart(3)}  | total rows ${tally.rowsWritten}  ${mins.toFixed(1)}m elapsed`);
  }

  // Record what we can honestly claim to cover. The UI phrases every historical badge
  // against covered_from, so this is what stops us saying "first buy ever".
  if (!DRY) {
    const r = await sql.query(`SELECT min(filing_date)::text mn, max(filing_date)::text mx FROM insider_trades`);
    await sql.query(
      `UPDATE insider_history_meta SET covered_from = $1, covered_to = $2, complete = $3, note = $4, updated_at = now() WHERE id = 1`,
      [r[0]?.mn || null, r[0]?.mx || null, daysDone < MAX_DAYS, `backfill ${iso(targetFrom)}..${iso(startFrom)}, codes=${KEEP_ALL ? 'ALL' : [...KEEP_CODES].join(',')}`],
    );
  }

  console.log(`\n[backfill] days ${daysDone}  filings seen ${tally.filingsSeen}  parsed ${tally.filingsParsed}`);
  console.log(`[backfill] rows written ${tally.rowsWritten}  enriched-existing ${enriched}  quarantined ${tally.rowsQuarantined}  skipped-by-code ${skippedByCode}`);
  console.log(`[backfill] amendments ${amendmentsSeen}  originals marked superseded ${superseded}`);
  console.log(`[backfill] elapsed ${((Date.now() - t0) / 60000).toFixed(1)} min`);
})();
