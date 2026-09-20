import { sql, and, eq, gte, gt, inArray, desc, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { insiderTrades, congressTrades, fundHoldings, fundFilings } from './schema';
import { quartersAndSummaryState, readFundQoq } from './fund-qoq';

// Confluence engine — cross-references the three "smart money" datasets we already own (insiders,
// Congress, 13F) to find tickers where multiple signals STACK the same direction. dir='bull'
// (accumulation) or 'bear' (distribution). Computed on demand; the API caches the result.
//
// Sub-scores are rough-but-monotonic for v1 — ranking matters more than absolute values; tune later.
const WINDOW_DAYS = 90;

// The board is IDENTICAL for every viewer: only how much of it a tier may see differs, and the
// route slices that after the fact. So the expensive part is computed once per direction and held
// briefly, instead of re-running a two-quarter 13F roll-up on every request. The response itself
// stays no-store, because what a given user is allowed to see is not cacheable.
//
// The inputs move on cron cadences (insider ingest, congress sync, 13F backfill), so a few minutes
// of staleness costs nothing and the page stops timing out under load.
const BOARD_TTL_MS = 10 * 60 * 1000;
const _boardCache = new Map();   // dir -> { at, value }
const _inFlight = new Map();     // dir -> Promise

export async function computeConfluence(dir = 'bull') {
  const hit = _boardCache.get(dir);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.value;

  // ONE COMPUTATION PER DIRECTION AT A TIME. The board is the same for every viewer, so when the
  // cache lapses there is no reason for ten simultaneous visitors to run ten identical roll-ups —
  // they queue behind the first. That mattered enormously on the old path, where each of those was
  // an eight-second scan holding a database connection, and it is cheap insurance now.
  const pending = _inFlight.get(dir);
  if (pending) return pending;

  const run = (async () => {
    try {
      const value = await computeConfluenceUncached(dir);
      _boardCache.set(dir, { at: Date.now(), value });
      return value;
    } finally {
      _inFlight.delete(dir);
    }
  })();
  _inFlight.set(dir, run);
  return run;
}

/**
 * The original inline roll-up, kept as the fallback for when the summary is not there yet.
 *
 * This is the expensive path — 3.09M rows, ~8 seconds — and it is deliberately still the SAME
 * arithmetic, so a board computed this way and a board read from `fund_qoq` are indistinguishable.
 * It runs when the summary has no row for the current quarter, which is a startup and ingest
 * condition, not a steady state.
 */
async function rollupFundQoqLive(q0, prev) {
  console.log(`[confluence] fund_qoq miss for ${q0} — falling back to the live roll-up`);
  const res = await db.execute(sql`
    with per_fund as (
      select ticker, cik,
             sum(case when quarter = ${q0} then shares else 0 end) cur,
             sum(case when quarter = ${prev} then shares else 0 end) prev
        from fund_holdings
       where quarter in (${q0}, ${prev})
         and ticker is not null and put_call = ''
       group by ticker, cik
    )
    select ticker,
           count(*) filter (where cur > prev)::int acc,
           count(*) filter (where cur < prev)::int red
      from per_fund group by ticker`);
  const map = new Map();
  for (const r of (res.rows ?? res)) map.set(r.ticker, { acc: Number(r.acc) || 0, red: Number(r.red) || 0 });
  return map;
}

async function computeConfluenceUncached(dir = 'bull', { forceLiveRollup = false } = {}) {
  const bull = dir !== 'bear';
  const action = bull ? 'BUY' : 'SELL';
  const since = sql`current_date - make_interval(days => ${WINDOW_DAYS})`;

  // ── 1) Insiders (Form 4) — open-market buys/sells in the window ──
  const insRowsP = db.select({
    ticker: insiderTrades.ticker,
    val: sql`coalesce(sum(${insiderTrades.totalValue}), 0)`.mapWith(Number),
    execs: sql`count(distinct ${insiderTrades.executive})`.mapWith(Number),
  }).from(insiderTrades)
    .where(and(eq(insiderTrades.action, action), gt(insiderTrades.totalValue, 0), gte(insiderTrades.transactionDate, since)))
    .groupBy(insiderTrades.ticker);

  // ── 2) Congress (STOCK Act) — purchases/sales DISCLOSED in the window ──
  //
  // ⚠️ THE WINDOW IS ON THE DISCLOSURE DATE, NOT THE TRANSACTION DATE, and the difference is not
  // cosmetic. A member of Congress may trade today and disclose it up to 45 days later; measured on
  // our own data the median lag is 28 days, the 90th percentile is 116, and 17.6% of trades are
  // disclosed MORE than 90 days after they happened.
  //
  // Windowing on `transaction_date` therefore did two wrong things at once. It dated the evidence to
  // a day nobody outside Congress could have known it — point-in-time nonsense — and, worse, it
  // STRUCTURALLY EXCLUDED every trade whose disclosure lag exceeded the window: those became public
  // and Pit Consensus never saw them at all. Measured at the time of this fix: 597 of the 911 buy
  // disclosures inside the window (65.5%), across 401 tickers and $12.4M, were invisible.
  //
  // THE FIX IS STRICTLY ADDITIVE, and provably so: disclosure_date >= transaction_date always, so
  // any row the old window admitted the new one admits too. Measured: 300 tickers gained, 0 lost.
  //
  // `disclosure_date` is NOT NULL in the schema and verified to have no nulls in the data, so there
  // is no fallback path here — and deliberately none is written. Falling back to a transaction date
  // would reintroduce the exact defect. The transaction date is preserved on the row and remains
  // available for display and context.
  const conRowsP = db.select({
    ticker: congressTrades.ticker,
    val: sql`coalesce(sum(${congressTrades.amountMid}), 0)`.mapWith(Number),
    members: sql`count(distinct ${congressTrades.memberSlug})`.mapWith(Number),
  }).from(congressTrades)
    .where(and(eq(congressTrades.action, action), isNotNull(congressTrades.ticker), gte(congressTrades.disclosureDate, since)))
    .groupBy(congressTrades.ticker);

  // ── The two cheap aggregations and the quarter lookup have nothing to say to each other, so they
  // go together. Measured: 102 ms, 47 ms and 51 ms sequentially; ~100 ms as one wave. ──
  const [insRows, conRows, qState] = await Promise.all([insRowsP, conRowsP, quartersAndSummaryState()]);
  const ins = new Map(insRows.map((r) => [r.ticker, r]));
  const con = new Map(conRows.map((r) => [r.ticker, r]));

  // ── 3) Institutions (13F) — quarter-over-quarter accumulation/reduction ──
  //
  // PRECOMPUTED AT INGEST, not here. Deriving this inline scanned 3.09M holding rows, hash-aggregated
  // 1.74M (ticker, cik) pairs, spilled ~145 MB to disk and took ~8 seconds — on every cold request,
  // from the homepage teaser and every ticker-page badge as well as this board. `fund_qoq` holds the
  // identical numbers (verified across all 14,474 tickers) and is read off an index.
  //
  // ONLY THE TICKERS THAT COULD MATTER. Two aligned signals are required, so a ticker no insider and
  // no member of Congress touched cannot reach the board whatever the funds did — asking for those
  // rows would be transfer for nothing.
  const { q0, q1, built } = qState;
  const candidates = [...new Set([...ins.keys(), ...con.keys()])].filter(Boolean);
  let fund = new Map(); // ticker -> { acc, red }
  if (q0) {
    const pre = (built && !forceLiveRollup) ? await readFundQoq(q0, candidates) : null;
    // A MISSING SUMMARY IS A SLOW BOARD, NEVER A WRONG ONE. Immediately after a deploy, mid-ingest,
    // or the day a new quarter first appears, there is nothing to read — so the old inline roll-up
    // is still here, and still correct. It just stops being what visitors normally hit.
    fund = pre ?? await rollupFundQoqLive(q0, q1 ?? q0);
  }

  // ── Merge + score ──
  const tickers = new Set([...ins.keys(), ...con.keys(), ...fund.keys()].filter(Boolean));
  const clamp = (n) => Math.max(0, Math.min(100, n));
  const list = [];
  for (const t of tickers) {
    const i = ins.get(t); const c = con.get(t); const f = fund.get(t);
    const insVal = i?.val || 0, execs = i?.execs || 0;
    const conVal = c?.val || 0, members = c?.members || 0;
    const netFunds = bull ? ((f?.acc || 0) - (f?.red || 0)) : ((f?.red || 0) - (f?.acc || 0));

    const insActive = execs >= 1 && insVal > 0;
    const conActive = members >= 1 && conVal > 0;
    const fundActive = netFunds > 0;
    const signals = (insActive ? 1 : 0) + (conActive ? 1 : 0) + (fundActive ? 1 : 0);
    if (signals < 2) continue;   // confluence = at least two aligned signals

    // ⚠️ DEPRECATED SCORE, RETAINED FOR COMPATIBILITY ONLY.
    //
    // screener_stocks.consensus_score is written from this and is still indexed, so removing the
    // field outright would break that write path and any stored history. It is no longer displayed
    // anywhere: not on the board, not in the screener, not on the ticker page.
    //
    // It should not be trusted. execs*20, value/250k*20, members*25, netFunds*18 and a 1.6/2.4
    // multiplier are arbitrary constants that were never validated, and averaging three of them
    // produces a number whose units are meaningless. Delete it once nothing reads the column.
    const insScore = clamp(execs * 20 + Math.min(60, (insVal / 250000) * 20));
    const conScore = clamp(members * 25 + Math.min(50, (conVal / 100000) * 20));
    const fundScore = clamp(netFunds * 18);
    const mult = signals === 3 ? 2.4 : 1.6;
    const score = Math.round(((insScore + conScore + fundScore) / 3) * mult);

    list.push({
      ticker: t, score, signals,
      insider: insActive ? { val: insVal, execs } : null,
      congress: conActive ? { val: conVal, members } : null,
      fund: fundActive ? { net: netFunds, acc: f?.acc || 0, red: f?.red || 0 } : null,
    });
  }
  // ORDERED BY FACTS, NOT BY THE DEPRECATED SCORE.
  //
  // How many independent families align is the thing the board is actually about, so it leads. Ties
  // break on insider dollars then congressional dollars — measured quantities in known units, so a
  // reader can see why one row sits above another. Ranking by the blended score meant the ordering
  // inherited every arbitrary constant in it.
  list.sort((a, b) => (b.signals - a.signals)
    || ((b.insider?.val || 0) - (a.insider?.val || 0))
    || ((b.congress?.val || 0) - (a.congress?.val || 0))
    || ((b.fund?.net || 0) - (a.fund?.net || 0)));
  return list.slice(0, 60);
}

// Exposed so the regression suite can run the board BOTH ways against the same data and assert the
// precomputed summary and the live roll-up produce an identical board. Nothing in the app calls it.
export const __internals = { computeConfluenceUncached };
