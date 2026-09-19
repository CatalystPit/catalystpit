import { and, eq, gte, sql, desc, isNull, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { fundHoldings, fundFilings, institutions } from './schema';
import { INSTITUTIONS } from './institutions.mjs';
import { quarterUnchanged, infoTableDetector, infoTableBlocks, fieldMatcher } from './institutions-quarter.mjs';
import { resolveCusips, reresolveCusips } from './security-resolver';
import { resolveIssuerItems } from './name-resolver';

// ─────────────────────────────────────────────────────────────────────────────
//  INSTITUTIONS UNIVERSE (Phase 2) — auto-discover EVERY SEC 13F filer from the
//  quarterly full-index (no curated list), register them in `institutions`, and
//  ingest their 13F-HR holdings (amendment-aware) into fund_holdings/fund_filings.
//  CUSIP→ticker via the shared security-resolver. The existing ~57 curated funds
//  are flagged as FEATURED (their slugs/labels preserved) but no longer gate what
//  gets ingested. Bounded per run; drive to full coverage/depth across runs.
// ─────────────────────────────────────────────────────────────────────────────

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BACKFILL_QUARTERS = Math.max(1, parseInt(process.env.INSTITUTIONS_BACKFILL_QUARTERS || '4', 10) || 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad10 = (c) => String(c).replace(/\D/g, '').padStart(10, '0');
const unpad = (c) => String(Number(String(c).replace(/\D/g, '')));
const slugify = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// SEC enforces fair access by BLOCKING the IP with 403, not by returning 429, and a blocked host
// keeps burning through filers finding nothing, which looks exactly like "the backfill is done".
// One 403 stops the whole run: there is no point issuing another request, and continuing to hammer
// a blocked endpoint is what extends the block.
let _secBlockedUntil = 0;
export const secBlocked = () => Date.now() < _secBlockedUntil;
const SEC_COOLDOWN_MS = 15 * 60 * 1000;

// ── 503 IS "TRY AGAIN", NOT "THIS FILING HAS NO HOLDINGS" ────────────────────
//
// EDGAR's Archives host sheds load with 503 and an HTML page titled "File Unavailable". It is
// transient and it is per-request: measured on live accessions, index.json returned 503, 503, then
// 200 on the third attempt for two different filers, while other documents inside the SAME accession
// answered 200 throughout. It is not a rate-limit signal, not a block, and not a missing file.
//
// Treating it as failure was quietly destroying the backfill. secFetch returned null, secJson turned
// that into null, fetchHoldings turned that into [], and ingestFiler read [] as "this quarter has
// nothing to store" and moved on — no error, no retry, filer counted as done. A run processing 38
// filers stored 1 quarter and looked healthy the whole way.
//
// 403 keeps its own meaning and its own path: SEC enforces fair access by blocking the IP, so one
// 403 still stops everything for the cooldown. These retries are for the load-shedding case only,
// they are few, and they back off.
// ⚠️ 429 IS NOT IN THIS SET, AND PUTTING IT THERE MADE THINGS WORSE.
//
// 503 means "this object is unavailable right now" — a fast retry is the correct response and it
// works. 429 means "you are sending too many requests", and retrying three more times inside seven
// seconds is the opposite of what was asked. Worse, it compounds: the three-route fallback tries
// each filing by three different URLs, so under a 429 every filing cost up to twelve requests
// instead of four, at the exact moment SEC was asking for fewer. Measured live — the crawler reached
// 26.6 filers/min and then www.sec.gov/Archives began returning 429 on every request while
// data.sec.gov still answered 200; quarters and holdings stopped advancing entirely while the
// unreadable count climbed 10 to 27 in under three minutes.
//
// A 429 now stops the whole pool exactly as a 403 does, because both mean "stop asking".
const SEC_RETRY_STATUS = new Set([502, 503, 504]);
const SEC_THROTTLE_STATUS = new Set([403, 429]);
const SEC_MAX_ATTEMPTS = 4;

// The classification itself, separated so it can be asserted without making a request. The set
// membership is the whole policy, and it is exactly what regressed: 429 sitting in the retry set
// looked harmless and caused the incident. A test that can only reach this through fetch() cannot
// catch that, so the decision is a pure function.
//   'throttle' — stop the entire pool for a while (403, 429)
//   'retry'    — this object is flaky, try it again shortly (502, 503, 504)
//   'final'    — take the response as the answer, success or not
export function secStatusAction(status) {
  if (SEC_THROTTLE_STATUS.has(status)) return 'throttle';
  if (SEC_RETRY_STATUS.has(status)) return 'retry';
  return 'final';
}
const SEC_THROTTLE_DEFAULT_MS = 5 * 60 * 1000;
export const secRetryDelayMs = (attempt) => 1000 * 2 ** (Math.max(1, attempt) - 1);   // 1s, 2s, 4s

// SEC sends Retry-After on some 429s. Honouring it is both more polite and more accurate than a
// guess, but it is attacker-free input from a server we already trust, so it is clamped: a missing,
// malformed or absurd value falls back to the default rather than parking the run for a day.
export function secThrottleWaitMs(retryAfter, status) {
  const base = status === 403 ? SEC_COOLDOWN_MS : SEC_THROTTLE_DEFAULT_MS;
  const secs = Number(String(retryAfter ?? '').trim());
  if (!Number.isFinite(secs) || secs <= 0) return base;
  return Math.min(Math.max(secs * 1000, 1000), 60 * 60 * 1000);
}

// ── ONE GLOBAL PACER, BECAUSE PER-WORKER SLEEPS DO NOT BOUND A RATE ──────────
//
// The per-quarter and per-document sleeps are per worker, so the actual request rate was whatever
// the pool size happened to make it — and the three-route fallback multiplied it again on exactly
// the filings that were already failing. That is how a run at 26.6 filers/min walked into a 429.
//
// This is the one place every SEC request passes through, so it is the only place a rate can
// actually be bounded. 200ms between requests is a ceiling of 5/s against SEC's published guidance
// of 10/s, and it holds no matter how many workers there are or how many routes a filing needs.
let _secNextSlot = 0;
const SEC_MIN_GAP_MS = 200;
async function secPace() {
  const now = Date.now();
  const slot = Math.max(now, _secNextSlot);
  _secNextSlot = slot + SEC_MIN_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

async function secFetch(url) {
  if (secBlocked()) return null;
  for (let attempt = 1; attempt <= SEC_MAX_ATTEMPTS; attempt++) {
    await secPace();
    try {
      const r = await fetch(url, { headers: SEC_HEADERS, cache: 'no-store' });
      const action = secStatusAction(r.status);
      if (action === 'throttle') {
        try { await r.body?.cancel?.(); } catch { /* nothing to release */ }
        const wait = secThrottleWaitMs(r.headers.get('retry-after'), r.status);
        _secBlockedUntil = Date.now() + wait;
        console.log(`[institutions-universe] SEC returned ${r.status}: pausing every worker for ` +
          `${(wait / 60000).toFixed(1)} min`);
        return null;
      }
      if (action === 'retry' && attempt < SEC_MAX_ATTEMPTS) {
        try { await r.body?.cancel?.(); } catch { /* nothing to release */ }
        await sleep(secRetryDelayMs(attempt));
        continue;
      }
      return r.ok ? r : null;
    } catch {
      if (attempt >= SEC_MAX_ATTEMPTS) return null;
      await sleep(secRetryDelayMs(attempt));
    }
  }
  return null;
}
async function secJson(url) { const r = await secFetch(url); if (!r) return null; try { return await r.json(); } catch { return null; } }
async function secText(url) { const r = await secFetch(url); if (!r) return null; try { return await r.text(); } catch { return null; } }
async function kvGet(k) { if (!KV_URL || !KV_TOKEN) return null; try { const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } }); if (!r.ok) return null; return (await r.json())?.result ?? null; } catch { return null; } }

let _ensured = false;
export async function ensureUniverseTables() {
  if (_ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS institutions (
    cik TEXT PRIMARY KEY, name TEXT, slug TEXT, featured_label TEXT, manager TEXT, category TEXT,
    first_seen_quarter DATE, last_quarter DATE, filing_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_institutions_slug ON institutions (slug)`);
  await db.execute(sql`ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS accession TEXT`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ticker_institutional_ownership (
    ticker TEXT PRIMARY KEY, as_of_quarter DATE, inst_shares DOUBLE PRECISION, inst_value DOUBLE PRECISION,
    filer_count INTEGER, shares_out DOUBLE PRECISION, ownership_pct DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _ensured = true;
}

// Nightly recompute of 13F-reported institutional ownership per ticker. For each fund we take its
// LATEST filed quarter, sum COMMON-stock shares (puts/calls excluded) per ticker, divide by shares
// outstanding (screener_meta → ticker_float fallback). Full refresh (delete + insert) so tickers that
// dropped to zero holders don't linger. `as_of_quarter` = newest contributing quarter per ticker.
export async function runOwnershipAggregate() {
  await ensureUniverseTables();
  const t0 = Date.now();
  await db.execute(sql`DELETE FROM ticker_institutional_ownership`);
  const res = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (cik) cik, quarter
      FROM fund_filings
      ORDER BY cik, quarter DESC
    ),
    -- THE SECURITY THE TICKER NAMES, exactly as fund_net_qoq decides it (17421db). This aggregate
    -- summed every CUSIP mapped to a ticker, and a convertible note's shares column is FACE VALUE,
    -- so note principal was added to share counts. Measured: Akamai's institutional holding came out
    -- at 2,984M shares against 144M outstanding — 2,077% — and removing non-equity CUSIPs brought it
    -- to 218M. Etsy 1,946M -> 152M. The denominator was never the problem.
    --
    -- The primary CUSIP is the one carrying the most positions for the ticker, and it only ever
    -- PROTECTS a security from exclusion: filers describe a bond ETF with bond words, so classifying
    -- in isolation deletes BSV, VCSH, GOVT and VGIT outright.
    primary_cusip AS (
      SELECT DISTINCT ON (ticker) ticker, cusip
        FROM (SELECT h.ticker, h.cusip, count(*)::int c
                FROM fund_holdings h JOIN latest l ON l.cik = h.cik AND l.quarter = h.quarter
               WHERE h.ticker IS NOT NULL AND coalesce(h.put_call, '') = ''
               GROUP BY h.ticker, h.cusip) z
       ORDER BY ticker, c DESC, cusip
    ),
    -- A derivative most filers label as one is never a share position, whatever CUSIP it sits on.
    -- Same rule as 228d140: a blank put_call on a (cusip, class) that the majority of filers report
    -- WITH an explicit put_call is one filer omitting the field.
    mislabelled_option AS (
      SELECT f.cusip, f.class
        FROM fund_holdings f
        JOIN latest l2 ON l2.cik = f.cik AND l2.quarter = f.quarter
        JOIN security_position_class s
          ON s.cusip = f.cusip AND s.cls = f.class AND s.put_call = ''
       WHERE s.kind IN ('option', 'warrant', 'right')
       GROUP BY f.cusip, f.class
      HAVING count(*) FILTER (WHERE coalesce(f.put_call, '') <> '')
           > count(*) FILTER (WHERE coalesce(f.put_call, '') = '')
    ),
    scoped AS (
      SELECT h.ticker, h.cik, h.quarter, h.cusip, h.shares, h.value, h.accession, h.filed_date
        FROM fund_holdings h
        JOIN latest l ON l.cik = h.cik AND l.quarter = h.quarter
        LEFT JOIN primary_cusip p ON p.ticker = h.ticker
        LEFT JOIN security_position_class s
          ON s.cusip = h.cusip AND s.cls = h.class AND s.put_call = h.put_call
        LEFT JOIN mislabelled_option m ON m.cusip = h.cusip AND m.class = h.class
       WHERE h.ticker IS NOT NULL
         AND coalesce(h.put_call, '') = ''
         AND coalesce(h.shares, 0) > 0
         AND m.cusip IS NULL
         AND (h.cusip = p.cusip
              OR s.kind IS NULL
              OR s.kind NOT IN ('debt', 'option', 'warrant', 'right', 'preferred'))
    ),
    -- AMENDMENTS. A 13F-HR/A restates what it re-lists, so an original and its amendment must not
    -- both contribute. Latest filing per (cik, quarter, cusip) wins.
    pick AS (
      SELECT DISTINCT ON (cik, quarter, cusip) cik, quarter, cusip, accession
        FROM scoped ORDER BY cik, quarter, cusip, filed_date DESC NULLS LAST, accession DESC
    ),
    kept AS (
      SELECT sc.* FROM scoped sc
        JOIN pick pk ON pk.cik = sc.cik AND pk.quarter = sc.quarter
                    AND pk.cusip = sc.cusip AND pk.accession = sc.accession
    ),
    agg AS (
      SELECT kept.ticker,
             SUM(kept.shares)::double precision AS inst_shares,
             SUM(kept.value)::double precision  AS inst_value,
             COUNT(DISTINCT kept.cik)           AS filer_count,
             MAX(kept.quarter)                  AS as_of
      FROM kept
      GROUP BY kept.ticker
    )
    INSERT INTO ticker_institutional_ownership
      (ticker, as_of_quarter, inst_shares, inst_value, filer_count, shares_out, ownership_pct, updated_at)
    SELECT a.ticker, a.as_of, a.inst_shares, a.inst_value, a.filer_count,
           so.shares_out,
           CASE WHEN so.shares_out > 0 THEN a.inst_shares / so.shares_out * 100 ELSE NULL END,
           now()
    FROM agg a
    LEFT JOIN LATERAL (
      SELECT coalesce(sm.shares_out, tf.outstanding_shares) AS shares_out
      FROM (SELECT 1) x
      LEFT JOIN screener_meta sm ON sm.ticker = a.ticker
      LEFT JOIN ticker_float  tf ON tf.ticker = a.ticker
    ) so ON true
  `);
  const [{ n } = { n: 0 }] = (await db.execute(sql`SELECT count(*)::int AS n FROM ticker_institutional_ownership`))?.rows || [];
  return { tickers: n || 0, ms: Date.now() - t0 };
}

// Map unpadded CIK → curated featured info (slug/label/manager/category) so featured funds keep their
// pages. Seeded CIKs come from the config; the rest reuse the CIK the curated cron cached in KV.
// MEMOISED. This issues one KV read per curated fund that lacks a hard-coded CIK, and it is called
// twice per ingest pass. A long-running driver loop therefore turned a static lookup into tens of
// thousands of Redis commands and helped exhaust the Upstash request quota, which takes the news
// page and every other KV-cached route down with it. The curated list is a constant within a
// process, so reading it once is enough.
let _featuredMap = null;
export async function buildFeaturedMap() {
  if (_featuredMap) return _featuredMap;
  const map = new Map();
  for (const f of INSTITUTIONS) {
    let cik = f.cik ? unpad(f.cik) : await kvGet(`catalystpit:inst:cik:${f.slug}`);
    if (cik) map.set(unpad(cik), { slug: f.slug, label: f.label, manager: f.manager, category: f.category });
  }
  _featuredMap = map;
  return map;
}

// The n most recent SEC full-index quarters (for filer discovery). server-side Date is fine here.
function recentQuarters(n) {
  const d = new Date();
  let y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3) + 1;
  const out = [];
  for (let i = 0; i < n; i++) { out.push({ y, q }); q--; if (q < 1) { q = 4; y--; } }
  return out;
}
// Earliest report-quarter-end we ingest (BACKFILL_QUARTERS back from the current quarter).
function backfillCutoff() {
  const d = new Date();
  let y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3) + 1;
  for (let i = 0; i < BACKFILL_QUARTERS; i++) { q--; if (q < 1) { q = 4; y--; } }
  const endMonth = q * 3;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// Parse a pipe-delimited SEC master.idx → distinct 13F-HR filers { cik(unpadded) → name }.
function parseMasterIdx(text, into) {
  const lines = text.split('\n');
  let started = false;
  for (const line of lines) {
    if (!started) { if (/^-{5,}/.test(line) || /^CIK\|/.test(line)) { started = true; } continue; }
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [cik, name, form] = parts;
    if (!String(form).startsWith('13F-HR')) continue;   // 13F-HR + 13F-HR/A
    const c = unpad(cik);
    if (c && c !== '0' && !into.has(c)) into.set(c, name.trim());
  }
}

// Discover all 13F filers from the recent quarterly indexes → upsert into `institutions`.
export async function discoverFilers({ indexes = 2, featured } = {}) {
  await ensureUniverseTables();
  const feat = featured || await buildFeaturedMap();
  const filers = new Map();
  for (const { y, q } of recentQuarters(indexes)) {
    const txt = await secText(`https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/master.idx`);
    if (txt) parseMasterIdx(txt, filers);
    await sleep(150);
  }
  let registered = 0;
  const rows = [...filers.entries()].map(([cik, name]) => {
    const f = feat.get(cik);
    return { cik, name, slug: f?.slug || slugify(name) || `cik-${cik}`, featuredLabel: f?.label || null, manager: f?.manager || null, category: f?.category || null, updatedAt: new Date() };
  });
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300);
    await db.insert(institutions).values(batch).onConflictDoUpdate({
      target: institutions.cik,
      set: { name: sql`excluded.name`, slug: sql`coalesce(institutions.slug, excluded.slug)`, featuredLabel: sql`coalesce(excluded.featured_label, institutions.featured_label)`, manager: sql`coalesce(excluded.manager, institutions.manager)`, category: sql`coalesce(excluded.category, institutions.category)`, updatedAt: sql`now()` },
    });
    registered += batch.length;
  }
  return { discovered: filers.size, registered };
}

// ── holdings parsing (ported from the curated cron) ──
function parseInfoTable(xml, wholeDollars) {
  // Strip CDATA wrappers + collapse whitespace so issuer names are clean (drives logo/name resolution).
  const tag = (block, name) => { const m = block.match(fieldMatcher(name)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : ''; };
  const rows = [];
  const blocks = xml.match(infoTableBlocks()) || [];
  for (const b of blocks) {
    const cusip = tag(b, 'cusip').toUpperCase();
    if (!cusip) continue;
    const rawValue = parseFloat(tag(b, 'value').replace(/,/g, '')) || 0;
    const shares = parseFloat(tag(b, 'sshPrnamt').replace(/,/g, '')) || 0;
    rows.push({ issuer: tag(b, 'nameOfIssuer'), cls: tag(b, 'titleOfClass') || '', cusip, value: wholeDollars ? rawValue : rawValue * 1000, shares, putCall: tag(b, 'putCall') || '' });
  }
  return rows;
}
// Returns the parsed positions, or NULL when the filing could not be read at all.
//
// The distinction is the whole point. An empty array means "we read this filing and it reports no
// positions", which is a real thing a 13F can say. Null means "we could not see the filing" — the
// directory listing was unavailable after retries, or none of its documents could be fetched. Those
// two were the same value before, so an unreachable filing was indistinguishable from an empty one
// and the caller skipped it without a word.
// The XML documents named by a filing's index PAGE, as bare filenames.
//
// EDGAR lists each document twice: once as the raw file and once under an `xslForm13F_X02/` prefix,
// which is the same document rendered as HTML for a browser and useless to the parser. Taking only
// the basename collapses the pair, so the raw file is fetched once rather than the rendering being
// fetched as well and discarded. A regex that silently matches nothing here would not raise anything
// — the route would just quietly contribute no candidates — which is why it is separated and tested.
export function documentNamesFromIndexHtml(html) {
  if (typeof html !== 'string') return [];
  return [...new Set([...html.matchAll(/href="[^"]*?\/([^"/]+\.xml)"/gi)].map((m) => m[1]))];
}

// ── THREE ROUTES TO THE SAME FILING, BECAUSE EDGAR 503s PER OBJECT ───────────
//
// The 503s are not global throttling and not a block: probed while the crawler was stopped and SEC
// was answering 200 everywhere else, individual URLs still returned "File Unavailable" persistently,
// and WHICH url fails varies within a single accession. Measured on live failures:
//
//   CIK 2039437  index.json 503 …but -index.htm and the .txt submission both 200
//   CIK 902367   index.json 200 …but the infotable.xml it names 503
//   CIK 2006218  index.json 503 …but the .txt submission 200, info table intact
//
// One route is therefore not enough, and retrying it harder does not help — the object itself is
// what is unavailable. These are three independent EDGAR objects for the same filing, so trying the
// next one costs a request only on a path that has already failed, and turns what would be a
// permanent hole in the dataset into a stored quarter. Nothing about the parse changes: whichever
// route supplies the XML, the same parseInfoTable reads it.
async function fetchHoldings(cik, accession, filedDate) {
  const accNoDash = accession.replace(/-/g, '');
  const dir = `https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accNoDash}`;
  const wholeDollars = String(filedDate) >= '2023-01-01';
  const hasTable = (s) => !!s && infoTableDetector().test(s);
  let readSomething = false;         // did ANY route let us see inside the filing?
  let missedDocument = false;        // did a document we were told about fail to load?

  // Fetch each named document, newest-style names first, and stop at the one holding the table.
  const tryDocuments = async (names) => {
    for (const name of [...new Set(names)].filter((n) => !/^primary_doc\.xml$/i.test(n))) {
      await sleep(100);
      const xml = await secText(`${dir}/${name}`);
      if (xml == null) { missedDocument = true; continue; }
      readSomething = true;
      if (hasTable(xml)) return parseInfoTable(xml, wholeDollars);
    }
    return null;
  };

  // ROUTE 1 — the directory listing. The cheapest and the one that works most of the time.
  const idx = await secJson(`${dir}/index.json`);
  if (idx) {
    readSomething = true;
    const names = (idx.directory?.item || []).map((it) => it.name).filter((n) => /\.xml$/i.test(n));
    const got = await tryDocuments(names);
    if (got) return got;
  }

  // ROUTE 2 — the filing index page, which names the same documents in HTML. Only the basename is
  // taken, so the xsl-rendered copy collapses onto the raw file rather than being fetched twice.
  const htm = await secText(`${dir}/${accession}-index.htm`);
  if (htm) {
    readSomething = true;
    const got = await tryDocuments(documentNamesFromIndexHtml(htm));
    if (got) return got;
  }

  // ROUTE 3 — the complete submission, every document of the filing concatenated in one object. The
  // info table is embedded verbatim, so the same parser reads it; documents without an <infoTable>
  // contribute no rows.
  const txt = await secText(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accession}.txt`);
  if (txt != null) {
    readSomething = true;
    if (hasTable(txt)) return parseInfoTable(txt, wholeDollars);
  }

  // Null means "we never got to see this filing", and the caller must not store the quarter. An empty
  // array is only honest when a route actually opened the filing AND every document it named loaded —
  // otherwise a 503 on one document would masquerade as a 13F reporting no positions.
  if (!readSomething || missedDocument) return null;
  return [];
}

// EVERY 13F-HR filing per report-quarter, oldest first. Which ones actually count is decided by
// resolveQuarter() below, because "latest filed wins" is wrong for 13F.
function filings13F(sub, cutoff) {
  const R = sub.filings?.recent || {};
  const byQ = new Map();
  for (let i = 0; i < (R.form || []).length; i++) {
    const form = String(R.form[i]);
    if (!form.startsWith('13F-HR')) continue;
    const q = R.reportDate?.[i]; if (!q || q < cutoff) continue;
    if (!byQ.has(q)) byQ.set(q, []);
    byQ.get(q).push({ quarter: q, form, accession: R.accessionNumber[i], filedDate: R.filingDate[i] });
  }
  for (const list of byQ.values()) {
    list.sort((a, b) => (a.filedDate === b.filedDate ? (a.accession < b.accession ? -1 : 1) : (a.filedDate < b.filedDate ? -1 : 1)));
  }
  return [...byQ.entries()].map(([quarter, list]) => ({ quarter, list }));
}

// The amendment type lives on the COVER PAGE, in primary_doc.xml, which the holdings parser skips.
// The SEC defines exactly two, and they mean opposite things:
//   RESTATEMENT   this filing replaces the original holdings in full
//   NEW HOLDINGS  this filing carries ONLY positions being ADDED to what was already reported
// Treating the second as the first discards the original filing. Measured on live data: ExodusPoint's
// Q1 2026 went from 1,454 positions to 41, Nomura's from 1,714 to 1.
async function amendmentInfo(cik, accession) {
  const xml = await secText(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accession.replace(/-/g, '')}/primary_doc.xml`);
  if (!xml) return { isAmendment: null, amendmentType: null };     // unknown: treated conservatively below
  const pick = (n) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${n}>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
  return { isAmendment: /true/i.test(pick('isAmendment')), amendmentType: pick('amendmentType') || null };
}

// Decide which filings compose a quarter: one BASE plus any additive amendments layered on top.
// A single filing needs no cover-page fetch, which is the overwhelming majority of quarters.
async function resolveQuarter(cik, list) {
  if (list.length === 1) return { base: list[0], additive: [] };
  // Only an amendment can BE additive, and the form type already tells us which filings are
  // amendments. Fetching the cover page for originals too cost ~26 extra seconds per filer and
  // dropped the backfill from ~126 filers an hour to under 13. A 13F-HR is a restatement by
  // definition, so it needs no cover-page lookup.
  const marked = [];
  for (const f of list) {
    if (!f.form.endsWith('/A')) { marked.push({ ...f, isAmendment: false, amendmentType: null }); continue; }
    marked.push({ ...f, ...(await amendmentInfo(cik, f.accession)) });
    await sleep(80);
  }
  const isAdditive = (f) => /NEW\s*HOLDINGS/i.test(f.amendmentType || '');
  // Base = the last filing that restates the whole portfolio: an original, or an explicit
  // RESTATEMENT. An amendment whose type we could not read is treated as a restatement, which is
  // the conservative reading: it keeps today's behaviour rather than silently layering.
  let baseIdx = -1;
  for (let i = marked.length - 1; i >= 0; i--) { if (!isAdditive(marked[i])) { baseIdx = i; break; } }
  if (baseIdx === -1) baseIdx = 0;                    // every filing is additive: layer onto the first
  const base = marked[baseIdx];
  // Only additive amendments filed AFTER the base apply; anything before it was superseded by it.
  const additive = marked.slice(baseIdx + 1).filter(isAdditive);
  return { base, additive };
}

// A large manager reports the SAME security across many sub-accounts (BlackRock lists NVIDIA dozens of
// times). The filer's true position is the SUM. Our unique key is (cik,quarter,cusip,class,putCall), so
// we MUST aggregate here — otherwise onConflictDoNothing keeps one arbitrary sub-account and badly
// undercounts (BlackRock NVIDIA showed $12B vs the real ~$247B). SEC's own total_value sums these too.
function aggregateHoldings(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.cusip}|${r.cls || ''}|${r.putCall || ''}`;
    const e = by.get(k);
    // Sub-accounts WITHIN a filing sum. A position restated by a LATER filing replaces rather than
    // adds, or an additive amendment correcting a position would double it.
    if (e && e.accession === r.accession) { e.value += r.value || 0; e.shares += r.shares || 0; }
    else if (e) { by.set(k, { ...r, value: r.value || 0, shares: r.shares || 0 }); }
    else by.set(k, { ...r, value: r.value || 0, shares: r.shares || 0 });
  }
  return [...by.values()];
}

// Store a filing; supersede any prior accession for the same (cik, quarter) — amendments fully restate.
async function storeFilingSuperseded(cik, quarter, filedDate, accession, rows) {
  const agg = aggregateHoldings(rows);   // sum sub-account rows → one total position per security
  const [existing] = await db.select().from(fundFilings).where(and(eq(fundFilings.cik, cik), eq(fundFilings.quarter, quarter))).limit(1);
  if (existing) {
    // A quarter is now composed of a base filing PLUS any additive amendments, so the head accession
    // alone no longer identifies what is stored. Comparing the position count as well makes the
    // ingest self-healing: a quarter written by the old restatement-only logic has the same head
    // accession but far fewer positions, and gets rewritten instead of skipped.
    if (existing.accession === accession && existing.holdingsCount === agg.length) return { skipped: true };
    if (String(existing.filedDate || '') > String(filedDate)) return { older: true };   // keep the newer existing
    await db.delete(fundHoldings).where(and(eq(fundHoldings.cik, cik), eq(fundHoldings.quarter, quarter)));
  }
  // Each row keeps the accession it actually came from, so a quarter composed of an original plus an
  // additive amendment stays traceable position by position to the SEC document that reported it.
  const values = agg.map((r) => ({ cik, quarter, cusip: r.cusip, ticker: null, issuer: r.issuer, cls: r.cls, shares: r.shares, value: r.value, putCall: r.putCall, filedDate: r.filedDate || filedDate, accession: r.accession || accession }));
  for (let i = 0; i < values.length; i += 500) await db.insert(fundHoldings).values(values.slice(i, i + 500)).onConflictDoNothing();
  const totalValue = agg.reduce((s, r) => s + (r.value || 0), 0);
  await db.insert(fundFilings).values({ cik, quarter, filedDate, accession, totalValue, holdingsCount: agg.length })
    .onConflictDoUpdate({ target: [fundFilings.cik, fundFilings.quarter], set: { filedDate: sql`excluded.filed_date`, accession: sql`excluded.accession`, totalValue: sql`excluded.total_value`, holdingsCount: sql`excluded.holdings_count` } });
  return { stored: rows.length };
}

// Ingest one filer's 13F holdings for the backfill window.
//
// `skipUnchanged` is OFF by default, so the production cron path is byte-for-byte what it was.
// The historical backfill turns it on, and it matters a great deal there: the runner walks filers
// that are missing OLD quarters, but ingestFiler re-walks every quarter at or after the cutoff —
// including the recent ones the filer already has. Measured on the live registry: 33,163 of those
// quarters are already stored across the remaining filers, ~3.4 per filer out of ~8. Each one was
// being downloaded and parsed in full before storeFilingSuperseded looked at it and returned
// `{ skipped: true }`. The download is the expensive part; the skip came too late to save it.
//
// ⚠️ THE SKIP RULE IS DELIBERATELY NARROWER THAN THE STORE-TIME ONE, and the difference is the point.
// storeFilingSuperseded also rewrites when `existing.holdingsCount !== agg.length`, which is how a
// quarter written by the old restatement-only logic heals itself — it has the same head accession but
// far fewer positions. That check needs the fetched holdings, so it cannot be made in advance.
// Instead we skip ONLY a quarter with exactly one filing whose accession is the stored one. With a
// single filing there are no amendments to layer, so the old logic and the current logic produce
// identical rows and there is nothing for the count check to heal. Every multi-filing quarter — 81 of
// 33,163 here — still takes the full path.
export async function ingestFiler(cik, cutoff, { skipUnchanged = false } = {}) {
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
  // Could not read the index at all — we never got to look. NOT evidence the filer has nothing.
  if (!sub) return { cik, status: 'failed', error: 'no-submissions', quarters: 0, stored: 0, skipped: 0, unresolved: [], unreadable: [] };
  const filings = filings13F(sub, cutoff);
  // ONE indexed read replaces those ~3.4 SEC round trips per filer.
  const known = new Map();
  if (skipUnchanged) {
    const have = await db.select({ quarter: fundFilings.quarter, accession: fundFilings.accession })
      .from(fundFilings).where(eq(fundFilings.cik, cik));
    for (const h of have) if (h.accession) known.set(String(h.quarter), h.accession);
  }
  let stored = 0, quarters = 0, skipped = 0;
  const unresolved = [];
  for (const { quarter, list } of filings) {
    if (quarterUnchanged(list, known.get(String(quarter)))) { skipped++; continue; }
    const { base, additive } = await resolveQuarter(cik, list);
    // Compose the quarter: the restating filing, then any additive amendments layered on top in the
    // order they were filed. Every row carries its own accession.
    const parts = [base, ...additive];
    let rows = [];
    let failed = false;
    for (const p of parts) {
      const got = await fetchHoldings(cik, p.accession, p.filedDate);
      // A part we could not read makes the WHOLE quarter untrustworthy, not merely smaller. Storing
      // the parts that did load would silently publish an incomplete quarter — the same shape of
      // error as treating an additive amendment as a restatement.
      if (got === null) { failed = true; break; }
      for (const r of got) rows.push({ ...r, accession: p.accession, filedDate: p.filedDate });
      await sleep(80);
    }
    // Reported so the caller can retry the filer later. Left uncounted, this is the hole the run
    // cannot see: the quarter is absent and everything says the filer was processed successfully.
    if (failed) { unresolved.push({ quarter, reason: 'unreadable' }); continue; }
    // A 13F-HR THAT PARSES TO NOTHING IS NOT AN EMPTY QUARTER.
    //
    // A manager files a 13F because it holds at least $100M in reportable securities, so "we read
    // the filing and it reports no positions" is very nearly a contradiction. Treating it as one
    // more empty result is how BNP Paribas lost six consecutive quarters: the documents downloaded
    // perfectly, an attribute on <infoTable> defeated the match, zero rows came back, and
    // `if (!rows.length) continue` moved on without a trace. Recorded, not skipped.
    if (!rows.length) { unresolved.push({ quarter, reason: 'no-positions-parsed' }); continue; }
    const head = parts[parts.length - 1];   // newest accession represents the quarter in fund_filings
    const res = await storeFilingSuperseded(cik, quarter, head.filedDate, head.accession, rows);
    if (res.stored) { stored += res.stored; quarters++; }
  }
  // update registry summary
  try {
    const [agg] = await db.select({ n: sql`count(*)`.mapWith(Number), last: sql`max(${fundFilings.quarter})`, first: sql`min(${fundFilings.quarter})` }).from(fundFilings).where(eq(fundFilings.cik, cik));
    await db.update(institutions).set({ name: sub.name || undefined, filingCount: agg?.n || 0, lastQuarter: agg?.last || null, firstSeenQuarter: agg?.first || null, updatedAt: new Date() }).where(eq(institutions.cik, cik));
  } catch { /* non-fatal */ }
  // ── SUCCESS HAS TO MEAN THE WORK ACTUALLY HAPPENED ─────────────────────────
  //
  // Three outcomes, never conflated, because the whole class of bug being fixed here is one of them
  // wearing another's clothes:
  //   complete — every quarter at or after the cutoff was stored, or was already stored unchanged
  //   partial  — some quarters could not be resolved; they are named, with why, and can be retried
  //   failed   — the filer's submissions index was unreadable, so NOTHING could even be attempted
  //
  // `failed` is emphatically not the same as "this filer has no filings". It means we never got to
  // look, which is the exact confusion that let a run report success while skipping real filings.
  const status = unresolved.length ? 'partial' : 'complete';
  return { cik, status, quarters, stored, skipped, unresolved, unreadable: unresolved.map((u) => u.quarter) };
}

// Resolve tickers for holdings, draining the backlog of NEVER-ATTEMPTED CUSIPs (not yet in
// cusip_map), highest-value first. Excluding CUSIPs already in cusip_map stops the resolver from
// re-thrashing permanently-unmappable bonds/foreign that clog the top-by-value slots. Chunked +
// time-bounded so a big cap stays within maxDuration.
export async function resolveHoldingTickers({ cap = 500, timeBudgetMs = 200000, t0 = Date.now() } = {}) {
  const res = await db.execute(sql`
    SELECT h.cusip AS cusip
    FROM fund_holdings h
    LEFT JOIN cusip_map m ON m.cusip = h.cusip
    WHERE h.ticker IS NULL AND m.cusip IS NULL
    GROUP BY h.cusip
    ORDER BY max(h.value) DESC NULLS LAST
    LIMIT ${cap}
  `);
  const cusips = (res?.rows || []).map((r) => r.cusip).filter(Boolean);
  if (!cusips.length) return { resolved: 0, checked: 0 };
  let resolved = 0, checked = 0;
  for (let i = 0; i < cusips.length; i += 500) {
    if (Date.now() - t0 > timeBudgetMs) break;
    const chunk = cusips.slice(i, i + 500);
    const map = await resolveCusips(chunk, { maxLookups: 500 });
    checked += chunk.length;
    for (const [cusip, ticker] of map) {
      await db.update(fundHoldings).set({ ticker }).where(and(eq(fundHoldings.cusip, cusip), isNull(fundHoldings.ticker)));
      resolved++;
    }
  }
  return { resolved, checked };
}

// Name-based fallback: for holdings still unresolved after OpenFIGI (foreign CINS OpenFIGI can't map),
// match the issuer name against SEC's ticker list. Updates fund_holdings + cusip_map (source 'sec-name').
// Matching is in-memory (cached SEC index, no API) so it's fast + safe to run every cycle.
export async function resolveHoldingsByName({ cap = 8000 } = {}) {
  // Use the DOMINANT (most-common) issuer per CUSIP — a stray mislabeled filing shouldn't drive the
  // ticker. CUSIP is authoritative; this is only the fallback for CUSIPs OpenFIGI couldn't map.
  //
  // DERIVATIVE AND DEBT LINES ARE NOT EVIDENCE OF IDENTITY. An option line carries a pseudo-CUSIP and
  // the sponsor's or underlying's name, and a note line carries the financing subsidiary's, so
  // letting either speak for a security is one of the ways an unrelated instrument acquires a ticker.
  // The EXISTING position classifier decides that — no second hand-written class regex — together
  // with put_call, which flags a derivative outright. Such rows are excluded from the VOTE only; the
  // holdings themselves are untouched here.
  //
  // A CUSIP the repair has REJECTED is skipped entirely. Without that, the next cron pass would put
  // the inference straight back onto the holdings the repair had just cleared.
  const res = await db.execute(sql`
    SELECT cusip, (array_agg(issuer ORDER BY cnt DESC, issuer))[1] AS issuer
    FROM (
      SELECT h.cusip, h.issuer, count(*)::int AS cnt
        FROM fund_holdings h
        LEFT JOIN security_position_class s
          ON s.cusip = h.cusip AND s.cls = h.class AND s.put_call = h.put_call
       WHERE h.ticker IS NULL AND h.issuer IS NOT NULL AND h.put_call = ''
         AND (s.kind IS NULL OR s.kind NOT IN ('debt', 'option', 'warrant', 'right', 'preferred'))
         AND NOT EXISTS (SELECT 1 FROM cusip_map c WHERE c.cusip = h.cusip AND c.status = 'rejected')
       GROUP BY h.cusip, h.issuer) t
    GROUP BY cusip
    LIMIT ${cap}
  `);
  const rows = res?.rows || [];
  if (!rows.length) return { resolved: 0 };
  const matches = await resolveIssuerItems(rows.map((r) => ({ cusip: r.cusip, issuers: [r.issuer], current: null })));
  if (!matches.length) return { resolved: 0 };
  // ARRAY[...] construction — drizzle expands a bare ${jsArray} to ($1,$2,…), so ${arr}::text[]
  // would wrongly cast a row-list; ARRAY[...] gives a real text[] param for unnest().
  const arr = (a) => sql`ARRAY[${sql.join(a.map((x) => sql`${x}`), sql`, `)}]::text[]`;
  for (let i = 0; i < matches.length; i += 1000) {
    const b = matches.slice(i, i + 1000);
    const cs = arr(b.map((p) => p.cusip)), ts = arr(b.map((p) => p.ticker));
    // WRITES ONLY WHERE NOTHING AUTHORITATIVE EXISTS, AND NEVER OVER ONE.
    //
    // This used to overwrite unconditionally, which is how an ETF sponsor's name became 33 unrelated
    // Invesco securities on IVZ, 7 ProShares CUSIP prefixes on AGQ and the Innovator trust on INHD:
    // the matcher prefix-matched a registrant name, and a sponsor's name is a prefix of every product
    // it sponsors. It also meant a later OpenFIGI answer could be replaced by an earlier inference.
    //
    // An inferred mapping is now the LAST word, never the overriding one: a CUSIP OpenFIGI has
    // already answered — resolved or explicitly unresolved — keeps that answer, and a CUSIP the
    // repair has rejected keeps its rejection.
    await db.execute(sql`INSERT INTO cusip_map (cusip, ticker, status, confidence, source, updated_at)
      SELECT u.cusip, u.t, 'resolved', 'medium', 'sec-name', now() FROM unnest(${cs}, ${ts}) AS u(cusip, t)
      ON CONFLICT (cusip) DO NOTHING`);
    // The same rule for the holdings themselves. Without this the repair would be undone on the next
    // cron pass: it NULLs the contaminated tickers, and this filled every NULL straight back in.
    await db.execute(sql`UPDATE fund_holdings h SET ticker = m.t
      FROM unnest(${cs}, ${ts}) AS m(cusip, t)
      WHERE h.cusip = m.cusip AND h.ticker IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM cusip_map c
           WHERE c.cusip = h.cusip
             AND (c.source IN ('openfigi', 'manual', 'consensus') OR c.status = 'rejected'))`);
  }
  return { resolved: matches.length };
}

/**
 * TARGETED AUTHORITATIVE RE-RESOLUTION of the CUSIPs on contaminated tickers.
 *
 * A ticker names one security, so its holdings should carry one CUSIP issuer prefix — characters 1-6
 * of a CUSIP identify the issuer, 7-8 the issue, 9 the check digit. 574 tickers carry more than one,
 * because resolveHoldingsByName() assigns a ticker from the issuer STRING when OpenFIGI cannot map
 * the CUSIP, and a sponsor's name is a prefix of every product it sponsors: 92 Invesco funds landed
 * on IVZ, 35 ProShares funds on AGQ, 19 Innovator ETFs on INHD, the iShares trusts on BLK.
 *
 * Neither of the obvious repairs is safe on its own. Trusting the stored mapping keeps a 2-row,
 * $0-value OpenFIGI artifact over QQQ's real 16,303-row CUSIP; trusting the majority keeps CRH plc
 * over RH's own security, because the contamination outweighs it 93% to 7%. The missing input is a
 * security-level answer, so this asks for one: every CUSIP on a contaminated ticker goes back to
 * OpenFIGI, bypassing both the cusip_map row and the KV cache that produced the mess.
 *
 * Bounded, resumable and idempotent. `cap` limits one pass; re-running re-queries and rewrites the
 * same answers. It changes cusip_map only — no holding is touched here.
 */
export async function reresolveDisputedCusips({ cap = 2500 } = {}) {
  await ensureUniverseTables();
  const res = await db.execute(sql`
    with pfx as (
      select ticker, left(cusip, 6) p from fund_holdings
       where ticker is not null and cusip ~ '^[0-9A-Z]{9}$'
       group by ticker, left(cusip, 6)),
    disputed as (select ticker from pfx group by ticker having count(*) > 1)
    select distinct f.cusip
      from fund_holdings f join disputed d on d.ticker = f.ticker
     where f.cusip ~ '^[0-9A-Z]{9}$'
     order by f.cusip
     limit ${cap}`);
  const cusips = (res?.rows ?? res ?? []).map((r) => r.cusip);
  if (!cusips.length) return { submitted: 0, queried: 0, resolved: 0, unresolved: 0, changed: 0 };
  const out = await reresolveCusips(cusips, { maxLookups: cap });
  // The map itself is not returned: it is a CUSIP→ticker table and has no business leaving the
  // server. Counts are what the caller needs to see progress.
  const { map, ...counts } = out;
  return counts;
}

// One-time cleanup for earlier mis-resolutions. NORMALIZE first (recover real symbols) so we don't
// destroy legit class shares: '/'→'.' (BRK/B → BRK.B), strip '*' (EA* → EA). THEN null only what's
// still not ticker-shaped (real bonds/preferreds with spaces → show issuer, no fake ticker). For
// cusip_map, normalize the same way and delete only the still-invalid non-null rows so they re-resolve.
export async function cleanupBadTickers() {
  await db.execute(sql`UPDATE fund_holdings SET ticker = replace(replace(upper(ticker), '/', '.'), '*', '') WHERE ticker ~ '[/*]'`);
  const h = await db.execute(sql`UPDATE fund_holdings SET ticker = NULL WHERE ticker IS NOT NULL AND ticker !~ '^[A-Z][A-Z0-9.-]{0,8}$'`);
  await db.execute(sql`UPDATE cusip_map SET ticker = replace(replace(upper(ticker), '/', '.'), '*', '') WHERE ticker ~ '[/*]'`);
  const c = await db.execute(sql`DELETE FROM cusip_map WHERE ticker IS NOT NULL AND ticker !~ '^[A-Z][A-Z0-9.-]{0,8}$'`);
  return { holdingsNulled: h?.rowCount ?? null, cusipMapPurged: c?.rowCount ?? null };
}

// Orchestrate one run: discover → ingest a bounded batch of not-yet-ingested filers → resolve tickers.
// tickerOnly: skip discovery/ingestion and just drain the ticker-resolution backlog (fast logo fill).
// cleanup: one-time purge of junk tickers before resolving.
export async function runInstitutionsUniverse({ indexes = 2, ingestCap = 60, tickerCap = 500, timeBudgetMs = 250000, tickerOnly = false, cleanup = false, disputed = false } = {}) {
  await ensureUniverseTables();
  const t0 = Date.now();
  const out = {};
  if (cleanup) { try { out.cleanup = await cleanupBadTickers(); } catch (e) { out.cleanup = { error: e?.message }; } }
  // Targeted authoritative re-resolution of the CUSIPs on contaminated tickers. Runs alone when
  // asked for: it is a repair step, not part of the steady-state cycle.
  if (disputed) {
    try { return { ...out, disputed: await reresolveDisputedCusips({ cap: tickerCap }), ms: Date.now() - t0 }; }
    catch (e) { return { ...out, disputed: { error: e?.message }, ms: Date.now() - t0 }; }
  }
  if (tickerOnly) {
    let tick = { resolved: 0, checked: 0 }, named = { resolved: 0 };
    try { tick = await resolveHoldingTickers({ cap: tickerCap, timeBudgetMs, t0 }); }
    catch (e) { console.log(`[institutions-universe] ticker resolve failed: ${e?.message}`); }
    try { named = await resolveHoldingsByName({ cap: tickerCap }); }
    catch (e) { console.log(`[institutions-universe] name resolve failed: ${e?.message}`); }
    return { ...out, tickerOnly: true, tickersResolved: tick.resolved, tickersChecked: tick.checked, namesResolved: named.resolved, ms: Date.now() - t0 };
  }
  const featured = await buildFeaturedMap();
  const disc = await discoverFilers({ indexes, featured });
  const cutoff = backfillCutoff();

  // Filers already ingested for the current window (have a fund_filings row at/after cutoff).
  const ingested = new Set((await db.selectDistinct({ cik: fundFilings.cik }).from(fundFilings).where(gte(fundFilings.quarter, cutoff))).map((r) => r.cik));
  const all = await db.select({ cik: institutions.cik, featured: institutions.featuredLabel, attempted: institutions.lastAttemptAt }).from(institutions);
  // LEAST-RECENTLY-ATTEMPTED first, never-attempted before that. Selecting the same head of the list
  // every pass meant a filer with nothing to ingest blocked its slot permanently: a 2,000-pass run
  // worked the same 120 CIKs and never reached the other 2,444. Featured filers still jump the queue,
  // but only among equals.
  const todo = all.filter((i) => !ingested.has(i.cik))
    .sort((a, b) => {
      if (!!a.featured !== !!b.featured) return a.featured ? -1 : 1;
      const av = a.attempted ? new Date(a.attempted).getTime() : 0;
      const bv = b.attempted ? new Date(b.attempted).getTime() : 0;
      return av - bv;
    })
    .slice(0, ingestCap);

  let ingestedNow = 0, storedNow = 0, failedNow = 0;
  const errorsSample = [];
  // Filers run CONCURRENTLY. One filer is mostly waiting on SEC: a submissions fetch, then an index
  // and an information table per quarter, each with a politeness sleep. Sequentially that spent a run
  // at roughly 0.3 requests per second against a 10/s allowance, which is why a pass moved ~8 filers.
  // A small pool keeps us well inside SEC's limit while using the budget properly. Per-filer error
  // isolation is unchanged: one failure is skipped and retried next run, never aborting the pass.
  const POOL = Number(process.env.INSTITUTIONS_POOL || 3);
  const queue = [...todo];
  const worker = async () => {
    for (;;) {
      if (Date.now() - t0 > timeBudgetMs || secBlocked()) return;
      const f = queue.shift();
      if (!f) return;
      try {
        const res = await ingestFiler(f.cik, cutoff);
        if (res.stored) { ingestedNow++; storedNow += res.stored; }
      } catch (e) {
        failedNow++;
        const error = `${e?.message || e}`.slice(0, 180);
        const cause = `${e?.cause?.message || ''}`.slice(0, 180);
        console.log(`[institutions-universe] filer ${f.cik} failed: ${error} | cause: ${cause}`);
        if (errorsSample.length < 5) errorsSample.push({ cik: f.cik, error, cause });
      } finally {
        // Mark the ATTEMPT whatever the outcome. A filer with nothing to ingest then rotates to the
        // back of the queue instead of holding its slot in the slice forever.
        try { await db.update(institutions).set({ lastAttemptAt: new Date() }).where(eq(institutions.cik, f.cik)); } catch { /* non-fatal */ }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, POOL) }, worker));
  let tick = { resolved: 0 }, named = { resolved: 0 };
  try { tick = await resolveHoldingTickers({ cap: tickerCap, timeBudgetMs, t0 }); }
  catch (e) { console.log(`[institutions-universe] ticker resolve failed: ${e?.message}`); }
  try { named = await resolveHoldingsByName({ cap: tickerCap }); }
  catch (e) { console.log(`[institutions-universe] name resolve failed: ${e?.message}`); }
  return { ...out, cutoff, ...disc, filersRemaining: todo.length, ingestedNow, storedNow, failedNow, errorsSample, tickersResolved: tick.resolved, namesResolved: named.resolved, ms: Date.now() - t0 };
}
