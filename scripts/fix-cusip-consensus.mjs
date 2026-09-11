// Find (and optionally fix) CUSIP→ticker mis-resolutions using issuer-prefix consensus + name validation.
// Cusips sharing a 6-char issuer prefix are the SAME company. Within a prefix, if one cusip's ticker
// disagrees with the dominant AND that ticker's company name does NOT match the issuer name (while the
// dominant's DOES), it's a mis-resolution (e.g. Nebius→MSI) → fix to the dominant. Name validation
// prevents breaking legit dual-class (GOOGL/GOOG both match "Alphabet").
// Report only: node --env-file=.env.local scripts/fix-cusip-consensus.mjs
// Apply:       node --env-file=.env.local scripts/fix-cusip-consensus.mjs apply
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv[2] === 'apply';

const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': 'CatalystPit contact@catalystpit.com' } });
const j = await r.json();
const tickerTitle = new Map();
for (const k in j) tickerTitle.set(j[k].ticker.toUpperCase(), j[k].title.toUpperCase());

const STOP = new Set(['GROUP', 'INC', 'CORP', 'CORPORATION', 'CO', 'HOLDINGS', 'HOLDING', 'CLASS', 'ORD', 'COM', 'COMMON', 'LTD', 'PLC', 'THE', 'SHS', 'CL', 'USD', 'ORDINARY', 'SHARES', 'AND', 'NEW', 'COMPANY', 'TRUST', 'FUND', 'ADR', 'ADS']);
const tokens = (s) => new Set(String(s || '').toUpperCase().replace(/N\.?V\.?/g, ' ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const nameMatch = (issuer, ticker) => {
  const title = tickerTitle.get(String(ticker || '').toUpperCase()); if (!title) return null;   // unknown ticker → can't validate
  const a = tokens(issuer), b = tokens(title);
  for (const w of a) if (b.has(w)) return true;
  return false;
};

// distinct (cusip, ticker, issuer) with a resolved sec-name ticker
const rows = await sql`SELECT DISTINCT ON (cusip) cusip, ticker, issuer FROM fund_holdings WHERE ticker IS NOT NULL AND cusip IS NOT NULL ORDER BY cusip`;
const byPrefix = new Map();
for (const x of rows) { const p = x.cusip.slice(0, 6); if (!byPrefix.has(p)) byPrefix.set(p, []); byPrefix.get(p).push(x); }

const fixes = [];
for (const [p, group] of byPrefix) {
  const tickers = new Set(group.map((g) => g.ticker));
  if (tickers.size < 2) continue;                               // single ticker → nothing to reconcile
  // dominant ticker = most cusips
  const count = new Map(); for (const g of group) count.set(g.ticker, (count.get(g.ticker) || 0) + 1);
  const dominant = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const g of group) {
    if (g.ticker === dominant) continue;
    const selfOk = nameMatch(g.issuer, g.ticker);               // does the CURRENT ticker match the issuer?
    const domOk = nameMatch(g.issuer, dominant);                // does the DOMINANT match the issuer?
    if (selfOk === false && domOk === true) fixes.push({ cusip: g.cusip, from: g.ticker, to: dominant, issuer: g.issuer });
  }
}

console.log(`Mis-resolution candidates (ticker name mismatches issuer, dominant matches): ${fixes.length}`);
fixes.slice(0, 40).forEach((f) => console.log(`  ${f.cusip} ${f.from} → ${f.to}   (${f.issuer.slice(0, 34)})`));

if (APPLY && fixes.length) {
  let done = 0;
  for (const f of fixes) {
    await sql`UPDATE cusip_map SET ticker=${f.to}, source='consensus', confidence='high', updated_at=now() WHERE cusip=${f.cusip}`;
    await sql`UPDATE fund_holdings SET ticker=${f.to} WHERE cusip=${f.cusip}`;
    done++;
  }
  console.log(`APPLIED ${done} fixes.`);
} else {
  console.log('(report only — re-run with "apply" to fix)');
}
