// THE TIINGO ADAPTER — server-only, normalised, behind the existing provider abstraction.
//
// ── WHAT THIS ACCOUNT ACTUALLY SERVES, MEASURED ──────────────────────────────
//
// Probed against the live API on 2026-09-19 at 11:55 ET, with the market OPEN
// (scripts/probe-tiingo-capabilities.mjs re-runs the whole matrix):
//
//   PASS                  auth, security metadata, daily EOD OHLCV (composite volume),
//                         historical intraday bars for PAST sessions, extended-hours history,
//                         all-ticker snapshot, fundamentals
//   ENTITLEMENT REQUIRED  real-time/reference last price, current-session intraday,
//                         corporate-actions endpoints, WebSocket streaming
//
// The real-time answer is not inferred from a plan description. At 11:55 ET on a trading day the
// IEX quote for AAPL returned last: null, lastSaleTimestamp: null, bidPrice: null, askPrice: null,
// a timestamp of the PREVIOUS session's close, and tngoLast equal to the previous close. Intraday
// bars for today came back as an empty array at both 1min and 5min. The WebSocket connects and
// authenticates, then rejects every thresholdLevel with "not valid for your subscription tier".
//
// So this file is written for an EOD feed, and says so in its capability descriptor. When the
// Standard Startup Redistribution agreement activates, the descriptor changes and the signals that
// require realtime switch on by themselves — that is what the capability layer is for.
//
// ── VOLUME, WHICH IS THE EASIEST THING HERE TO GET WRONG ─────────────────────
//
// Tiingo's DAILY bar volume is full composite market volume. Measured: SPY 65,395,148 for
// 2026-09-18, which is tape-scale, not one venue's share.
//
// Tiingo's INTRADAY bars carry NO VOLUME FIELD AT ALL on this account — not a small number, not a
// venue subset: absent. So participating-venue intraday volume is not something we are currently
// receiving and therefore not something we can display, scale, or build an RVOL numerator from.
// Under the future agreement it becomes available, delayed 15 minutes, at roughly 7-8% of
// consolidated — which is why it gets its own methodology constant now rather than later.
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
 * THE ENTITLEMENT GATE, AS A FUNCTION SO IT CAN BE TESTED RATHER THAN ASSERTED.
 *
 * Both halves are required. `vendorIsLive` says Tiingo sent a timestamped sale; `entitled` says we
 * are permitted to redistribute one. Either alone yields EOD — which is the whole point, because
 * the previous behaviour let the VENDOR decide by simply populating a field.
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
  // Intraday participating venues, 15-minute delayed, ~7-8% of consolidated and varying by symbol
  // and session. NOT AVAILABLE on this account today; defined so that when it arrives it cannot be
  // mistaken for the tape.
  PARTICIPATING_VENUES_DELAYED: VOLUME_METHODOLOGY.SINGLE_VENUE,
});

/** The human-facing label. Displayed volume must never be called consolidated unless it is. */
export const volumeLabel = (methodology) =>
  methodology === TIINGO_VOLUME.COMPOSITE_EOD ? 'composite end-of-day volume'
    : methodology === TIINGO_VOLUME.PARTICIPATING_VENUES_DELAYED ? 'participating-venue volume, 15-minute delayed'
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
//   /iex/<sym>/prices              IEX    getIntradayBars — currently called from NOWHERE. Built
//   /iex                           IEX    getAllTickersSnapshot — likewise uncalled. Neither is
//                                         reachable by a page today; both must acquire the same
//                                         entitlement check before anything calls them.
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

// ── 3. INTRADAY OHLCV — past sessions, and NO VOLUME ─────────────────────────
/**
 * Intraday bars for PAST sessions.
 *
 * `volume` is deliberately null on every bar rather than 0. This account's intraday payload has no
 * volume field at all, and zero is a number a caller would happily divide by or chart. The
 * methodology comes back null for the same reason: there is no volume here to have a methodology.
 */
export async function getIntradayBars(symbol, { from, to, freq = '5min', extendedHours = false } = {}) {
  const res = await tiingo(`/iex/${encodeURIComponent(String(symbol).toUpperCase())}/prices`,
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
      // A live print is one the vendor timestamps as a sale. Unentitled, such a payload is not
      // ours to serve, so the settled previous close is used instead. Outside a session this
      // branch never fires — tngoLast is then the official close and is served as it always was.
      const vendorIsLive = live != null && !!q.lastSaleTimestamp;
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
        // The volume on this payload matches the DAILY composite figure, so it is labelled as such
        // rather than as an intraday venue number.
        volume: num(q.volume),
        volumeMethodology: num(q.volume) == null ? null : TIINGO_VOLUME.COMPOSITE_EOD,
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
      changePct: (prevClose != null && prevClose !== 0) ? ((price - prevClose) / prevClose) * 100 : null,
      open: num(q.open), high: num(q.high), low: num(q.low),
      volume: num(q.volume),
      volumeMethodology: num(q.volume) == null ? null : TIINGO_VOLUME.COMPOSITE_EOD,
      asOf: q.timestamp || null,
      live: live != null && Boolean(q.lastSaleTimestamp),
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
