// Live source-exposure scan: nothing institutional-internal may reach a public response.
const BASE = process.argv[2] || 'https://catalystpit.com';
// A CUSIP is 9 alphanumerics with at least one LETTER in the issuer/issue part, quoted as a string.
// A bare 9-digit run is a share count, not a CUSIP, which is why deltaShares 621529106 is not a hit.
const CUSIPISH = /"[0-9]{3}[0-9A-Z]{0,2}[A-Z][0-9A-Z]{2}[0-9]"|"[A-Z][0-9A-Z]{7}[0-9]"/;
const FORBIDDEN = [
  [/"cusip"|\bcusip[_ ]?map\b/i, 'cusip field'], [/"cik"\s*:/i, 'cik field'],
  [/"accession"|accession_?number/i, 'accession'], [/openfigi/i, 'OpenFIGI'],
  [/fund_holdings/i, 'fund_holdings'], [/sec-name/i, 'sec-name'],
  [/security_position_class/i, 'classifier table'], [/catalystpit:cusip/i, 'KV key'],
  [CUSIPISH, 'CUSIP value'], [/screener_stocks/i, 'screener_stocks'],
  [/ticker_institutional_ownership/i, 'rollup table'], [/"source"\s*:\s*"(openfigi|kv|sec-name|repair)"/i, 'mapping provenance'],
];
const PATHS = ['/ticker/AAPL', '/ticker/BLK', '/ticker/IVZ', '/ticker/AGQ', '/ticker/INHD',
  '/api/institutions?ticker=AAPL', '/api/institutions-heatmap', '/api/heatmap', '/api/screener?limit=5'];
let bad = 0, checked = 0;
for (const p of PATHS) {
  let r;
  try { r = await fetch(BASE + p, { headers: { 'User-Agent': 'CatalystPit-leakscan' } }); } catch (e) { console.log('  SKIP ' + p + ' ' + e.message); continue; }
  const body = await r.text();
  checked++;
  const hits = FORBIDDEN.filter(([re]) => re.test(body)).map(([, n]) => n);
  console.log('  ' + String(r.status).padEnd(4) + p.padEnd(34) + (body.length / 1024).toFixed(0).padStart(5) + ' KB   '
    + (hits.length ? 'LEAK: ' + hits.join(', ') : 'clean'));
  if (hits.length) bad++;
}
console.log(`\n${checked} responses scanned, ${bad} with a leak`);
