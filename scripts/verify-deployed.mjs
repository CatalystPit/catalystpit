// IS WHAT I VERIFIED WHAT IS ACTUALLY LIVE?
//
//   node scripts/verify-deployed.mjs
//
// ⚠️ WHY THIS EXISTS. The feature flags that hide Guidance, Analyst Ratings and Tools & offers were
// written, tested green, and built green — and the live site went on showing all three for hours,
// because the work was never committed or pushed. Every check that had been run read the WORKING
// TREE, so not one of them could have noticed. "The tests pass" and "the site is fixed" are
// different claims, and nothing in the repo distinguished them.
//
// This does. It compares three things that are easy to assume agree:
//
//   THE WORKING TREE   what I just edited
//   HEAD / origin/main what a deploy would actually build
//   THE LIVE BUNDLE    what a user's browser is running right now
//
// It is the one suite that needs the network, so it is not part of the offline run. Failing it does
// not mean the code is wrong — it usually means the code is fine and has not shipped, which is
// exactly the distinction that was missing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SITE = process.env.CP_SITE || 'https://catalystpit.com';
const PROBE_PATH = '/ticker/AAPL';

let pass = 0, fail = 0, warn = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const note = (msg) => { warn++; console.log(`  note ${msg}`); };
const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch { return null; }
};

// ── 1. the working tree against what a deploy would build ─────────────────────────────────────
console.log('\n1. the working tree against what a deploy would build');

const head = git('rev-parse', 'HEAD');
ok('this is a git checkout', !!head);

// UNCOMMITTED SOURCE IS THE WHOLE POINT. A dirty scripts/ or a stray note is noise; a dirty src/ is
// a change that exists only on this machine, however green its tests are. package.json and the lock
// file count too — they change what the deploy installs, so a dirty one means the build that ran is
// not the build this checkout describes.
const DEPLOY_RELEVANT = /(^|\s)(src\/|package\.json|package-lock\.json)/;
const porcelain = git('status', '--porcelain') || '';
const dirty = porcelain.split('\n')
  .map((l) => l.trim()).filter(Boolean)
  .map((l) => l.replace(/^\S+\s+/, ''))
  .filter((f) => DEPLOY_RELEVANT.test(` ${f}`));
ok('nothing that affects the deploy is left uncommitted', dirty.length === 0,
  dirty.length ? `only on this machine: ${dirty.join(', ')}` : '');

// Ahead of origin means committed but never pushed — nothing has built it.
git('fetch', 'origin', '--quiet');
const counts = git('rev-list', '--left-right', '--count', 'origin/main...HEAD');
if (counts) {
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  ok('nothing is committed-but-unpushed', ahead === 0,
    ahead ? `${ahead} commit(s) on HEAD that origin/main does not have` : '');
  if (behind > 0) note(`local is ${behind} commit(s) behind origin/main`);
} else {
  note('could not compare against origin/main (no network, or no upstream)');
}

// ── 2. the live bundle ────────────────────────────────────────────────────────────────────────
console.log('\n2. the live bundle');

// WHAT THE PAGE'S OWN CHUNK MUST CONTAIN. These are object-literal KEYS in feature-availability.mjs,
// so a minifier keeps them verbatim — unlike the function names around them, which it renames. That
// is what makes them a usable fingerprint for "this deploy has the feature system in it".
const FINGERPRINTS = ['analystRatings', 'toolsAndOffers'];
// A string that has been in the ticker page for a long time. If THIS is missing the probe found the
// wrong file, and every other result in this section is meaningless.
const CONTROL = 'Insider Trades';

let html = null;
try {
  const r = await fetch(`${SITE}${PROBE_PATH}`, { redirect: 'follow' });
  html = r.ok ? await r.text() : null;
  ok(`${SITE}${PROBE_PATH} responds`, r.ok, `HTTP ${r.status}`);
} catch (e) {
  ok(`${SITE}${PROBE_PATH} responds`, false, e.message);
}

if (html) {
  // ⚠️ THE CHUNK PATH IS URL-ENCODED: app/ticker/%5Bsymbol%5D/page-<hash>.js. A character class of
  // [A-Za-z0-9._/-] silently skips it, which is how an earlier version of this probe "found no
  // matches" in a bundle that did contain them and reported a clean result.
  const chunks = [...new Set([...html.matchAll(/static\/chunks\/[^"'\\\s]+?\.js/g)].map((m) => m[0]))];
  const pageChunk = chunks.find((c) => /ticker/.test(c));
  ok('the ticker page chunk is referenced by the page', !!pageChunk,
    `${chunks.length} chunks seen, none matching /ticker/`);

  if (pageChunk) {
    let js = null;
    try {
      const r = await fetch(`${SITE}/_next/${pageChunk}`);
      js = r.ok ? await r.text() : null;
      ok('the ticker page chunk downloads', !!js, `HTTP ${r.status}`);
    } catch (e) { ok('the ticker page chunk downloads', false, e.message); }

    if (js) {
      // The control first: everything below is meaningless without it.
      ok(`the chunk is the ticker page (contains "${CONTROL}")`, js.includes(CONTROL),
        `probed ${pageChunk}`);
      for (const fp of FINGERPRINTS) {
        ok(`the live bundle contains the feature registry key "${fp}"`, js.includes(fp),
          'the deployed build predates the feature-availability module');
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} note(s)` : ''}`);
if (fail) {
  console.error('\n⚠️  The live site and this checkout do not agree. Green offline suites say the CODE');
  console.error('   is right; they say nothing about what is DEPLOYED. Check the two against each');
  console.error('   other before reporting a user-visible fix as done.');
}
process.exit(fail ? 1 : 0);
