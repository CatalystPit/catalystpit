import { db } from '../../../lib/db';
import { insiderTrades as insiderTradesTable } from '../../../lib/schema';
import { inArray, sql } from 'drizzle-orm';
import { recordJobRun } from '../../../lib/job-heartbeat';
import { isIngestableTicker } from '../../../lib/security-identity.mjs';

// How many rows the last insert refused for an unusable ticker, surfaced in the form4 heartbeat
// so a parser regression is visible in /api/health rather than only in the logs.
let lastInsiderReject = 0;

export const runtime = 'nodejs';
export const maxDuration = 60;

const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };

const KV_TOKEN     = process.env.KV_REST_API_TOKEN;
const CRON_SECRET  = process.env.CRON_SECRET;

const NEWS_TICKERS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','GOOG','JPM','BAC','XOM','WMT','COIN','PLTR','BA','DIS','UBER','SHOP'];

async function kvSet(key, value) {
  await fetch(
    `https://powerful-grouper-86116.upstash.io/set/${encodeURIComponent(key)}?ex=14400`,
    { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'text/plain' }, body:value }
  );
  console.log(`✅ ${key}`);
}

async function kvGet(key) {
  try {
    const r = await fetch(
      `https://powerful-grouper-86116.upstash.io/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } }
    );
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ?? null;
  } catch { return null; }
}

/**
 * THE TICKER TAPE, PRICED FROM THE LICENSED PROVIDER.
 *
 * ⚠️ THIS WAS FOURTEEN FINNHUB QUOTES EVERY FIVE MINUTES, AND IT WAS THE MOST PUBLIC EXPOSURE IN THE
 * PRODUCT. The results were written to catalystpit:ticker_tape and catalystpit:market_snapshot, which
 * are read by the homepage (CatalystPit.jsx), the Terminal and NewsFeed.jsx — and NewsFeed's own
 * comment records that the tape stays on the public path for SIGNED-OUT visitors. /api/market serves
 * the same keys with no authentication at all. So an unlicensed vendor's prices were the first thing
 * an anonymous visitor saw.
 *
 * One getQuotes() call now covers the whole set — fewer requests than the throttled per-symbol loop it
 * replaces — and there is no second provider behind it. If Tiingo cannot answer, this returns {} and
 * the caller's existing guard refuses to overwrite the last good tape, which is the correct failure:
 * a slightly stale tape rather than an unlicensed one.
 */
async function fetchStockPrices(tickers) {
  try {
    const { getQuotes } = await import('../../../lib/market-data');
    // realtime:false — the tape is a single shared KV value served to everyone, including signed-out
    // readers, so it must never contain an entitled real-time print.
    const quotes = await getQuotes(tickers, { realtime: false });
    const out = {};
    for (const [sym, q] of Object.entries(quotes || {})) {
      const price = Number(q?.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const pc = Number(q?.prevClose);
      const changePct = Number.isFinite(Number(q?.changePct)) ? Number(q.changePct)
        : (pc > 0 ? ((price - pc) / pc) * 100 : 0);
      out[sym] = {
        price: +price.toFixed(2),
        change: Number.isFinite(pc) ? +(price - pc).toFixed(2) : 0,
        changePct: +changePct.toFixed(2),
      };
    }
    return out;
  } catch { return {}; }
}

/**
 * BTC IS NO LONGER PRICED. CoinGecko is a commercial provider whose redistribution rights we have not
 * established, and there is no approved crypto source to move to — Tiingo's entitlement here is
 * equities. Substituting another commercial crypto API would be the same error with a different name.
 *
 * ⚠️ RETURNS {} RATHER THAN A ZERO. A price of 0 renders as a real number on a tape; an absent symbol
 * simply does not appear, because every consumer already filters on `price > 0`. The BTC-USD entry
 * drops out of the tape and the snapshot, and nothing claims a value it does not have.
 */
async function fetchCrypto() {
  return {};
}

// ─── Form 4 helpers ─────────────────────────────────────────────────────────
const extractFormValue = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>`))?.[1]?.trim();

const extractFormText = (xml, tag) =>
  xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

// SEC dates sometimes carry a timezone tail (e.g. "2026-03-02-05:00") that
// Postgres rejects as type date. Keep only the leading YYYY-MM-DD, else null.
const normalizeDate = (d) => {
  if (!d) return null;
  const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const decodeEntities = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
};

async function throttledBatch(items, concurrency, gapMs, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(worker));
    out.push(...results);
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, gapMs));
  }
  return out;
}

/**
 * Fill in `amendsAccession` / `amendLinkBasis` on freshly parsed amendment rows, and mark the
 * filings they supersede.
 *
 * ⚠️ IT ASKS ONLY THE SEC'S OWN METADATA. Candidates are the non-amendment filings for this issuer
 * filed on the date the amendment states — nothing about matching shares, prices or codes, which
 * would be a coincidence promoted to a lineage claim.
 */
/**
 * Put freshly parsed rows on the ticker their issuer actually owns.
 *
 * ⚠️ TWO INDEXED LOOKUPS PER DISTINCT (ticker, issuerCik), NOT A CORPUS SCAN. The repair script builds
 * the whole authority table because it is repairing every row; here only the handful of filings in this
 * run matter, so the same question is asked pointwise against idx_insider_ticker_action_date and
 * idx_insider_issuer_cik. The DECISION is authoritativeTicker either way — one rule, two callers.
 */
async function relocateMisfiledTickers(rows) {
  const { buildTickerAuthority, authoritativeTicker } = await import('../../../lib/insider-ticker-authority.mjs');
  const pairs = new Map();
  for (const r of rows) {
    if (!r.ticker || !r.issuerCik) continue;
    pairs.set(`${r.ticker}|${r.issuerCik}`, { ticker: r.ticker, issuerCik: r.issuerCik });
  }
  for (const p of pairs.values()) {
    try {
      // Who holds this ticker, and does this issuer hold one of its own? Counted, not assumed.
      const held = await db.execute(sql`
        SELECT issuer_cik AS cik, count(*)::int AS n FROM insider_trades
         WHERE ticker = ${p.ticker} AND issuer_cik IS NOT NULL GROUP BY 1`);
      const own = await db.execute(sql`
        SELECT ticker, count(*)::int AS n FROM insider_trades
         WHERE issuer_cik = ${p.issuerCik} AND ticker ~ '^[A-Z][A-Z0-9.-]{0,9}$' GROUP BY 1`);
      const counts = [
        ...(held.rows ?? held ?? []).map((x) => ({ ticker: p.ticker, issuerCik: x.cik, n: x.n })),
        ...(own.rows ?? own ?? []).map((x) => ({ ticker: x.ticker, issuerCik: p.issuerCik, n: x.n })),
      ];
      const to = authoritativeTicker(p, buildTickerAuthority(counts));
      if (!to) continue;
      for (const r of rows) if (r.ticker === p.ticker && r.issuerCik === p.issuerCik) r.ticker = to;
      console.log(`[form4] ${p.ticker} belongs to another issuer; ${p.issuerCik} filed under ${to}`);
    } catch (e) {
      // The filed symbol is the fallback. A lookup failure must never stop a filing being stored.
      console.log(`[form4] ticker authority check failed for ${p.ticker}: ${e.message}`);
    }
  }
}

async function resolveLineageForRows(rows) {
  const amendments = new Map();
  for (const r of rows) {
    if (!r.isAmendment || !r.origSubmissionDate || !r.issuerCik) continue;
    if (!amendments.has(r.accession)) amendments.set(r.accession, r);
  }
  if (!amendments.size) return;

  const { resolveAmendment, LINK_BASIS } = await import('../../../lib/form4-lineage.mjs');
  for (const [accession, r] of amendments) {
    try {
      // Candidates are the issuer's non-amendment filings submitted on the stated date — plus, when
      // the filer named an accession outright, that filing too, since it need not share the date.
      const named = r.lineage?.accessionRefs?.length ? r.lineage.accessionRefs : [''];
      const res_ = await db.execute(sql`
        SELECT DISTINCT accession, issuer_cik, owner_cik, filing_date::text AS filing_date,
               period_of_report::text AS period_of_report
          FROM insider_trades
         WHERE issuer_cik = ${r.issuerCik}
           AND coalesce(is_amendment, false) = false
           AND (filing_date = ${r.origSubmissionDate}::date OR accession = ANY(${named}))`);
      const res = resolveAmendment(
        { isAmendment: true, issuerCik: r.issuerCik,
          ownerCiks: r.lineage?.ownerCiks?.length ? r.lineage.ownerCiks : (r.ownerCik ? [r.ownerCik] : []),
          periodOfReport: r.periodOfReport, origSubmissionDate: r.origSubmissionDate,
          accessionRefs: r.lineage?.accessionRefs ?? [] },
        (res_.rows ?? res_ ?? []).map((c) => ({
          accession: c.accession, issuerCik: c.issuer_cik, ownerCik: c.owner_cik,
          filingDate: c.filing_date, periodOfReport: c.period_of_report,
        })),
        accession,
      );
      for (const row of rows) {
        if (row.accession !== accession) continue;
        row.amendsAccession = res.accession;
        row.amendLinkBasis = res.basis;
      }
      if (res.basis === LINK_BASIS.DETERMINISTIC || res.basis === LINK_BASIS.EXPLICIT) {
        await db.execute(sql`
          UPDATE insider_trades SET superseded_by = ${accession}
           WHERE accession = ${res.accession} AND coalesce(superseded_by, '') = ''`);
      }
    } catch (e) {
      // Lineage is an improvement to the row, never a precondition for storing the filing.
      console.log(`[form4] lineage unresolved for ${accession}: ${e.message}`);
    }
  }
}

function parseForm4(xml, filing) {
  // ── ⚠️ THE LIVE PATH HAD NEVER INGESTED A SINGLE AMENDMENT ─────────────────
  //
  // This read `!== '4'`, so every Form 4/A the per-minute cron ever saw was dropped on the floor.
  // The 2,027 amendments in the table all arrived through the backfill scripts, which use
  // lib/form4.mjs and do accept them. That is the two parsers drifting again, on the document type
  // this time rather than on the ticker gate — and it meant a filer correcting a price, a share
  // count or a transaction code was invisible to production from the moment the backfills stopped.
  const documentType = extractFormText(xml, 'documentType');
  if (documentType !== '4' && documentType !== '4/A') return [];
  const isAmendment = documentType === '4/A';

  // The SEC's own statement of WHEN the amended filing was submitted. There is no element naming
  // the accession — across all 901 distinct 4/A filings in our corpus exactly one states it, and
  // that one typed it into <remarks> by hand — so this date, the issuer, the owners and the period
  // are effectively the whole of the lineage a Form 4/A makes available. Resolving it into an
  // accession happens at the write, where the corpus is in reach; see form4-lineage.mjs, which
  // refuses when more than one filing fits.
  const origSubmissionDate = normalizeDate(extractFormText(xml, 'dateOfOriginalSubmission'));
  // ...but when a filer DOES name one, it is better evidence than the date, so it is carried through
  // rather than thrown away here and rediscovered only by the backfill.
  const accessionRefs = isAmendment
    ? [...new Set([...String(xml).matchAll(/\b\d{10}-\d{2}-\d{6}\b/g)].map((m) => m[0]))] : [];

  const ticker  = extractFormText(xml, 'issuerTradingSymbol')?.toUpperCase();
  const company = decodeEntities(extractFormText(xml, 'issuerName'));
  // ⚠️ THE SYMBOL MUST BE A SYMBOL, AND THIS IS THE PARSER THAT ACTUALLY RUNS.
  //
  // There are two Form 4 parsers. lib/form4.mjs validates its ticker against a placeholder list
  // and quarantines what fails — but only the backfill scripts use it. THIS one, local to the
  // per-minute cron, is the live path, and its only test was `if (!ticker)`. So every string a
  // filer typed into issuerTradingSymbol was stored verbatim: NONE, N/A, "Z AND ZG",
  // "NYSE: VTEX", "(CALX)". 1,220 such rows accumulated, 51 of them in the last seven days.
  // Public surfaces gate them at render, which is why this stayed invisible — the dirt was real,
  // it was just downstream of the last place anyone looked.
  //
  // isIngestableTicker is the shared gate, so the two parsers cannot drift apart again. It is
  // looser than the card rule on purpose (see its comment): rejecting on the card rule would have
  // thrown away 391 legitimate AXIA3 rows along with BRK.A and NYT.A.
  if (!isIngestableTicker(ticker)) return [];

  // ── ⚠️ THE TWO IDENTIFIERS THIS PARSER WAS SILENTLY DROPPING ───────────────
  //
  // lib/form4.mjs extracts both and always has. THIS parser — the one the per-minute cron
  // actually runs — never did, so every row the live path wrote carried NULL for both. It stayed
  // invisible while the manual backfill scripts were still running over history and filling them
  // in behind it; the moment those stopped, CIK coverage on new filings went to 0% and took the
  // conviction context pipeline down with it, because build-insider-context requires
  // owner_cik IS NOT NULL.
  //
  // ⚠️ TAKEN FROM THE FILING, NEVER INFERRED. These are the SEC's own identifiers for the issuer
  // and the reporting person; deriving them from a ticker or a name would be a guess wearing an
  // identifier's clothes. Absent in the XML means null here.
  //
  // The leading-zero strip matches lib/form4.mjs exactly, so the two parsers cannot write the
  // same company's CIK in two different shapes.
  const issuerCik = extractFormText(xml, 'issuerCik')?.replace(/^0+/, '') || null;

  // ⚠️ ONE ROW HOLDS ONE OWNER, BUT A FORM 4 MAY REPORT SEVERAL. A joint filing carries repeated
  // <rptOwnerCik> blocks, and taking the first would staple owner A's identifier to owner B's
  // transactions. Only an unambiguous filing — exactly one reporting owner — yields an owner_cik
  // here. Anything else stays null, which is the same answer the row had before and is honest,
  // rather than an identity we cannot stand behind.
  const ownerCiks = [...xml.matchAll(/<rptOwnerCik>([\s\S]*?)<\/rptOwnerCik>/g)]
    .map((m) => m[1].trim().replace(/^0+/, ''))
    .filter(Boolean);
  const ownerCik = new Set(ownerCiks).size === 1 ? ownerCiks[0] : null;

  const executive = decodeEntities(extractFormText(xml, 'rptOwnerName') || '');
  const isDirector   = ['true','1'].includes(extractFormText(xml, 'isDirector'));
  const isOfficer    = ['true','1'].includes(extractFormText(xml, 'isOfficer'));
  const isTenPercent = ['true','1'].includes(extractFormText(xml, 'isTenPercentOwner'));
  const officerTitle = decodeEntities(extractFormText(xml, 'officerTitle') || '');
  let title;
  if (isOfficer && officerTitle) title = officerTitle;
  else if (isOfficer)            title = 'Officer';
  else if (isDirector)           title = 'Director';
  else if (isTenPercent)         title = '10% Owner';
  else                           title = 'Other';

  // Footnotes (form-level) — kept for traceability + as a 10b5-1 fallback signal.
  const fnBlock = xml.match(/<footnotes>([\s\S]*?)<\/footnotes>/i)?.[1] || '';
  const footnoteTexts = [...fnBlock.matchAll(/<footnote[^>]*>([\s\S]*?)<\/footnote>/gi)].map(m => decodeEntities(m[1].replace(/\s+/g, ' ').trim()));
  const footnotes = footnoteTexts.join('  |  ') || null;
  const footnotesMention10b5 = /10b5-?1/i.test(fnBlock);
  // Rule 10b5-1 (amended Form 4 checkbox element). true=disclosed plan, false=explicitly NOT, null=not disclosed.
  const affDoc = extractFormText(xml, 'aff10b5One');

  // Only parse <nonDerivativeTable> — derivatives belong to /options-flow, not /insiders
  const ndtMatch = xml.match(/<nonDerivativeTable>([\s\S]*?)<\/nonDerivativeTable>/);
  if (!ndtMatch) return [];
  const txns = [...ndtMatch[1].matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)]
    .map(m => m[1]);

  return txns.map(txn => {
    const transactionCode = extractFormText(txn, 'transactionCode') || '';
    const affTxn = extractFormText(txn, 'aff10b5One') ?? affDoc;
    let rule10b5_1 = null;
    if (affTxn != null && affTxn !== '') rule10b5_1 = ['1', 'true'].includes(String(affTxn).toLowerCase());
    else if (footnotesMention10b5) rule10b5_1 = true;
    const transactionDate = extractFormValue(txn, 'transactionDate') || '';
    const shares          = parseFloat(extractFormValue(txn, 'transactionShares'))        || 0;
    const pricePerShare   = parseFloat(extractFormValue(txn, 'transactionPricePerShare')) || 0;
    const securityTitle   = decodeEntities(extractFormValue(txn, 'securityTitle') || '');
    const rawSOA          = extractFormValue(txn, 'sharesOwnedFollowingTransaction');
    const sharesOwnedAfter = rawSOA ? parseFloat(rawSOA) : null;
    // ⚠️ THE RAW STRINGS, CARRIED FORWARD FOR THE VALIDATOR AT THE WRITE. validateRow in
    // lib/form4.mjs needs them for two things that cannot be recovered after the fact: a failure
    // detail naming what the filer actually wrote, and the distinction between a price the filer
    // DISCLOSED as zero (a data error) and one they footnoted instead (a real transaction whose price
    // we simply do not hold as a number). Both land as 0 here, and only the first should be refused.
    const rawSharesStr = extractFormValue(txn, 'transactionShares');
    const rawPriceStr  = extractFormValue(txn, 'transactionPricePerShare');

    let action;
    if      (transactionCode === 'P') action = 'BUY';
    else if (transactionCode === 'S') action = 'SELL';
    else                              action = 'OTHER';

    return {
      ticker, company, executive, title,
      // The SEC's own identifiers, carried through so the context and conviction pipelines
      // downstream have the keys they partition on.
      issuerCik, ownerCik,
      // Provenance the amendment lineage needs. The live path wrote none of it, so even once it
      // accepted a 4/A there would have been nothing to resolve a lineage from.
      periodOfReport: normalizeDate(extractFormText(xml, 'periodOfReport')),
      formType: documentType,
      isAmendment,
      origSubmissionDate: isAmendment ? origSubmissionDate : null,
      // ⚠️ NOT COLUMNS — lineage inputs, stripped before the insert. ownerCiks is every reporting
      // owner on the filing (ownerCik above is null on a joint filing, which would leave the
      // resolver with nothing to match), and accessionRefs is the rare hand-typed reference.
      lineage: isAmendment ? { ownerCiks: [...new Set(ownerCiks)], accessionRefs } : null,
      transactionCode, action,
      shares, pricePerShare,
      totalValue: shares * pricePerShare,
      // Validator inputs, stripped before the insert alongside `lineage` — not columns.
      rawShares: rawSharesStr, rawPrice: rawPriceStr,
      priceDisclosed: rawPriceStr != null && rawPriceStr !== '',
      sharesOwnedAfter,
      securityTitle,
      transactionDate,
      filingDate: filing.filingDate,
      accession:  filing.accession,
      filingUrl:  filing.indexUrl,
      rule10b5_1,
      footnotes,
    };
  });
}

const FORM4_PAGES = 4;   // getcurrent pages (start 0,100,200,300) → ~200 unique filings/run
const SEEN_KEY = 'catalystpit:insider:seen_accessions';

async function fetchForm4Trades() {
  try {
    // Scan several pages of SEC's live Form 4 stream so post-close bursts aren't missed.
    // Each filing appears 2x (Issuer + reporting-owner views) — de-dupe to Issuer.
    const filings = new Map();
    for (let p = 0; p < FORM4_PAGES; p++) {
      const atomRes = await fetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=include&count=100&start=${p * 100}&output=atom`,
        { headers: SEC_HEADERS }
      );
      if (!atomRes.ok) { console.log(`❌ SEC atom p${p}: HTTP ${atomRes.status}`); break; }
      const entries = [...(await atomRes.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
      if (entries.length === 0) break;                 // past the end of the stream
      let added = 0;
      for (const entry of entries) {
        const title = entry.match(/<title>(.*?)<\/title>/)?.[1] || '';
        if (!title.includes('(Issuer)')) continue;
        const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] || '';
        const lm = link.match(/\/data\/(\d+)\/(\d+)\/([\d-]+)-index\.htm/);
        if (!lm) continue;
        const [, cik, accessionNoDashes, accessionWithDashes] = lm;
        if (filings.has(accessionWithDashes)) continue;
        const filingDate = entry.match(/<updated>(.*?)<\/updated>/)?.[1]?.split('T')[0] || '';
        filings.set(accessionWithDashes, { accession: accessionWithDashes, cik, accessionNoDashes, indexUrl: link, filingDate });
        added++;
      }
      if (added === 0 && p > 0) break;                 // nothing new on this page → stop paging
    }

    // Only fetch details (2 SEC reqs each) for accessions we haven't handled — skip what's already
    // in Postgres AND a rolling KV "seen" set (also stops re-parsing derivative-only filings every run).
    let candidates = Array.from(filings.values());
    const scanned = candidates.length;
    let seen = [];
    try { const s = await kvGet(SEEN_KEY); if (s) seen = JSON.parse(s); } catch { /* ignore */ }
    const seenSet = new Set(seen);
    if (candidates.length > 0) {
      const known = await db.select({ accession: insiderTradesTable.accession })
        .from(insiderTradesTable)
        .where(inArray(insiderTradesTable.accession, candidates.map(f => f.accession)));
      known.forEach(k => seenSet.add(k.accession));
    }
    candidates = candidates.filter(f => !seenSet.has(f.accession));
    console.log(`📋 SEC: ${scanned} unique Form 4 scanned · ${scanned - candidates.length} skipped (seen) · ${candidates.length} new`);

    // Two requests per filing (index.json + ownership xml) throttled to stay under SEC's 10 req/sec.
    const results = await throttledBatch(candidates, 5, 600, async (f) => {
      try {
        const idxRes = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accessionNoDashes}/index.json`,
          { headers: SEC_HEADERS }
        );
        if (!idxRes.ok) return [];
        const idx = await idxRes.json();
        const xmlFile = idx.directory?.item?.find(i => i.name.endsWith('.xml'));
        if (!xmlFile) return [];

        const xmlRes = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.accessionNoDashes}/${xmlFile.name}`,
          { headers: SEC_HEADERS }
        );
        if (!xmlRes.ok) return [];
        return parseForm4(await xmlRes.text(), f);
      } catch (e) {
        console.log(`⚠️ Filing ${f.accession}: ${e.message}`);
        return [];
      }
    });

    // Remember what we just processed so we don't re-fetch it next run (cap keeps the KV value small).
    const processed = candidates.map(f => f.accession);
    if (processed.length > 0) {
      try { await kvSet(SEEN_KEY, JSON.stringify([...processed, ...seen].slice(0, 600))); } catch { /* ignore */ }
    }

    const flat = results.flat();
    const codeCounts = flat.reduce((acc, t) => {
      acc[t.transactionCode || '?'] = (acc[t.transactionCode || '?'] || 0) + 1;
      return acc;
    }, {});
    console.log(`📊 Form 4 transactions: ${flat.length} total · codes=${JSON.stringify(codeCounts)}`);
    return flat;
  } catch (e) {
    console.log(`❌ fetchForm4Trades: ${e.message}`);
    return [];
  }
}

// ── Detect generic placeholder images (Yahoo's purple "fi" thing, etc.) ──
function isPlaceholderImage(url) {
  if (!url || typeof url !== 'string') return true;
  const u = url.toLowerCase();
  // Yahoo Finance generic placeholders (exact + pattern)
  if (u.includes('yahoo_finance_en-us_h_p_finance')) return true;
  if (u.includes('s.yimg.com/rz/stage/')) return true;
  if (u.includes('s.yimg.com/cv/apiv2/default')) return true;
  if (u.includes('s.yimg.com/os/creatr-uploaded-images/finance')) return true;
  if (u.match(/s\.yimg\.com.*\/api\/res\/.*\/finance/)) return true;
  // Generic share-images known to be placeholders
  if (u.includes('default-share-image')) return true;
  if (u.includes('logo-placeholder')) return true;
  if (u.includes('default_thumbnail')) return true;
  if (u.includes('default-image')) return true;
  if (u.includes('og-default')) return true;
  // Tiny images (often placeholders / icons)
  if (u.match(/\b(1x1|pixel|spacer|blank)\.(gif|png|jpg)\b/)) return true;
  // Stock photo agencies — common in API-republished wire stories
  if (u.includes('gettyimages')) return true;
  if (u.includes('istockphoto')) return true;
  if (u.includes('shutterstock')) return true;
  if (u.includes('dreamstime')) return true;
  if (u.includes('123rf')) return true;
  if (u.includes('alamy')) return true;
  if (u.includes('depositphotos')) return true;
  // SeekingAlpha CDN — images uniformly low quality
  if (u.includes('seekingalpha')) return true;
  return false;
}

// ─── RSS helpers (no XML parser dep; mirrors fetchSECInsiders' regex approach) ─
function extractTag(itemXml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`);
  const m = itemXml.match(re);
  if (!m) return null;
  let content = m[1].trim();
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) content = cdata[1].trim();
  return content
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&#x2014;/g, '—').replace(/&#x2019;/g, "'");
}

function extractAttr(itemXml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*\\b${attrName}="([^"]*)"`);
  const m = itemXml.match(re);
  return m ? m[1] : null;
}

async function fetchRSS(url, sourceName, rank, opts = {}) {
  const { cap = null } = opts;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystPit/1.0; +contact@catalystpit.com)' },
    });
    if (!res.ok) {
      console.log(`❌ RSS ${sourceName}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(m => m[0]);

    const articles = items.map(item => {
      const title = extractTag(item, 'title');
      const link  = extractTag(item, 'link');
      if (!title || !link) return null;

      const image_url =
        extractAttr(item, 'media:content',   'url') ||
        extractAttr(item, 'media:thumbnail', 'url') ||
        extractAttr(item, 'enclosure',       'url') ||
        null;

      let published = null;
      const pubDate = extractTag(item, 'pubDate');
      if (pubDate) {
        const d = new Date(pubDate);
        if (!isNaN(d.getTime())) published = d.toISOString();
      }

      return {
        title,
        source: sourceName,
        url: link,
        image_url, // RSS sources skip isPlaceholderImage — publisher CDNs are trusted
        published,
        ticker: null,
        _provider: `rss-${sourceName.toLowerCase().replace(/\s+/g, '-')}`,
        _rank: rank,
      };
    }).filter(Boolean);

    return cap ? articles.slice(0, cap) : articles;
  } catch (e) {
    console.log(`❌ RSS ${sourceName}: ${e.message}`);
    return [];
  }
}

// ── Press-release wires (PR Newswire / GlobeNewswire / Business Wire) ──
// Free public RSS. Stored in a SEPARATE pool (catalystpit:wire_news) that is NOT Claude-enriched,
// so adding them costs nothing extra. Ticker pulled from the "(NASDAQ: XYZ)" pattern in the title.
const WIRE_TICKER_RE = /\((?:NASDAQ|NYSE(?:\s*American|\s*Arca)?|NYSEAMERICAN|AMEX|OTCMKTS|OTCQB|OTCQX|OTC|CBOE|BATS)\s*[:\-]\s*([A-Z][A-Z.\-]{0,6})\)/i;
function extractWireTicker(title) {
  const m = (title || '').match(WIRE_TICKER_RE);
  return m ? m[1].toUpperCase().replace(/[.\-]+$/, '') : null;
}
function wireCategory(title) {
  const t = (title || '').toLowerCase();
  if (/(earnings|quarter|q[1-4]\b|full[- ]year|results|revenue|\beps\b|guidance)/.test(t)) return 'Earnings';
  if (/(to acquire|acquisition|acquires|merger|buyout|takeover|definitive agreement)/.test(t)) return 'M&A';
  if (/(fda|phase [123]|clinical|trial|topline|approval|nda|biologics)/.test(t)) return 'Pharma';
  if (/(offering|priced|convertible|senior notes|private placement|registered direct|\bipo\b)/.test(t)) return 'IPO';
  if (/(dividend|buyback|repurchase)/.test(t)) return 'Markets';
  return 'Markets';
}
async function fetchWire(url, sourceName) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystPit/1.0; +contact@catalystpit.com)' } });
    if (!res.ok) { console.log(`❌ Wire ${sourceName}: HTTP ${res.status}`); return []; }
    const xml = await res.text();
    const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(m => m[0]);
    return items.map(item => {
      const title = extractTag(item, 'title');
      const link  = extractTag(item, 'link');
      if (!title || !link) return null;
      let published = null;
      const pubDate = extractTag(item, 'pubDate');
      if (pubDate) { const d = new Date(pubDate); if (!isNaN(d.getTime())) published = d.toISOString(); }
      return {
        title, source: sourceName, url: link, image_url: null,
        published, ticker: extractWireTicker(title), category: wireCategory(title), _wire: true,
      };
    }).filter(Boolean).slice(0, 40);
  } catch (e) {
    console.log(`❌ Wire ${sourceName}: ${e.message}`);
    return [];
  }
}

/**
 * THE TWO FINNHUB NEWS FEEDS ARE GONE.
 *
 * ⚠️ WHAT THEY WERE. fetchFinnhubPerTicker() pulled /company-news for a fixed ticker list and
 * fetchFinnhubMarket() pulled /news?category=general; both were merged into catalystpit:_raw_news and
 * catalystpit:wire_news, which the public news feed renders. Their content was largely syndicated from
 * publishers Finnhub aggregates, so the licence question was never ours to answer in the first place.
 *
 * ⚠️ AND NOTHING REPLACES THEM, BECAUSE NOTHING NEEDS TO. The same handler already fetches WSJ,
 * MarketWatch and Bloomberg RSS directly, and the Pit Wire's own 87-feed pipeline
 * (lib/primary-sources.mjs) is the product's real news ingest. Removing these two narrows the wire's
 * breadth slightly; it does not leave it empty, and the merge below handles a missing source already.
 *
 * Returning [] rather than deleting the call sites keeps the merge arithmetic and the log line honest
 * about how many sources contributed.
 */
async function fetchFinnhubPerTicker() { return []; }
async function fetchFinnhubMarket() { return []; }

const HARD_BLOCK = [
  'ufc','mma','nfl','nba','nhl','mlb','wnba','ncaa','espn','fight night',
  'super bowl','world cup','olympic','olympics','playoff','playoffs','draft pick',
  'football','basketball','baseball','soccer','tennis','golf tournament','pga','formula 1','f1 race',
  'mcgregor','ngannou','khabib','jon jones',
  'taylor swift','travis kelce','kardashian','kanye','beyonce','drake',
  'oscar','grammy','emmy','cannes','met gala','red carpet',
  'movie review','box office','netflix series','tv show','reality tv',
  'recipe','restaurant review','travel destination','vacation','lounge review',
  'horoscope','astrology','dating',
  'gubernatorial','school board','mayor election','city council',
];

function hasBlockedTerm(article) {
  const t = (article.title || '').toLowerCase();
  return HARD_BLOCK.some(b => t.includes(b));
}

const FINANCE_KEYWORDS = [
  'stock','stocks','shares','equity','bond','treasury','etf','futures','option','options',
  'crypto','bitcoin','ethereum',
  'earnings','revenue','eps','guidance','quarterly','beats','misses','q1','q2','q3','q4',
  'nyse','nasdaq','dow','s&p','wall street','sec','fdic','ipo',
  'merger','acquisition','buyback','dividend','spinoff','bankruptcy',
  'fed','federal reserve','powell','rate hike','rate cut','interest rate','inflation','cpi','ppi','gdp',
  'recession','yield','jobs report','unemployment',
  'rally','plunge','surge','soar','tumble','crash','jumps','slides','climbs',
  'bull','bear','bullish','bearish',
  'billion','trillion','market cap','valuation',
];

const TRUSTED_SOURCES = [
  'reuters','bloomberg','cnbc','wsj','wall street journal','financial times','ft.com',
  'marketwatch','yahoo finance','investing.com','seeking alpha','barron',
  'forbes','fortune','business insider','thestreet',
  'benzinga','zacks','morningstar','motley fool','investorplace',
  'kitco','coindesk','cointelegraph','finnhub',
];

// Sources known to give great article images
const SOURCES_WITH_GOOD_IMAGES = [
  'reuters','bloomberg','cnbc','wsj','financial times','ft.com','marketwatch','barron',
  'forbes','fortune','business insider','thestreet','benzinga','seeking alpha',
];

// Sources known for generic placeholder images
const SOURCES_WITH_BAD_IMAGES = ['yahoo','yahoo finance','aol','msn'];

function isFinanceRelevant(article) {
  if (hasBlockedTerm(article)) return false;
  if (article._provider === 'finnhub-ticker') return true;
  const title = (article.title || '').toLowerCase();
  const source = (article.source || '').toLowerCase();
  const trustedSource = TRUSTED_SOURCES.some(s => source.includes(s));
  const financeKw = FINANCE_KEYWORDS.some(k => title.includes(k));
  if (article._provider === 'finnhub-market') return financeKw;
  return trustedSource && financeKw;
}

function mergeNews(...sources) {
  const all = sources.flat();
  const seen = new Map();
  for (const story of all) {
    if (!story.title) continue;
    if (!isFinanceRelevant(story)) continue;
    const key = story.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
    if (!seen.has(key)) {
      seen.set(key, story);
    } else {
      const existing = seen.get(key);
      // Prefer better rank, then with-image over without
      if (story._rank < existing._rank || (!existing.image_url && story.image_url)) {
        seen.set(key, story);
      }
    }
  }
  // Computed image quality score for sorting
  const imgScore = (a) => {
    if (!a.image_url) return 0;
    const src = (a.source || '').toLowerCase();
    if (SOURCES_WITH_GOOD_IMAGES.some(s => src.includes(s))) return 2;
    if (SOURCES_WITH_BAD_IMAGES.some(s => src.includes(s))) return 0; // treat as no image
    return 1;
  };
  return Array.from(seen.values())
    .sort((a, b) => {
      // First by image quality (real images first)
      const ia = imgScore(a), ib = imgScore(b);
      if (ia !== ib) return ib - ia;
      // Then by rank (lower is better)
      if (a._rank !== b._rank) return a._rank - b._rank;
      // Then by recency
      return new Date(b.published || 0) - new Date(a.published || 0);
    });
}

// Insert parsed Form 4 trades (dedup on the natural key). Shared by the full refresh + the fast path.
async function insertInsiderTrades(insiderTrades) {
  // Reset FIRST. This is module state on a warm serverless instance, so leaving it untouched on
  // the early return would let a previous run's reject count be reported against a later run that
  // refused nothing — a stale number in a health note is worse than no number.
  lastInsiderReject = 0;
  if (!insiderTrades?.length) return 0;
  const mapped = insiderTrades
    .map(r => ({ ...r, transactionCode: r.transactionCode || null, transactionDate: normalizeDate(r.transactionDate), filingDate: normalizeDate(r.filingDate) }))
    .filter(r => r.filingDate);

  // ⚠️ THE SAME GATE AGAIN, AT THE WRITE. parseForm4 above already refuses an unusable symbol, so
  // in normal operation this rejects nothing. It is here because this function is the ONLY door
  // into insider_trades from the live path, and a table is protected by its last gate, not its
  // first — the original defect was precisely that every gate sat downstream of the write, at
  // render time. Counted rather than silent, so a parser regression shows up as a number instead
  // of as a slow drift in how many rows nobody can click.
  const tickered = mapped.filter(r => isIngestableTicker(r.ticker));
  const rejected = mapped.length - tickered.length;
  if (rejected) console.log(`[form4] rejected ${rejected} row(s) with an unusable ticker`);
  lastInsiderReject = rejected;
  if (!tickered.length) return 0;

  // ── ⚠️ THE NUMERIC VALIDATOR, AT THE SAME DOOR, AND THE DEFECT THAT PUT IT HERE ──────────
  //
  // On 2026-10-01 a Form 4 for SLBT was stored with price_per_share = 2,272,653 against 4,545,306
  // shares, producing a $10,329,903,316,818 transaction that became the largest insider purchase on
  // record and was served, ranked and scored for conviction.
  //
  // THE PARSER WAS NOT WRONG. The SEC document really does say
  // <transactionPricePerShare><value>2272653</value></transactionPricePerShare>: the filer put the
  // AGGREGATE consideration in the per-share field, as their own footnote states plainly
  // ("4,545,306 Ordinary Shares ... for an aggregate purchase price of US$2,272,653", i.e. $0.50 a
  // share). There is no node to re-map and no field shift to correct. The input was bad.
  //
  // THE DEFECT WAS THAT NOTHING CHECKED IT. lib/form4.mjs has carried validateRow and its documented
  // bounds all along — MAX_PRICE sits just above BRK.A so a real filing never trips it, MAX_VALUE at
  // $500B is beyond any real single transaction — and this filing breaches BOTH. But that validator
  // was only ever reached by the backfill scripts. This route carries its own copy of the parser, as
  // the comment above parseForm4 says out loud, and that copy validated nothing numeric at all: a
  // `parseFloat(...) || 0` and a multiplication, straight into the insert.
  //
  // So the two paths now agree, at the place this function already calls the last gate. The bounds are
  // not re-litigated here and are not lowered: a $500,000 share price and a $400B transaction both
  // still pass, because legitimate extremes exist and refusing them would be a worse bug than this one.
  const { validateRow } = await import('../../../lib/form4.mjs');
  const rows = [];
  const invalid = [];
  for (const r of tickered) {
    const bad = validateRow(r);
    if (bad) invalid.push({ row: r, bad }); else rows.push(r);
  }
  if (invalid.length) {
    // QUARANTINED, NOT DROPPED. insider_quarantine exists for exactly this and already holds the
    // parsed row and its source URL, so a refusal is something a human can open the filing and judge —
    // which matters when the cause is the filer rather than us, because the row is evidence of a real
    // event whose price we cannot trust. Best effort, and one statement per row: a quarantine write
    // that fails must not take the good rows down with it.
    console.log(`[form4] quarantined ${invalid.length} row(s): `
      + invalid.map(({ row, bad }) => `${row.ticker} ${bad.reason}`).join(', '));
    for (const { row, bad } of invalid) {
      try {
        await db.execute(sql`insert into insider_quarantine
          (accession, issuer_cik, owner_cik, ticker, filing_date, reason, detail, parsed, raw_url)
          values (${row.accession ?? null}, ${row.issuerCik ?? null}, ${row.ownerCik ?? null},
                  ${row.ticker ?? null}, ${row.filingDate ?? null}, ${bad.reason},
                  ${String(bad.detail ?? "").slice(0, 500)},
                  ${JSON.stringify(row)}::jsonb, ${row.filingUrl ?? null})`);
      } catch (e) {
        console.error(`[form4] quarantine write failed: ${String(e?.message || e).slice(0, 160)}`);
      }
    }
  }
  if (!rows.length) return 0;
  // ── ⚠️ AMENDMENT LINEAGE, RESOLVED BEFORE THE WRITE ────────────────────────
  //
  // A 4/A arriving now must land already knowing which filing it amends, or the correction sits
  // beside the thing it corrects and both count. The parser carried the SEC's own
  // dateOfOriginalSubmission; this is the only place with the corpus in reach to turn it into an
  // accession. resolveAmendment refuses when more than one filing fits, and an UNRESOLVED
  // amendment supersedes nothing — a missing link is visible debt, a false one silently rewrites
  // what the evidence engine believes about a company.
  await resolveLineageForRows(rows);

  // ⚠️ AN AMENDMENT WE CANNOT PLACE IS NOT INGESTED. If a 4/A arrives and the SEC metadata does not
  // identify exactly one filing it amends, storing it would put the correction beside the thing it
  // corrects with nothing marking either as superseded — and both would count. Dropping it is what
  // this path already did for every amendment, so this is the status quo for the unresolvable
  // minority rather than a new gap, and it is recoverable: the backfill re-examines them whenever
  // more of the corpus is present. A double count is not recoverable, because nothing downstream
  // can tell which of the two rows is the correction.
  // ⚠️ A WELL-FORMED SYMBOL CAN STILL BELONG TO SOMEBODY ELSE. issuerTradingSymbol is free text on a
  // Form 4: resolveFilerSymbol already refuses the unparseable ones ("Z AND ZG", "MOGA/MOGB"), but it
  // cannot catch a symbol that is a perfectly valid ticker for a DIFFERENT company. Measured on the
  // corpus, 8 tickers carried filings from a company the ticker does not name — 8 DoorDash rows on
  // Fabrinet's FN page, Bank of America rows on an Invesco muni fund, PEDEVCO on Crexendo.
  //
  // The rule is deliberately narrow and lives in insider-ticker-authority.mjs, which explains why:
  // a row moves ONLY when the filed ticker is established by another issuer CIK and this filing's CIK
  // has a ticker of its own. That leaves symbol changes, reorganisations and recased names untouched,
  // because a new symbol is not established by anyone else.
  await relocateMisfiledTickers(rows);

  // `lineage` was an input to the resolution above, not a column; it goes no further than this.
  const placeable = rows.filter((r) => !r.isAmendment || r.amendsAccession)
    .map(({ lineage, rawShares, rawPrice, priceDisclosed, ...row }) => row);
  const droppedAmendments = rows.length - placeable.length;
  if (droppedAmendments) console.log(`[form4] held back ${droppedAmendments} row(s) from unresolvable amendments`);
  if (!placeable.length) return 0;

  const inserted = await db.insert(insiderTradesTable).values(placeable)
    .onConflictDoNothing({ target: [insiderTradesTable.accession, insiderTradesTable.transactionDate, insiderTradesTable.transactionCode, insiderTradesTable.securityTitle, insiderTradesTable.shares, insiderTradesTable.pricePerShare, insiderTradesTable.sharesOwnedAfter] })
    .returning({ id: insiderTradesTable.id, ticker: insiderTradesTable.ticker });

  // MARK THE AFFECTED TICKERS FOR CONSENSUS RECOMPUTATION.
  //
  // ⚠️ EVIDENCE FIRST, DERIVED CONSENSUS SECOND. The insert above is authoritative and has already
  // committed. markConsensusDirty never throws, and this is deliberately NOT awaited into the
  // return value or wrapped around the insert — a derived cache that could roll back an SEC filing
  // ingest would be trading real data for a convenience. If this mark is lost, the reconciliation
  // cron repairs it within 30 minutes; if the insert were lost, nothing repairs it.
  //
  // Only ACTUALLY-INSERTED rows are marked. onConflictDoNothing means a re-parse of the same filing
  // returns nothing, so re-reading a feed cannot generate recomputation work.
  if (inserted.length) {
    const { markConsensusDirty } = await import('../../../lib/consensus/materialization.mjs');
    await markConsensusDirty(inserted.map((r) => r.ticker));
  }
  return inserted.length;
}

export async function GET(request) {
  const isVercelCron = request.headers.get('x-vercel-cron')==='1';
  if (!isVercelCron && request.headers.get('authorization')!==`Bearer ${CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  // FAST PATH (?form4=1): only ingest Form 4s — near-real-time insider feed, every minute,
  // skipping the heavier price/crypto/news work the full refresh does at 5-min cadence.
  if (new URL(request.url).searchParams.get('form4') === '1') {
    try {
      const insider = await fetchForm4Trades();
      const inserted = await insertInsiderTrades(insider);
      // `inserted: 0` is the normal answer overnight and at weekends — EDGAR publishes nothing,
      // so the heartbeat records that we ASKED. That is the fact no amount of inspecting
      // insider_trades afterwards can recover.
      await recordJobRun('form4', { ok: true, seen: inserted,
        note: `parsed ${insider.length}` + (lastInsiderReject ? `, rejected ${lastInsiderReject}` : '') });
      return Response.json({ form4: true, parsed: insider.length, inserted, ts: new Date().toISOString() });
    } catch (e) {
      // ⚠️ THIS PATH RETURNS 200 ON PURPOSE — a per-minute cron must not page on a single bad SEC
      // response. Which means a permanently broken Form 4 ingest has looked identical, from
      // outside, to a healthy one. The heartbeat is the only place that difference is now
      // recorded, so it records the failure even though the HTTP response does not.
      await recordJobRun('form4', { ok: false, note: 'fetch/insert threw' });
      return Response.json({ form4: true, error: e.message }, { status: 200 });
    }
  }

  const results = { refreshed:[], failed:[], timestamp:new Date().toISOString() };
  const fail = (k,e) => { results.failed.push({key:k,error:e.message}); console.error(`❌ ${k}:`,e.message); };

  const STOCKS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','GLD','USO','UVXY'];
  const [stockPrices, crypto, insiderRaw, finnhubTickerRaw, finnhubMarketRaw, rssWSJRaw, rssMWRaw, rssBBRaw] = await Promise.allSettled([
    fetchStockPrices(STOCKS),
    fetchCrypto(),
    fetchForm4Trades(),
    fetchFinnhubPerTicker(),
    fetchFinnhubMarket(),
    fetchRSS('https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', 'WSJ',         0, { cap: 30 }),
    fetchRSS('https://feeds.content.dowjones.io/public/rss/mw_topstories',  'MarketWatch', 0),
    fetchRSS('https://feeds.bloomberg.com/markets/news.rss',                'Bloomberg',   0),
  ]);

  try {
    const stocks = stockPrices.status==='fulfilled' ? stockPrices.value : {};
    const btc    = crypto.status==='fulfilled'      ? crypto.value      : {};
    const prices = { ...stocks, ...btc };

    const TAPE = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','SPY','QQQ','DIA','UVXY','BTC-USD'];
    const tape = TAPE
      .filter(s => prices[s]?.price > 0)
      .map(s => ({ symbol:s, ...prices[s] }));
    if (tape.length > 0) {
      await kvSet('catalystpit:ticker_tape', JSON.stringify(tape));
      results.refreshed.push('catalystpit:ticker_tape');
    } else {
      console.log('⚠ ticker_tape: no price data, skipping write to preserve last good value');
    }

    const SNAP = ['SPY','QQQ','DIA','GLD','USO','UVXY','BTC-USD','AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD'];
    const snap = Object.fromEntries(
      SNAP.filter(s => prices[s]?.price > 0).map(s => [s, prices[s]])
    );
    if (Object.keys(snap).length > 0) {
      await kvSet('catalystpit:market_snapshot', JSON.stringify(snap));
      results.refreshed.push('catalystpit:market_snapshot');
    } else {
      console.log('⚠ market_snapshot: no price data, skipping write to preserve last good value');
    }
  } catch(e) { fail('prices', e); }

  try {
    const insiderTrades = insiderRaw.status === 'fulfilled' ? insiderRaw.value : [];

    // Postgres is the source of truth for insider trades.
    if (insiderTrades.length > 0) {
      try {
        const rows = insiderTrades
          .map(r => ({
            ...r,
            transactionCode: r.transactionCode || null,
            transactionDate: normalizeDate(r.transactionDate),
            filingDate:      normalizeDate(r.filingDate),
          }))
          .filter(r => r.filingDate);
        const skipped = insiderTrades.length - rows.length;
        const inserted = await db.insert(insiderTradesTable)
          .values(rows)
          .onConflictDoNothing({
            target: [
              insiderTradesTable.accession,
              insiderTradesTable.transactionDate,
              insiderTradesTable.transactionCode,
              insiderTradesTable.securityTitle,
              insiderTradesTable.shares,
              insiderTradesTable.pricePerShare,
              insiderTradesTable.sharesOwnedAfter,
            ],
          })
          .returning({ id: insiderTradesTable.id });
        console.log(`[insider_pg] ${inserted.length} new · ${rows.length - inserted.length} dupes${skipped ? ` · ${skipped} skipped (missing filingDate)` : ''}`);
        results.refreshed.push('catalystpit:postgres:insider_trades');
      } catch (e) {
        console.log(`[insider_pg] insert failed: ${e.message}`);
      }
    }

    const finnhubTicker = finnhubTickerRaw.status === 'fulfilled' ? finnhubTickerRaw.value : [];
    const finnhubMarket = finnhubMarketRaw.status === 'fulfilled' ? finnhubMarketRaw.value : [];
    const rssWSJ  = rssWSJRaw.status  === 'fulfilled' ? rssWSJRaw.value  : [];
    const rssMW   = rssMWRaw.status   === 'fulfilled' ? rssMWRaw.value   : [];
    const rssBB   = rssBBRaw.status   === 'fulfilled' ? rssBBRaw.value   : [];

    const mergedNews = mergeNews(rssWSJ, rssMW, rssBB, finnhubTicker, finnhubMarket).slice(0, 20);
    const withImages = mergedNews.filter(a => a.image_url).length;
    console.log(`📰 News: ${rssWSJ.length} WSJ + ${rssMW.length} MW + ${rssBB.length} BB + ${finnhubTicker.length} F-tkr + ${finnhubMarket.length} F-mkt → ${mergedNews.length} merged (${withImages} with real images)`);
    await kvSet('catalystpit:_raw_news', JSON.stringify(mergedNews));
    results.refreshed.push('catalystpit:_raw_news');
  } catch(e) { fail('raw_news_sec', e); }

  // Press-release wires — separate pool, NOT enriched (zero Anthropic cost). Filtered client-side by source.
  try {
    const [prn, gnw, bwr] = await Promise.allSettled([
      fetchWire('https://www.prnewswire.com/rss/news-releases-list.rss', 'PR Newswire'),
      fetchWire('https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies', 'GlobeNewswire'),
      fetchWire('https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEF9YXA%3D%3D', 'Business Wire'),
    ]);
    const wireAll = [prn, gnw, bwr].flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const wireSeen = new Set();
    const wireNews = [];
    for (const w of wireAll) {
      if (!w.title || hasBlockedTerm(w)) continue;
      const key = w.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (wireSeen.has(key)) continue;
      wireSeen.add(key);
      wireNews.push(w);
    }
    wireNews.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
    console.log(`📡 Wires: ${wireAll.length} raw → ${wireNews.length} deduped (PRN/GNW/BW)`);
    await kvSet('catalystpit:wire_news', JSON.stringify(wireNews.slice(0, 80)));
    results.refreshed.push('catalystpit:wire_news');
  } catch(e) { fail('wire_news', e); }

  await kvSet('catalystpit:last_refresh', results.timestamp);
  // The 5-minute pass that refreshes quotes, the tape and the raw wire pool. `results.failed`
  // carries the per-key failures; the run itself is a tick as long as it completed, and the note
  // names how many keys did not refresh so a partial degradation is visible without log-diving.
  await recordJobRun('quotes', {
    ok: true,
    seen: results.refreshed?.length ?? 0,
    note: results.failed?.length ? `${results.failed.length} keys failed` : 'all keys refreshed',
  });
  return Response.json(results, { status:200 });
}
