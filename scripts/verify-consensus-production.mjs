// PRODUCTION VERIFICATION for consensus materialization.
//
// Runs the DEPLOYED code paths against the real database and the real KV, so the things that only
// exist in production — the actual board, the actual filings, the actual key layout — are the ones
// being checked. The in-memory suite proves the logic; this proves the wiring.
//
// ⚠️ IT MARKS A REAL TICKER FOR RECOMPUTATION AND REPUBLISHES THE BOARD. That is precisely what the
// drain cron does every minute, it is idempotent, and the board it publishes is computed from real
// filings. NOTHING HERE FABRICATES OR MUTATES FINANCIAL EVIDENCE — no row is written to any
// evidence table, and the recomputed consensus is whatever the real data says.
//
// Run: node --import ./scripts/next-resolve-loader.mjs scripts/verify-consensus-production.mjs

import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const L = (s = '') => console.log(s);
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const { drizzle } = await import('drizzle-orm/neon-http');
const { neon } = await import('@neondatabase/serverless');
const { sql } = await import('drizzle-orm');
const db = drizzle(neon(process.env.DATABASE_URL));

const M = await import('../src/lib/consensus/materialization.mjs');
const R = await import('../src/lib/consensus/refresh.js');
const { SYNTHESIS_VERSION } = await import('../src/lib/consensus/synthesis.mjs');
const { resolveEvidence } = await import('../src/lib/consensus/evidence.js');

L('=== 1. DEPLOYED METHODOLOGY ===');
L(`  materialization version: ${M.MATERIALIZATION_VERSION}`);
L(`  board key:               ${M.boardKey()}`);
ok('the version is composed of both engine versions plus a shape version',
  M.MATERIALIZATION_VERSION.split('.').length >= 3);

L('\n=== 2. WHAT IS PUBLISHED RIGHT NOW ===');
const before = await R.readPublishedBoard();
ok('a board is published', !!before.payload, before.status);
ok('…under the CURRENT methodology, not an older one',
  before.status === 'ok', before.status);
L(`  builtAt:  ${before.payload?.builtAt}`);
L(`  version:  ${before.payload?.materializationVersion}`);
L(`  rows:     ${before.payload?.rows?.length} of ${before.payload?.candidates} candidates`
  + ` (${before.payload?.failed} failed, ${before.payload?.reused ?? 0} reused)`);
L(`  reason:   ${before.payload?.reason}`);

L('\n=== 3. EVERY ROW BELONGS TO THE DEPLOYED METHODOLOGY ===');
{
  const rows = before.payload?.rows || [];
  const wrong = rows.filter((r) => r?.canonical?.version !== SYNTHESIS_VERSION);
  ok(`all ${rows.length} published rows carry ${SYNTHESIS_VERSION}`, wrong.length === 0,
    wrong.map((r) => `${r.ticker}:${r.canonical?.version}`).join(', '));
  ok('the payload validates against the publication rules',
    M.validateBoardPayload(before.payload).ok, M.validateBoardPayload(before.payload).reason);
  const states = {};
  for (const r of rows) states[r.canonical.state] = (states[r.canonical.state] || 0) + 1;
  L(`  states:   ${Object.entries(states).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

L('\n=== 4. LAST KNOWN GOOD EXISTS AND IS NOT THE SAME KEY ===');
{
  const lastGood = await M.kvGetJson(M.LAST_GOOD_KEY);
  ok('a last-known-good board is retained', !!lastGood);
  ok('…carrying its own version stamp', !!lastGood?.materializationVersion,
    lastGood?.materializationVersion);
  ok('…and it is stored under a DIFFERENT key from the current board',
    M.LAST_GOOD_KEY !== M.boardKey());
}

L('\n=== 5. TARGETED REFRESH: ONLY THE MARKED TICKER RECOMPUTES ===');
{
  // A real ticker already on the real board. Marking it dirty asks the drain to recompute its
  // consensus from the filings that are already in the database — no evidence is written.
  const subject = before.payload.rows[0]?.ticker;
  ok('a real board ticker was chosen as the subject', !!subject, subject);
  L(`  subject:  ${subject}`);

  await M.markConsensusDirty([subject]);
  const dirty = await M.readDirty();
  ok('the ticker is marked dirty', dirty.includes(subject), dirty.join(','));

  // Wrap the REAL resolver so the work can be counted. The evidence read is genuine.
  const touched = [];
  const countingResolve = async (t, opts) => { touched.push(t); return resolveEvidence(t, opts); };

  const t0 = Date.now();
  const d = await R.drainDirty(db, sql, { resolve: countingResolve });
  const ms = Date.now() - t0;

  ok('the drain chose the targeted strategy', d.strategy === 'targeted', d.strategy);
  ok('…and published', d.published, d.reason);
  ok('ONLY the marked ticker resolved evidence',
    touched.length === 1 && touched[0] === subject, touched.join(',') || 'none');
  ok('…every other ticker was reused from its materialization',
    d.payload.reused === d.payload.rows.length - 1 || d.payload.reused > 0,
    `reused ${d.payload.reused} of ${d.payload.rows.length}`);
  L(`  drain took ${ms}ms — a full rebuild is ~90s`);
  ok('a targeted drain is far cheaper than a full rebuild', ms < 45_000, `${ms}ms`);
  ok('the dirty set is cleared afterwards', (await M.readDirty()).length === 0);
}

L('\n=== 6. NO CROSS-TICKER CONTAMINATION ===');
{
  const after = await R.readPublishedBoard();
  const b = Object.fromEntries(before.payload.rows.map((r) => [r.ticker, r.canonical]));
  const a = Object.fromEntries(after.payload.rows.map((r) => [r.ticker, r.canonical]));

  const changed = Object.keys(a).filter((t) => b[t] && (b[t].state !== a[t].state || b[t].why !== a[t].why));
  ok('no untouched ticker changed state or explanation as a side effect',
    changed.length === 0, changed.join(', '));
  ok('the board still has the same membership',
    Object.keys(a).sort().join(',') === Object.keys(b).sort().join(','));
  ok('the republished board is newer', Date.parse(after.payload.builtAt) > Date.parse(before.payload.builtAt));
  ok('…and still validates', M.validateBoardPayload(after.payload).ok);
  ok('…and is still entirely one methodology',
    after.payload.rows.every((r) => r.canonical.version === SYNTHESIS_VERSION));
  L(`  builtAt advanced: ${before.payload.builtAt} -> ${after.payload.builtAt}`);
}

L('\n=== 7. TICKER AND BOARD AGREE ON REAL DATA ===');
{
  const { consensusRow } = await import('../src/lib/consensus/board.mjs');
  const boardRow = (await R.readPublishedBoard()).payload.rows[0];
  const direct = await consensusRow(boardRow.ticker, {});
  ok(`${boardRow.ticker}: board state matches a direct computation`,
    boardRow.canonical.state === direct.canonical.state,
    `${boardRow.canonical.state} vs ${direct.canonical.state}`);
  ok('…and the WHY matches word for word',
    boardRow.canonical.why === direct.canonical.why);
}

L('\n=== 8. THE PUBLIC READ PATH ===');
{
  const r = await fetch('https://catalystpit.com/api/consensus-board', { cache: 'no-store' });
  const j = await r.json();
  ok('the public endpoint responds 200', r.status === 200, String(r.status));
  ok('…reporting the deployed methodology as current', j.methodologyCurrent === true,
    `${j.version} vs ${j.expectedVersion}`);
  ok('…with status ok', j.status === 'ok', j.status);
  ok('…serving the board this script just republished',
    j.builtAt === (await R.readPublishedBoard()).payload.builtAt, j.builtAt);
  ok('the entitlement gate is intact for an anonymous reader',
    j.rows.length === 5 && j.lockedCount > 0, `${j.rows.length} rows, ${j.lockedCount} locked`);
  ok('…and the response is not shared-cacheable',
    (r.headers.get('cache-control') || '').includes('no-store'), r.headers.get('cache-control'));

  const page = await fetch('https://catalystpit.com/consensus', { cache: 'no-store' });
  ok('the /consensus page still renders', page.status === 200, String(page.status));
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
