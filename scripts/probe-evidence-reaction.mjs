// Market reaction — live validation against real Catalyst Pit data.
//
// Prints, per sampled event: family, economic date, publicTime, the mapped entry session, the entry
// price, and each horizon with its SPY-relative figure. Then INDEPENDENTLY recomputes a sample
// straight from ticker_daily_candles, so the numbers are checked against the stored bars rather
// than against the code that produced them.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs scripts/probe-evidence-reaction.mjs

import { neon } from '@neondatabase/serverless';
import { tickerEvidenceRange } from '../src/lib/evidence/timeline.js';

const sql = neon(process.env.DATABASE_URL);
const NOW = Date.now();
const DAY = 86400e3;
const L = (s = '') => console.log(s);
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const pc = (n) => (n == null ? '    —  ' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`.padStart(7));

const TICKERS = ['ALK', 'AMRZ', 'AIM', 'AMRC', 'MSFT'];
const from = new Date(NOW - 730 * DAY).toISOString();
const to = new Date(NOW).toISOString();

const samples = [];

for (const ticker of TICKERS) {
  const t0 = Date.now();
  const res = await tickerEvidenceRange(ticker, { from, to, now: NOW });
  const ms = Date.now() - t0;
  const withReaction = res.evidence.filter((e) => e.reaction?.hasAny);

  L('');
  L('='.repeat(92));
  L(`${ticker}   ${res.evidence.length} evidence · ${withReaction.length} with reaction · ${ms}ms`);
  L('='.repeat(92));
  L(`  ${'FAMILY'.padEnd(12)} ${'ECONOMIC'.padEnd(11)} ${'PUBLIC'.padEnd(11)} ${'ENTRY'.padEnd(11)} ${'PRICE'.padStart(9)}`
    + `  ${'1D'.padStart(7)} ${'5D'.padStart(7)} ${'20D'.padStart(7)} ${'63D'.padStart(7)}`);

  // One per family, plus anything with a full 63D history.
  const seen = new Set();
  const picked = withReaction.filter((e) => {
    const full = e.reaction.horizons[63]?.return != null;
    if (!seen.has(e.family)) { seen.add(e.family); return true; }
    return full && samples.length < 12;
  }).slice(0, 6);

  for (const e of picked) {
    const r = e.reaction;
    const economic = e.family === 'congress' ? e.facts?.transactionDate
      : e.family === 'institution' ? e.facts?.quarterEnd
        : day(e.eventTime);
    L(`  ${e.family.padEnd(12)} ${String(economic ?? '—').padEnd(11)} ${String(day(e.publicTime)).padEnd(11)}`
      + ` ${r.anchorDate.padEnd(11)} ${String(r.anchorClose).padStart(9)}`
      + `  ${pc(r.horizons[1]?.return)} ${pc(r.horizons[5]?.return)} ${pc(r.horizons[20]?.return)} ${pc(r.horizons[63]?.return)}`);
    L(`  ${''.padEnd(12)} ${''.padEnd(11)} ${''.padEnd(11)} ${'vs SPY'.padEnd(11)} ${''.padStart(9)}`
      + `  ${pc(r.horizons[1]?.relative)} ${pc(r.horizons[5]?.relative)} ${pc(r.horizons[20]?.relative)} ${pc(r.horizons[63]?.relative)}`);
    L(`  ${''.padEnd(12)} basis=${r.anchorBasis}  ${e.summary.slice(0, 58)}`);
    samples.push({ ticker, e, r });
  }
}

// ── independent verification straight from the stored candles ────────────────
L('');
L('='.repeat(92));
L('INDEPENDENT RECOMPUTE FROM ticker_daily_candles (not via the engine)');
L('='.repeat(92));

let checked = 0, mismatched = 0;
for (const { ticker, e, r } of samples.slice(0, 8)) {
  // Pull the sessions from the anchor forward and recompute by hand.
  const rowsT = await sql.query(
    `select date::text d, close c from ticker_daily_candles
      where ticker=$1 and date >= $2 order by date asc limit 70`, [ticker, r.anchorDate]);
  if (rowsT.length < 2) continue;
  const anchorC = Number(rowsT[0].c);
  const okAnchorDate = rowsT[0].d === r.anchorDate;
  const okAnchorPrice = Math.abs(anchorC - r.anchorClose) < 0.0001;

  let line = `  ${ticker.padEnd(6)} ${e.family.padEnd(12)} anchor ${r.anchorDate} @ ${anchorC}`
    + `  ${okAnchorDate && okAnchorPrice ? 'MATCH' : 'MISMATCH'}`;
  for (const h of [1, 5, 20, 63]) {
    const engine = r.horizons[h]?.return;
    if (engine == null) continue;
    if (rowsT.length <= h) continue;
    const manual = Math.round(((Number(rowsT[h].c) - anchorC) / anchorC) * 1000) / 10;
    const agree = Math.abs(manual - engine) < 0.15;
    checked++;
    if (!agree) { mismatched++; line += `  ${h}D:ENGINE ${engine} vs MANUAL ${manual} MISMATCH`; }
    else line += `  ${h}D:${manual}✓`;
  }
  if (!okAnchorDate || !okAnchorPrice) mismatched++;
  L(line);
}

L('');
L(`horizon values independently recomputed: ${checked}   mismatches: ${mismatched}`);
L('='.repeat(92));
process.exit(mismatched ? 1 : 0);
