// V3.5 INVESTIGATION — where do tickers actually get excluded, and what do reactions look like?
//
// Two questions must be answered from production before any threshold is chosen:
//
//   1. For a named ticker, what canonical evidence exists, and at exactly which stage is it
//      dropped — candidate generation, evaluation, or setup qualification?
//   2. What is the real distribution of post-publicTime returns? A dead zone picked without that
//      is a guess, and the current board is calling +0.8% "diverging".
//
// Run: node --import ./scripts/next-resolve-loader.mjs scripts/probe-v35-investigation.mjs [TICKERS...]

import fs from 'node:fs';
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { drizzle } = await import('drizzle-orm/neon-http');
const { neon } = await import('@neondatabase/serverless');
const { sql } = await import('drizzle-orm');
const db = drizzle(neon(process.env.DATABASE_URL));

const { tickerEvidence } = await import('../src/lib/evidence/resolve.js');
const { selectSetupCandidates, buildSetup } = await import('../src/lib/consensus/setup-board.js');
const { attachReactions } = await import('../src/lib/evidence/reaction-data.js');

const L = (s = '') => console.log(s);
const NOW = Date.now();
const DAY = 86_400_000;

const NAMED = process.argv.slice(2).filter((a) => /^[A-Z.]{1,6}$/.test(a));
const SUBJECTS = NAMED.length ? NAMED : ['BE', 'INTC', 'AMRZ', 'ALK', 'GOLD', 'AAT'];

// ── STAGE 1: the candidate set, and the raw signals that feed it ────────────
const candidates = await selectSetupCandidates(db, sql, {});
const candSet = new Set(candidates);
L(`candidate set: ${candidates.length} tickers\n`);

async function rawSignals(t) {
  const q = async (s) => {
    const r = await db.execute(s);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return rows[0] || {};
  };
  const [ins, insBuy, con, cat] = await Promise.all([
    q(sql`select count(*)::int n, coalesce(sum(total_value),0)::float8 v from insider_trades
           where ticker=${t} and filing_date >= current_date - 30 and total_value > 0
             and coalesce(superseded_by,'')=''`),
    q(sql`select count(*)::int n, coalesce(sum(total_value),0)::float8 v from insider_trades
           where ticker=${t} and filing_date >= current_date - 30 and transaction_code='P'
             and coalesce(is_derivative,false)=false and total_value > 0
             and coalesce(superseded_by,'')=''`),
    q(sql`select count(*)::int n from congress_trades
           where ticker=${t} and disclosure_date >= current_date - 45`),
    q(sql`select count(*)::int n, count(*) filter (where material)::int m,
                 max(filed_at) last from eightk_filings
           where ticker=${t} and filed_at >= now() - interval '30 days'`),
  ]);
  return { ins, insBuy, con, cat };
}

L('═══════════ NAMED SUBJECT INVESTIGATION ═══════════');
for (const t of SUBJECTS) {
  L(`\n──────── ${t} ────────`);
  const raw = await rawSignals(t);
  L(`  RAW (the inputs candidate generation sees):`);
  L(`    insider filings 30d: ${raw.ins.n}  ($${Math.round((raw.ins.v || 0) / 1e6)}M)`);
  L(`    open-market BUYS 30d: ${raw.insBuy.n}  ($${Math.round((raw.insBuy.v || 0) / 1e6)}M)`);
  L(`    congress disclosures 45d: ${raw.con.n}`);
  L(`    8-K 30d: ${raw.cat.n} (material ${raw.cat.m})  last ${raw.cat.last || '—'}`);

  // Families needed for the >=2 rule (institutions deliberately excluded from selection).
  const fams = [raw.ins.n > 0, raw.con.n > 0, raw.cat.n > 0].filter(Boolean).length;
  L(`  SELECTION: ${fams} selecting families (need >=2 for the multi tier)`);
  L(`    in candidate set: ${candSet.has(t) ? 'YES' : 'NO'}`);

  let ev;
  try { ev = await tickerEvidence(t, { now: NOW }); } catch (e) { L(`  EVIDENCE: ERROR ${e.message}`); continue; }
  L(`  CANONICAL EVIDENCE: ${ev.evidence.length} records, failed=${ev.failedFamilies.length}`);
  for (const e of ev.evidence) {
    const ageD = ((NOW - Date.parse(e.publicTime)) / DAY).toFixed(1);
    L(`    [${e.family}/${e.type}] ${e.direction} mat=${e.materiality} q=${e.quality} public ${ageD}d`);
    L(`       ${e.summary}`);
    if (e.context?.text) L(`       CONTEXT: ${e.context.text}`);
    const f = e.facts || {};
    const keys = Object.keys(f).filter((k) => f[k] !== null && f[k] !== undefined);
    if (keys.length) L(`       facts: ${keys.map((k) => `${k}=${JSON.stringify(f[k])}`).join(' ')}`);
  }

  // Stage 3: what the current setup engine decides.
  try {
    const s = await buildSetup(t, { now: NOW });
    L(`  QUALIFICATION: ${s.setup.setup} (active=${s.setup.active})`);
    L(`    reasons: ${s.setup.reasons.join(' | ')}`);
    L(`    V2.1 state=${s.canonical?.state} conf=${s.canonical?.confidence} market=${s.canonical?.market?.confirmation}`);
    L(`    EXCLUDED AT: ${!candSet.has(t) ? 'CANDIDATE GENERATION' : s.setup.active ? '(not excluded)' : 'SETUP QUALIFICATION'}`);
  } catch (e) { L(`  QUALIFICATION: ERROR ${e.message}`); }
}

// ── STAGE 2: the reaction distribution that must set the dead zone ──────────
L('\n\n═══════════ REACTION DISTRIBUTION (for the dead zone) ═══════════');
const sample = candidates.slice(0, 60);
const rets = [];   // {t, fam, r1, rel1, r5}
for (const t of sample) {
  try {
    const ev = await tickerEvidence(t, { now: NOW });
    const withR = await attachReactions(t, ev.evidence, { now: NOW });
    for (const e of withR) {
      const h = e.reaction?.horizons;
      if (!h) continue;
      const one = h['1'] ?? h[1];
      const five = h['5'] ?? h[5];
      if (one && Number.isFinite(one.return)) {
        rets.push({ t, fam: e.family, r1: one.return, rel1: one.relative, r5: five?.return ?? null });
      }
    }
  } catch { /* skip */ }
}

const abs = rets.map((r) => Math.abs(r.r1)).sort((a, b) => a - b);
const absRel = rets.filter((r) => Number.isFinite(r.rel1)).map((r) => Math.abs(r.rel1)).sort((a, b) => a - b);
const pctile = (arr, p) => (arr.length ? arr[Math.floor(arr.length * p)] : null);
const fmt = (v) => (v === null ? '—' : v.toFixed(2));

L(`n = ${rets.length} reaction observations across ${sample.length} tickers\n`);
L('  |1-session return|   p10 %s  p25 %s  p50 %s  p75 %s  p90 %s  max %s'
  .replace(/%s/g, () => '')); // header spacing handled below
L(`    p10=${fmt(pctile(abs, 0.10))}  p25=${fmt(pctile(abs, 0.25))}  p50=${fmt(pctile(abs, 0.50))}`
  + `  p75=${fmt(pctile(abs, 0.75))}  p90=${fmt(pctile(abs, 0.90))}  max=${fmt(abs[abs.length - 1])}`);
L(`  |1-session vs SPY|`);
L(`    p10=${fmt(pctile(absRel, 0.10))}  p25=${fmt(pctile(absRel, 0.25))}  p50=${fmt(pctile(absRel, 0.50))}`
  + `  p75=${fmt(pctile(absRel, 0.75))}  p90=${fmt(pctile(absRel, 0.90))}  max=${fmt(absRel[absRel.length - 1])}`);

for (const th of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]) {
  const n = abs.filter((v) => v >= th).length;
  const nRel = absRel.filter((v) => v >= th).length;
  L(`  threshold ${th.toFixed(1)}%: ${n}/${abs.length} (${Math.round(100 * n / abs.length)}%) absolute`
    + ` · ${nRel}/${absRel.length} (${Math.round(100 * nRel / absRel.length)}%) vs SPY survive`);
}

L('\n  LARGEST MOVES (sanity):');
for (const r of [...rets].sort((a, b) => Math.abs(b.r1) - Math.abs(a.r1)).slice(0, 8)) {
  L(`    ${r.t.padEnd(6)} ${r.fam.padEnd(12)} 1d=${r.r1.toFixed(2)}%  vsSPY=${fmt(r.rel1)}%  5d=${fmt(r.r5)}%`);
}
