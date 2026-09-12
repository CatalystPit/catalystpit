import { parseForm4, isOpenMarketBuy } from '../src/lib/form4.mjs';

const UA = { 'User-Agent': 'CatalystPit Research bcoghill88@gmail.com' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pull a real day of Form 4 filings straight from EDGAR's daily index.
const day = process.argv[2] || '2026-09-10';
const [y, m, d] = day.split('-');
const q = 'QTR' + (Math.floor((Number(m) - 1) / 3) + 1);
const idxUrl = `https://www.sec.gov/Archives/edgar/daily-index/${y}/${q}/form.${y}${m}${d}.idx`;

const res = await fetch(idxUrl, { headers: UA });
if (!res.ok) { console.log('index fetch failed', res.status, idxUrl); process.exit(0); }
const idx = await res.text();

const lines = idx.split('\n').filter(l => /^\s*4(\/A)?\s/.test(l));
console.log(`daily index ${day}: ${lines.length} Form 4/4-A rows`);
const amend = lines.filter(l => /^\s*4\/A\s/.test(l));
console.log(`  of which amendments (4/A): ${amend.length}`);

const pick = [...lines.slice(0, 4), ...amend.slice(0, 2)];
let ok = 0, rows = 0, quar = 0, omBuys = 0, withCik = 0, withOwnership = 0, with10b5 = 0, deriv = 0;

for (const line of pick) {
  const fileName = line.trim().split(/\s{2,}/).pop().trim();
  const accession = fileName.match(/(\d{10}-\d{6}-\d{6})/)?.[1] || fileName.split('/').pop().replace('.txt','');
  const base = `https://www.sec.gov/Archives/${fileName}`;
  await sleep(120);                                  // SEC fair-access pacing
  const doc = await fetch(base, { headers: UA });
  if (!doc.ok) { console.log('  doc fail', doc.status); continue; }
  const txt = await doc.text();
  const xml = txt.match(/<\?xml[\s\S]*?<\/ownershipDocument>/)?.[0] || txt;
  const out = parseForm4(xml, { accession, filingDate: day, indexUrl: base, docUrl: base });
  ok++;
  rows += out.rows.length; quar += out.quarantine.length;
  omBuys += out.rows.filter(isOpenMarketBuy).length;
  withCik += out.rows.filter(r => r.issuerCik && r.ownerCik).length;
  withOwnership += out.rows.filter(r => r.ownershipType).length;
  with10b5 += out.rows.filter(r => r.rule10b5_1 !== null).length;
  deriv += out.rows.filter(r => r.isDerivative).length;
  const r0 = out.rows[0];
  console.log(`  ${out.meta.documentType.padEnd(3)} ${(out.meta.ticker||'?').padEnd(6)} rows=${out.rows.length} quar=${out.quarantine.length}` +
    (r0 ? ` | ${r0.transactionCode} ${r0.action} ${r0.shares}@${r0.pricePerShare} own=${r0.ownershipType} issuerCik=${r0.issuerCik} ownerCik=${r0.ownerCik} deriv=${r0.isDerivative}` : ''));
  if (out.quarantine.length) console.log('     QUARANTINE:', out.quarantine.map(x => x.reason + ' (' + x.detail + ')').join('; '));
}
console.log(`\nparsed ${ok} filings -> ${rows} rows, ${quar} quarantined`);
console.log(`  open-market buys ${omBuys} | derivative rows ${deriv}`);
console.log(`  both CIKs present ${withCik}/${rows} | ownership D/I present ${withOwnership}/${rows} | 10b5-1 determined ${with10b5}/${rows}`);
