// PROBE ONLY — SEC EDGAR 8-K recent filings shape for AAPL + STT.
// Run: node scripts/probe-8k.mjs
// Pulls data.sec.gov/submissions/CIK{10-digit}.json, filters form==='8-K',
// and prints date / accession / primary doc URL / items + description.
// Ticker→CIK via SEC's company_tickers.json (free, commercial-OK).

const UA = 'CatalystPit contact@catalystpit.com';
const HEADERS = { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' };
const TICKERS = ['AAPL', 'STT'];
const MAX_SHOW = 8; // how many recent 8-Ks to print per ticker

const pad10 = (cik) => String(cik).padStart(10, '0');

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// 1) ticker → CIK map
async function loadCikMap() {
  const data = await getJson('https://www.sec.gov/files/company_tickers.json');
  // shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
  const map = {};
  for (const k of Object.keys(data)) {
    const row = data[k];
    map[String(row.ticker).toUpperCase()] = { cik: row.cik_str, title: row.title };
  }
  return map;
}

// primary document URL: accession dashes stripped for the folder segment
function primaryDocUrl(cik, accessionNumber, primaryDocument) {
  const folder = String(accessionNumber).replace(/-/g, '');
  const cikNoPad = String(Number(cik)); // archives path uses non-zero-padded CIK
  return `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${folder}/${primaryDocument}`;
}

async function probeTicker(ticker, cikInfo) {
  const cik10 = pad10(cikInfo.cik);
  const url = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const sub = await getJson(url);

  const recent = sub.filings?.recent || {};
  const fieldNames = Object.keys(recent);

  // parallel arrays — zip into per-filing objects, then filter to 8-K
  const n = (recent.accessionNumber || []).length;
  const eightKs = [];
  for (let i = 0; i < n; i++) {
    if (recent.form?.[i] !== '8-K') continue;
    eightKs.push({
      filingDate: recent.filingDate?.[i] ?? null,
      reportDate: recent.reportDate?.[i] ?? null,
      accessionNumber: recent.accessionNumber?.[i] ?? null,
      primaryDocument: recent.primaryDocument?.[i] ?? null,
      primaryDocDescription: recent.primaryDocDescription?.[i] ?? null,
      items: recent.items?.[i] ?? null,
      primaryDocUrl: primaryDocUrl(cikInfo.cik, recent.accessionNumber?.[i], recent.primaryDocument?.[i]),
    });
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${ticker} — ${cikInfo.title}  (CIK ${cikInfo.cik} → ${cik10})`);
  console.log(`submissions URL: ${url}`);
  console.log(`filings.recent field names (${fieldNames.length}): ${fieldNames.join(', ')}`);
  console.log(`total recent filings: ${n} | 8-K count: ${eightKs.length}`);
  console.log('-'.repeat(78));

  // raw shape of the FIRST 8-K (every field present in filings.recent, that row's value)
  if (eightKs.length) {
    const i0 = (recent.form || []).findIndex((f) => f === '8-K');
    const rawRow = {};
    for (const f of fieldNames) rawRow[f] = recent[f]?.[i0];
    console.log('RAW shape of most-recent 8-K row (all filings.recent fields):');
    console.log(JSON.stringify(rawRow, null, 2));
    console.log('-'.repeat(78));
  }

  console.log(`Most recent ${Math.min(MAX_SHOW, eightKs.length)} 8-K filings (extracted fields):`);
  for (const f of eightKs.slice(0, MAX_SHOW)) {
    console.log(JSON.stringify(f, null, 2));
  }
}

async function main() {
  const cikMap = await loadCikMap();
  for (const t of TICKERS) {
    const info = cikMap[t];
    if (!info) { console.log(`\n${t}: NOT FOUND in company_tickers.json`); continue; }
    try {
      await probeTicker(t, info);
    } catch (e) {
      console.log(`\n${t}: probe failed — ${e.message}`);
    }
  }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
