// The row stores the adapter's own item under `raw`, which is exactly what the ingest gate saw.
// Run: node --env-file=.env.local scripts/probe-raw-item.mjs <seq>
import { neon } from '@neondatabase/serverless';
import { materiallyNonEnglish } from '../src/lib/language.mjs';
const sql = neon(process.env.DATABASE_URL);
const seq = process.argv[2];
const [r] = await sql.query('select seq, source, headline, source_headline, summary, display_ready, raw from primary_events where seq = $1', [seq]);
if (!r) { console.log('no such row'); process.exit(1); }
const raw = typeof r.raw === 'string' ? JSON.parse(r.raw) : r.raw;
console.log('feed    :', raw?.feed, '| adapter:', raw?.adapter);
console.log('display_ready:', r.display_ready);
console.log('\nraw item.title   :', JSON.stringify(raw?.title));
console.log('raw item.summary :', JSON.stringify(String(raw?.summary || '').slice(0, 160)));
console.log('stored headline  :', JSON.stringify(r.headline));
console.log('\ngate would have said (raw title + raw summary):');
console.log('  ', JSON.stringify(materiallyNonEnglish(raw?.title, raw?.summary)));
console.log('detector on the stored headline:');
console.log('  ', JSON.stringify(materiallyNonEnglish(r.headline, r.summary)).slice(0, 200));
