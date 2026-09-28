// REMOVE TICKERS THAT WERE ONLY EVER A WORD MATCH.
//
//   node scripts/cleanup-word-tickers.mjs              # dry run, reports and changes nothing
//   node scripts/cleanup-word-tickers.mjs --apply      # writes
//   node scripts/cleanup-word-tickers.mjs --limit 5000 # bound the scan
//
// The resolver no longer turns an ordinary English word into a ticker (see common-words.mjs), but
// the events it already tagged keep their symbols: a Michael Saylor story stays tagged $HERE until
// something clears it. This is that something.
//
// ⚠️ CONSERVATIVE BY CONSTRUCTION. A symbol is removed only when ALL of these hold:
//   1. the CURRENT resolver does not produce it from the source headline, and
//   2. the OLD word-matching behaviour did — so this only ever undoes this specific mistake, and
//      never touches a symbol that arrived from EDGAR, a cashtag, or an exchange-qualified line, and
//   3. the headline does not print it as a cashtag or "(NASDAQ: X)" itself.
// An event left with no symbols at all is correct and expected: no ticker beats a wrong one.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { buildIndex, resolveCompanies } from '../src/lib/company-symbols.mjs';
import { COMMON_WORDS } from '../src/lib/common-words.mjs';
import { statedTickersIn } from '../src/lib/news-normalize.mjs';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((/--limit\s+(\d+)/.exec(process.argv.join(' ')) || [])[1] || 100000);

const ROOT = process.cwd();
const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const sql = neon(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/.exec(env)[1].trim());

const screener = await sql`SELECT ticker, company, industry FROM screener_stocks
  WHERE company is not null and company <> ''`;
const insider = await sql`SELECT distinct on (ticker) ticker, company FROM insider_trades
  WHERE company is not null and company <> '' ORDER BY ticker, filing_date desc`;
const rows = [...insider, ...screener];

const idxNow = buildIndex(rows);
// The behaviour that produced the bad tags, reconstructed by emptying the measured word set. This is
// what makes the cleanup surgical: without it we could not tell a word match from a real one.
const saved = new Set(COMMON_WORDS);
COMMON_WORDS.clear();
const idxThen = buildIndex(rows);
for (const w of saved) COMMON_WORDS.add(w);

const events = await sql`SELECT seq, headline, source_headline, tickers FROM primary_events
  WHERE coalesce(array_length(tickers, 1), 0) > 0 ORDER BY seq DESC LIMIT ${LIMIT}`;
console.log(`events with tickers scanned: ${events.length}`);

const plan = [];
for (const e of events) {
  const h = e.source_headline || e.headline || '';
  const now = resolveCompanies(h, idxNow);
  const then = resolveCompanies(h, idxThen);
  const printed = new Set(statedTickersIn(h));
  const keep = (e.tickers || []).filter(
    (t) => now.includes(t) || !then.includes(t) || printed.has(t),
  );
  if (keep.length !== (e.tickers || []).length) plan.push({ seq: e.seq, from: e.tickers, to: keep, h });
}

const removed = plan.reduce((n, p) => n + (p.from.length - p.to.length), 0);
const emptied = plan.filter((p) => !p.to.length).length;
const bySym = new Map();
for (const p of plan) for (const t of p.from) if (!p.to.includes(t)) bySym.set(t, (bySym.get(t) || 0) + 1);

console.log(`events to change: ${plan.length}`);
console.log(`symbols removed:  ${removed}`);
console.log(`events left with no ticker: ${emptied}`);
console.log([...bySym].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join('  '));
console.log('\nsample:');
for (const p of plan.slice(0, 12)) {
  console.log(`  ${p.seq}  ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}  ${String(p.h).replace(/\s+/g, ' ').slice(0, 84)}`);
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

let done = 0;
for (const p of plan) {
  await sql`UPDATE primary_events SET tickers = ${p.to}::text[] WHERE seq = ${p.seq}`;
  done++;
  if (done % 100 === 0) console.log(`  ${done}/${plan.length}`);
}
console.log(`\nupdated ${done} events`);
