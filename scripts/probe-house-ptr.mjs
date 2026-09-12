// Probe: dump a known e-filed House PTR via pdf-parse v2 (text + table) so we can
// write a parser against the real layout. Run: node scripts/probe-house-ptr.mjs [year] [docId]
import { PDFParse } from 'pdf-parse';

const year = process.argv[2] || '2024';
const docId = process.argv[3] || '20025031';
const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;

const r = await fetch(url, { headers: { 'User-Agent': 'CatalystPit research contact@catalystpit.com' } });
console.log('HTTP', r.status, r.headers.get('content-type'));
const buf = Buffer.from(await r.arrayBuffer());
console.log('bytes', buf.length);

const parser = new PDFParse({ data: buf });
const text = await parser.getText();
console.log('==== TEXT (readable) ====');
console.log((text.text || '').slice(0, 3500));

try {
  const tbl = await parser.getPageTables ? await parser.getTable() : null;
  console.log('\n==== TABLE (json) ====');
  console.log(JSON.stringify(tbl, null, 1).slice(0, 3000));
} catch (e) {
  console.log('table extraction error:', e.message);
}
await parser.destroy?.();
