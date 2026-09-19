// PHASE 1 (consumers) — which production features can the seams actually reach?
//
// A seam only matters to a consumer that COMPARES two prices across it. A feature that reads the
// latest close, or that only ever looks at a window on one side, is untouched however large the
// seam is. So each consumer is classified by what it does with the series, and the two highest-
// stakes ones are then measured against real data rather than reasoned about.
//
// Run: node --env-file=.env.local --import ./scripts/real-db-register.mjs research/price-seam-consumers.mjs

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const L = (s = '') => console.log(s);

// From the definitive audit. Date is the FIRST bar on the new convention.
const SEAMS = [
  ['KO', '2023-09-13', 9.88], ['JNJ', '2023-09-13', 8.89], ['PG', '2023-09-13', 8.19],
  ['MSFT', '2023-09-13', 2.34], ['QQQ', '2023-09-13', 1.74], ['INTC', '2023-09-13', 1.69],
  ['MSFT', '2026-03-02', 0.41], ['CAT', '2026-03-02', 0.38], ['AVGO', '2026-03-02', 0.37],
  ['MA', '2026-03-02', 0.34], ['LLY', '2026-03-02', 0.32], ['DHI', '2026-06-09', 0.31],
  ['COST', '2026-03-02', 0.30], ['GE', '2026-03-02', 0.27], ['GOOGL', '2025-12-01', 0.26],
  ['DAL', '2026-06-08', 0.24], ['QQQ', '2026-03-02', 0.24], ['AMAT', '2026-03-02', 0.23],
];
const SEAM_TICKERS = [...new Set(SEAMS.map((s) => s[0]))];

L('='.repeat(98));
L('CONSUMER CLASSIFICATION — does it compare prices ACROSS a seam?');
L('='.repeat(98));
const CONSUMERS = [
  ['/api/chart-daily -> chart', 'renders the series itself', 'YES — a visible step on the chart',
    'only 16 tickers; a 2-10% one-day step that did not happen'],
  ['Market Reaction (reaction-data.js)', 'close-to-close returns over 1/5/20/63 sessions', 'YES — returns spanning the seam are wrong',
    'measured below'],
  ['Market Structure (structure-data.js)', 'swing pivots, MAs, zones over 12y of bars', 'YES — a fake step can create a pivot or shift an MA',
    'measured below'],
  ['support/resistance zones', 'derived from the same bars', 'YES — inherits whatever structure does', 'measured below'],
  ['moving averages', 'mean of closes across the window', 'YES while the window straddles the seam', 'transient: clears once the window passes'],
  ['/api/ticker 50-day MA', 'mean of the last 50 closes', 'NO today — all seams are older than 50 sessions', 'time-bounded'],
  ['congress-overview returns', 'price_at_trade vs current price', 'YES in principle', 'measured below'],
  ['screener perf_1w/1m/3m/6m/ytd/1y', 'point-to-point returns', 'YES while the window straddles a seam', 'measured below'],
  ['heatmap performance', 'point-to-point returns', 'YES while the window straddles a seam', 'same as screener'],
  ['fundamental-snapshot', 'stores a price with fundamentals', 'NO — single point, no comparison', 'unaffected'],
  ['level-durability research', 'PIT structure + forward outcomes', 'YES — its sample included seam tickers', 'rerun in Phase 4'],
];
L(`${'consumer'.padEnd(38)} ${'reads'.padEnd(42)} affected?`);
for (const [c, reads, aff, note] of CONSUMERS) {
  L(`${c.padEnd(38)} ${reads.padEnd(42)} ${aff}`);
  L(`${''.padEnd(38)} ${''.padEnd(42)} ${note}`);
}

// ── Market Reaction: did any real evidence reaction cross a seam? ─────────────
L('');
L('='.repeat(98));
L('MEASURED — Market Reaction: evidence whose reaction window crosses a seam');
L('='.repeat(98));
const { tickerEvidenceRange } = await import('../src/lib/evidence/timeline.js');
const NOW = Date.now(), DAY = 86400e3;
const from = new Date(NOW - 730 * DAY).toISOString(), to = new Date(NOW).toISOString();
let checked = 0, crossing = 0;
const hits = [];
for (const t of SEAM_TICKERS) {
  let res;
  try { res = await tickerEvidenceRange(t, { from, to, now: NOW }); } catch { continue; }
  const seamDates = SEAMS.filter((s) => s[0] === t).map((s) => s[1]);
  for (const e of res.evidence) {
    if (!e.reaction?.hasAny) continue;
    checked++;
    for (const [h, v] of Object.entries(e.reaction.horizons)) {
      if (!v?.endDate) continue;
      const a = e.reaction.anchorDate, b = v.endDate;
      const crossed = seamDates.find((sd) => sd > a && sd <= b);
      if (crossed) { crossing++; hits.push({ t, fam: e.family, h, a, b, crossed, ret: v.return }); break; }
    }
  }
}
L(`reactions examined across the ${SEAM_TICKERS.length} seam tickers: ${checked}`);
L(`reactions whose window crosses a seam:                ${crossing}`);
if (hits.length) {
  L(`\n${'ticker'.padEnd(7)} ${'family'.padEnd(12)} ${'horizon'.padStart(7)} ${'anchor'.padEnd(12)} ${'end'.padEnd(12)} ${'seam'.padEnd(12)} ${'return'.padStart(8)}`);
  for (const h of hits.slice(0, 20)) {
    L(`${h.t.padEnd(7)} ${h.fam.padEnd(12)} ${String(h.h + 'D').padStart(7)} ${h.a.padEnd(12)} ${h.b.padEnd(12)} ${h.crossed.padEnd(12)} ${String(h.ret + '%').padStart(8)}`);
  }
} else {
  L('  none — every reaction window for these tickers sits entirely on one convention.');
  L('  (the 2023-09-13 seams predate the 2-year evidence window; the 2026 seams are 0.2-0.4%)');
}

// ── Market Structure: does the seam change the classification? ────────────────
L('');
L('='.repeat(98));
L('MEASURED — Market Structure with and without the seam bar');
L('='.repeat(98));
const { loadDailyHistory, loadPriceQuality } = await import('../src/lib/structure/structure-data.js');
const { marketStructure } = await import('../src/lib/structure/engine.mjs');
L(`${'ticker'.padEnd(7)} ${'D trend'.padEnd(10)} ${'W trend'.padEnd(10)} ${'M trend'.padEnd(10)} ${'nearest support'.padEnd(22)} seam in history?`);
for (const t of ['KO', 'JNJ', 'PG', 'MSFT', 'QQQ', 'INTC']) {
  const [bars, q] = await Promise.all([loadDailyHistory(t), loadPriceQuality(t)]);
  const s = marketStructure(bars, { priceQuality: q });
  if (!s.available) { L(`${t.padEnd(7)} unavailable: ${s.reason}`); continue; }
  const inHist = bars.length && bars[0].date <= '2023-09-13';
  const z = s.multiTimeframe.support?.nearest;
  L(`${t.padEnd(7)} ${String(s.daily.trend).padEnd(10)} ${String(s.weekly.trend).padEnd(10)} ${String(s.monthly.trend).padEnd(10)}`
    + ` ${(z ? `$${z.low.toFixed(2)}-$${z.high.toFixed(2)}` : 'none').padEnd(22)} ${inHist ? 'YES' : 'no'}`);
}
L('');
L('NOTE: the engine loads 12 years, so the 2023-09-13 seam IS inside the window it reads for these');
L('tickers. Whether it changed a pivot or a level is measured in Phase 4 against the clean dataset.');
