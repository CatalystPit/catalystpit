// OUTPUT EQUIVALENCE — old per-ticker path vs new batched path, same tickers, PINNED CLOCK.
//
// ⚠️ THIS IS THE ACCEPTANCE TEST FOR THE BATCHED BUILD, and it needs the real database because
// equivalence is a claim about real rows. It is not part of the pure suite for that reason.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs \n//        scripts/verify-consensus-batch-equivalence.mjs [sampleSize] [pinnedISO]
//
// The batched path is only acceptable if it produces the identical Consensus object. This runs
// buildSetup twice for the same tickers at the same `now`: once with ctx = null (every resolver
// issues its own queries, i.e. the old behaviour) and once with a loaded BuildContext.
import { register } from 'node:module';
register('./real-db-loader.mjs', import.meta.url);
const { db } = await import('../src/lib/db.js');
const { sql } = await import('drizzle-orm');
const { buildSetup, selectSetupCandidates, EVALUATE_LIMIT } = await import('../src/lib/consensus/setup-board.js');
const { loadBuildContext } = await import('../src/lib/consensus/build-context.mjs');

const N = Number(process.argv[2] || 300);
const NOW = Date.parse(process.argv[3] || '2026-09-25T06:00:00Z');

const cands = await selectSetupCandidates(db, sql, { limit: EVALUATE_LIMIT });
// A spread across the score distribution, not just the heaviest names.
const step = Math.max(1, Math.floor(cands.length / N));
const sample = [];
for (let i = 0; i < cands.length && sample.length < N; i += step) sample.push(cands[i]);
console.log(`equivalence sample: ${sample.length} of ${cands.length} candidates · now pinned ${new Date(NOW).toISOString()}\n`);

// ⚠️ INTERNALS ARE COMPARED TOO, not just the rendered row: _significant and _consensusFamilies
// feed qualification and the "why", so a difference there is a real difference even when the
// visible card happens to agree.
const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
  if (typeof x === 'number' && !Number.isInteger(x)) return Math.round(x * 1e9) / 1e9;
  return x;
}));

const run = async (ctx, tickers) => {
  const out = new Map();
  for (const t of tickers) {
    try { out.set(t, norm(await buildSetup(t, { now: NOW, ctx }))); }
    catch (e) { out.set(t, { __error: e.message }); }
  }
  return out;
};

const t0 = Date.now();
const oldOut = await run(null, sample);
const oldMs = Date.now() - t0;

const t1 = Date.now();
const ctx = await loadBuildContext(db, sql, sample, { now: NOW });
const loadMs = Date.now() - t1;
const t2 = Date.now();
const newOut = await run(ctx, sample);
const calcMs = Date.now() - t2;

console.log(`old path : ${oldMs}ms (${(oldMs / sample.length).toFixed(0)}ms/tk)`);
console.log(`new path : ${loadMs}ms bulk load + ${calcMs}ms calculation = ${loadMs + calcMs}ms (${((loadMs + calcMs) / sample.length).toFixed(0)}ms/tk)\n`);

// deep diff
const diffs = [];
const walk = (a, b, path, t) => {
  if (diffs.length > 60) return;
  if (a === b) return;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { diffs.push(`${t} ${path}: type ${ta} vs ${tb}`); return; }
  if (ta === 'array') {
    if (a.length !== b.length) { diffs.push(`${t} ${path}: length ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`, t);
    return;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) walk(a[k], b[k], `${path}.${k}`, t);
    return;
  }
  diffs.push(`${t} ${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
};
let same = 0;
for (const t of sample) walk(oldOut.get(t), newOut.get(t), '', t) ?? 0;
for (const t of sample) if (JSON.stringify(oldOut.get(t)) === JSON.stringify(newOut.get(t))) same++;

console.log(`identical setups: ${same}/${sample.length}`);
if (diffs.length) {
  console.log(`\nDIFFERENCES (first ${Math.min(diffs.length, 60)}):`);
  for (const d of diffs.slice(0, 60)) console.log('  ' + d);
} else {
  console.log('NO DIFFERENCES — every field of every setup matches.');
}
process.exit(diffs.length ? 1 : 0);
