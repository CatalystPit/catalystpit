// READING THE HEATMAP — FOUR BOUNDED QUERIES, WHATEVER THE BOARD SIZE.
//
// The naive version of this page asks each ticker for its history and computes a return: 300 tickers
// is 300 round trips, and this codebase has already paid for that mistake twice (the 13F roll-up at
// 8.2s and symbol search at 11.6s). It is not repeated here.
//
// Instead, per request:
//   1. the universe — reference data (market cap, sector, name), ONE indexed read
//   2. the latest session close + volume per ticker, ONE `distinct on`
//   3. the baseline session close per ticker at or before the window's anchor, ONE `distinct on`
//   4. price-continuity verdicts for the universe, ONE read
//
// Four queries, each bounded by the universe size, none scanning the 2.8M-row candle table whole:
// `distinct on (ticker) … order by ticker, date desc` walks the (ticker, date) primary key backwards
// and stops at the first row per ticker.
//
// REFERENCE DATA STAYS SEPARATE FROM PRICE. Market cap and sector come from the screener tables and
// are static between nightly refreshes; only the two close reads are dynamic. That is what makes the
// live migration a change to step 2 alone — nothing about tile sizing recomputes on a tick.

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { anchorDateFor, pctReturn, asDay, NO_RETURN, MAX_BASELINE_GAP_DAYS } from './heatmap-window.mjs';
import { TRADEABLE_ASSET_TYPES } from './heatmap-universe.mjs';
import { returnBlocked } from '../price-continuity.mjs';

/** The most recent session anywhere in our candle history — the board's `asOf`. */
export async function latestSessionDate() {
  const res = await db.execute(sql`select max(date)::text as d from ticker_daily_candles`);
  return (res.rows ?? res)[0]?.d ?? null;
}

/**
 * The universe: the largest securities we cover, with the reference data a tile needs.
 *
 * Company name comes from the security master via coalesce, so funds and ETFs carry a name here for
 * the same reason they do on the Dividend Calendar — screener_stocks.company is filings-derived and
 * null for anything that files neither a Form 4 nor an 8-K.
 */
export async function heatmapUniverse(limit = 500) {
  const lim = Math.max(10, Math.min(6000, Number(limit) || 500));
  // ASSET TYPE IS THE ELIGIBILITY RULE, and it is existing reference data rather than a maintained
  // exclusion list — see TRADEABLE_ASSET_TYPES for why funds, warrants and units are not operating
  // companies. `market_cap > 0` does the rest: every mutual-fund share class carries none.
  const types = sql`${`{${TRADEABLE_ASSET_TYPES.join(',')}}`}::text[]`;
  const res = await db.execute(sql`
    select s.ticker,
           coalesce(s.company, i.name) as company,
           coalesce(s.sector, m.sector) as sector,
           coalesce(s.market_cap, m.market_cap) as market_cap
      from screener_stocks s
      left join screener_meta     m on m.ticker = s.ticker
      left join security_identity i on i.ticker = s.ticker
     where coalesce(s.market_cap, m.market_cap) > 0
       and coalesce(m.asset_type, '') = any(${types})
     order by coalesce(s.market_cap, m.market_cap) desc
     limit ${lim}`);
  return (res.rows ?? res).map((r) => ({
    ticker: String(r.ticker),
    company: r.company || null,
    sector: r.sector || null,
    marketCap: Number(r.market_cap) || null,
  }));
}

/** A Postgres text[] literal for a ticker list — the driver will not interpolate a JS array here. */
const tickerArray = (tickers) =>
  sql`${`{${tickers.map((t) => `"${String(t).replace(/["\\]/g, '')}"`).join(',')}}`}::text[]`;

/**
 * The latest session at or before `onOrBefore` for each ticker, in one statement.
 *
 * `strictlyBefore` shifts the comparison to `<`, which is how 1D asks for "the session before the
 * latest one" without needing to know the trading calendar: across a weekend that lands on Friday,
 * across a holiday weekend on the Thursday, because the data carries the calendar.
 */
async function sessionPerTicker(tickers, onOrBefore, { strictlyBefore = false, floorDays = MAX_BASELINE_GAP_DAYS } = {}) {
  if (!tickers.length || !asDay(onOrBefore)) return new Map();
  const arr = tickerArray(tickers);
  const bound = strictlyBefore
    ? sql`date < ${onOrBefore}::date`
    : sql`date <= ${onOrBefore}::date`;
  // A LOWER BOUND ON THE SCAN, which is both the correctness rule and the performance win: a
  // baseline more than MAX_BASELINE_GAP_DAYS before its anchor is not the window it claims to be.
  // Without it, `distinct on` walks each ticker's history back through years of bars; with it the
  // whole eligible universe costs 317ms instead of 1,650ms.
  // The ::integer cast is load-bearing: an untyped parameter here makes Postgres resolve
  // `date - $n` as date-minus-date, which yields an integer and fails with
  // "operator does not exist: date >= integer".
  const floor = sql`date >= ${onOrBefore}::date - ${floorDays}::integer`;
  const res = await db.execute(sql`
    select distinct on (ticker) ticker, date::text as date, close, volume
      from ticker_daily_candles
     where ticker = any(${arr}) and ${bound} and ${floor}
     order by ticker, date desc`);
  const out = new Map();
  for (const r of (res.rows ?? res)) {
    out.set(String(r.ticker), { date: r.date, close: Number(r.close), volume: Number(r.volume) });
  }
  return out;
}

/**
 * Every security's close and volume ON the latest session, in one statement.
 *
 * `date = asOf` rather than `distinct on … date <= asOf`, which is SIX TIMES faster across the
 * eligible universe (337ms against 2,033ms) because it reads one date's rows instead of walking
 * every ticker's history backwards.
 *
 * It is also the more honest question. A security with no print on the latest session has no current
 * price, and the previous version would have handed back a stale close to be displayed as today's —
 * the exact failure the heatmap audit recorded. Those rows now arrive with no price and are reported
 * as unmeasurable rather than shown with an old one.
 */
async function latestSession(tickers, asOfDay) {
  if (!tickers.length || !asDay(asOfDay)) return new Map();
  const res = await db.execute(sql`
    select ticker, date::text as date, close, volume
      from ticker_daily_candles
     where date = ${asOfDay}::date and ticker = any(${tickerArray(tickers)})`);
  const out = new Map();
  for (const r of (res.rows ?? res)) {
    out.set(String(r.ticker), { date: r.date, close: Number(r.close), volume: Number(r.volume) });
  }
  return out;
}

/** Continuity verdicts, so a return spanning a reused symbol or an unadjusted split is withheld. */
async function qualityFor(tickers) {
  if (!tickers.length) return new Map();
  const res = await db.execute(sql`
    select ticker, usable, reason, last_break::text as last_break
      from ticker_price_quality where ticker = any(${tickerArray(tickers)})`);
  const out = new Map();
  for (const r of (res.rows ?? res)) {
    out.set(String(r.ticker), { usable: r.usable, reason: r.reason, lastBreak: r.last_break });
  }
  return out;
}

/**
 * The whole board for one timeframe.
 *
 * Returns { asOf, baselineDate, rows: [{ ticker, company, sector, marketCap, price, pct, volume,
 * latestDate, baselineDate, reason }] }. A row whose return could not be measured keeps its tile —
 * sized by market cap, coloured as unknown — with a `reason`, rather than dropping out of the board
 * and silently changing what the market looks like.
 */
/**
 * THE INTRADAY NUMERATOR, FOR 1D AND FOR AN ENTITLED READER ONLY.
 *
 * ⚠️ IT REPLACES ONE NUMBER AND NOTHING ELSE. The universe, the sector classification, the tile
 * sizing, the market-cap methodology, the baseline session and the quality gates are all untouched
 * — the board already computes (latest − baseline) / baseline, and this changes only what "latest"
 * means for the one window where an intraday price is the honest answer.
 *
 * ⚠️ 1D ONLY, DELIBERATELY. A live price against a 1Y baseline is still a legitimate return, but
 * it would silently re-measure a window the reader believes is built from completed sessions, and
 * the other windows have no intraday question to answer. They keep the close.
 *
 * ⚠️ AND NEVER VOLUME. Most Active stays on completed-session volume because the only intraday
 * volume this entitlement carries is one venue's — 0.17%–0.40% of the tape. A realtime price and a
 * completed-session volume side by side is honest; relabelling that volume would not be.
 *
 * ⚠️ AND ONLY WHILE THE REGULAR SESSION IS OPEN — see the lifecycle note below.
 *
 * @returns { prices: Map<ticker,{price,asOf}>, session } — `prices` is empty whenever the board
 *          should render from completed sessions; `session` describes why.
 */
async function intradayPrices(tickers, { realtime = false, timeframe = '1D', limit = 0, asOf = null, now = Date.now() } = {}) {
  const none = (session = null) => ({ prices: new Map(), session });
  if (timeframe !== '1D' || !tickers.length) return none();

  // ── THE SESSION LIFECYCLE ──────────────────────────────────────────────────
  //
  // ⚠️ THE SNAPSHOT EXISTS ONLY BETWEEN THE BELLS. 09:30–16:00 ET on a real trading day (13:00 on
  // a scheduled half-day) is the ONLY window in which this function may reach a provider. Outside
  // it — evenings, overnight, weekends, holidays — heatmap traffic must generate zero upstream
  // requests no matter how many people are looking, so every exit below happens BEFORE any batch.
  //
  // The reason is not only cost. A 1D return the reader believes runs close-to-close must not be
  // re-measured by overnight or pre-market movement: a board that drifts at 3am is a different
  // number wearing the same label.
  // `now` is a clock seam, not a feature: it exists so the closed-market, weekend and holiday
  // paths can be exercised against the REAL store, KV and provider rather than only against a
  // simulation of them. No route passes it, and it defaults to the wall clock.
  const { marketPhase } = await import('../market/market-session.mjs');
  const session = marketPhase(now);

  // ⚠️ THE OFFICIAL CLOSE WINS THE MOMENT IT EXISTS, AND A 15:59 QUOTE IS NOT IT. A price captured
  // just before the bell is a trade, not the exchange's settled closing print, and freezing it as
  // "the close" would leave the board permanently disagreeing with every other source by a few
  // cents. So the test is not the clock — it is whether the completed-session data has ARRIVED:
  // once `ticker_daily_candles` carries the session the board belongs to, that row IS the final
  // board and the snapshot is no longer consulted at all.
  const official = Boolean(session.sessionDate && asOf && String(asOf) >= session.sessionDate);
  if (official) return none({ ...session, frozen: false, final: true });

  // ⚠️ THE SESSION STATE IS REPORTED EVEN WITHOUT ENTITLEMENT, because it is a fact about the
  // MARKET rather than about the reader. "The market is closed" is equally true for a Free viewer,
  // and withholding it would leave them reading "End of day" at 2am with no idea whether that is
  // the latest board or a stalled one. Only the PRICES are gated — which is the correct boundary.
  if (!realtime) return none({ ...session, frozen: false, final: false });

  // ⚠️ AND IF THE VENDOR SIDE IS NOT LIVE, DO NOT ASK IT. With the realtime flag off every quote
  // comes back stamped 'eod' by design, so the batch is guaranteed to yield nothing usable —
  // five upstream requests spent to learn what the configuration already knew. Checked here, above
  // the lock, so a non-realtime environment neither pays for the batch nor takes a lock that would
  // stall an environment that IS entitled.
  const { tiingoRealtimeEnabled } = await import('../market/tiingo.mjs');
  if (!tiingoRealtimeEnabled()) return none({ ...session, frozen: false, final: false });

  if (session.phase !== 'regular') {
    // Between the bell and the official close landing, the last intraday snapshot of THAT session
    // is the best board available — frozen, never refreshed, and never called final. Serving it
    // costs one KV read and zero provider requests, which is the whole point.
    try {
      const { readSnapshot } = await import('./heatmap-realtime.mjs');
      const { snap } = await readSnapshot(limit);
      // ⚠️ KEYED TO THE SESSION IT WAS CAPTURED IN. Without this a Saturday viewer would be served
      // Thursday's snapshot labelled as Friday's final board. Age is deliberately NOT the test —
      // a frozen snapshot is supposed to be hours old.
      if (snap && snap.sessionDate && snap.sessionDate === session.sessionDate) {
        const out = new Map();
        for (const [sym, price] of Object.entries(snap.prices || {})) {
          if (Number.isFinite(Number(price))) out.set(sym, { price: Number(price), asOf: snap.calculatedAt });
        }
        if (out.size) return { prices: out, session: { ...session, frozen: true, final: false } };
      }
    } catch { /* fall through to the completed-session board */ }
    return none({ ...session, frozen: false, final: false });
  }

  const out = new Map();
  const useSnapshot = (snap) => {
    for (const [sym, price] of Object.entries(snap.prices || {})) {
      if (Number.isFinite(Number(price))) out.set(sym, { price: Number(price), asOf: snap.calculatedAt });
    }
    return out.size > 0;
  };

  const live = (frozen = false) => ({ prices: out, session: { ...session, frozen, final: false } });

  try {
    const { readSnapshot, writeSnapshot, acquireRebuildLock, snapshotState,
      isSessionSuspended, suspendSession } = await import('./heatmap-realtime.mjs');

    // ⚠️ THE SHARED SNAPSHOT FIRST, AND THIS IS THE WHOLE ECONOMICS OF THE FEATURE. Without it,
    // provider load grows with CONCURRENT VIEWERS rather than with time: every poller would issue
    // its own five upstream requests for a board identical to everyone else's. With it the work
    // happens once per 15-minute snapshot — about 20 Tiingo requests/hour at Top 500, the same
    // number for ten viewers or ten thousand.
    const { snap, state } = await readSnapshot(limit);
    const ofSession = snap && snap.sessionDate === session.sessionDate;
    if (state === 'fresh' && ofSession && useSnapshot(snap)) return live();

    // ⚠️ THE CALENDAR KNOWS THE SCHEDULED CLOSURES AND CANNOT KNOW THE REST. A national day of
    // mourning or a weather closure follows no rule, so the clock will say "regular session" on a
    // day the market never opened. That is detected rather than guessed: if a rebuild comes back
    // with nothing the entitlement gate calls realtime, the session is marked suspended for the
    // remainder of the ET day and every later request exits here. The cost of an unforeseen
    // closure is therefore ONE futile batch per day, not one per rebuild.
    if (await isSessionSuspended(session.etDate)) {
      if (snap && ofSession && useSnapshot(snap)) return live(true);
      return none({ ...session, frozen: false, final: false, suspended: true });
    }

    // ⚠️ ONE REBUILD, NOT ONE PER INSTANCE. When the snapshot expires under load, every serverless
    // instance handling that burst would otherwise launch its own batch. The loser of the lock
    // serves the previous snapshot for a few seconds instead — a slightly older board is a far
    // better answer than a thundering herd against the provider.
    const mine = await acquireRebuildLock(limit);
    if (!mine) {
      // stale is better than nothing while it rebuilds
      if (snap && ofSession && useSnapshot(snap)) return live();
      return live();
    }

    const { getQuotes } = await import('../market-data');
    // ⚠️ getQuotes DOES NOT BATCH — IT TRUNCATES, AND THIS QUIETLY HALVED THE BOARD.
    //
    // It caps its input at 100 symbols (`slice(0, 100)`) and silently discards the rest, which is
    // the right default for a watchlist and wrong for a 500-tile board: measured, a Top 500
    // rebuild made ONE upstream request and returned 100 live prices, so 400 tiles rendered
    // completed-session while the strip said the board was a market snapshot. Nothing failed and
    // nothing logged — the board was simply 20% live.
    //
    // So the chunking happens HERE rather than by widening a shared helper every other caller
    // depends on. Five sequential requests for Top 500, which is exactly the upstream cost this
    // feature is budgeted for, and the entitlement gate still runs inside each call.
    const QUOTE_BATCH = 100;
    const quotes = {};
    for (let i = 0; i < tickers.length; i += QUOTE_BATCH) {
      Object.assign(quotes, await getQuotes(tickers.slice(i, i + QUOTE_BATCH), { realtime: true }));
    }
    // ⚠️ ONE CAPTURE INSTANT FOR THE WHOLE BATCH, NOT EACH QUOTE'S OWN STAMP. The UI shows a single
    // "last updated" time, and per-symbol vendor timestamps would make that time depend on which
    // row happened to sort first — a board captured at one moment must report one moment. This is
    // also the value writeSnapshot records as `calculatedAt`, so a board served from the store and
    // the board that built it describe themselves identically.
    const capturedAt = new Date().toISOString();
    const fresh = {};
    for (const [sym, q] of Object.entries(quotes || {})) {
      // ⚠️ THE SERVER'S OWN STAMP, NOT A GUESS FROM THE NUMBER. A quote is usable here only if the
      // entitlement gate called it realtime; anything else is the settled close wearing a
      // different name, and substituting it would change nothing except the label.
      // ⚠️ `q.price != null` IS NOT REDUNDANT WITH isFinite — Number(null) is 0, AND 0 IS FINITE.
      // Without it a quote carrying a null price becomes a price of zero, and (0 − prevClose) /
      // prevClose renders that tile at exactly −100%: the most alarming number on the board,
      // produced by a missing value rather than a market event.
      if (q && q.freshness === 'realtime' && q.price != null && Number.isFinite(Number(q.price)) && Number(q.price) > 0) {
        out.set(sym, { price: Number(q.price), asOf: capturedAt });
        fresh[sym] = Number(q.price);
      }
    }
    // ⚠️ ONLY PRICES GO IN, AND ONLY INTO THE HEATMAP'S OWN NAMESPACE. This is not the quote cache
    // and must never become it: /api/quotes still refuses to store an entitled quote, and that
    // policy is unchanged. What is shared here is one board's numerator, behind a key no
    // unentitled path reads.
    if (Object.keys(fresh).length) {
      await writeSnapshot(limit, fresh, { calculatedAt: capturedAt, sessionDate: session.sessionDate });
    } else {
      // ⚠️ THE PROVIDER ANSWERED WITH NOTHING USABLE DURING WHAT THE CALENDAR CALLS A SESSION.
      // The likeliest explanation is an unscheduled closure the rule set cannot know about, so the
      // day is stood down rather than re-batched every 15 minutes.
      //
      // ⚠️ BUT ONLY IF WE WERE ACTUALLY ENTITLED TO REALTIME PRICES IN THE FIRST PLACE, AND THIS
      // DISTINCTION IS NOT THEORETICAL — it fired on the first run of the probe. With the realtime
      // flag off, every quote comes back stamped 'eod' BY DESIGN, which looks identical to a shut
      // market from here. Suspending on that would let a configuration state (or a local script
      // sharing the production KV) silently freeze the real board for the rest of the day.
      //
      // "We cannot obtain realtime prices" and "the market is not trading" are different facts and
      // only the second one justifies standing down.
      const { tiingoRealtimeEnabled } = await import('../market/tiingo.mjs');
      if (tiingoRealtimeEnabled()) await suspendSession(session.etDate);
      if (snap && ofSession && snapshotState(snap) === 'stale') {
        // The choice is a blank board, a fabricated one, or the last thing we genuinely knew —
        // and only the third is honest, provided it is labelled as what it is. The route reports
        // the snapshot's age, so a stale board says so.
        useSnapshot(snap);
      }
    }
  } catch {
    // Same reasoning on a thrown request: prefer the last known good prices over nothing, and let
    // the caller describe their age rather than silently presenting them as current.
    try {
      const { readSnapshot: rs } = await import('./heatmap-realtime.mjs');
      const fb = await rs(limit);
      if (fb.snap && fb.state && fb.snap.sessionDate === session.sessionDate) useSnapshot(fb.snap);
    } catch { /* nothing to fall back to — the board renders end-of-day */ }
  }
  return live();
}

export async function heatmapBoard({ timeframe = '1D', limit = 150, realtime = false, now = Date.now() } = {}) {
  const asOf = await latestSessionDate();
  if (!asOf) return { asOf: null, baselineDate: null, rows: [] };

  const universe = await heatmapUniverse(limit);
  const tickers = universe.map((u) => u.ticker);
  if (!tickers.length) return { asOf, baselineDate: null, rows: [] };

  // The anchor for everything except 1D, which is expressed as "strictly before the latest session".
  const anchor = anchorDateFor(timeframe, asOf);

  const [intraday, latest, baseline, quality] = await Promise.all([
    intradayPrices(tickers, { realtime, timeframe, limit, asOf, now }),
    latestSession(tickers, asOf),
    timeframe === '1D'
      ? sessionPerTicker(tickers, asOf, { strictlyBefore: true, floorDays: 10 })
      : sessionPerTicker(tickers, anchor),
    qualityFor(tickers),
  ]);
  const live = intraday.prices;

  const rows = universe.map((u) => {
    const l = latest.get(u.ticker);
    const b = baseline.get(u.ticker);
    const row = {
      ...u,
      price: l?.close ?? null,
      volume: l?.volume ?? null,
      latestDate: l?.date ?? null,
      baselineDate: b?.date ?? null,
      pct: null,
      reason: null,
    };
    if (!l) { row.reason = NO_RETURN.NO_PRICE; return row; }
    // A baseline that is the latest session itself means the security has no history reaching back
    // that far — a recent listing. 0% would be a fabrication, so it is reported as missing history.
    if (!b || b.date >= l.date) { row.reason = NO_RETURN.NO_HISTORY; return row; }
    if (returnBlocked(quality.get(u.ticker) ?? null, b.date)) { row.reason = NO_RETURN.SERIES_BREAK; return row; }
    // ⚠️ THE LIVE PRICE REPLACES ONLY THE NUMERATOR, AND ONLY IF THERE IS ONE FOR THIS SYMBOL.
    // Everything above — the universe, the baseline, the quality gates — has already decided that
    // this row is measurable. A symbol the quote feed has nothing for keeps its close, so a partial
    // feed produces a board that is partly intraday and wholly correct, rather than a gap.
    // ⚠️ A LIVE 1D RETURN MEASURES FROM A DIFFERENT SESSION THAN AN END-OF-DAY ONE, AND GETTING
    // THIS WRONG PRODUCED A TWO-DAY RETURN WEARING A LIVE LABEL.
    //
    //   EOD 1D:  Sep 18 close  →  Sep 21 close      baseline = b.close (strictly before `asOf`)
    //   LIVE 1D: Sep 21 close  →  current price     baseline = l.close (the PREVIOUS close, which
    //                                               is the latest completed session)
    //
    // The first version swapped only the numerator and kept b.close, so it computed
    // (live Sep 22 price − Sep 18 close) and NVDA read +2.72% against a true +0.41%. The baseline
    // has to move forward one session the moment the numerator does — they are two halves of one
    // question, and the whole point of 1D is that the two ends are one session apart.
    //
    // This is also why it must agree with the Watchlist by construction: both are now
    // (current price − prevClose) / prevClose over the same pair of numbers.
    const lq = live.get(u.ticker);
    const base = lq ? l.close : b.close;
    if (lq) {
      row.price = lq.price;
      row.priceAsOf = lq.asOf ?? null;
      row.live = true;
      // The row states what it was actually measured FROM, so the banner cannot disagree with it.
      row.baselineDate = l.date;
    }
    const pct = pctReturn(lq ? lq.price : l.close, base);
    if (pct === null) { row.reason = NO_RETURN.NO_PRICE; return row; }
    row.pct = pct;
    return row;
  });

  // The board's baseline date is the one most securities share — the market's session, not any one
  // name's. Reported so the UI can state exactly what the percentages are measured from.
  const counts = new Map();
  for (const r of rows) if (r.baselineDate) counts.set(r.baselineDate, (counts.get(r.baselineDate) || 0) + 1);
  const baselineDate = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;

  // ⚠️ THE BOARD IS ONE SNAPSHOT, NOT 500 UNRELATED MOMENTS. Every live row carries the same
  // `asOf` because they all came from one capture, and reporting it is what lets the page say
  // "last updated 11:45" truthfully instead of implying a continuously ticking board.
  const snapshotAt = rows.find((r) => r.live)?.priceAsOf ?? null;

  return { asOf, baselineDate, anchorDate: anchor, snapshotAt, session: intraday.session, rows };
}

/**
 * The board, trimmed for the wire.
 *
 * The full eligible universe is 5,553 rows, and sent verbatim that is 1.24MB — mostly float noise
 * (a return carried to fifteen decimal places) and per-row dates that are the same on almost every
 * row. Nothing is lost that the page displays: returns render to two decimals, prices to two, and
 * the board already reports its own `asOf` and `baselineDate`.
 *
 * A row's OWN dates are kept only when they differ from the board's, which is exactly the case a
 * reader needs to see — a security whose baseline fell on a different session than the market's.
 */
export function compactRows(rows, { asOf, baselineDate } = {}) {
  const round = (v, dp) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp)));
  return (rows || []).map((r) => {
    const out = {
      ticker: r.ticker,
      company: r.company ?? null,
      sector: r.sector ?? null,
      marketCap: r.marketCap == null ? null : Math.round(r.marketCap),
      price: round(r.price, 2),
      pct: round(r.pct, 2),
      volume: r.volume == null ? null : Math.round(r.volume),
    };
    if (r.reason) out.reason = r.reason;
    if (r.latestDate && r.latestDate !== asOf) out.latestDate = r.latestDate;
    if (r.baselineDate && r.baselineDate !== baselineDate) out.baselineDate = r.baselineDate;
    return out;
  });
}
