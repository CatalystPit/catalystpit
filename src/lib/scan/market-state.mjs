// THE NORMALIZED MARKET STATE.
//
// One shape per symbol, built from whatever the active provider gives us, and the ONLY thing the
// signal engine reads. Vendors disagree about everything — field names, whether volume is
// cumulative, whether pre-market is included, what a "day" is — and that disagreement stops here.
//
// EVERY FIELD IS NULLABLE AND NULL MEANS UNKNOWN. Not zero, not "assume it did not happen". A signal
// asked to decide on a null returns nothing at all, which is what stops the scanner inventing a
// breakout because a provider omitted yesterday's high.
//
// Pure: no network, no clock of its own (the caller passes `now`), no React. That is what lets every
// scenario in scan-fixtures.mjs be replayed exactly in a test.

/** US market session boundaries, in ET minutes from midnight. */
export const SESSION = {
  PREMARKET_OPEN: 4 * 60,        // 04:00
  REGULAR_OPEN: 9 * 60 + 30,     // 09:30
  REGULAR_CLOSE: 16 * 60,        // 16:00
  AFTERHOURS_CLOSE: 20 * 60,     // 20:00
};

export const PHASES = ['closed', 'premarket', 'regular', 'afterhours'];

/** Which part of the trading day a given ET minute falls in. */
export function sessionPhase(etMinutes) {
  if (etMinutes == null || !Number.isFinite(etMinutes)) return null;
  if (etMinutes >= SESSION.REGULAR_OPEN && etMinutes < SESSION.REGULAR_CLOSE) return 'regular';
  if (etMinutes >= SESSION.PREMARKET_OPEN && etMinutes < SESSION.REGULAR_OPEN) return 'premarket';
  if (etMinutes >= SESSION.REGULAR_CLOSE && etMinutes < SESSION.AFTERHOURS_CLOSE) return 'afterhours';
  return 'closed';
}

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});

/** Minutes since ET midnight for an epoch — the market's clock, not the reader's. */
export function etMinutesOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const p = {};
  for (const x of ET_PARTS.formatToParts(ms)) p[x.type] = x.value;
  return (+p.hour) * 60 + (+p.minute);
}

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * WHICH TRADING DAY an epoch belongs to, in ET. 'YYYY-MM-DD'.
 *
 * A minute-of-day on its own does not identify a session: 09:35 happened yesterday too. Any adapter
 * that hands us more than one day of intraday bars — which is the normal way to fetch them — would
 * otherwise fold yesterday's prints into today's session high, and a level that never traded today is
 * a breakout that never happened.
 */
export function etDateKey(ms) {
  if (!Number.isFinite(ms)) return null;
  return ET_DATE.format(ms);
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The state of one symbol, normalized.
 *
 * `bars` are intraday, oldest → newest, each { t (epoch ms), o, h, l, c, v }. Everything derived
 * from them is computed here ONCE so that twenty signals reading the same symbol do not each walk
 * the bar list again — which is the difference between scanning forty symbols and four thousand.
 */
/**
 * Bars as the rest of the module promises them: oldest → newest, one per timestamp.
 *
 * A feed does not deliver them that way. A websocket reconnect replays bars that already arrived, a
 * late bar lands after its successor, and a provider revising a print re-sends the same minute with
 * different numbers. Each of those corrupts something different and quietly: a duplicate is counted
 * twice by every volume-weighted figure, and an out-of-order bar makes `priceAt` walk past the
 * window it was asked for and report no move at all.
 *
 * So the disagreement stops here, at the boundary, which is the one place that is allowed to know
 * about it. LAST WRITE WINS for a repeated timestamp: when a provider re-sends a bar it is correcting
 * it, and the correction is the one we want.
 */
export function normalizeBars(input) {
  if (!Array.isArray(input)) return [];
  const byTime = new Map();
  for (const b of input) {
    if (b && Number.isFinite(b.t)) byTime.set(b.t, b);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function buildSymbolState(input, { now = Date.now() } = {}) {
  if (!input || !input.symbol) return null;
  const bars = normalizeBars(input.bars);
  const last = bars.length ? bars[bars.length - 1] : null;
  const price = num(input.price) ?? (last ? num(last.c) : null);

  const phase = input.phase || sessionPhase(etMinutesOf(now));

  // Session extremes are taken from the REGULAR-session bars of TODAY only. Two separate mistakes are
  // being avoided here and both produce a level that never traded:
  //
  //   FOLDING PRE-MARKET IN is the most common way a scanner reports a breakout that never happened —
  //   almost every gap-up opens below its own pre-market high.
  //   FOLDING YESTERDAY IN is the same error one axis over. A minute-of-day does not identify a
  //   session, and an adapter asked for intraday bars will quite reasonably return several days of
  //   them, so the ET calendar date has to be part of the test.
  const sessionDate = etDateKey(now);
  const inSession = (b, from, to) => {
    if (etDateKey(b.t) !== sessionDate) return false;
    const m = etMinutesOf(b.t);
    return m != null && m >= from && m < to;
  };
  const regular = bars.filter((b) => inSession(b, SESSION.REGULAR_OPEN, SESSION.REGULAR_CLOSE));
  const pre = bars.filter((b) => inSession(b, SESSION.PREMARKET_OPEN, SESSION.REGULAR_OPEN));

  const sessionHigh = input.sessionHigh != null ? num(input.sessionHigh) : highOf(regular);
  const sessionLow = input.sessionLow != null ? num(input.sessionLow) : lowOf(regular);
  const premarketHigh = input.premarketHigh != null ? num(input.premarketHigh) : highOf(pre);
  const premarketLow = input.premarketLow != null ? num(input.premarketLow) : lowOf(pre);

  const bid = num(input.bid);
  const ask = num(input.ask);
  // A spread is only a spread when BOTH sides are known and sane. A crossed or one-sided book yields
  // null rather than a negative percentage that would sort to the top of a "tightest" list.
  const spread = (bid != null && ask != null && ask >= bid && bid > 0) ? ask - bid : null;

  const prevClose = num(input.prevClose);
  const open = num(input.open) ?? (regular.length ? num(regular[0].o) : null);

  return {
    symbol: String(input.symbol).toUpperCase(),
    now,
    etMinutes: etMinutesOf(now),
    phase,
    price,

    // ── quote ──
    bid,
    ask,
    spread,
    spreadPct: (spread != null && price > 0) ? (spread / price) * 100 : null,

    // ── identity, carried so filters and benchmarks do not need a second lookup ──
    company: input.company || null,
    sector: input.sector || null,
    industry: input.industry || null,
    marketCap: num(input.marketCap),
    float: num(input.float),
    // 'halted' | 'trading' | null. NULL IS UNKNOWN: a provider without halt status must not make
    // every symbol look like it is trading normally.
    haltStatus: input.haltStatus || null,

    // ── previous session, from settled daily data ──
    prevClose,
    prevHigh: num(input.prevHigh),
    prevLow: num(input.prevLow),

    // ── this session ──
    open,
    // THE GAP is open against yesterday's close — the overnight move, which is a different number
    // from the day's change and the one premarket traders actually watch.
    gapPct: pctChange(prevClose, open),
    premarketPct: pctChange(prevClose, premarketLastOf(pre) ?? price),
    sessionHigh,
    sessionLow,
    premarketHigh,
    premarketLow,

    // ── multi-day levels, from daily candles ──
    high20d: num(input.high20d),
    low20d: num(input.low20d),
    high52w: num(input.high52w),
    low52w: num(input.low52w),
    atr14: num(input.atr14),

    // ── volume. `volumeQuality` travels WITH the number so nothing downstream has to guess whether
    // it is consolidated, live, or a single venue's delayed print. ──
    volume: num(input.volume),
    avgVolume: num(input.avgVolume),
    premarketVolume: num(input.premarketVolume) ?? sumVolume(pre),
    dollarVolume: (num(input.volume) != null && price != null) ? num(input.volume) * price : null,
    // Travels WITH the number, so nothing downstream has to guess whether it is consolidated, live,
    // or one venue's delayed print. 'consolidated' | 'single-venue' | 'delayed' | null.
    volumeQuality: input.volumeQuality || null,

    // ── VWAP, only when the provider actually supplies or supports it ──
    vwap: num(input.vwap),

    bars,
    regularBars: regular,
    premarketBars: pre,

    // Carried through untouched for the enrichment layer; the engine never reads it.
    context: input.context || null,
  };
}

function highOf(bars) {
  let h = null;
  for (const b of bars) { const v = num(b.h); if (v != null && (h == null || v > h)) h = v; }
  return h;
}
function lowOf(bars) {
  let l = null;
  for (const b of bars) { const v = num(b.l); if (v != null && (l == null || v < l)) l = v; }
  return l;
}

/**
 * The opening range: the high and low of the first N minutes of the regular session.
 *
 * Returns null while the range is still forming. A breakout of a range that has not finished yet is
 * not a breakout, and reporting one is how a scanner fires on every gap-up at 09:31.
 */
export function openingRange(state, minutes) {
  if (!state || !Number.isFinite(minutes) || minutes <= 0) return null;
  const bars = state.regularBars || [];
  if (!bars.length) return null;
  const startM = SESSION.REGULAR_OPEN;
  const inRange = bars.filter((b) => {
    const m = etMinutesOf(b.t);
    return m != null && m >= startM && m < startM + minutes;
  });
  if (!inRange.length) return null;
  const nowM = etMinutesOf(state.now);
  if (nowM == null || nowM < startM + minutes) return null;   // still forming
  return { minutes, high: highOf(inRange), low: lowOf(inRange), complete: true };
}

export const OPENING_RANGE_MINUTES = [1, 5, 15, 30];

/**
 * Session VWAP from the bars we hold.
 *
 * Returns null unless the volume is good enough to mean anything: a VWAP computed from one venue's
 * delayed prints is not the VWAP anyone is trading against, and a wrong VWAP is worse than none,
 * because "reclaimed VWAP" is a decision people act on.
 */
export function sessionVwap(state, { requireConsolidated = true } = {}) {
  if (!state) return null;
  if (state.vwap != null) return state.vwap;
  if (requireConsolidated && state.volumeQuality !== 'consolidated') return null;
  const bars = state.regularBars || [];
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const vol = num(b.v);
    const typical = (num(b.h) != null && num(b.l) != null && num(b.c) != null)
      ? (b.h + b.l + b.c) / 3 : num(b.c);
    if (vol == null || vol <= 0 || typical == null) continue;
    pv += typical * vol;
    v += vol;
  }
  return v > 0 ? pv / v : null;
}

/** Percent change between two prices, null when either is unknown or the base is zero. */
export function pctChange(from, to) {
  const a = num(from);
  const b = num(to);
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

/** The last premarket print, for the premarket percentage. */
function premarketLastOf(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const c = bars[bars.length - 1].c;
  return Number.isFinite(c) ? c : null;
}

function sumVolume(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  let total = 0;
  let saw = false;
  for (const b of bars) {
    if (Number.isFinite(b.v)) { total += b.v; saw = true; }
  }
  return saw ? total : null;
}

/**
 * The premarket range and where price sits inside it.
 *
 * Distance from the pre-market high is what a premarket trader is watching all morning — "how far
 * from taking it" is a different and more useful question than "has it taken it".
 */
export function premarketProfile(state) {
  if (!state) return null;
  const hi = state.premarketHigh;
  const lo = state.premarketLow;
  if (hi == null || lo == null) return null;
  return {
    high: hi,
    low: lo,
    range: hi - lo,
    rangePct: state.prevClose > 0 ? ((hi - lo) / state.prevClose) * 100 : null,
    distanceToHighPct: pctChange(state.price, hi),
    distanceToLowPct: pctChange(state.price, lo),
    volume: state.premarketVolume,
  };
}

/** Where price sits between the session low and high — 0 at the low, 1 at the high. */
export function dayLocation(state) {
  if (!state) return null;
  const hi = state.sessionHigh;
  const lo = state.sessionLow;
  const p = state.price;
  if (hi == null || lo == null || p == null || hi <= lo) return null;
  return (p - lo) / (hi - lo);
}
