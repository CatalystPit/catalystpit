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
  name: 'tiingo-eod',
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

// ── HTTP ─────────────────────────────────────────────────────────────────────
// The token goes in the Authorization header, never the query string, so it cannot leak through a
// logged URL, a referrer or an error message that echoes the request.
async function tiingo(path, { searchParams = {} } = {}) {
  if (!tiingoConfigured()) return { ok: false, status: 0, reason: 'not-configured', data: null };
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
export async function getQuotes(symbols) {
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
      const price = live ?? prevClose;
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
        // Whether this price is live is a fact about the feed, not a hope.
        freshness: (live != null && q.lastSaleTimestamp) ? FRESHNESS.REALTIME : FRESHNESS.EOD,
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
