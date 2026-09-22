// ZERO ACTIVE PRODUCTION DEPENDENCE ON POLYGON.
//
//   node scripts/verify-no-active-polygon.mjs [--mutate=<mode>]
//
// ⚠️ SUCCESS IS NOT "grep finds no 'polygon'". SVG <polygon> is unrelated, and preserved adapters,
// comments and migration history may legitimately remain. What must be zero is a Polygon URL a
// CUSTOMER REQUEST can reach.
//
// ⚠️ AND THIS DOES NOT PRETEND TO DO CALL-GRAPH ANALYSIS. A first version tried to infer which
// function owned each Polygon URL and flagged `sleep()`, `ymd()` and `fval()` as live Polygon
// dependencies — a heuristic confident enough to be believed and wrong enough to be useless.
// Instead every file that still contains a Polygon URL in NON-COMMENT code is listed against a
// declared inventory. A file that appears without a declaration fails; a declaration whose file
// no longer has a Polygon URL also fails, so the inventory cannot rot.

import { readdir, readFile } from 'node:fs/promises';

const L = (s = '') => console.log(s);
const MUT = (process.argv.find((a) => a.startsWith('--mutate')) || '').split('=')[1]
  || (process.argv.includes('--mutate') ? 'all' : '');
const mut = (m) => MUT === m || MUT === 'all';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; L(`  ok   ${n}`); } else { fail++; L(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

// Strips block comments, whole-line // comments, and trailing // comments (avoiding URLs' `://`).
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/([^:'"`])\/\/.*$/gm, '$1');

// ── THE DECLARED INVENTORY ───────────────────────────────────────────────────
// customerFacing:true here would be a failure. Everything listed is either dormant (preserved,
// no caller) or backend-only ingest that Tiingo measurably cannot replace.
const INVENTORY = {
  'lib/screener-data.js': {
    customerFacing: false,
    why: 'BACKEND INGEST. Supplies asset_type, exchange, sector, industry, sic_code, country and '
       + 'grouped EOD into screener_meta/screener_stocks. Tiingo CANNOT replace it, measured: '
       + '/tiingo/fundamentals/meta returns 20,319 rows but sector, industry, sicCode, sicSector, '
       + 'sicIndustry, location and companyWebsite are "Field not available" on 20,289 of them — '
       + 'usable for exactly 30 (the Dow). Migrating would delete the sector taxonomy the heatmap '
       + 'is built on. Tiingo DOES supply ticker, name, isActive and isADR for all 20,319.',
  },
  'lib/polygon-intraday.mjs': { customerFacing: false, why: 'Dormant adapter; chart-intraday now uses Tiingo.' },
  'lib/dividends/providers/polygon-dividends.mjs': { customerFacing: false, why: 'Dormant provider; dividends use Tiingo corporate actions.' },
  'lib/congress-chart.mjs': { customerFacing: false, why: 'fetchPolygonDaily preserved, uncalled; the route uses fetchLicensedDaily.' },
  'lib/congress-options.mjs': { customerFacing: false, why: 'Options pricing disabled at the cron; no licensed options feed exists to migrate to.' },
  'lib/market-data.js': { customerFacing: false, why: 'polygonQuotes preserved, uncalled; getQuotes returns {} rather than falling back.' },
  'app/api/earnings/route.js': { customerFacing: false, why: 'polygonEarnings preserved, uncalled; the fallback fails closed.' },
};

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = await walk('src');
const found = [];
for (const f of files) {
  if (/api\.polygon\.io/.test(strip(await readFile(f, 'utf8')))) found.push(f.replace(/^src\//, ''));
}

L('=== FILES WITH A POLYGON URL IN LIVE CODE ===');
for (const f of found) {
  const d = INVENTORY[f];
  L(`  ${d ? (d.customerFacing ? '⚠️ CUSTOMER-FACING' : 'declared          ') : '⚠️ UNDECLARED     '} ${f}`);
}

L('\n=== ASSERTIONS ===');
const undeclared = found.filter((f) => !INVENTORY[f]);
ok('⚠️ every remaining Polygon URL is declared and accounted for',
  mut('undeclared') ? false : undeclared.length === 0, undeclared.join(', '));
ok('⚠️ NONE of them is customer-facing',
  found.every((f) => INVENTORY[f] && INVENTORY[f].customerFacing !== true),
  found.filter((f) => INVENTORY[f]?.customerFacing).join(', '));
const stale = Object.keys(INVENTORY).filter((f) => !found.includes(f));
ok('…and the inventory has not rotted (no declaration for a file that is now clean)',
  stale.length === 0, stale.join(', '));

// ── THE PATHS MIGRATED, ASSERTED BY NAME so a regression is legible ──
L('');
const migrated = [
  ['app/api/chart-intraday/route.js', 'intraday chart candles'],
  ['app/api/movers/route.js', 'Terminal movers'],
  ['app/api/congress-chart/route.js', 'congress price line'],
  ['app/api/refresh-congress/route.js', 'congress price enrichment'],
  ['app/api/cron/enrich-insider-perf/route.js', 'insider performance'],
  ['app/api/ticker/route.js', 'ticker news'],
  ['app/api/dividends/route.js', 'dividend events + yield basis'],
];
for (const [file, what] of migrated) {
  const code = strip(await readFile(`src/${file}`, 'utf8'));
  ok(`${what}: no Polygon URL`, mut('revive') ? false : !/api\.polygon\.io/.test(code), file);
}

// ── FAIL-CLOSED PATHS: the code stays, the call does not happen ──
L('');
{
  const earnings = strip(await readFile('src/app/api/earnings/route.js', 'utf8'));
  ok('⚠️ earnings fails closed rather than calling Polygon',
    mut('revive') ? false : /async function earningsFallback\s*\([^)]*\)\s*\{\s*return empty\(/.test(earnings),
    'Tiingo fundamentals is capped to the Dow 30 — exactly the set that never needed a fallback');
  ok('…and the adapter is preserved for a future licensed use', /async function polygonEarnings/.test(earnings));

  const opts = strip(await readFile('src/app/api/cron/enrich-options/route.js', 'utf8'));
  ok('⚠️ options pricing is disabled, not substituted with equity data',
    mut('revive') ? false : /OPTIONS_PRICING_ENABLED = false/.test(opts) && /if \(!OPTIONS_PRICING_ENABLED\)/.test(opts));
  ok('…and the options implementation is preserved intact',
    /export async function priceOption/.test(await readFile('src/lib/congress-options.mjs', 'utf8')));

  // ⚠️ NO SILENT FALLBACK. A Tiingo failure must not reach Polygon.
  const md = strip(await readFile('src/lib/market-data.js', 'utf8'));
  ok('⚠️ a quote failure returns empty rather than falling back to Polygon',
    mut('revive') ? false : !/return polygonQuotes\(/.test(md));
  ok('…and polygonQuotes is preserved, uncalled', /async function polygonQuotes/.test(md));
}

// ── THE REPLACEMENTS ARE THE LICENSED ONES ──
L('');
for (const [file, needle, what] of [
  ['app/api/chart-intraday/route.js', 'getIntradayBars', 'charts read Tiingo intraday'],
  ['app/api/dividends/route.js', 'getCorporateActions', 'dividends read Tiingo corporate actions'],
  ['app/api/dividends/route.js', 'dailyCloses', 'the yield basis is our stored close'],
  ['app/api/refresh-congress/route.js', 'dailyCloses', 'congress prices read stored candles first'],
  ['app/api/cron/enrich-insider-perf/route.js', 'dailyCloses', 'insider performance reads stored candles first'],
  ['app/api/ticker/route.js', 'fetchTiingoNews', 'ticker news reads Tiingo'],
  ['app/api/movers/route.js', 'marketMovers', 'movers reuse the shared licensed snapshot'],
]) {
  ok(what, new RegExp(needle).test(await readFile(`src/${file}`, 'utf8')), `${needle} in ${file}`);
}

L(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
