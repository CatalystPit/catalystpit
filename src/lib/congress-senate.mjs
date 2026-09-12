// src/lib/congress-senate.mjs
//
// OFFICIAL Senate eFD PTR ingest (Phase 4). Pure fetch + parse — NO db imports.
// Produces FMP-shaped records so buildRow(rec, 'senate', index) maps them unchanged.
//
// Source mechanics (host is efdsearch.senate.gov — NOT efd.senate.gov):
//  1. GET  /search/home/                 → csrftoken cookie + <input csrfmiddlewaretoken>
//  2. POST /search/home/ (prohibition_agreement=1, csrfmiddlewaretoken)  → sessionid (accepts ToU)
//  3. POST /search/report/data/ (DataTables; report_types=[11] = PTR; start/length paginate) → JSON rows
//  4. row col[3] href → /search/view/ptr/{uuid}/ (e-filed HTML, parseable) | /search/view/paper/… (scanned → skip)
// ToU restricts PURPOSE (no commercial use except news/communications-media dissemination to the public),
// not the method of access. Throttle ~2s/request; re-auth if the data endpoint returns HTML not JSON.

const ROOT = 'https://efdsearch.senate.gov';
const HOME = `${ROOT}/search/home/`;
const SEARCH = `${ROOT}/search/`;
const DATA = `${ROOT}/search/report/data/`;
const UA = 'Mozilla/5.0 (compatible; CatalystPit/1.0; +https://catalystpit.com)';
const PTR_REPORT_TYPE = 11;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toISO = (mdy) => { const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const decode = (s) => String(s || '').replace(/<[^>]*>/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// ── minimal cookie jar over fetch ─────────────────────────────────────────────
function jar() {
  const store = new Map();
  return {
    absorb(res) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) store.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
    },
    get(k) { return store.get(k); },
    header() { return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

async function establishSession() {
  const cookies = jar();
  const r1 = await fetch(HOME, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  cookies.absorb(r1);
  const html = await r1.text();
  const tok = html.match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/i)?.[1] || cookies.get('csrftoken');
  const body = new URLSearchParams({ csrfmiddlewaretoken: tok, prohibition_agreement: '1' });
  const r2 = await fetch(HOME, {
    method: 'POST', redirect: 'manual',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: HOME, Cookie: cookies.header() },
    body, cache: 'no-store',
  });
  cookies.absorb(r2);
  return cookies;
}

// One page of the DataTables PTR feed. Returns { rows, total } or throws (triggers re-auth upstream).
async function fetchPage(cookies, start, length, startDate) {
  const csrf = cookies.get('csrftoken') || '';
  const body = new URLSearchParams({
    start: String(start), length: String(length),
    report_types: `[${PTR_REPORT_TYPE}]`, filer_types: '[]',
    submitted_start_date: startDate || '', submitted_end_date: '',
    candidate_state: '', senator_state: '', office_id: '', first_name: '', last_name: '',
    csrfmiddlewaretoken: csrf,
  });
  const r = await fetch(DATA, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: SEARCH, 'X-CSRFToken': csrf, Cookie: cookies.header(), 'X-Requested-With': 'XMLHttpRequest' },
    body, cache: 'no-store',
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { throw new Error('non-json (session expired?)'); }
  const rows = (json.data || []).map((c) => {
    const href = (String(c[3] || '').match(/href=['"]([^'"]+)['"]/i) || [])[1] || null;
    const docId = href ? (href.match(/\/(ptr|paper)\/([0-9a-f-]+)/i) || [])[2] || href : null;
    return {
      first: decode(c[0]), last: decode(c[1]), filerDesc: decode(c[2]),
      href, docId, isPaper: href ? /\/paper\//i.test(href) : false, filingDate: toISO(decode(c[4])),
    };
  });
  return { rows, total: json.recordsTotal || json.recordsFiltered || rows.length };
}

// Walk the whole PTR feed (paginated). startDate = 'MM/DD/YYYY HH:MM:SS'. Bounded by maxRows/pages.
export async function fetchSenatePtrIndex({ startDate = '01/01/2012 00:00:00', pageSize = 100, maxPages = 60, gapMs = 1800 } = {}) {
  let cookies = await establishSession();
  const all = [];
  let start = 0, total = Infinity, pages = 0;
  while (start < total && pages < maxPages) {
    let page;
    try { page = await fetchPage(cookies, start, pageSize, startDate); }
    catch { cookies = await establishSession(); page = await fetchPage(cookies, start, pageSize, startDate); }
    all.push(...page.rows);
    total = page.total; start += pageSize; pages++;
    if (page.rows.length < pageSize) break;
    await sleep(gapMs);
  }
  return { rows: all, total };
}

// ── PTR report HTML → transactions ────────────────────────────────────────────
export function parseSenatePtrHtml(html) {
  const tbody = String(html || '').match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || '';
  const trs = tbody.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const txns = [];
  for (const tr of trs) {
    const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((td) => decode(td));
    if (cells.length < 8) continue;
    // [0]# [1]TxDate [2]Owner [3]Ticker [4]AssetName [5]AssetType [6]TxType [7]Amount [8]Comment
    // Stripping every separator fused a two-leg corporate action into a symbol that does not exist:
    // a cell reading "CEQP ET" became CEQPET, "ETRN EQT" became ETRNEQT, "LSXMK SIRI" became
    // LSXMKSIRI. Split instead, and when there are two legs record none. One column cannot hold
    // both, and the description ("X (Exchanged) Y (Received)") keeps the detail either way.
    const legs = (cells[3] || '').split(/[^A-Za-z0-9.\-]+/).filter(Boolean);
    const rawTicker = legs.length === 1 ? legs[0].toUpperCase() : '';
    txns.push({
      transactionDate: toISO(cells[1]),
      owner: cells[2] && cells[2] !== '--' ? cells[2] : 'Self',
      ticker: rawTicker && rawTicker !== '--' ? rawTicker : null,
      assetDescription: cells[4] || null,
      assetType: cells[5] || null,
      type: cells[6] || null,
      amount: cells[7] || null,
      comment: cells[8] && cells[8] !== '--' ? cells[8] : null,
    });
  }
  return txns;
}

export async function fetchSenatePtr(row, cookies) {
  if (row.isPaper || !row.href) return { status: 'paper', format: 'paper', url: ROOT + (row.href || ''), transactions: [], recs: [] };
  const url = row.href.startsWith('http') ? row.href : ROOT + row.href;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: SEARCH, Cookie: cookies ? cookies.header() : '' }, cache: 'no-store' });
  if (!r.ok) return { status: 'error', format: 'html', url, error: `HTTP ${r.status}`, transactions: [], recs: [] };
  const txns = parseSenatePtrHtml(await r.text());
  const recs = txns.map((t) => senateRec(row, t, url));
  return { status: txns.length ? 'parsed' : 'empty', format: 'html', url, transactions: txns, recs };
}

export function senateRec(row, t, url) {
  return {
    firstName: row.first, lastName: row.last,
    office: `${row.first} ${row.last}`.trim(),
    district: null,
    symbol: t.ticker || null,
    assetDescription: t.assetDescription || null,
    assetType: t.assetType || null,
    owner: t.owner || null,
    type: t.type || null,
    amount: t.amount || null,
    transactionDate: t.transactionDate || null,
    disclosureDate: row.filingDate || t.transactionDate || null,
    capitalGainsOver200: null,
    comment: t.comment || null,
    link: url,
  };
}

export { establishSession };
