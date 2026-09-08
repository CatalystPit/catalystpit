// PROBE ONLY — forward-guidance source check. Run:
//   node --env-file=.env.local scripts/probe-guidance.mjs
// (1) Finnhub estimate/guidance endpoints on our tier (expect premium/403).
// (2) Is guidance extractable from the 8-K earnings EX-99.1 text we already parse? Scan AAPL Q2 + STT.

const FINNHUB = process.env.FINNHUB_KEY;
const SEC_HEADERS = { 'User-Agent': 'CatalystPit contact@catalystpit.com', 'Accept-Encoding': 'gzip, deflate' };

// ── (1) Finnhub endpoints ──────────────────────────────────────────────────────
const FINNHUB_ENDPOINTS = [
  ['eps-estimate (quarterly)',     '/stock/eps-estimate?symbol=AAPL&freq=quarterly'],
  ['revenue-estimate (quarterly)', '/stock/revenue-estimate?symbol=AAPL&freq=quarterly'],
  ['price-target',                 '/stock/price-target?symbol=AAPL'],
  ['recommendation trends',        '/stock/recommendation?symbol=AAPL'],   // often FREE — control case
  ['company guidance (eps)',       '/stock/eps-estimate?symbol=AAPL'],
];

async function finnhubProbe() {
  console.log('=== (1) FINNHUB estimate/guidance endpoints (our tier) ===');
  if (!FINNHUB) { console.log('  FINNHUB_KEY missing'); return; }
  for (const [label, path] of FINNHUB_ENDPOINTS) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1${path}${path.includes('?') ? '&' : '?'}token=${FINNHUB}`);
      const body = await r.text();
      const paywalled = r.status === 403 || /don.t have access|premium/i.test(body);
      console.log(`\n  ${label}\n    ${path.split('&token')[0]}  → HTTP ${r.status}${paywalled ? '  >>> PAYWALLED' : ''}`);
      console.log('    body (≤220):', body.slice(0, 220));
    } catch (e) { console.log(`  ${label}: fetch error ${e.message}`); }
  }
}

// ── (2) 8-K EX-99.1 guidance-language scan ──────────────────────────────────────
const PR_DOCS = [
  ['AAPL Q2 2026', 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000011/a8-kex991q2202603282026.htm'],
  ['STT Q1 2026',  'https://www.sec.gov/Archives/edgar/data/93751/000009375126000184/stt-20260417.htm'],
];
// STT primaryDocument was the cover; the 99.1 lives in the same folder — resolve via index.
const STT_INDEX = 'https://www.sec.gov/Archives/edgar/data/93751/000009375126000184/0000093751-26-000184-index.htm';

const GUIDANCE_RE = /(guidance|we (?:expect|anticipate|estimate|continue to expect)|outlook|for the (?:first|second|third|fourth|next) quarter|full[- ]year|fiscal\s+20\d\d|we (?:are )?(?:targeting|forecast)|expects? (?:revenue|EPS|net interest))/i;

const stripText = (html) => String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/[ \t]+/g, ' ');

async function scanGuidance(label, url) {
  console.log(`\n  ── ${label} ──\n    ${url}`);
  const r = await fetch(url, { headers: SEC_HEADERS });
  if (!r.ok) { console.log(`    HTTP ${r.status} — skip`); return; }
  const text = stripText(await r.text());
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 30);
  const hits = sentences.filter((s) => GUIDANCE_RE.test(s));
  console.log(`    extracted ${sentences.length} sentences | guidance-language matches: ${hits.length}`);
  for (const h of hits.slice(0, 8)) console.log('      •', h.slice(0, 180));
  if (!hits.length) console.log('    >>> NO forward-guidance language found in this exhibit');
}

async function secScan() {
  console.log('\n\n=== (2) GUIDANCE in 8-K EX-99.1 earnings exhibits ===');
  await scanGuidance(PR_DOCS[0][0], PR_DOCS[0][1]);
  // STT: resolve the EX-99.1 from the filing index by parsing table rows (Seq|Desc|Document|Type|Size)
  try {
    const idx = await (await fetch(STT_INDEX, { headers: SEC_HEADERS })).text();
    let href = null;
    for (const tr of idx.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
      if (tds.length < 4) continue;
      const type = (tds[3] || '').replace(/<[^>]+>/g, '').trim();
      const hrefM = (tds[2] || '').match(/href="([^"]+)"/i);
      if (/^ex-?99\.1$/i.test(type) && hrefM) { href = hrefM[1]; break; }
    }
    if (href) await scanGuidance('STT Q1 2026 (EX-99.1)', href.startsWith('http') ? href : `https://www.sec.gov${href}`);
    else { console.log('\n  ── STT Q1 2026 ── no EX-99.1 row in index'); }
  } catch (e) { console.log('  STT scan error:', e.message); }
}

async function main() {
  await finnhubProbe();
  await secScan();
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
