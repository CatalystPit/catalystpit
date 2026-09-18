// PIT CONSENSUS: the architecture, not the clock.
//
// The board once derived its institutional leg inline — 3.09M holding rows, 1.74M hash groups,
// ~145 MB spilled to disk, about eight seconds — on every cold request, from the homepage teaser and
// every ticker-page badge as well as /consensus. It is now precomputed at ingest and read off an
// index.
//
// This suite guards the SHAPE of that, because that is what silently regresses: someone removes the
// summary read, or drops the `built` check, or awaits the three aggregations one after another, and
// nothing fails — the page just gets slow again. So the assertions are about which statements run,
// how many, in what order, and whether they overlap. No millisecond thresholds: those are flaky in
// CI and they do not describe the property that matters.
//
// Run: node --import ./scripts/verify-confluence-register.mjs scripts/verify-confluence.mjs

import { reset, __state } from './verify-confluence-db.mjs';
import { __internals } from '../src/lib/confluence.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const kinds = () => __state.calls.map((c) => c.kind);
const countOf = (k) => kinds().filter((x) => x === k).length;

// A universe where AAPL has all three signals, MSFT has insider+fund, NVDA has congress+fund,
// and ZZZZ has ONLY a fund signal — which must never be enough to reach the board.
const DATA = {
  insider: [
    { ticker: 'AAPL', val: 2_000_000, execs: 3 },
    { ticker: 'MSFT', val: 1_000_000, execs: 2 },
  ],
  congress: [
    { ticker: 'AAPL', val: 400_000, members: 2 },
    { ticker: 'NVDA', val: 250_000, members: 3 },
  ],
  summary: [
    { ticker: 'AAPL', acc: 9, red: 1 },
    { ticker: 'MSFT', acc: 6, red: 2 },
    { ticker: 'NVDA', acc: 4, red: 1 },
    { ticker: 'ZZZZ', acc: 40, red: 0 },
  ],
};
// The live roll-up returns the same numbers — that is the invariant the precomputation rests on.
DATA.holdings = DATA.summary;

console.log('\n=== the expensive roll-up does not run on a request ===');
{
  reset(DATA);
  const board = await __internals.computeConfluenceUncached('bull');
  ok('the board is produced', Array.isArray(board) && board.length > 0, JSON.stringify(kinds()));
  // THE LOAD-BEARING ASSERTION of this whole file.
  ok('the 3M-row roll-up is NOT executed', countOf('live_rollup') === 0, kinds().join(', '));
  ok('the precomputed summary IS read', countOf('fund_qoq_read') === 1, kinds().join(', '));
  ok('nothing writes to fund_qoq on a read path', countOf('fund_qoq_refresh') === 0);
}

console.log('\n=== a bounded number of queries, whatever the data ===');
{
  reset(DATA);
  await __internals.computeConfluenceUncached('bull');
  // insider + congress + quarters/state + summary read. If this climbs, something is fetching
  // per-ticker — the N+1 shape this architecture exists to avoid.
  ok('exactly four statements', __state.calls.length === 4, kinds().join(', '));

  // Ten times the tickers must not mean more queries.
  const big = {
    ...DATA,
    insider: Array.from({ length: 400 }, (_, i) => ({ ticker: `T${i}`, val: 500_000, execs: 2 })),
    congress: Array.from({ length: 400 }, (_, i) => ({ ticker: `T${i}`, val: 200_000, members: 2 })),
    summary: Array.from({ length: 400 }, (_, i) => ({ ticker: `T${i}`, acc: 5, red: 1 })),
  };
  big.holdings = big.summary;
  reset(big);
  await __internals.computeConfluenceUncached('bull');
  ok('still four statements with 400 tickers — no N+1', __state.calls.length === 4, String(__state.calls.length));
}

console.log('\n=== independent work overlaps ===');
{
  reset({ ...DATA, delayMs: 60 });
  const t0 = Date.now();
  await __internals.computeConfluenceUncached('bull');
  const elapsed = Date.now() - t0;
  // Three statements have no dependency on each other and must be issued together; the summary read
  // genuinely depends on them, so the honest expectation is TWO waves, not four.
  //
  // Asserted as a relationship between the double's own delay and the elapsed time, not as an
  // absolute duration — so it means the same thing on a slow CI box as on a fast laptop.
  ok('the three independent queries run as one wave, not three',
    elapsed < __state.delayMs * 3.5, `${elapsed}ms with a ${__state.delayMs}ms per-query delay`);

  const first = __state.calls.filter((c) => c.kind !== 'fund_qoq_read');
  const startSpread = Math.max(...first.map((c) => c.startedAt)) - Math.min(...first.map((c) => c.startedAt));
  ok('they start together rather than in sequence', startSpread < __state.delayMs, `${startSpread}ms apart`);
  const read = __state.calls.find((c) => c.kind === 'fund_qoq_read');
  ok('the summary read waits for them, because it needs their tickers',
    read.startedAt >= Math.max(...first.map((c) => c.endedAt)));
}

console.log('\n=== a missing summary is slow, never wrong or empty ===');
{
  reset({ ...DATA, built: false });
  const board = await __internals.computeConfluenceUncached('bull');
  ok('the live roll-up is used as the fallback', countOf('live_rollup') === 1, kinds().join(', '));
  ok('the summary is not read when it does not exist', countOf('fund_qoq_read') === 0);
  ok('and the board still has rows', board.length > 0, JSON.stringify(board.map((r) => r.ticker)));

  // The property that makes precomputation safe: both paths agree.
  reset(DATA);
  const fast = await __internals.computeConfluenceUncached('bull');
  reset({ ...DATA, built: false });
  const slow = await __internals.computeConfluenceUncached('bull');
  ok('precomputed and live boards are identical', JSON.stringify(fast) === JSON.stringify(slow),
    `\n    fast=${JSON.stringify(fast.map((r) => `${r.ticker}:${r.score}`))}\n    slow=${JSON.stringify(slow.map((r) => `${r.ticker}:${r.score}`))}`);
}

console.log('\n=== the methodology itself is unchanged ===');
{
  reset(DATA);
  const board = await __internals.computeConfluenceUncached('bull');
  const by = new Map(board.map((r) => [r.ticker, r]));

  ok('three aligned signals makes the board', by.get('AAPL')?.signals === 3);
  ok('two aligned signals makes the board', by.get('MSFT')?.signals === 2 && by.get('NVDA')?.signals === 2);
  // A fund-only name is why the summary read can be restricted to insider/congress tickers at all.
  ok('a fund-only name NEVER makes the board', !by.has('ZZZZ'), JSON.stringify([...by.keys()]));
  ok('three signals outrank two', by.get('AAPL').score > by.get('MSFT').score,
    `${by.get('AAPL')?.score} vs ${by.get('MSFT')?.score}`);

  // SORTING, tested with a fixture whose natural insertion order is the WRONG order. The merge walks
  // insider tickers first, so putting the weakest name there means an unsorted board would surface
  // it at the top — which a fixture that happens to arrive pre-sorted could never detect.
  reset({
    insider: [{ ticker: 'WEAK', val: 1, execs: 1 }, { ticker: 'STRONG', val: 9_000_000, execs: 9 }],
    congress: [{ ticker: 'WEAK', val: 1, members: 1 }, { ticker: 'STRONG', val: 9_000_000, members: 9 }],
    summary: [], holdings: [],
  });
  const sorted = await __internals.computeConfluenceUncached('bull');
  ok('the board is sorted by score, strongest first',
    sorted[0].ticker === 'STRONG' && sorted.every((r, i) => i === 0 || sorted[i - 1].score >= r.score),
    JSON.stringify(sorted.map((r) => `${r.ticker}:${r.score}`)));

  // THE CAP, tested with more than 60 qualifying names — the previous fixture had four.
  const many = {
    insider: Array.from({ length: 90 }, (_, i) => ({ ticker: `Q${i}`, val: 500_000 + i, execs: 2 })),
    congress: Array.from({ length: 90 }, (_, i) => ({ ticker: `Q${i}`, val: 200_000 + i, members: 2 })),
    summary: [], holdings: [],
  };
  reset(many);
  const capped = await __internals.computeConfluenceUncached('bull');
  ok('90 qualifying names are capped to 60', capped.length === 60, String(capped.length));

  // Direction flips which side of the fund comparison counts, and nothing else.
  reset({ ...DATA, summary: [{ ticker: 'AAPL', acc: 1, red: 9 }], holdings: [{ ticker: 'AAPL', acc: 1, red: 9 }] });
  const bear = await __internals.computeConfluenceUncached('bear');
  reset({ ...DATA, summary: [{ ticker: 'AAPL', acc: 1, red: 9 }], holdings: [{ ticker: 'AAPL', acc: 1, red: 9 }] });
  const bull = await __internals.computeConfluenceUncached('bull');
  ok('net reduction counts for the distribution board, not accumulation',
    (bear.find((r) => r.ticker === 'AAPL')?.fund?.net ?? 0) === 8
    && bull.find((r) => r.ticker === 'AAPL')?.fund == null);
}

console.log('\n=== only the tickers that could matter are fetched ===');
{
  reset(DATA);
  await __internals.computeConfluenceUncached('bull');
  ok('the summary read happens once, for a bounded ticker set', countOf('fund_qoq_read') === 1);

  // The summary is keyed (quarter, ticker). A read that forgot to bind the quarter would return the
  // PREVIOUS quarter's counts alongside this one's and silently double them.
  const read = __state.calls.find((c) => c.kind === 'fund_qoq_read');
  ok('the summary read is scoped to a quarter', /where\s+quarter\s*=/.test(read?.text || ''), read?.text || '(no text)');
  ok('and to a ticker list', /ticker\s*=\s*any/.test(read?.text || ''), read?.text || '(no text)');

  // With no insider and no congress activity there is nothing the funds could complete, so there is
  // nothing to ask for at all.
  reset({ ...DATA, insider: [], congress: [] });
  const board = await __internals.computeConfluenceUncached('bull');
  ok('no candidates means no summary query', countOf('fund_qoq_read') === 0, kinds().join(', '));
  ok('and an empty board, not a fund-only one', board.length === 0, JSON.stringify(board));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
