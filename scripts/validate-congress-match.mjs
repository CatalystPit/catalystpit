// scripts/validate-congress-match.mjs
//
// QA tool: pulls the live FMP senate + house feeds, runs the matcher against
// the built roster, and reports the distinct-member match/miss rate (the miss
// rate = members who'd show blank party/state on a card). Re-run after any
// roster rebuild or matcher change:
//   node --env-file=.env.local scripts/validate-congress-match.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, matchMember } from '../src/lib/congress-match.mjs';

const K = process.env.FMP_API_KEY;
if (!K) { console.error('FMP_API_KEY not set (run with --env-file=.env.local)'); process.exit(1); }

const rosterPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'congress-roster.json');
const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
const index = buildIndex(roster);

const pull = async (ch) => {
  const r = await fetch(`https://financialmodelingprep.com/stable/${ch}-latest?page=0&apikey=${K}`);
  return r.ok ? r.json() : [];
};

async function main() {
  let total = 0, matched = 0;
  const byMethod = {};
  const misses = [];

  for (const ch of ['senate', 'house']) {
    const rows = await pull(ch);
    const seen = new Map();   // distinct members in the feed
    for (const r of rows) {
      const key = `${(r.firstName || '').toLowerCase()}|${(r.lastName || '').toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, r);
    }
    for (const r of seen.values()) {
      total++;
      const { entry, method } = matchMember(index, {
        firstName: r.firstName, lastName: r.lastName, chamber: ch, district: r.district,
      });
      byMethod[method] = (byMethod[method] || 0) + 1;
      if (entry) matched++;
      else misses.push(`${ch.padEnd(6)} ${r.firstName} ${r.lastName}  (district='${r.district || ''}')`);
    }
  }

  console.log(`\n[match] distinct members across both feeds: ${total}`);
  console.log(`[match] matched:   ${matched}  (${(100 * matched / total).toFixed(1)}%)`);
  console.log(`[match] unmatched: ${misses.length}  (${(100 * misses.length / total).toFixed(1)}%)`);
  console.log(`[match] by method:`, JSON.stringify(byMethod));
  if (misses.length) {
    console.log(`\n[match] UNMATCHED members (blank party/state on card):`);
    for (const m of misses) console.log('   •', m);
  }
}

main().catch(e => { console.error('[match] fatal:', e.message); process.exit(1); });
