// Rebuild the consensus board from production data and report the V2.1 distribution plus a real
// example for each state. Read-only.

import fs from 'fs';
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { drizzle } = await import('drizzle-orm/neon-http');
const { neon } = await import('@neondatabase/serverless');
const db = drizzle(neon(process.env.DATABASE_URL));
const { sql } = await import('drizzle-orm');
const { buildConsensusBoard, BOARD_LIMIT } = await import('../src/lib/consensus/board.mjs');

const t0 = Date.now();
const board = await buildConsensusBoard(db, sql, { limit: BOARD_LIMIT });
const rows = board.rows || board.board || [];
console.log(`rows=${rows.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const byState = {};
const byMarket = {};
const byConf = {};
for (const r of rows) {
  const k = r.canonical || {};
  (byState[k.state] ||= []).push(r);
  byMarket[k.market?.confirmation] = (byMarket[k.market?.confirmation] || 0) + 1;
  byConf[k.confidence] = (byConf[k.confidence] || 0) + 1;
}
console.log('\nSTATE:', Object.entries(byState).map(([s, v]) => `${s}=${v.length}`).join('  '));
console.log('MARKET:', JSON.stringify(byMarket));
console.log('CONFIDENCE:', JSON.stringify(byConf));

console.log('\n--- ONE REAL EXAMPLE PER STATE ---');
for (const [s, list] of Object.entries(byState)) {
  const r = list[0]; const k = r.canonical;
  console.log(`\n[${s}] ${r.ticker}  ${k.confidence} conf · ${k.coverage.active}/${k.coverage.total} · market ${k.market.confirmation}`);
  console.log(`   drivers: ${k.drivers.map((f) => `${f.label}:${f.state}`).join(', ') || '—'}`);
  console.log(`   opposition: ${k.opposition.map((f) => `${f.label}:${f.state}`).join(', ') || '—'}`);
  console.log(`   minorContrary: ${k.minorContrary.map((f) => f.label).join(', ') || '—'}`);
  console.log(`   why: ${k.why}`);
  console.log(`   diag: pos=${k.diagnostics.positiveMass} neg=${k.diagnostics.negativeMass} share=${k.diagnostics.minorityShare} dirFams=${k.diagnostics.directionalFamilies}`);
}

const gold = rows.find((r) => r.ticker === 'GOLD');
console.log('\n--- GOLD ---');
console.log(gold ? JSON.stringify({ state: gold.canonical.state, confidence: gold.canonical.confidence,
  coverage: gold.canonical.coverage.active, market: gold.canonical.market.confirmation,
  drivers: gold.canonical.drivers.map((f) => f.family), opposition: gold.canonical.opposition.map((f) => f.family),
  minorContrary: gold.canonical.minorContrary.map((f) => f.family), diag: gold.canonical.diagnostics,
  why: gold.canonical.why }, null, 2) : 'not on the board');
