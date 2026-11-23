// ⚠️ DOES THE HEAT MAP SHOW A MARKET, OR TWO STOCKS?
//
//   node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local scripts/verify-heatmap-distribution.mjs
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
//
// The live homepage heat map was BRK.A and BRK.B and almost nothing else, and no test noticed,
// because every existing heat map assertion was about layout geometry or colour and none was about
// WHAT IS IN THE UNIVERSE. The tile maths was correct the whole time; it was faithfully drawing a
// universe that had lost the actual market.
//
// Root cause: `coalesce(m.asset_type, '') = any({Stock,ADRC})` turned an UNKNOWN asset type into ''
// and then failed to match it, so every security whose type we do not happen to store was dropped.
// Asset type has no licensed source — a few hundred rows out of ~8,000 carry one — and those rows
// skew heavily to multi-class listings. The top-500 universe came back with 160 rows, no AAPL, no
// MSFT, no NVDA, and BRK.A + BRK.B holding 87% of the drawn area.
//
// So these assertions are about AREA, measured against the real production dataset.

import { heatmapUniverse, collapseShareClasses } from '../src/lib/heatmap/heatmap-store.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); }
};
const L = (s) => console.log(`\n${s}`);
const share = (rows, k) => {
  const sum = rows.reduce((a, r) => a + (r.marketCap || 0), 0);
  if (!sum) return 1;
  return rows.slice(0, k).reduce((a, r) => a + (r.marketCap || 0), 0) / sum;
};

// The three shapes the board is actually drawn at: the homepage sidebar preview, the full desktop
// page and a phone. The counts are what each surface slices.
const SURFACES = [
  { name: 'homepage sidebar (120 tiles)', limit: 120 },
  { name: 'full page desktop (500 tiles)', limit: 500 },
  { name: 'mobile page (200 tiles)', limit: 200 },
];

const universe = await heatmapUniverse(500);
L(`⚠️ 1 — the universe is a market, not a handful of share classes`);
{
  ok(`⚠️ it returns a real number of companies (${universe.length})`, universe.length >= 400,
    `got ${universe.length}; the broken filter returned 160`);
  const tickers = universe.map((r) => r.ticker);
  // ⚠️ THE MEGACAPS ARE THE CANARY. Their absence is what made the old universe absurd, and it is
  // the single cheapest signal that the eligibility rule has broken again.
  for (const t of ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'AVGO', 'TSLA', 'LLY', 'JPM', 'WMT', 'XOM']) {
    ok(`⚠️ ${t} is on the board`, tickers.includes(t));
  }
  const dotted = tickers.filter((t) => t.includes('.')).length;
  ok(`⚠️ it is not dominated by dotted share classes (${dotted}/${tickers.length})`,
    dotted / tickers.length < 0.2, `${((dotted / tickers.length) * 100).toFixed(1)}% dotted`);
}

L('⚠️ 2 — no company occupies the board twice');
{
  // ⚠️ THE DUPLICATE IS NOT COSMETIC. The provider reports the COMPANY's capitalisation on each
  // listed class — BRK.A and BRK.B both carry ~$1.08T — so drawing both hands one company double
  // the area it has earned rather than splitting it.
  const brk = universe.filter((r) => /^BRK\./.test(r.ticker));
  ok('⚠️ Berkshire appears at most once', brk.length <= 1, brk.map((r) => r.ticker).join(', '));
  for (const pair of [['BF.A', 'BF.B'], ['MOG.A', 'MOG.B'], ['HEI', 'HEI.A'], ['LEN', 'LEN.B']]) {
    const both = pair.filter((t) => universe.some((r) => r.ticker === t));
    ok(`⚠️ ${pair.join(' / ')} — at most one survives`, both.length <= 1, both.join(', '));
  }
  // And the rule itself, executed on a fixture, so it is not merely observed to hold today.
  const fixture = [
    { ticker: 'BRK.A', company: 'BERKSHIRE HATHAWAY INC CL A', marketCap: 1.09e12, avgVol: 2_000 },
    { ticker: 'BRK.B', company: 'Berkshire Hathaway Inc. Class B', marketCap: 1.08e12, avgVol: 4_000_000 },
    { ticker: 'AAPL', company: 'Apple Inc.', marketCap: 5.18e12, avgVol: 50_000_000 },
  ];
  const collapsed = collapseShareClasses(fixture);
  ok('⚠️ the rule collapses two classes of one company into one row', collapsed.length === 2);
  ok('⚠️ …keeping the MORE LIQUID class, not the larger cap',
    collapsed.some((r) => r.ticker === 'BRK.B') && !collapsed.some((r) => r.ticker === 'BRK.A'),
    collapsed.map((r) => r.ticker).join(', '));
  ok('…and it does not merge genuinely different companies',
    collapseShareClasses([
      { ticker: 'BRKR', company: 'Bruker Corporation', marketCap: 1e10, avgVol: 1e6 },
      { ticker: 'BRK.B', company: 'Berkshire Hathaway Inc.', marketCap: 1.08e12, avgVol: 4e6 },
    ]).length === 2);
  ok('…and a row with no company name still groups by its root symbol',
    collapseShareClasses([
      { ticker: 'ZZZ.A', company: null, marketCap: 2e9, avgVol: 10 },
      { ticker: 'ZZZ.B', company: null, marketCap: 1e9, avgVol: 99 },
    ]).length === 1);
}

L('⚠️ 3 — AREA: no two securities may consume the board (the reported defect)');
{
  for (const s of SURFACES) {
    const rows = universe.slice(0, s.limit);
    const top1 = share(rows, 1), top2 = share(rows, 2), top5 = share(rows, 5);
    console.log(`      ${s.name}: top1 ${(top1 * 100).toFixed(1)}%  top2 ${(top2 * 100).toFixed(1)}%  top5 ${(top5 * 100).toFixed(1)}%`);
    // ⚠️ THE THRESHOLD THAT WOULD HAVE CAUGHT THIS. The broken board was 87% in two tiles; a healthy
    // cap-weighted board of this size is around 19%. 35% leaves generous room for a genuine
    // megacap run-up while failing loudly on anything resembling a two-stock display.
    ok(`⚠️ ${s.name} — top 2 hold under 35% of area`, top2 < 0.35,
      `${(top2 * 100).toFixed(1)}%`);
    ok(`   ${s.name} — the largest single tile is under 20%`, top1 < 0.20,
      `${(top1 * 100).toFixed(1)}%`);
    ok(`   ${s.name} — the top 5 do not hold the whole board`, top5 < 0.60,
      `${(top5 * 100).toFixed(1)}%`);
  }
}

L('⚠️ 4 — the board is diversified across sectors');
{
  const rows = universe.slice(0, 120);
  const bySector = new Map();
  for (const r of rows) {
    const k = r.sector || '(unclassified)';
    bySector.set(k, (bySector.get(k) || 0) + (r.marketCap || 0));
  }
  const sum = rows.reduce((a, r) => a + (r.marketCap || 0), 0);
  const ranked = [...bySector.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`      sectors: ${ranked.map(([k, v]) => `${k} ${((v / sum) * 100).toFixed(0)}%`).join(', ')}`);
  ok('⚠️ at least 8 sectors are represented', bySector.size >= 8, `${bySector.size}`);
  // The old board was 87.6% "Financial Services" purely because Berkshire was all that was left.
  ok('⚠️ no single sector holds more than 60% of area', (ranked[0][1] / sum) < 0.60,
    `${ranked[0][0]} ${((ranked[0][1] / sum) * 100).toFixed(1)}%`);
  ok('…and unclassified names are a minority, not the board',
    ((bySector.get('(unclassified)') || 0) / sum) < 0.15);
}

L('⚠️ 5 — capitalisations are plausible, and derived ones are marked');
{
  // Not a check against a reference price — a check that the SCALE is sane. A unit error or a
  // double-counted share class shows up here as an order of magnitude, which is what to catch.
  const biggest = universe[0];
  ok(`⚠️ the largest capitalisation is in trillions, not quadrillions (${(biggest.marketCap / 1e12).toFixed(2)}T)`,
    biggest.marketCap > 5e11 && biggest.marketCap < 2e13, String(biggest.marketCap));
  ok('⚠️ nothing on the board exceeds $15T',
    universe.every((r) => (r.marketCap || 0) < 1.5e13),
    universe.filter((r) => (r.marketCap || 0) >= 1.5e13).map((r) => r.ticker).join(', '));
  ok('⚠️ every row has a positive capitalisation — none is zero or negative',
    universe.every((r) => (r.marketCap || 0) > 0));
  // ⚠️ AND NO CAP IS DERIVED FROM price x shares. That looked like free coverage and produced
  // LATAM Airlines at $25.48T, TSMC at $8.26T and Toyota at $2.70T — all ADRs, where shares_out is
  // the foreign company's ordinary share count and price is the ADR price, a ratio apart. This
  // assertion is what caught it, and it is what stops the idea coming back.
  ok('⚠️ no capitalisation is a price x shares derivation of an ADR',
    !/price \* coalesce\(s\.shares_out/.test(
      (await import('node:fs')).readFileSync('src/lib/heatmap/heatmap-store.js', 'utf8')),
    'a derived cap multiplies ADR price by ordinary shares and is a unit error');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
