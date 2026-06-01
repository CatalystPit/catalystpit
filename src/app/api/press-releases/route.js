// Press Releases — full PR text from SEC EDGAR 8-K Exhibit 99.1 (free, commercial-OK).
// PR-only feed: scan the most-recent ~15 8-Ks per ticker, keep ONLY those that attach an
// EX-99.1 (the press release). Two-hop fetch validated in scripts/probe-8k*.mjs:
//   1) data.sec.gov/submissions/CIK{10}.json  → 8-K accessions (filingDate, items)
//   2) Archives/.../{accession}-index.htm      → Document table; locate EX-99.1 by EDGAR Type
//   3) fetch the 99.1 .htm                      → strip boilerplate + tags → clean text
// CIK resolved via SEC company_tickers.json. Hard KV cache (24h — 8-Ks are immutable once filed).

export const runtime = 'nodejs';
export const maxDuration = 30;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const SEC_UA = 'CatalystPit contact@catalystpit.com';   // SEC requires a UA with contact
const SEC_HEADERS = { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' };

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const TTL_OK = 24 * 60 * 60;      // 24h — filed 8-Ks don't change; new ones surface next refresh
const TTL_EMPTY = 6 * 60 * 60;    // 6h negative cache (so a newly-filing ticker recovers sooner)
const TTL_CIK = 7 * 24 * 60 * 60; // per-ticker CIK rarely changes
const SCAN_LIMIT = 15;            // most-recent 8-Ks to check for a 99.1 (caps SEC index fetches)
const FETCH_DELAY_MS = 130;       // politeness throttle between SEC fetches → < 10 req/s
const MAX_BODY_CHARS = 12000;     // cap stored PR body (keeps the KV value bounded)

// ── KV (REST), mirrors the other routes ──
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const { result } = await r.json();
    return result ? JSON.parse(result) : null;
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttl}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch { /* non-fatal */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad10 = (cik) => String(cik).padStart(10, '0');

async function secJson(url) {
  try {
    const r = await fetch(url, { headers: SEC_HEADERS });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function secText(url) {
  try {
    const r = await fetch(url, { headers: SEC_HEADERS });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

// ── ticker → CIK ──────────────────────────────────────────────────────────────
// Per-ticker CIK is cached in KV (tiny). The full company_tickers.json (~1MB) is memoised at
// module scope for warm invocations rather than stored in KV as one oversized value.
let TICKER_MAP = null;
async function loadTickerMap() {
  if (TICKER_MAP) return TICKER_MAP;
  const data = await secJson('https://www.sec.gov/files/company_tickers.json');
  if (!data) return null;
  const map = {};
  for (const k of Object.keys(data)) {
    const row = data[k];
    if (row && row.ticker) map[String(row.ticker).toUpperCase()] = { cik: row.cik_str, title: row.title || null };
  }
  TICKER_MAP = map;
  return map;
}
async function resolveCik(ticker) {
  const cached = await kvGet(`sec:cik:${ticker}`);
  if (cached) return cached;
  const map = await loadTickerMap();
  const info = map ? map[ticker] : null;
  if (!info) return null;
  await kvSet(`sec:cik:${ticker}`, info, TTL_CIK);
  return info;
}

// ── HTML → text ────────────────────────────────────────────────────────────────
const decodeEntities = (s) => String(s)
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&rsquo;|&#8217;/g, '’').replace(/&lsquo;|&#8216;/g, '‘')
  .replace(/&rdquo;|&#8221;/g, '”').replace(/&ldquo;|&#8220;/g, '“')
  .replace(/&mdash;|&#8212;/g, '—').replace(/&ndash;|&#8211;/g, '–')
  .replace(/&reg;|&#174;/g, '®').replace(/&trade;|&#8482;/g, '™')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

// Block-aware: turn block-closers into newlines so paragraph structure survives the tag strip.
function htmlToLines(html) {
  let s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|table|section|header|footer|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// EDGAR prepends a document header that strips to "EX-99.1 <seq> <filename> EX-99.1 Document"
// (and the exhibit itself often opens with a bare "Exhibit 99.1"). Peel both off the front.
const BOILER_LINE = (l) => /^ex-?99\.\d+$/i.test(l) || /^document$/i.test(l) || /^exhibit\s+99\.\d+$/i.test(l) || /^\d{1,3}$/.test(l) || /\.htm$/i.test(l);
function cleanPrLines(lines) {
  const out = [...lines];
  if (out.length) {
    out[0] = out[0]
      .replace(/^\s*ex-?99\.\d+\b[\s\S]*?\bdocument\b\s*/i, '')   // "EX-99.1 2 file.htm EX-99.1 Document"
      .replace(/^\s*exhibit\s+99\.\d+\b[:.\s-]*/i, '')            // leading "Exhibit 99.1"
      .trim();
  }
  while (out.length && (BOILER_LINE(out[0]) || out[0] === '')) out.shift();
  return out;
}

// Parse the filing-index .htm Document/Data Files tables (Seq|Description|Document|Type|Size),
// returning [{ name, href, type, description }]. The Type column is the authoritative identifier.
function parseIndexDocs(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 4) continue;
    const docCell = tds[2] || '';
    const hrefM = docCell.match(/href="([^"]+)"/i);
    if (!hrefM) continue;
    rows.push({
      name: docCell.replace(/<[^>]+>/g, '').trim(),
      href: hrefM[1],
      type: (tds[3] || '').replace(/<[^>]+>/g, '').trim(),
      description: (tds[1] || '').replace(/<[^>]+>/g, '').trim(),
    });
  }
  return rows;
}

// Headline picker. Some filers open the 99.1 with the actual title (Apple: "Apple reports
// second quarter results"); others lead with a letterhead block — company name, address,
// "NYSE: STT", URL, date — before the title (State Street). Skip letterhead-noise lines and
// take the first title-like line; fall back to line 0 if nothing qualifies.
const normCo = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(?:the|corp|corporation|inc|incorporated|co|company|ltd|plc|lp|llc|group|holdings|sa|nv|ag)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();
function pickHeadline(lines, companyName) {
  const coNorm = normCo(companyName);
  const isNoise = (l) => {
    if (l.length < 25) return true;                                    // letterhead fragments / company name
    if (/(?:https?:\/\/|www\.)/i.test(l)) return true;                 // URL
    if (/\b(?:NYSE|NASDAQ|NYSE American|OTC|CBOE)\b\s*[:.]/i.test(l)) return true;  // exchange line
    if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(l)) return true;        // "Boston, MA 02114"
    if (/^[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4}$/.test(l)) return true;    // bare date "April 17, 2026"
    if (/\b(?:news|press)\s+release\b/i.test(l)) return true;          // dateline label "Boston, MA… <date> News Release"
    if (coNorm && normCo(l) === coNorm) return true;                   // letterhead = company name
    return false;
  };
  const n = Math.min(lines.length, 15);
  for (let i = 0; i < n; i++) if (!isNoise(lines[i])) return { idx: i, headline: lines[i].slice(0, 240) };
  return { idx: 0, headline: (lines[0] || '').slice(0, 240) };
}

// Given an 8-K accession, return its press release (EX-99.1) or null when it has none.
async function fetchPressRelease(cikUnpadded, accession, filingDate, itemsStr, companyName) {
  const folder = accession.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${folder}`;
  const indexHtm = await secText(`${base}/${accession}-index.htm`);
  if (!indexHtm) return null;

  const docs = parseIndexDocs(indexHtm);
  // primary: EDGAR Type === EX-99.1; fallback: filename pattern (filenames are inconsistent).
  const hit = docs.find((d) => /^ex-?99\.1$/i.test(d.type))
    || docs.find((d) => /(?:^|[^0-9])ex.?-?99[._-]?1|exhibit.?99[._-]?1|ex991/i.test(d.name));
  if (!hit) return null;   // no 99.1 → not a press release (e.g. item 5.07/5.02 filings)

  const docUrl = hit.href.startsWith('http') ? hit.href : `https://www.sec.gov${hit.href}`;
  await sleep(FETCH_DELAY_MS);
  const docHtml = await secText(docUrl);
  if (!docHtml) return null;

  const lines = cleanPrLines(htmlToLines(docHtml));
  if (!lines.length) return null;

  const { idx, headline } = pickHeadline(lines, companyName);
  let bodyText = lines.slice(idx + 1).join('\n').trim();
  if (bodyText.length > MAX_BODY_CHARS) bodyText = bodyText.slice(0, MAX_BODY_CHARS).trim() + '…';
  const excerpt = (bodyText || headline).replace(/\s+/g, ' ').slice(0, 280).trim();

  return {
    filingDate,
    items: itemsStr ? itemsStr.split(',').map((x) => x.trim()).filter(Boolean) : [],
    headline,
    excerpt,
    bodyText,
    filingUrl: docUrl,
  };
}

async function buildPressReleases(ticker) {
  const info = await resolveCik(ticker);
  if (!info) return { ticker, companyName: null, pressReleases: [] };   // junk/unknown → empty (no crash)

  const sub = await secJson(`https://data.sec.gov/submissions/CIK${pad10(info.cik)}.json`);
  const recent = sub?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return { ticker, companyName: info.title, pressReleases: [] };

  // most-recent 8-K accessions, capped
  const eightKs = [];
  for (let i = 0; i < recent.form.length && eightKs.length < SCAN_LIMIT; i++) {
    if (recent.form[i] !== '8-K') continue;
    eightKs.push({ accession: recent.accessionNumber[i], filingDate: recent.filingDate[i], items: recent.items?.[i] || '' });
  }

  const cikUnpadded = String(Number(info.cik));
  const pressReleases = [];
  for (const f of eightKs) {
    const pr = await fetchPressRelease(cikUnpadded, f.accession, f.filingDate, f.items, info.title);
    if (pr) pressReleases.push(pr);
    await sleep(FETCH_DELAY_MS);   // throttle the per-8-K index fetch too
  }

  return { ticker, companyName: info.title, pressReleases };
}

export async function GET(request) {
  let ticker = '';
  try {
    const { searchParams } = new URL(request.url);
    ticker = (searchParams.get('ticker') || '').toUpperCase().trim();
    const forceRefresh = searchParams.get('refresh') === '1';
    if (!TICKER_RE.test(ticker)) return Response.json({ error: 'Invalid ticker' }, { status: 400 });

    const cacheKey = `pressreleases:${ticker}`;
    if (!forceRefresh) {
      const cached = await kvGet(cacheKey);
      if (cached) return Response.json({ ...cached, cached: true });
    }

    const fresh = await buildPressReleases(ticker);
    await kvSet(cacheKey, fresh, fresh.pressReleases.length ? TTL_OK : TTL_EMPTY);
    return Response.json({ ...fresh, cached: false });
  } catch (e) {
    console.log(`[press_releases] ${ticker} route error: ${e.message}`);
    // null discipline: never surface a 500 — empty list renders the clean "no PRs" state
    return Response.json({ ticker, companyName: null, pressReleases: [], error: false }, { status: 200 });
  }
}
