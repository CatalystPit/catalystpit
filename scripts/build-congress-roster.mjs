// scripts/build-congress-roster.mjs
//
// Fetches the unitedstates/congress-legislators dataset and flattens it to a
// compact roster used to attach party / state / chamber / photo (via bioguide)
// to FMP congressional-trade data, which carries no party and no clean state.
//
// Run occasionally (new Congress, special elections, party switches):
//   node scripts/build-congress-roster.mjs
//
// Writes src/lib/congress-roster.json (committed to the repo). The matcher in
// scripts/congress-match.mjs consumes the precomputed nLast/nFirst/nNick keys.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { norm, firstToken } from '../src/lib/congress-match.mjs';

const CURRENT    = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const HISTORICAL = 'https://unitedstates.github.io/congress-legislators/legislators-historical.json';

// Recently-departed members can still appear in disclosure feeds (they traded
// before leaving). Include historical members whose most recent term ended
// on/after this date. Keeps the roster lean and limits last-name collisions
// vs. pulling all ~12k historical members.
const HISTORICAL_SINCE = '2023-01-01';

const lastTerm = (m) => (m.terms || [])[m.terms?.length - 1] || null;

function toEntry(m) {
  const t = lastTerm(m);
  if (!t) return null;
  const chamber = t.type === 'sen' ? 'senate' : t.type === 'rep' ? 'house' : null;
  if (!chamber) return null;
  return {
    bioguide:     m.id?.bioguide || null,
    first:        m.name?.first || '',
    last:         m.name?.last || '',
    nickname:     m.name?.nickname || null,
    officialFull: m.name?.official_full || `${m.name?.first || ''} ${m.name?.last || ''}`.trim(),
    party:        t.party || null,
    state:        t.state || null,
    district:     t.district != null ? String(t.district) : null,
    chamber,
    termEnd:      t.end || null,
    // precomputed normalized keys for the ingest-time matcher
    nLast:  norm(m.name?.last),
    nFirst: firstToken(m.name?.first),
    nNick:  m.name?.nickname ? firstToken(m.name?.nickname) : null,
  };
}

async function main() {
  const [cur, hist] = await Promise.all([
    fetch(CURRENT).then(r => r.json()),
    fetch(HISTORICAL).then(r => r.json()),
  ]);

  const byBioguide = new Map();
  let recentHist = 0;
  // historical first so a current term overwrites it
  for (const m of hist) {
    const t = lastTerm(m);
    if (!t || !t.end || t.end < HISTORICAL_SINCE) continue;
    const e = toEntry(m);
    if (e?.bioguide) { byBioguide.set(e.bioguide, e); recentHist++; }
  }
  for (const m of cur) {
    const e = toEntry(m);
    if (e?.bioguide) byBioguide.set(e.bioguide, e);
  }

  const roster = [...byBioguide.values()];
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'congress-roster.json');
  writeFileSync(out, JSON.stringify(roster));

  const sen = roster.filter(r => r.chamber === 'senate').length;
  const hou = roster.filter(r => r.chamber === 'house').length;
  console.log(`[roster] current=${cur.length} + recent-historical(since ${HISTORICAL_SINCE})=${recentHist}`);
  console.log(`[roster] wrote ${roster.length} members (${sen} senate, ${hou} house) → ${out}`);
}

main().catch(e => { console.error('[roster] fatal:', e.message); process.exit(1); });
