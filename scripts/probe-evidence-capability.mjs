// WHAT FACTS DO WE ACTUALLY HAVE? — a production capability census, not a test.
//
// Consensus V3 turns family labels into factual sentences ("448 managers vs 433 prior quarter"),
// which is only possible for facts the engine genuinely populates. Designing archetypes against a
// schema rather than against real data is how you end up with a card that renders "undefined".
//
// So this walks real tickers through the canonical engine and reports, per family: which `facts`
// keys are present, how often, what they look like, and how often historical context is available.
//
// Run: node --import ./scripts/next-resolve-loader.mjs scripts/probe-evidence-capability.mjs [TICKERS...]

import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { drizzle } = await import('drizzle-orm/neon-http');
const { neon } = await import('@neondatabase/serverless');
const { sql } = await import('drizzle-orm');
const db = drizzle(neon(process.env.DATABASE_URL));

const { tickerEvidence } = await import('../src/lib/evidence/resolve.js');

const L = (s = '') => console.log(s);

// Sanity-check tickers plus whatever the live board is currently carrying, so the census reflects
// the companies the product actually shows rather than a hand-picked set.
let tickers = process.argv.slice(2).filter((a) => /^[A-Z.]{1,6}$/.test(a));
if (!tickers.length) {
  const { readPublishedBoard } = await import('../src/lib/consensus/refresh.js');
  const board = await readPublishedBoard();
  const fromBoard = (board.payload?.rows || []).map((r) => r.ticker);
  tickers = [...new Set(['AMRZ', 'ALK', 'GOLD', ...fromBoard])].slice(0, 45);
}
L(`census over ${tickers.length} tickers\n`);

const famStats = new Map();   // family -> { n, types:Map, factKeys:Map, ctx:n, url:n, dirs:Map }
const typeExamples = new Map();
let failedFamilies = 0, quarantined = 0, errored = 0;

const stat = (family) => {
  if (!famStats.has(family)) {
    famStats.set(family, { n: 0, types: new Map(), factKeys: new Map(), ctx: 0, url: 0, dirs: new Map() });
  }
  return famStats.get(family);
};

const t0 = Date.now();
for (const t of tickers) {
  let r;
  try { r = await tickerEvidence(t, {}); } catch (e) { errored++; L(`  ${t}: ERROR ${e.message}`); continue; }
  failedFamilies += (r.failedFamilies || []).length;
  quarantined += (r.quarantined || []).length;

  for (const ev of r.evidence || []) {
    const s = stat(ev.family);
    s.n++;
    s.types.set(ev.type, (s.types.get(ev.type) || 0) + 1);
    s.dirs.set(ev.direction, (s.dirs.get(ev.direction) || 0) + 1);
    if (ev.context?.text) s.ctx++;
    if (ev.url) s.url++;
    for (const [k, v] of Object.entries(ev.facts || {})) {
      if (v === null || v === undefined) continue;
      if (!s.factKeys.has(k)) s.factKeys.set(k, { n: 0, sample: v });
      s.factKeys.get(k).n++;
    }
    if (!typeExamples.has(ev.type)) typeExamples.set(ev.type, { ticker: t, ev });
  }
}
const ms = Date.now() - t0;

L(`\nresolved in ${(ms / 1000).toFixed(1)}s (${(ms / tickers.length).toFixed(0)}ms/ticker)`);
L(`failedFamilies=${failedFamilies}  quarantined=${quarantined}  errored=${errored}\n`);

for (const [family, s] of [...famStats.entries()].sort()) {
  L(`━━━ ${family.toUpperCase()} — ${s.n} records`);
  L(`  types:      ${[...s.types.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  L(`  directions: ${[...s.dirs.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  L(`  context:    ${s.ctx}/${s.n} (${Math.round(100 * s.ctx / s.n)}%)   url: ${s.url}/${s.n} (${Math.round(100 * s.url / s.n)}%)`);
  L('  facts available:');
  for (const [k, v] of [...s.factKeys.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const pct = Math.round(100 * v.n / s.n);
    const sample = typeof v.sample === 'object' ? JSON.stringify(v.sample).slice(0, 70) : String(v.sample).slice(0, 70);
    L(`    ${k.padEnd(24)} ${String(v.n).padStart(4)}/${s.n} (${String(pct).padStart(3)}%)  e.g. ${sample}`);
  }
  L('');
}

L('━━━ ONE REAL RECORD PER TYPE');
for (const [type, { ticker, ev }] of [...typeExamples.entries()].sort()) {
  L(`\n[${type}] ${ticker}`);
  L(`  summary:    ${ev.summary}`);
  L(`  direction:  ${ev.direction}   materiality=${ev.materiality}  quality=${ev.quality}`);
  L(`  publicTime: ${ev.publicTime}   eventTime: ${ev.eventTime ?? '—'}   refPeriod: ${ev.referencePeriod ?? '—'}`);
  L(`  context:    ${ev.context?.text ?? '—'}${ev.context?.note ? ` | note: ${ev.context.note}` : ''}`);
  L(`  url:        ${ev.url ?? '(none)'}`);
  L(`  facts:      ${JSON.stringify(ev.facts)}`);
}
