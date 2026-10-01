// ZERO POLYGON, FULL STOP — SUPERSEDED BY THE GENERAL LICENSING GUARD.
//
//   node scripts/verify-no-active-polygon.mjs
//
// ⚠️ THIS SUITE'S ORIGINAL JOB IS DONE, AND ITS SHAPE IS WHY IT HAD TO CHANGE. It maintained a DECLARED
// INVENTORY of the files that still contained a Polygon URL, each annotated `customerFacing: false`, and
// failed if a file appeared undeclared or a declaration went stale. That was the right design while
// Polygon was being wound down from a dozen places: it tolerated dormant adapters and migration history
// while forbidding a live customer path.
//
// It also encoded an assumption that turned out to be false. "Dormant, preserved for a future licensed
// use" was recorded for lib/polygon-intraday.mjs, congress-chart's fetchPolygonDaily, market-data's
// polygonQuotes, the Polygon dividend adapter and the option pricer — and a provenance audit then found
// Polygon supplying 85% of the stored daily candle history, the Screener's prices, its fundamentals, its
// company metadata and every technical indicator, through paths this inventory did not cover because they
// were never URLs this file looked for. An inventory of exceptions is a list of things somebody decided
// were fine.
//
// So the exceptions are gone, along with the files that held them, and the assertion is now the simple
// one: NO file under src/ contains a Polygon URL in executable code. Not "none that are customer-facing",
// not "none undeclared" — none.
//
// ⚠️ AND THE GENERAL VERSION LIVES IN scripts/verify-commercial-licensing.mjs, which does this for every
// unapproved provider at once, sweeps for vendor key reads and provider-selection strings, and exercises
// the runtime refusal. This file is kept as the Polygon-specific canary because Polygon was the largest
// exposure and a regression here deserves its own name in a test report.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const MUT = (process.argv.find((a) => a.startsWith('--mutate=')) || '').split('=')[1] || '';

// ⚠️ LINE COMMENTS FIRST. market/tiingo.mjs contains `// /realtime/*, /consolidated/* all 404`, and
// stripping block comments first treats that as an opener and deletes 30KB of real code.
const strip = (s) => s
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const files = [];
const walk = async (dir) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(e.name)) files.push(p);
  }
};
await walk('src');

console.log(`\n=== NO POLYGON URL IN EXECUTABLE CODE UNDER src/ (${files.length} files) ===`);
{
  // The hostname, not the word: `<polygon points=...>` is an SVG element and has nothing to do with a
  // data vendor. The first version of the general guard flagged five files for exactly that.
  const URL_RE = /https?:\/\/[a-z0-9.-]*polygon\.io/i;
  const hits = [];
  for (const f of files) {
    let code = strip(await readFile(f, 'utf8'));
    if (MUT === 'reintroduce' && f.endsWith('market-data.js')) code += '\nfetch("https://api.polygon.io/v2/x");\n';
    if (URL_RE.test(code)) hits.push(f.replace(/\\/g, '/'));
  }
  ok('⚠️ zero files reach a Polygon URL', hits.length === 0, hits.join(', '));

  // The key is the other half: a key read is an intent to call, and one survived in four files after the
  // URLs were removed — /api/dividends, /api/ticker, refresh-congress and screener-data.
  const keyHits = [];
  for (const f of files) {
    const code = strip(await readFile(f, 'utf8'));
    if (/process\.env\.POLYGON[A-Z_]*/.test(code)) keyHits.push(f.replace(/\\/g, '/'));
  }
  ok('⚠️ …and none reads a Polygon API key', keyHits.length === 0, keyHits.join(', '));

  // The files the old inventory declared as dormant are gone rather than dormant.
  for (const gone of ['src/lib/polygon-intraday.mjs', 'src/lib/congress-options.mjs',
    'src/lib/dividends/providers/polygon-dividends.mjs']) {
    ok(`${gone} no longer exists`, !files.some((f) => f.replace(/\\/g, '/') === gone));
  }

  // And the candle write contract refuses the source by name, so storage cannot refill either.
  const { CANDLE_SOURCE, UNLICENSED_SOURCES } = await import('../src/lib/market/candles.mjs');
  ok('⚠️ polygon is not a writable candle source', !Object.values(CANDLE_SOURCE).includes('polygon'));
  ok('⚠️ …and is explicitly named unlicensed', UNLICENSED_SOURCES.includes('polygon'));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('(the all-vendor version of this check is scripts/verify-commercial-licensing.mjs)');
process.exit(fail ? 1 : 0);
