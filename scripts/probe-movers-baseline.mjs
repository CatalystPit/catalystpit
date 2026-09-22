// WHAT ARE TOP GAINERS/LOSERS ACTUALLY RANKING? An investigation, not a test.
//
//   TIINGO_REALTIME_ENABLED=true node --env-file=.env.local \
//     --experimental-loader ./scripts/ext-resolve-loader.mjs scripts/probe-movers-baseline.mjs
//
// Prints, per control symbol: the live Tiingo price and its timestamp, the previous official close
// and ITS DATE from stored candles, the day % those two imply, and what the board actually put on
// the tile — then the Top 10 lists with the baseline date each row was measured from.

process.env.CP_HEATMAP_KV_NAMESPACE = process.env.CP_HEATMAP_KV_NAMESPACE || 'probe';

const L = (s = '') => console.log(s);
const { heatmapBoard } = await import('../src/lib/heatmap/heatmap-store.js');
const { topMovers } = await import('../src/lib/heatmap/heatmap-universe.mjs');
const { kvNamespace } = await import('../src/lib/heatmap/heatmap-realtime.mjs');
if (!kvNamespace()) { console.error('not namespaced — refusing'); process.exit(2); }

const CONTROLS = ['SHOP', 'MPWR', 'ALAB', 'SNDK', 'TWLO', 'NVDA', 'AAPL', 'SPY'];

const board = await heatmapBoard({ timeframe: '1D', limit: 500, realtime: true });
L(`board asOf=${board.asOf}  baselineDate=${board.baselineDate}  snapshotAt=${board.snapshotAt}`);
L(`session: ${JSON.stringify(board.session)}`);
const liveRows = board.rows.filter((r) => r.live).length;
L(`rows=${board.rows.length}  live=${liveRows}  notLive=${board.rows.length - liveRows}`);

// The vendor's own current print, fetched directly so the comparison does not go through the board.
const KEY = process.env.TIINGO_API_KEY;
const H = { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' };
const onBoard = CONTROLS.filter((s) => board.rows.some((r) => r.ticker === s));
const res = await fetch(`https://api.tiingo.com/iex/?tickers=${onBoard.join(',')}`, { headers: H });
const vendor = new Map((res.ok ? await res.json() : []).map((q) => [String(q.ticker).toUpperCase(), q]));

L('\n=== CONTROL SYMBOLS ===');
L(`${'TICKER'.padEnd(7)}${'CUR PRICE'.padStart(11)}${'PREV CLOSE'.padStart(12)} ${'BASE DATE'.padEnd(11)}${'CALC %'.padStart(9)}${'BOARD %'.padStart(9)}  ${'LIVE'.padEnd(6)}QUOTE TS`);
for (const s of CONTROLS) {
  const row = board.rows.find((r) => r.ticker === s);
  if (!row) { L(`${s.padEnd(7)}  — not in the Top 500 universe —`); continue; }
  const q = vendor.get(s);
  // The vendor's prevClose is the immediately preceding official close, independent of our tables.
  const prev = q?.prevClose ?? null;
  const cur = row.price;
  const calc = prev && cur != null ? ((cur - prev) / prev) * 100 : null;
  L(`${s.padEnd(7)}${String(cur ?? '—').padStart(11)}${String(prev ?? '—').padStart(12)} ${String(row.baselineDate ?? '—').padEnd(11)}`
    + `${(calc?.toFixed(3) ?? '—').padStart(9)}${(row.pct?.toFixed(3) ?? '—').padStart(9)}  ${String(!!row.live).padEnd(6)}${q?.timestamp ?? '—'}`);
}

const show = (title, list) => {
  L(`\n=== ${title} ===`);
  L(`${'#'.padStart(3)} ${'TICKER'.padEnd(7)}${'PCT'.padStart(9)}  ${'LIVE'.padEnd(6)}${'BASE DATE'.padEnd(12)}${'PRICE'.padStart(10)}`);
  list.forEach((r, i) => L(`${String(i + 1).padStart(3)} ${r.ticker.padEnd(7)}${r.pct.toFixed(2).padStart(9)}  ${String(!!r.live).padEnd(6)}${String(r.baselineDate).padEnd(12)}${String(r.price).padStart(10)}`));
};
show('TOP 10 GAINERS (as production ranks them today)', topMovers(board.rows, { direction: 'up', limit: 10 }));
show('TOP 10 LOSERS (as production ranks them today)', topMovers(board.rows, { direction: 'down', limit: 10 }));

// ⚠️ THE DIAGNOSIS. If the leaders are measured from a different session than the board's live
// rows, the list is ranking two different periods against each other.
const baselines = new Map();
for (const r of board.rows) if (r.pct != null) baselines.set(r.baselineDate, (baselines.get(r.baselineDate) || 0) + 1);
L('\n=== BASELINE DATES PRESENT IN ONE RANKING ===');
for (const [d, n] of [...baselines].sort()) L(`  ${d}: ${n} rows`);

const g = topMovers(board.rows, { direction: 'up', limit: 10 });
const mixed = new Set(g.map((r) => r.baselineDate));
L(`\ngainers measured from ${mixed.size} different baseline date(s): ${[...mixed].join(', ')}`);
L(`gainers that are NOT live: ${g.filter((r) => !r.live).map((r) => r.ticker).join(', ') || 'none'}`);
