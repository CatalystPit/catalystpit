// Re-ingest existing 13F filings with sub-account AGGREGATION (fixes undercounted holdings, e.g.
// BlackRock NVIDIA $12B → real ~$247B). Re-fetches each stored filing's info table from SEC, sums
// rows per (cusip,class,putCall), and replaces fund_holdings — preserving resolved tickers from
// cusip_map. Prioritizes corporate filers + largest managers + biggest by value.
// Run: node --env-file=.env.local scripts/reingest-13f-aggregate.mjs [filerLimit] [quartersPerFiler]
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const UA = { 'User-Agent': 'CatalystPit contact@catalystpit.com' };
const unpad = (c) => String(Number(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filerLimit = parseInt(process.argv[2] || '300', 10);
const qPer = parseInt(process.argv[3] || '2', 10);

async function secText(url) { try { const r = await fetch(url, { headers: UA }); return r.ok ? await r.text() : null; } catch { return null; } }
async function secJson(url) { try { const r = await fetch(url, { headers: UA }); return r.ok ? await r.json() : null; } catch { return null; } }

const tag = (b, n) => { const m = b.match(new RegExp(`<(?:\\w+:)?${n}>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : ''; };
function parseAndAggregate(xml, wholeDollars) {
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) || [];
  const by = new Map();
  for (const b of blocks) {
    const cusip = tag(b, 'cusip').toUpperCase(); if (!cusip) continue;
    const raw = parseFloat(tag(b, 'value').replace(/,/g, '')) || 0;
    const value = wholeDollars ? raw : raw * 1000;
    const shares = parseFloat(tag(b, 'sshPrnamt').replace(/,/g, '')) || 0;
    const cls = tag(b, 'titleOfClass') || '', putCall = tag(b, 'putCall') || '';
    const k = `${cusip}|${cls}|${putCall}`;
    const e = by.get(k);
    if (e) { e.value += value; e.shares += shares; }
    else by.set(k, { cusip, issuer: tag(b, 'nameOfIssuer'), cls, putCall, value, shares });
  }
  return [...by.values()];
}
async function fetchHoldings(cik, accession, filedDate) {
  const accND = accession.replace(/-/g, '');
  const idx = await secJson(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accND}/index.json`);
  const items = idx?.directory?.item || [];
  const xmls = items.filter((it) => /\.xml$/i.test(it.name) && !/primary_doc\.xml$/i.test(it.name));
  const wholeDollars = String(filedDate) >= '2023-01-01';
  for (const it of xmls) {
    await sleep(120);
    const xml = await secText(`https://www.sec.gov/Archives/edgar/data/${unpad(cik)}/${accND}/${it.name}`);
    if (xml && /<(?:\w+:)?infoTable>/i.test(xml)) return parseAndAggregate(xml, wholeDollars);
  }
  return [];
}

// cusip → ticker (preserve resolution on re-insert)
const cmap = new Map();
for (const r of await sql`SELECT cusip, ticker FROM cusip_map WHERE ticker IS NOT NULL`) cmap.set(r.cusip, r.ticker);
console.log('cusip_map entries:', cmap.size);

const filers = await sql`
  SELECT cik FROM institutions WHERE stock_ticker IS NOT NULL
  UNION
  SELECT cik FROM (SELECT cik FROM fund_filings GROUP BY cik ORDER BY max(total_value) DESC NULLS LAST LIMIT ${filerLimit}) x`;
console.log('filers to re-ingest:', filers.length);

let done = 0, fixed = 0;
for (const { cik } of filers) {
  try {
    const quarters = await sql`SELECT quarter, filed_date, accession FROM fund_filings WHERE cik=${cik} ORDER BY quarter DESC LIMIT ${qPer}`;
    for (const q of quarters) {
      if (!q.accession) continue;
      const agg = await fetchHoldings(cik, q.accession, q.filed_date);
      if (!agg.length) continue;
      const iso = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
      const qd = iso(q.quarter), fd = iso(q.filed_date);
      await sql`DELETE FROM fund_holdings WHERE cik=${cik} AND quarter=${qd}::date`;
      const vals = agg.map((r) => ({ ...r, ticker: cmap.get(r.cusip) || null }));
      const COLS = 11;
      for (let i = 0; i < vals.length; i += 400) {
        const chunk = vals.slice(i, i + 400);
        const ph = chunk.map((_, j) => `(${Array.from({ length: COLS }, (_, c) => '$' + (j * COLS + c + 1)).join(',')})`).join(',');
        const params = chunk.flatMap((r) => [cik, qd, r.cusip, r.ticker, r.issuer, r.cls, r.shares, r.value, r.putCall, fd, q.accession]);
        await sql.query(`INSERT INTO fund_holdings (cik,quarter,cusip,ticker,issuer,class,shares,value,put_call,filed_date,accession) VALUES ${ph} ON CONFLICT DO NOTHING`, params);
      }
      const totalValue = agg.reduce((s, r) => s + (r.value || 0), 0);
      await sql`UPDATE fund_filings SET total_value=${totalValue}, holdings_count=${agg.length} WHERE cik=${cik} AND quarter=${qd}::date`;
      fixed++;
    }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${filers.length} filers · ${fixed} filings re-aggregated`);
  } catch (e) { console.log(`  cik ${cik}: ${e.message}`); }
}
console.log(`DONE: ${done} filers · ${fixed} filings re-aggregated`);
