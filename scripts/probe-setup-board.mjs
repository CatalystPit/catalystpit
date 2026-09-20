// Build the V3 setup board against production and print it as a trader would read it.
//
// Run: node --import ./scripts/next-resolve-loader.mjs scripts/probe-setup-board.mjs [TICKER]

import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { drizzle } = await import('drizzle-orm/neon-http');
const { neon } = await import('@neondatabase/serverless');
const { sql } = await import('drizzle-orm');
const db = drizzle(neon(process.env.DATABASE_URL));

const { buildSetupBoard, buildSetup, whyThisIsHere } = await import('../src/lib/consensus/setup-board.js');

const L = (s = '') => console.log(s);

const one = process.argv[2];
if (one && /^[A-Z.]{1,6}$/.test(one)) {
  const s = await buildSetup(one, {});
  s.why = whyThisIsHere({ setup: s.setup, canonical: s.canonical, sheet: s.families, market: s.market });
  L(JSON.stringify(s, null, 2));
  process.exit(0);
}

const t0 = Date.now();
const board = await buildSetupBoard(db, sql, {});
L(`evaluated ${board.evaluated}/${board.candidates} candidates in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
L(`ACTIVE: ${board.rows.length}   dropped as no-active-setup: ${board.dropped}   failed: ${board.failed}\n`);

const dist = {};
for (const r of board.rows) dist[r.setup.setup] = (dist[r.setup.setup] || 0) + 1;
L('SETUP DISTRIBUTION');
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) L(`  ${k.padEnd(28)} ${v}`);

const dirs = {};
for (const r of board.rows) dirs[r.setup.direction] = (dirs[r.setup.direction] || 0) + 1;
L(`\nDIRECTION: ${Object.entries(dirs).map(([k, v]) => `${k}=${v}`).join('  ')}`);

L('\n━━━━━━━━━━━ THE BOARD AS A TRADER READS IT ━━━━━━━━━━━');
for (const r of board.rows.slice(0, 14)) {
  const k = r.canonical;
  L(`\n${'═'.repeat(72)}`);
  L(`${r.ticker}   ${r.setup.label.toUpperCase()}`);
  L(`Direction: ${r.setup.direction} · ${k?.confidence ?? '—'} confidence · `
    + `${k?.coverage?.active ?? 0}/${k?.coverage?.total ?? 4} families · Market ${r.market.verdict}`
    + (r.setup.whyNowAgo ? ` · trigger ${r.setup.whyNowAgo}` : ''));
  if (r.setup.secondary?.length) L(`Also: ${r.setup.secondary.join(', ')}`);

  for (const [fam, items] of Object.entries(r.families)) {
    for (const f of items) {
      L(`\n  ${f.familyLabel}${f.direction && f.direction !== 'unknown' ? ` · ${f.direction.toUpperCase()}` : ''}`);
      if (f.headline) L(`    ${f.headline}`);
      for (const line of f.lines) L(`    ${line}`);
      if (f.dates) L(`    ${f.dates}`);
      if (f.context) L(`    ${f.context}`);
      if (f.publicAgo) L(`    public ${f.publicAgo}${f.url ? '  [verify]' : '  [no link]'}`);
    }
  }

  L(`\n  MARKET STRUCTURE · ${r.market.verdict}`);
  for (const line of r.market.lines) L(`    ${line}`);
  if (r.market.explain) L(`    ${r.market.explain}`);

  L(`\n  WHY THIS IS HERE`);
  L(`    ${r.why || '(none)'}`);
}

L(`\n\n━━━ FULL ACTIVE LIST (${board.rows.length})`);
for (const r of board.rows) {
  L(`  ${r.ticker.padEnd(6)} ${r.setup.setup.padEnd(26)} ${r.setup.direction.padEnd(8)}`
    + ` mkt=${(r.market.verdict || '').padEnd(12)} ${r.setup.whyNowAgo || ''}`);
}
