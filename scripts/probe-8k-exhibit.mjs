// PROBE ONLY (Step 1b) — second hop: from an 8-K accession to its Exhibit 99.1 (press release).
// Run: node scripts/probe-8k-exhibit.mjs
// For the most-recent 8-K of AAPL + STT: list the filing's documents, locate EX-99.1
// empirically (by EDGAR Type AND by filename pattern — reporting which actually identifies it),
// fetch the 99.1, print ~500 chars of extracted text, assess cleanliness, and flag any miss.

const UA = 'CatalystPit contact@catalystpit.com';
const HEADERS = { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' };
const TICKERS = ['AAPL', 'STT'];

const pad10 = (cik) => String(cik).padStart(10, '0');

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function loadCikMap() {
  const data = await getJson('https://www.sec.gov/files/company_tickers.json');
  const map = {};
  for (const k of Object.keys(data)) map[String(data[k].ticker).toUpperCase()] = { cik: data[k].cik_str, title: data[k].title };
  return map;
}

// most-recent 8-K accession for a ticker
async function recentMost8K(cik) {
  const sub = await getJson(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
  const r = sub.filings?.recent || {};
  const i = (r.form || []).findIndex((f) => f === '8-K');
  if (i < 0) return null;
  return { accession: r.accessionNumber[i], filingDate: r.filingDate[i], items: r.items[i], primaryDocument: r.primaryDocument[i] };
}

// ── HTML helpers ──
const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
const cellText = (h) => stripTags(h || '');

// Parse the EDGAR filing-index .htm tables (Document Format Files / Data Files):
// columns are Seq | Description | Document(link) | Type | Size.
function parseIndexHtm(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 4) continue;
    const docCell = tds[2] || '';
    const hrefM = docCell.match(/href="([^"]+)"/i);
    rows.push({
      seq: cellText(tds[0]),
      description: cellText(tds[1]),
      name: cellText(docCell),
      href: hrefM ? hrefM[1] : null,
      type: cellText(tds[3]),
      size: cellText(tds[4] || ''),
    });
  }
  return rows;
}

const looksLike991ByName = (name) => /(?:^|[^0-9])ex.?-?99[._-]?1|exhibit.?99[._-]?1|ex991/i.test(name || '');
const isInlineXbrl = (html) => /<ix:|xmlns:ix=|inline\s*xbrl/i.test(html);

async function probe(ticker, info) {
  const cikUnpadded = String(Number(info.cik));
  const f = await recentMost8K(info.cik);
  console.log('\n' + '='.repeat(80));
  console.log(`${ticker} — ${info.title}`);
  if (!f) { console.log('  no recent 8-K found'); return; }

  const folder = f.accession.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${folder}`;
  const indexJsonUrl = `${base}/index.json`;
  const indexHtmUrl = `${base}/${f.accession}-index.htm`;
  console.log(`  most-recent 8-K: ${f.filingDate}  acc ${f.accession}  items ${f.items}`);
  console.log(`  folder base    : ${base}`);

  // (1) index.json — does it carry document types?
  let dirItems = [];
  try {
    const ij = await getJson(indexJsonUrl);
    dirItems = ij.directory?.item || [];
    console.log(`\n  [index.json] ${indexJsonUrl}`);
    console.log(`    lists ${dirItems.length} files. per-item fields: ${dirItems[0] ? Object.keys(dirItems[0]).join(', ') : '(none)'}`);
    console.log('    sample items:', JSON.stringify(dirItems.slice(0, 6).map((d) => ({ name: d.name, type: d.type })), null));
  } catch (e) { console.log(`  [index.json] FAILED: ${e.message}`); }

  // (2) filing-index .htm — authoritative Type column
  let rows = [];
  try {
    const html = await getText(indexHtmUrl);
    rows = parseIndexHtm(html).filter((r) => r.href);
    console.log(`\n  [filing-index .htm] ${indexHtmUrl}`);
    console.log('    Document Format / Data Files table (name | TYPE | description):');
    for (const r of rows) console.log(`      - ${r.name}  |  TYPE="${r.type}"  |  ${r.description}`);
  } catch (e) { console.log(`  [filing-index .htm] FAILED: ${e.message}`); }

  // (3) identify EX-99.1 — by Type vs by filename, report both signals
  const byType = rows.filter((r) => /EX-?99\.1\b/i.test(r.type));
  const byName = rows.filter((r) => looksLike991ByName(r.name));
  console.log('\n  [99.1 identification]');
  console.log(`    by EDGAR Type  (/EX-99.1/): ${byType.map((r) => r.name).join(', ') || '(none)'}`);
  console.log(`    by filename pattern        : ${byName.map((r) => r.name).join(', ') || '(none)'}`);

  const hit = byType[0] || byName[0] || null;
  if (!hit) {
    console.log(`    >>> NO EXHIBIT 99.1 in this 8-K (items ${f.items}). MISS — render fallback.`);
    return;
  }
  console.log(`    chosen: ${hit.name} (matched by ${byType[0] ? 'Type' : 'filename-only'})`);

  // (4) fetch the 99.1, extract text, assess cleanliness
  const docUrl = hit.href.startsWith('http') ? hit.href : `https://www.sec.gov${hit.href}`;
  try {
    const raw = await getText(docUrl);
    const text = stripTags(raw);
    const density = (text.length / raw.length);
    console.log(`\n  [99.1 fetch] ${docUrl}`);
    console.log(`    raw bytes: ${raw.length} | extracted text chars: ${text.length} | text/raw density: ${density.toFixed(3)}`);
    console.log(`    inline-XBRL wrapper: ${isInlineXbrl(raw) ? 'YES (iXBRL — more markup to strip)' : 'no (plain HTML)'}`);
    console.log(`    --- first 500 chars of extracted text ---`);
    console.log('    ' + text.slice(0, 500).replace(/\n/g, ' '));
    console.log(`    --- end ---`);
  } catch (e) { console.log(`  [99.1 fetch] FAILED: ${e.message}`); }
}

async function main() {
  const map = await loadCikMap();
  for (const t of TICKERS) {
    const info = map[t];
    if (!info) { console.log(`\n${t}: NOT FOUND`); continue; }
    try { await probe(t, info); } catch (e) { console.log(`\n${t}: probe failed — ${e.message}`); }
  }
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
