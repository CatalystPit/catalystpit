// THE TIINGO ADAPTER — server-only, normalised, behind the existing provider abstraction.
//
// ── WHAT THIS ACCOUNT ACTUALLY SERVES, MEASURED ──────────────────────────────
//
// ⚠️ RE-PROBED 2026-09-22 ~10:10-10:15 ET, MARKET OPEN, ON THE COMMERCIAL KEY. This replaces the
// 2026-09-19 matrix, which described the old entitlement and is now wrong in BOTH directions:
// things that were blocked now work, and one field silently changed meaning.
// (scripts/probe-tiingo-entitlement-2026.mjs, probe-tiingo-websocket.mjs, probe-tiingo-24x5-discovery.mjs)
//
//   PASS        auth, security master, daily EOD OHLCV (consolidated volume), intraday bars,
//               all-ticker snapshot, fundamentals, CORPORATE ACTIONS (distributions + splits),
//               REAL-TIME consolidated price via REST /iex tngoLast,
//               REAL-TIME via wss://api.tiingo.com/equities level 6 (last price ticks),
//               TOP OF BOOK via wss://api.tiingo.com/equities level 4 (bid/ask + sizes)
//   UNAVAILABLE ANY intraday or real-time CONSOLIDATED volume -> no RVOL, no VWAP
//   UNPROVEN    premarket / after-hours / overnight 24x5 — probed inside a regular session only
//
// ⚠️ THE 24x5 PRODUCT IS A DIFFERENT SOCKET FROM IEX, and that distinction cost a wrong report.
// wss://api.tiingo.com/iex accepts ONLY level 6 and carries price alone. The provisioned product
// is wss://api.tiingo.com/equities: level 4 returns
//   [ts, ticker, spreadRatio, bidSize, bidPrice, mid, askPrice, askSize]
// e.g. ["…10:15:05…","aapl",0.000044,60,339.38,339.39,339.395,140] — spread check
// (339.395-339.38)/339.38 = 0.0000442. No REST equivalent exists: /tiingo/equities/*,
// /realtime/*, /consolidated/* all 404. REST realtime is /iex tngoLast.
//
// ⚠️ AND lastSaleTimestamp IS NULL ON EVERY ROW, mid-session included. The live price arrives in
// tngoLast, so any gate detecting liveness from lastSaleTimestamp concludes the feed is dead and
// serves prevClose to an entitled user. See isFreshQuote.
//
// ── VOLUME, WHICH IS THE EASIEST THING HERE TO GET WRONG ─────────────────────
//
// Tiingo's DAILY bar volume is full composite market volume. Measured: SPY 65,395,148 for
// 2026-09-18, which is tape-scale, not one venue's share.
//
// ⚠️ INTRADAY VOLUME IS STILL NOT USABLE, AND THE COMMERCIAL KEY DID NOT CHANGE THAT. Two
// separate measurements, both 2026-09-22:
//
//   · intraday bars requested WITH an explicit volume column return volume: 0 on every bar
//   · /iex quote volume is real but is ONE VENUE'S — 0.17%-0.40% of the same day's consolidated
//     tape (AAPL 139,475 vs 34,999,229; SPY 83,354 vs 50,484,685)
//   · neither websocket payload carries a volume field at any permitted threshold level
//
// So there is no defensible full-market intraday volume anywhere in this entitlement. RVOL has no
// numerator and VWAP has no weights. Both stay off, and the capability descriptor keeps
// liveVolume/consolidatedVolume false so every dependent signal stays dark on its own rather than
// relying on anyone remembering this.
//
// The one rule that matters: a comparison is computed only when both sides carry the SAME
// methodology. methodologyCompatible() in scan/provider-contract.mjs enforces exact match with no
// scaling factor, and returns null rather than an estimate.

import { VOLUME_METHODOLOGY } from '../scan/provider-contract.mjs';
import { describeProvider, FRESHNESS } from '../scan/market-capabilities.mjs';

const BASE = 'https://api.tiingo.com';

// ── CONFIGURATION ────────────────────────────────────────────────────────────
// TIINGO_API_KEY is the existing project convention and is read ONLY here, on the server. Nothing in
// this module is imported by a client component, and the token never appears in a URL we log.
const TOKEN = process.env.TIINGO_API_KEY || process.env.TIINGO_API_TOKEN || '';
// Two switches rather than one, because "use Tiingo" and "trust Tiingo for live prices" are
// different decisions and the second must stay off until the entitlement is real.
const ENABLED = String(process.env.TIINGO_ENABLED ?? (TOKEN ? 'true' : 'false')).toLowerCase() !== 'false';
const REALTIME_ENABLED = String(process.env.TIINGO_REALTIME_ENABLED ?? 'false').toLowerCase() === 'true';

export const tiingoConfigured = () => Boolean(TOKEN) && ENABLED;
export const tiingoRealtimeEnabled = () => tiingoConfigured() && REALTIME_ENABLED;

/**
 * IS THIS PAYLOAD ABOUT NOW?
 *
 * ⚠️ THE FRESHNESS TEST EXISTS BECAUSE THE VENDOR'S OWN LIVENESS FLAG DOES NOT. Tiingo leaves
 * `lastSaleTimestamp` null on this account in every row, at every hour, so there is no field that
 * says "this is a live print". What there IS, on every row, is `timestamp` — and during a session
 * it tracks the wall clock to the second.
 *
 * The window is deliberately generous. It is not trying to measure latency; it is trying to tell
 * a quote about the current market from a payload echoing the last close, and those differ by
 * hours, not seconds. Too tight a window would flicker a Pro user between live and delayed on
 * ordinary network jitter, which is worse than being a minute behind.
 *
 * Exported so the behaviour is testable without a network.
 */
export const QUOTE_FRESH_WINDOW_MS = 5 * 60 * 1000;
export function isFreshQuote(timestamp, { now = Date.now() } = {}) {
  if (!timestamp) return false;
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return false;
  // A timestamp in the future is a clock problem, not a fresh quote; a small skew is tolerated
  // for the same reason the window is generous.
  const age = now - t;
  return age >= -QUOTE_FRESH_WINDOW_MS && age <= QUOTE_FRESH_WINDOW_MS;
}

/**
 * THE ENTITLEMENT GATE, AS A FUNCTION SO IT CAN BE TESTED RATHER THAN ASSERTED.
 *
 * Both halves are required. `vendorIsLive` says the feed is carrying a price about now; `entitled`
 * says we are permitted to redistribute one. Either alone yields EOD — which is the whole point,
 * because the original behaviour let the VENDOR decide by simply populating a field.
 *
 * @returns {{ freshness: string, useLivePrice: boolean }}
 */
export function resolveQuoteEntitlement({ entitled = false, vendorIsLive = false } = {}) {
  const live = Boolean(entitled && vendorIsLive);
  return {
    freshness: live ? FRESHNESS.REALTIME : FRESHNESS.EOD,
    // Unentitled, a live print is not ours to serve at any label — fall back to the settled close.
    useLivePrice: !(vendorIsLive && !entitled),
  };
}

/**
 * VOLUME METHODOLOGY, named for what it actually is.
 *
 * These map onto the shared VOLUME_METHODOLOGY vocabulary so the scan engine's compatibility rule
 * applies unchanged; the Tiingo-specific names exist so a number's provenance survives being passed
 * around and nobody has to remember which feed "single-venue" meant.
 */
export const TIINGO_VOLUME = Object.freeze({
  // Daily bars. Full composite market volume — the official tape figure.
  COMPOSITE_EOD: VOLUME_METHODOLOGY.CONSOLIDATED,
  // ⚠️ THIS ARRIVED, AND IT IS WHY THE CONSTANT EXISTED. Written as a placeholder for a capability
  // we did not have; the commercial entitlement turned /iex volume into exactly this — one venue's
  // intraday print, measured at 0.17%-0.40% of the tape. The name keeps DELAYED for compatibility
  // with stored values, but no delay has been measured on this account; see volumeLabel.
  PARTICIPATING_VENUES_DELAYED: VOLUME_METHODOLOGY.SINGLE_VENUE,
});

/** The human-facing label. Displayed volume must never be called consolidated unless it is. */
export const volumeLabel = (methodology) =>
  methodology === TIINGO_VOLUME.COMPOSITE_EOD ? 'composite end-of-day volume'
    // ⚠️ NO DELAY IS CLAIMED. The old text said "15-minute delayed", inherited from the free-tier
    // rules and never observed on this account. What IS measured is that the figure is one
    // venue's and not the market's, so that is all it says.
    : methodology === TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED ? 'single-venue volume, not the consolidated tape'
      : 'volume methodology unknown';

/**
 * WHAT WE CAN DEFEND ABOUT THIS FEED TODAY.
 *
 * Every field is what the probe observed, not what the price list advertises. `liveVolume` and
 * `consolidatedVolume` are both false because intraday volume is absent entirely — declaring
 * consolidatedVolume true from the DAILY bar would let a signal believe it can compute intraday
 * RVOL against the tape, which is exactly the fabrication the contract exists to prevent.
 */
export const TIINGO_EOD_CAPABILITIES = describeProvider({
  id: 'tiingo-eod',
  label: 'Tiingo (end-of-day)',
  streaming: false,                       // WebSocket rejects every thresholdLevel on this tier
  quoteFreshness: FRESHNESS.EOD,          // measured: live fields null during market hours
  observationsPerMinute: 0,
  minBarSeconds: 60,                      // 1min bars serve for PAST sessions
  extendedHours: true,                    // afterHours=true returns bars for past sessions
  liveVolume: false,                      // intraday bars carry no volume field at all
  consolidatedVolume: false,              // true only of the DAILY bar; see the note above
  bidAsk: false,
  trades: false,
  historicalDaily: true,
  historicalIntraday: true,               // past sessions only
  intradayVolumeHistory: false,           // no volume on intraday bars → no time-of-day baseline
  marketCap: false,
  float: false,
  haltStatus: false,
  universeSize: 42764,                    // measured from the all-ticker snapshot
});

/**
 * THE SAME FEED WITH THE COMMERCIAL ENTITLEMENT SWITCHED ON.
 *
 * ⚠️ READ THE FALSE FIELDS FIRST — they are why this is a second descriptor and not an edit:
 *
 *   consolidatedVolume  measured 0.17%-0.40% of the tape. One venue's prints.
 *   liveVolume          intraday bars return volume: 0; no websocket payload carries volume.
 *   intradayVolumeHistory  no volume on intraday bars → no time-of-day baseline exists.
 *
 * Because those stay false, every volume-dependent signal stays dark by itself and RVOL cannot be
 * computed however the rest is configured. That is the point of gating on measured capability
 * rather than on a plan name: the entitlement improved, the volume did not, and only the parts
 * that genuinely improved are allowed to notice.
 *
 * ⚠️ bidAsk IS TRUE BUT NOTHING CONSUMES IT YET. Top of book is real — wss .../equities level 4
 * returns [ts, ticker, spreadRatio, bidSize, bidPrice, mid, askPrice, askSize] — so the descriptor
 * records the truth. No surface displays a quote today, and none should start without its own
 * decision.
 *
 * ⚠️ extendedHours IS NOT PROMOTED. The probes ran inside a regular session, so premarket,
 * after-hours and overnight 24x5 were never observed. The plan says 24x5; this file records
 * measurements, and it will say so when someone has watched it at 04:00 ET.
 */
export const TIINGO_REALTIME_CAPABILITIES = describeProvider({
  ...TIINGO_EOD_CAPABILITIES,
  id: 'tiingo-realtime',
  label: 'Tiingo (real-time consolidated)',
  streaming: true,                        // wss .../equities accepted levels 4 and 6
  quoteFreshness: FRESHNESS.REALTIME,     // measured: tngoLast moves intraday and ≠ prevClose
  observationsPerMinute: 60,              // conservative; the stream ran ~7 ticks/s over 4 symbols
  bidAsk: true,                           // level 4 top of book, measured
  // Unchanged, deliberately — see the note above.
  liveVolume: false,
  consolidatedVolume: false,
  intradayVolumeHistory: false,
  trades: false,                          // level 6 is a reference-price tick, not a sale print
});

/**
 * Which Tiingo descriptor is in force right now.
 *
 * ⚠️ OUR FLAG DECIDES, NOT THE VENDOR'S PAYLOAD. tngoLast being live is Tiingo saying it CAN send
 * a live price; TIINGO_REALTIME_ENABLED is us saying we are permitted to redistribute one. With
 * the flag unset this returns the EOD descriptor and every surface behaves exactly as it does
 * today — which is also the instant rollback if anything goes wrong.
 */
export const tiingoCapabilities = () =>
  (tiingoRealtimeEnabled() ? TIINGO_REALTIME_CAPABILITIES : TIINGO_EOD_CAPABILITIES);

// ── WHICH CONTRACT BUCKET EACH ENDPOINT DRAWS ON ─────────────────────────────
//
// Three buckets, priced and entitled differently. Knowing which one a call lands in is the
// difference between a supported request and an invoice conversation, so it is written down here
// rather than inferred from the path each time:
//
//   /tiingo/daily/<sym>            EOD    metadata for a symbol. Entitled today.
//   /tiingo/daily/<sym>/prices     EOD    end-of-day bars. Entitled today; this is the feed the
//                                         whole product runs on — charts, Scan, Consensus levels.
//   /iex/  (batch)                 IEX    the quote path. Reachable with the token, but NOT
//                                         entitled for live redistribution: getQuotes() below
//                                         refuses a timestamped live print unless
//                                         tiingoRealtimeEnabled() is true.
//   /tiingo/equity/intraday/<sym>/prices
//                                  CONS   getIntradayBars — the intraday chart's bar source.
//                                         Consolidated across venues, ~2s behind the tape, and it
//                                         includes the bucket currently forming. Verified entitled
//                                         on this token: 200 with live data, no plan refusal.
//                                         ⚠️ Returns from 00:00 ET; the caller applies the 04:00
//                                         session floor.
//   /tiingo/equity/intraday        CONS   the consolidated realtime quote (tngoLast plus lq* book).
//                                         Entitled, but nothing calls it yet: the chart gets its
//                                         forming bar from the /prices bucket above, so there is
//                                         no reason to also poll a quote and reconcile two sources.
//   /iex                           IEX    getAllTickersSnapshot — uncalled. Single venue, and NOT
//   /iex/<sym>/prices              IEX    no longer used by the chart. Single venue and delayed on
//                                         this token (measured ~17 min); must not be mixed with
//                                         consolidated bars in one series.
//   wss://api.tiingo.com/equity/intraday  STREAM — deliberately NOT implemented. No subscribe
//                                         exists in this codebase, and none may be added until
//                                         the realtime flag is on for a real entitlement.
//
// ⚠️ DERIVED ≠ ENTITLED. An IEX last is a single-venue print, not the consolidated tape. It may
// never be presented as "the" price or as consolidated volume — see TIINGO_VOLUME above.
//
// ── QUERY BUDGET: 400,000/day, 30,000/hour ───────────────────────────────────
//
// ⚠️ CACHING IS THE REAL LIMITER, AND IT HAS TO BE. Scan fans out over the whole Consensus board
// and the watchlist surfaces fan out per ticker, so a per-page-view Tiingo call would burn the
// hourly budget on one busy afternoon. The defences, in order of importance:
//
//   1. Nothing here is called from a page render. Quotes come from the shared quote cache
//      (5-minute TTL, same key as /api/ticker), and Scan reads the ALREADY-materialized Consensus
//      board rather than resolving anything per visitor.
//   2. Daily bars are written to ticker_daily_candles by the warmers and read from Postgres.
//   3. The counter below records what did leave the building, so "are we near the ceiling" is a
//      question with an answer instead of a guess.
//
// The counter is observability, not a throttle: it does not block a call, because silently
// dropping a market-data request would corrupt a board more quietly than exceeding a quota.

/** Rolling in-process call counts. Per-instance, so treat as a floor, not a total. */
const budget = { day: null, dayCount: 0, hour: null, hourCount: 0 };
export const TIINGO_BUDGET = Object.freeze({ PER_DAY: 400_000, PER_HOUR: 30_000 });

function countCall() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  if (budget.day !== day) { budget.day = day; budget.dayCount = 0; }
  if (budget.hour !== hour) { budget.hour = hour; budget.hourCount = 0; }
  budget.dayCount++; budget.hourCount++;
  // Logged at the thresholds that matter, not on every call — a log line per request would itself
  // be the cost problem. 80% is the point at which someone should look.
  if (budget.hourCount === Math.floor(TIINGO_BUDGET.PER_HOUR * 0.8)
    || budget.dayCount === Math.floor(TIINGO_BUDGET.PER_DAY * 0.8)) {
    console.warn(`[tiingo] budget 80%: ${budget.hourCount}/h ${budget.dayCount}/day (this instance)`);
  }
}

/** What this instance has spent. Exposed for /api/health and for tests. */
export const tiingoBudget = () => ({
  day: budget.day, calls24h: budget.dayCount, perDay: TIINGO_BUDGET.PER_DAY,
  hour: budget.hour, callsThisHour: budget.hourCount, perHour: TIINGO_BUDGET.PER_HOUR,
});

// ── HTTP ─────────────────────────────────────────────────────────────────────
// The token goes in the Authorization header, never the query string, so it cannot leak through a
// logged URL, a referrer or an error message that echoes the request.
async function tiingo(path, { searchParams = {} } = {}) {
  if (!tiingoConfigured()) return { ok: false, status: 0, reason: 'not-configured', data: null };
  countCall();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(searchParams)) if (v != null) url.searchParams.set(k, String(v));
  try {
    const r = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${TOKEN}` },
      cache: 'no-store',
    });
    if (!r.ok) {
      // 403 is an entitlement answer and is worth distinguishing from a broken symbol, because one
      // is a purchase decision and the other is a bug.
      return { ok: false, status: r.status, reason: r.status === 403 ? 'entitlement' : r.status === 404 ? 'not-found' : 'http', data: null };
    }
    return { ok: true, status: r.status, reason: null, data: await r.json() };
  } catch {
    return { ok: false, status: 0, reason: 'network', data: null };
  }
}

const num = (v) => {
  // Number(null) is 0 and Number('') is 0, both finite — so absence is checked BEFORE conversion or
  // a missing price becomes a real one at zero.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── 1. SECURITY MASTER ───────────────────────────────────────────────────────
export async function getSecurity(symbol) {
  const res = await tiingo(`/tiingo/daily/${encodeURIComponent(String(symbol).toUpperCase())}`);
  if (!res.ok || !res.data) return { ok: false, reason: res.reason, security: null };
  const d = res.data;
  return {
    ok: true,
    reason: null,
    security: {
      symbol: String(d.ticker || symbol).toUpperCase(),
      name: d.name || null,
      exchange: d.exchangeCode || null,
      currency: d.priceCurrency || null,
      description: d.description || null,
      firstTradeDate: d.startDate || null,
      lastTradeDate: d.endDate || null,
      provider: 'tiingo',
    },
  };
}

// ── 2. DAILY OHLCV — composite EOD volume ────────────────────────────────────
/**
 * Daily bars, normalised to Catalyst Pit's internal bar model.
 *
 * Both raw and split/dividend-adjusted values are carried. The raw close is what a chart's price
 * axis should read; adjClose is what a return calculation needs. Collapsing them here would force
 * every caller to guess which one it had.
 */
export async function getDailyBars(symbol, { from, to } = {}) {
  const res = await tiingo(`/tiingo/daily/${encodeURIComponent(String(symbol).toUpperCase())}/prices`,
    { searchParams: { startDate: from, endDate: to } });
  if (!res.ok || !Array.isArray(res.data)) return { ok: false, reason: res.reason, bars: [], methodology: null };

  const bars = [];
  for (const r of res.data) {
    const date = String(r.date || '').slice(0, 10);
    const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
    // A bar missing any of OHLC is dropped rather than repaired: a chart with a gap is honest, a
    // chart with an invented price is not.
    if (!date || open == null || high == null || low == null || close == null) continue;
    bars.push({
      time: date, open, high, low, close,
      volume: num(r.volume),
      adjOpen: num(r.adjOpen), adjHigh: num(r.adjHigh), adjLow: num(r.adjLow), adjClose: num(r.adjClose),
      adjVolume: num(r.adjVolume),
      divCash: num(r.divCash), splitFactor: num(r.splitFactor),
    });
  }
  bars.sort((a, b) => a.time.localeCompare(b.time));
  return { ok: true, reason: null, bars, methodology: TIINGO_VOLUME.COMPOSITE_EOD, provider: 'tiingo' };
}

// ── 3. INTRADAY OHLCV — CONSOLIDATED, INCLUDING THE FORMING BAR, AND NO VOLUME ───
/**
 * Intraday bars, consolidated across venues, up to and including the bucket currently forming.
 *
 * ── ⚠️ WHY THIS IS NO LONGER /iex ───────────────────────────────────────────
 *
 * /iex is a SINGLE VENUE and, on this token, delayed. Measured against the same token on the same
 * morning: the /iex quote timestamp sat frozen at 08:38 across four samples from 08:55 to 08:57
 * — a lag growing 17.2 -> 18.7 minutes — with `last`, `lastSaleTimestamp`, `quoteTimestamp` and
 * `bidPrice` all null. Its 1-minute bars ended at 08:38 while the clock read 08:54.
 *
 * That delay was indistinguishable from a chart bug and was reported as one twice: a 5m chart
 * "stuck" at 08:35 and a 15m chart "missing" its 08:45 bucket were both faithful renderings of a
 * feed 17 minutes behind. There was no forming bar to append because no data existed in the bucket.
 *
 * The consolidated product answers the same query shape with a ~2-SECOND lag, and it already
 * contains the in-progress bucket — at 08:59:40 it returned 1m through 08:59, 5m through 08:55 and
 * 15m through 08:45. So "the current candle" needs no synthesis here: it is a real bar, built by
 * the vendor from real prints, and this function simply stops throwing it away.
 *
 * ⚠️ IT ALSO STARTS AT MIDNIGHT ET, NOT 04:00. The caller is responsible for the session floor;
 * see the route's inExtended. Passing the 00:00–04:00 bars straight through would put hours of
 * thin overnight prints on a chart labelled "pre-market".
 *
 * `volume` is deliberately null on every bar rather than 0: the payload carries
 * date/open/high/low/close and no volume field, and zero is a number a caller would happily divide
 * by or chart. The realtime endpoint's `volume` is CUMULATIVE DAY volume and is not a per-bar
 * figure — using it as one would invent a histogram. The methodology comes back null for the same
 * reason: there is no volume here to have a methodology.
 */
export async function getIntradayBars(symbol, { from, to, freq = '5min', extendedHours = false } = {}) {
  const res = await tiingo(`/tiingo/equity/intraday/${encodeURIComponent(String(symbol).toUpperCase())}/prices`,
    { searchParams: { startDate: from, endDate: to, resampleFreq: freq, afterHours: extendedHours ? 'true' : undefined } });
  if (!res.ok || !Array.isArray(res.data)) return { ok: false, reason: res.reason, bars: [], methodology: null };

  const bars = [];
  for (const r of res.data) {
    const t = r.date ? Math.floor(new Date(r.date).getTime() / 1000) : null;
    const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
    if (t == null || !Number.isFinite(t) || open == null || high == null || low == null || close == null) continue;
    bars.push({ time: t, open, high, low, close, volume: num(r.volume) });
  }
  bars.sort((a, b) => a.time - b.time);
  const anyVolume = bars.some((b) => b.volume != null);
  return {
    ok: true, reason: null, bars, provider: 'tiingo',
    // Only claim a methodology when there is actually volume to describe.
    methodology: anyVolume ? TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED : null,
  };
}

// ── 4. QUOTES — reference price, honestly labelled ───────────────────────────
/**
 * Batch quotes in Catalyst Pit's internal quote model.
 *
 * ⚠️ `freshness` IS PART OF THE ANSWER. On this account the IEX payload's live fields are null and
 * its timestamp is the previous close, so every quote is returned as EOD and says so. A caller that
 * wants to show "live" must check the field rather than assume, which is what keeps a delayed price
 * from being presented as a current one.
 *
 * tngoLast is Tiingo's own last-price field and is preferred when present; `last` is the raw venue
 * print. Both are null outside an entitled session, in which case the previous close is used and
 * the change is reported against it — a real number with a truthful label, not a fabricated one.
 */
export async function getQuotes(symbols, { realtime = false } = {}) {
  // ⚠️ OUR FLAG DECIDES, NOT THE VENDOR'S FIELDS.
  //
  // This function took only `symbols` while its one caller passed `{ realtime: wantLive }` — so
  // the entitlement gate in market-data.js was computed and then dropped on the floor. What kept
  // free users on EOD was an accident of the payload: on this account `lastSaleTimestamp`, `last`,
  // `bidPrice` and `quoteTimestamp` all come back null and only `tngoLast` (the settled close) is
  // populated, so the REALTIME branch never fired. That is the VENDOR withholding live data, not
  // us declining to serve it. The day an entitlement is switched on at Tiingo's end, this would
  // have started serving and labelling live prices with TIINGO_REALTIME_ENABLED still false.
  //
  // Now the flag is the gate. Unentitled, a payload that DOES carry a live print is refused and
  // the previous close is served instead — because a live last we are not licensed to
  // redistribute must not reach a page, however it is labelled.
  const entitled = realtime && tiingoRealtimeEnabled();
  const syms = [...new Set((symbols || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean))];
  if (!syms.length) return { ok: true, quotes: {}, freshness: FRESHNESS.EOD, provider: 'tiingo' };

  const out = {};
  // Batched: Tiingo takes a comma list, and polling per symbol is what the all-ticker guidance
  // explicitly warns against.
  for (let i = 0; i < syms.length; i += 100) {
    const chunk = syms.slice(i, i + 100);
    const res = await tiingo('/iex/', { searchParams: { tickers: chunk.join(',') } });
    if (!res.ok || !Array.isArray(res.data)) continue;
    for (const q of res.data) {
      const sym = String(q.ticker || '').toUpperCase();
      if (!sym) continue;
      const live = num(q.tngoLast) ?? num(q.last);
      const prevClose = num(q.prevClose);
      // ⚠️ lastSaleTimestamp IS NULL ON EVERY ROW OF THIS ACCOUNT, EVEN MID-SESSION, AND THAT WAS
      // THE BUG. Liveness was detected from that field, so with the commercial entitlement active
      // the check concluded "vendor is not live", and an entitled Pro user would have been served
      // prevClose while a genuinely live tngoLast sat in the same payload. Measured 2026-09-22
      // 10:10 ET: lastSaleTimestamp null, tngoLast 339.32 vs prevClose 338.98, and the stream
      // showing 339.56 at that moment. The field is not the signal it looks like.
      //
      // So liveness is now what it should always have been: a price that differs from the settled
      // close, carried on a timestamp recent enough to be about NOW rather than about the last
      // session. Both halves matter — the timestamp alone would call a stale payload live, and the
      // price alone cannot distinguish an unchanged quote from a closed market.
      const vendorIsLive = live != null && isFreshQuote(q.timestamp);
      const gate = resolveQuoteEntitlement({ entitled, vendorIsLive });
      const price = gate.useLivePrice ? (live ?? prevClose) : prevClose;
      if (price == null) continue;                       // no price is no quote; omit rather than zero
      const changePct = (prevClose != null && prevClose !== 0 && price != null)
        ? ((price - prevClose) / prevClose) * 100 : null;
      out[sym] = {
        price,
        prevClose,
        changePct,
        open: num(q.open), high: num(q.high), low: num(q.low),
        // ⚠️ THIS FIELD CHANGED MEANING WHEN THE COMMERCIAL ENTITLEMENT WENT LIVE, AND THE OLD
        // LABEL BECAME A FALSE CLAIM. It used to carry the previous DAILY composite figure,
        // because nothing intraday flowed on the old key, and COMPOSITE_EOD was true of it. It now
        // accumulates intraday and it is IEX's own venue print. Measured 2026-09-22 ~10:10 ET
        // against the SAME day's consolidated EOD bar:
        //
        //   AAPL 139,475 / 34,999,229 = 0.40%     NVDA 336,981 / 109,806,067 = 0.31%
        //   SPY   83,354 / 50,484,685 = 0.17%     AMD  134,714 /  44,494,272 = 0.30%
        //
        // Forty minutes into a session a consolidated figure would be a double-digit percentage of
        // the day. A third of one percent is one venue's share. Calling that the tape is the exact
        // mistake PARTICIPATING_VENUES_DELAYED was defined in advance to prevent, and anything
        // computing a ratio from it would be inventing RVOL out of 0.3% of the market.
        volume: num(q.volume),
        volumeMethodology: num(q.volume) == null ? null : TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED,
        asOf: q.timestamp || null,
        // Whether this price is live is a fact about the feed AND about our entitlement. Both
        // have to be true; the vendor alone cannot promote a quote to REALTIME.
        freshness: gate.freshness,
        provider: 'tiingo',
      };
    }
  }
  const anyLive = Object.values(out).some((q) => q.freshness === FRESHNESS.REALTIME);
  return { ok: true, quotes: out, freshness: anyLive ? FRESHNESS.REALTIME : FRESHNESS.EOD, provider: 'tiingo' };
}

// ── 5. ALL-TICKER SNAPSHOT — the scanner ingestion Tiingo recommends ─────────
/**
 * One request for the whole universe, rather than thousands of per-symbol polls.
 *
 * Measured: 42,764 rows, ~12MB. That is a server-side ingestion, never something a browser receives,
 * and it is why this returns a normalised array rather than the raw payload.
 */
export async function getAllTickersSnapshot() {
  const res = await tiingo('/iex');
  if (!res.ok || !Array.isArray(res.data)) return { ok: false, reason: res.reason, rows: [], asOf: null };
  const rows = [];
  for (const q of res.data) {
    const sym = String(q.ticker || '').toUpperCase();
    if (!sym) continue;
    const live = num(q.tngoLast) ?? num(q.last);
    const prevClose = num(q.prevClose);
    const price = live ?? prevClose;
    if (price == null) continue;
    rows.push({
      symbol: sym, price, prevClose,
      // ⚠️ THE LIVE PRINT ON ITS OWN, WITH NO FALLBACK — additive, and `price` above is unchanged.
      // `price` deliberately degrades to prevClose so a caller always has a number; a RANKING
      // cannot use that. A reverse-split symbol whose live print is missing would otherwise be
      // measured as (unadjusted prevClose ÷ our split-adjusted close) and appear as a −99% loser.
      // Callers that must distinguish "trading now" from "last known" read this instead.
      lastPrice: live,
      changePct: (prevClose != null && prevClose !== 0) ? ((price - prevClose) / prevClose) * 100 : null,
      open: num(q.open), high: num(q.high), low: num(q.low),
      volume: num(q.volume),
      // Same endpoint, same correction as getQuotes — /iex volume is one venue's print, measured
      // at 0.17%–0.40% of the consolidated tape. It is never the market's volume.
      volumeMethodology: num(q.volume) == null ? null : TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED,
      asOf: q.timestamp || null,
      // Same correction as getQuotes: lastSaleTimestamp is null on every row of this account, so
      // deriving liveness from it reports every quote as stale.
      live: live != null && isFreshQuote(q.timestamp),
    });
  }
  return { ok: true, reason: null, rows, asOf: rows[0]?.asOf ?? null, provider: 'tiingo' };
}

// ── 6. CORPORATE ACTIONS — from the daily bars, since the endpoint is not entitled ──
/**
 * Dividends and splits.
 *
 * The dedicated corporate-actions endpoints return 403 on this account. Every daily bar already
 * carries divCash and splitFactor, so the same facts are derived from the series we are entitled to
 * rather than left missing — and `source` records which route produced them, because the dedicated
 * endpoint carries fields (declaration and record dates) this one cannot.
 */
export async function getCorporateActions(symbol, { from, to } = {}) {
  const daily = await getDailyBars(symbol, { from, to });
  if (!daily.ok) return { ok: false, reason: daily.reason, dividends: [], splits: [], source: null };
  const dividends = [];
  const splits = [];
  for (const b of daily.bars) {
    if (b.divCash != null && b.divCash > 0) dividends.push({ exDate: b.time, amount: b.divCash });
    if (b.splitFactor != null && b.splitFactor !== 1) splits.push({ exDate: b.time, factor: b.splitFactor });
  }
  return {
    ok: true, reason: null, dividends, splits,
    source: 'daily-bars',
    note: 'Derived from daily bar divCash/splitFactor; the dedicated corporate-actions endpoints require an entitlement this account does not have.',
  };
}
