// Cache EDGAR filing history for a stratified sample, so the backtest can iterate without refetching.
//
// submissions.json gives BOTH things we need in one request per issuer:
//   - 8-K rows with an `items` string, so Item 2.02 ("Results of Operations") is directly readable
//   - `reportDate`, the PERIOD-OF-REPORT the filer declares — for a 2.02 that is the day the results
//     were released, which is closer to the truth than the filing date
//   - 10-Q / 10-K filing dates, the fallback history the current estimator uses
//
// `recent` holds roughly the last 1,000 filings; anything older sits in filings.files[], which is
// fetched too so the history reaches back far enough to model year-over-year timing.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

const UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const OUT = path.join(process.cwd(), 'node_modules', '.cache', 'earnings');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = fs.readFileSync('.env.local', 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());

const WANT = Number(process.argv[2] || 300);

const cikData = await (await fetch('https://www.sec.gov/files/company_tickers.json', { headers: UA })).json();
const CIK = new Map();
for (const e of Object.values(cikData)) CIK.set(e.ticker, String(e.cik_str).padStart(10, '0'));

// Stratified by market cap, because a calendar is read for large caps but judged on all of them.
const bucket = async (lo, hi, n) => sql`
  SELECT ticker, company, market_cap FROM screener_stocks
   WHERE market_cap > ${lo} AND market_cap <= ${hi} AND company IS NOT NULL
   ORDER BY random() LIMIT ${n}`;
const LARGE = 10e9, MID = 2e9, SMALL = 3e8;
const groups = [
  ['large', await bucket(LARGE, 1e15, Math.round(WANT / 3))],
  ['mid', await bucket(MID, LARGE, Math.round(WANT / 3))],
  ['small', await bucket(SMALL, MID, Math.round(WANT / 3))],
];

const pull = async (url) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch { /* retry */ }
    await sleep(600);
  }
  return null;
};

let done = 0, skipped = 0;
for (const [cap, rows] of groups) {
  for (const row of rows) {
    const t = String(row.ticker).toUpperCase();
    const cik = CIK.get(t);
    if (!cik) { skipped++; continue; }
    const file = path.join(OUT, `${t}.json`);
    if (fs.existsSync(file)) { done++; continue; }

    const j = await pull(`https://data.sec.gov/submissions/CIK${cik}.json`);
    await sleep(130);
    if (!j) { skipped++; continue; }

    const blocks = [j.filings?.recent].filter(Boolean);
    for (const extra of (j.filings?.files || []).slice(0, 3)) {
      const e = await pull(`https://data.sec.gov/submissions/${extra.name}`);
      await sleep(130);
      if (e) blocks.push(e);
    }

    const announcements = [];   // 8-K Item 2.02
    const periodic = [];        // 10-Q / 10-K filing dates
    for (const b of blocks) {
      const n = (b.form || []).length;
      for (let i = 0; i < n; i++) {
        const form = b.form[i];
        if (form === '10-Q' || form === '10-K') {
          periodic.push({ filed: b.filingDate[i], form, period: b.reportDate?.[i] || null });
        } else if (form === '8-K' && String(b.items?.[i] || '').includes('2.02')) {
          announcements.push({
            filed: b.filingDate[i],
            event: b.reportDate?.[i] || b.filingDate[i],
            items: String(b.items[i]),
            accession: b.accessionNumber?.[i] || null,
          });
        }
      }
    }
    const uniq = (arr, key) => [...new Map(arr.map((x) => [key(x), x])).values()];
    fs.writeFileSync(file, JSON.stringify({
      ticker: t, cik, company: row.company, marketCap: Number(row.market_cap), cap,
      sic: j.sic || null, sicDescription: j.sicDescription || null,
      fiscalYearEnd: j.fiscalYearEnd || null,
      announcements: uniq(announcements, (x) => x.accession || `${x.filed}|${x.event}`)
        .sort((a, b) => a.event.localeCompare(b.event)),
      periodic: uniq(periodic, (x) => `${x.form}|${x.filed}`).sort((a, b) => a.filed.localeCompare(b.filed)),
    }), 'utf8');
    done++;
    if (done % 25 === 0) console.log(`  ${done} cached (${skipped} skipped)`);
  }
}
console.log(`cached ${done}, skipped ${skipped}, in ${OUT}`);
