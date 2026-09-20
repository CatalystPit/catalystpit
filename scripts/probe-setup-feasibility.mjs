// CAN THE REAL BOARD SUPPORT THESE SETUPS? — a feasibility census.
//
// V3 proposes setup archetypes. An archetype nobody in production can satisfy is a filter that is
// always empty, and one everybody satisfies is not a setup at all. So before writing any
// qualification rule, this counts the raw ingredients across the live board:
//
//   · how fresh the most recent catalyst is
//   · which disclosure families carry direction, and how strong
//   · how often historical context exists to make evidence "unusual"
//   · how the V2.1 states and market confirmation currently fall
//
// Run: node --import ./scripts/next-resolve-loader.mjs scripts/probe-setup-feasibility.mjs

import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { drizzle } = await import('drizzle-orm/neon-http');
const { neon } = await import('@neondatabase/serverless');
const db = drizzle(neon(process.env.DATABASE_URL));

const { tickerEvidence } = await import('../src/lib/evidence/resolve.js');
const { freshness } = await import('../src/lib/evidence/model.mjs');
const { readPublishedBoard } = await import('../src/lib/consensus/refresh.js');

const L = (s = '') => console.log(s);
const NOW = Date.now();
const DAY = 86_400_000;

const board = await readPublishedBoard();
const rows = board.payload?.rows || [];
L(`board: ${rows.length} rows, built ${board.payload?.builtAt}\n`);

const out = [];
for (const r of rows) {
  const t = r.ticker;
  let ev;
  try { ev = await tickerEvidence(t, { now: NOW }); } catch { continue; }
  const list = ev.evidence || [];

  const byFam = (f) => list.filter((e) => e.family === f);
  const cat = byFam('catalyst');
  const ins = byFam('insider');
  const inst = byFam('institution');
  const con = byFam('congress');

  const freshest = (arr) => arr.reduce((acc, e) => {
    const p = Date.parse(e.publicTime);
    return Number.isFinite(p) && p > acc ? p : acc;
  }, 0);

  const catAge = cat.length ? (NOW - freshest(cat)) / DAY : null;
  const materialCat = cat.filter((e) => e.facts?.material === true);
  const materialCatAge = materialCat.length ? (NOW - freshest(materialCat)) / DAY : null;

  // Directional disclosure families (catalyst direction is usually unknown, so it is excluded).
  const dirFams = new Set(list.filter((e) => e.direction === 'positive' || e.direction === 'negative')
    .map((e) => e.family));
  const unusual = list.filter((e) => e.context?.unusual || e.context?.boundedByCoverage
    || typeof e.context?.gapDays === 'number');

  out.push({
    ticker: t,
    state: r.canonical?.state,
    market: r.canonical?.market?.confirmation,
    conf: r.canonical?.confidence,
    catAge, materialCatAge,
    catFresh7: catAge !== null && catAge <= 7,
    matCatFresh7: materialCatAge !== null && materialCatAge <= 7,
    ins: ins.length, inst: inst.length, con: con.length, cat: cat.length,
    dirFams: dirFams.size,
    unusual: unusual.length,
    unusualFams: [...new Set(unusual.map((e) => e.family))],
    total: list.length,
  });
}

const n = out.length;
const pct = (c) => `${String(c).padStart(3)}/${n} (${String(Math.round(100 * c / n)).padStart(3)}%)`;

L('━━━ RAW INGREDIENTS ACROSS THE LIVE BOARD');
L(`  has any catalyst                ${pct(out.filter((o) => o.cat > 0).length)}`);
L(`  catalyst public <= 7d           ${pct(out.filter((o) => o.catFresh7).length)}`);
L(`  MATERIAL catalyst public <= 7d  ${pct(out.filter((o) => o.matCatFresh7).length)}`);
L(`  catalyst public <= 2d           ${pct(out.filter((o) => o.catAge !== null && o.catAge <= 2).length)}`);
L(`  has insider evidence            ${pct(out.filter((o) => o.ins > 0).length)}`);
L(`  has institution evidence        ${pct(out.filter((o) => o.inst > 0).length)}`);
L(`  has congress evidence           ${pct(out.filter((o) => o.con > 0).length)}`);
L(`  >=2 directional families        ${pct(out.filter((o) => o.dirFams >= 2).length)}`);
L(`  >=3 directional families        ${pct(out.filter((o) => o.dirFams >= 3).length)}`);
L(`  has historically unusual        ${pct(out.filter((o) => o.unusual > 0).length)}`);
L(`  unusual AND >=2 dir families    ${pct(out.filter((o) => o.unusual > 0 && o.dirFams >= 2).length)}`);

L('\n━━━ CURRENT V2.1 DISTRIBUTION');
const tally = (key) => {
  const m = {};
  for (const o of out) m[o[key]] = (m[o[key]] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');
};
L(`  state:      ${tally('state')}`);
L(`  market:     ${tally('market')}`);
L(`  confidence: ${tally('conf')}`);

L('\n━━━ CANDIDATE ARCHETYPE YIELD (rough, before real rules)');
const A = {
  'fresh material catalyst + >=1 directional family':
    out.filter((o) => o.matCatFresh7 && o.dirFams >= 1).length,
  'fresh material catalyst, no directional family':
    out.filter((o) => o.matCatFresh7 && o.dirFams === 0).length,
  'unusual insider activity (+ another family)':
    out.filter((o) => o.unusualFams.includes('insider') && o.dirFams >= 2).length,
  'unusual institutional shift':
    out.filter((o) => o.unusualFams.includes('institution')).length,
  'congress present at all':
    out.filter((o) => o.con > 0).length,
  '>=2 directional families, no fresh catalyst':
    out.filter((o) => !o.matCatFresh7 && o.dirFams >= 2).length,
  'NOTHING fresh and <2 directional families (quiet)':
    out.filter((o) => !o.catFresh7 && o.dirFams < 2).length,
};
for (const [k, v] of Object.entries(A)) L(`  ${k.padEnd(52)} ${pct(v)}`);

L('\n━━━ PER-TICKER DETAIL (freshest catalyst age in days)');
for (const o of out.sort((a, b) => (a.matCatFresh7 === b.matCatFresh7 ? 0 : a.matCatFresh7 ? -1 : 1)
  || (b.dirFams - a.dirFams))) {
  L(`  ${o.ticker.padEnd(6)} cat=${o.catAge === null ? '  —' : o.catAge.toFixed(1).padStart(5)}d`
    + ` matCat=${o.materialCatAge === null ? '  —' : o.materialCatAge.toFixed(1).padStart(5)}d`
    + ` dirFams=${o.dirFams} unusual=${o.unusual}[${o.unusualFams.join(',')}]`
    + ` ins=${o.ins} inst=${o.inst} con=${o.con} cat#=${o.cat}`
    + `  ${o.state} / ${o.market}`);
}
