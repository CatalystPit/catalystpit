// Every named import in src/ must resolve to a real export.
//
//   node --env-file=.env.local scripts/verify-module-exports.mjs
//
// ⚠️ WHY THIS EXISTS. 050af15a moved isRealtime, WATCHLIST_LIMIT and WATCHLIST_LISTS_LIMIT out of
// lib/entitlements.js into lib/entitlement-rules.mjs and re-exported only the other six names. An ES
// re-export that omits a name does not fail to build — importers simply receive undefined — so:
//
//   isRealtime(tier)            threw TypeError inside `try { … } catch { /* signed-out → delayed */ }`
//                               at six call sites, so the catch written for anonymous callers
//                               swallowed it and PRO/ELITE USERS WERE SERVED DELAYED DATA.
//   WATCHLIST_LIMIT[tier]       read off undefined, so it threw outright.
//
// The gating suite has 118 assertions and stayed green throughout, because it greps for the call
// site — `isRealtime(tier) && !beta` — which is present whether or not the function exists. A text
// assertion cannot see a missing export. This one compares the IMPORT DEMAND against the EXPORT
// SURFACE, which is the only check that could have caught it.
//
// It is static on purpose: lib/entitlements.js imports @clerk/nextjs/server and cannot be imported
// outside Next, so "just import it and look" is not available here.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = join(ROOT, 'src');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (/\.(js|jsx|mjs)$/.test(e)) files.push(p);
  }
})(SRC);

const readFile = (p) => readFileSync(p, 'utf8');
const resolveSpec = (fromFile, spec) => {
  if (!spec.startsWith('.')) return null;                      // package, not ours
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, base + '.js', base + '.mjs', base + '.jsx', join(base, 'index.js'), join(base, 'index.mjs')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

// A module's export surface: direct declarations, brace exports, and `export { … } from './x'`
// re-exports resolved one level deep (which is exactly the shape that broke).
const surfaceCache = new Map();
function exportSurface(file, depth = 0) {
  if (surfaceCache.has(file)) return surfaceCache.get(file);
  const src = readFile(file);
  const names = new Set();
  let starFrom = false;

  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export { a, b as c } [from '...']
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    const from = m[2];
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const local = as ? as[1] : t;
      const exposed = as ? as[2] : t;
      if (!from) { names.add(exposed); continue; }
      // ⚠️ A RE-EXPORTED NAME IS ONLY REAL IF THE SOURCE MODULE ACTUALLY HAS IT. This is the check
      // the incident needed: the list named six of nine, and the three omissions were invisible.
      const target = resolveSpec(file, from);
      if (!target || depth > 3) { names.add(exposed); continue; }
      if (exportSurface(target, depth + 1).names.has(local)) names.add(exposed);
    }
  }
  if (/export\s*\*\s*from/.test(src)) starFrom = true;
  const out = { names, starFrom };
  surfaceCache.set(file, out);
  return out;
}

console.log(`scanning ${files.length} files under src/\n`);
const problems = [];
let checkedImports = 0;

for (const file of files) {
  const src = readFile(file);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpec(file, m[2]);
    if (!target) continue;
    const surface = exportSurface(target);
    if (surface.starFrom) continue;                            // cannot be sure; skip rather than cry wolf
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const name = (t.match(/^([A-Za-z_$][\w$]*)/) || [])[1];
      if (!name || name === 'default') continue;
      checkedImports++;
      if (!surface.names.has(name)) {
        problems.push(`${file.replace(ROOT, '').replace(/\\/g, '/')} imports { ${name} } from '${m[2]}' — not exported there`);
      }
    }
  }
}

ok(`every named import resolves to an export (${checkedImports} checked)`, problems.length === 0);
for (const p of problems) console.error('      ' + p);

// The three names from the incident, pinned by name so a future move cannot quietly drop them again.
{
  const ent = join(SRC, 'lib', 'entitlements.js');
  const surface = exportSurface(ent).names;
  for (const n of ['isRealtime', 'marketDataAccess', 'WATCHLIST_LIMIT', 'WATCHLIST_LISTS_LIMIT',
    'isProTier', 'eodCutoffIso', 'chartIntervalAllowed', 'isIntradayInterval']) {
    ok(`⚠️ lib/entitlements.js exposes ${n}`, surface.has(n));
  }
  // And it must be reachable, not merely listed — the rules module has to really define it.
  const rules = await import('../src/lib/entitlement-rules.mjs');
  ok('⚠️ …and entitlement-rules.mjs really defines isRealtime', typeof rules.isRealtime === 'function');
  ok('⚠️ …returning true for pro and elite, false for free',
    rules.isRealtime('pro') === true && rules.isRealtime('elite') === true && rules.isRealtime('free') === false);
  ok('the watchlist limits kept their values through the move',
    rules.WATCHLIST_LIMIT?.free === 15 && rules.WATCHLIST_LIMIT?.pro === 250 && rules.WATCHLIST_LIMIT?.elite === 1000
    && rules.WATCHLIST_LISTS_LIMIT?.free === 1 && rules.WATCHLIST_LISTS_LIMIT?.pro === 10 && rules.WATCHLIST_LISTS_LIMIT?.elite === 25,
    JSON.stringify([rules.WATCHLIST_LIMIT, rules.WATCHLIST_LISTS_LIMIT]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
